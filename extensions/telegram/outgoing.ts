// ── Outgoing: Pi → Telegram ──────────────────────────────────────────────────
// Handles outgoing Pi events: sending responses, streaming preview,
// tool call display, TUI input echo, reactions, typing indicator,
// and flushing queued file attachments.
//
// Turn buffer: as the agent runs, we accumulate interleaved text blocks
// and tool-call lines in turnBlocks[]. The preview message is edited live
// after each update so the user sees progress in real-time. At agent_end
// the preview is edited in-place with HTML formatting (no delete+resend).

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TelegramApi } from "./api.js";
import { convertToHtml, splitMessage, MAX_MESSAGE_LENGTH, escapeHtml } from "./markdown.js";
import type { PendingFile } from "./tools.js";
import { flushPendingFiles } from "./tools.js";
import { createLogger } from "./log.js";

const log = createLogger("outgoing");

// ── Tool input formatting ───────────────────────────────────────────────────
//
// Tool lines are formatted as raw HTML that passes through convertToHtml untouched.
// They use the sentinel \x00TOOL to mark them. The convertToHtml function
// extracts these before markdown processing and restores them after.
//
// Display format: 🔧 **bash:** `ls -la /home/…/pi-tobis-extensions/`
// HTML: <b>bash:</b> <code>ls -la /home/…/pi-tobis-extensions/</code>

/** Sentinel for tool lines - extracted before markdown processing, restored after. */
const TOOL_SENTINEL = "\x00TOOL";

/** Check if a turn block is a tool line (marked with sentinel). */
function isToolBlock(block: string): boolean {
	return block.startsWith(TOOL_SENTINEL);
}

/** Shorten paths in a bash command string. */
function shortenBashCommand(cmd: string, maxLen: number): string {
	// Shorten any path-like segments in the command
	// Matches: /foo/bar/baz/qux, ~/foo/bar/baz, ./foo/bar/baz
	return cmd.replace(/(~?\.?\/[\/\w._-]+)/g, (match) => {
		return shortenPath(match, maxLen);
	});
}

/** Truncate a tool input into a short summary for the turn buffer. */
function summarizeToolInput(toolName: string, args: Record<string, unknown>): string {
	switch (toolName) {
		case "bash": {
			const cmd = String(args.command ?? "");
			const shortened = shortenBashCommand(cmd.replace(/\n/g, " \u{21B5} "), 60);
			return shortened;
		}
		case "read":
		case "write":
		case "edit":
			return shortenPath(String(args.path ?? args.file ?? ""), 40);
		case "grep":
			return truncate(String(args.pattern ?? ""), 30);
		case "find":
			return truncate(String(args.pattern ?? ""), 30);
		case "ls":
			return shortenPath(String(args.path ?? "."), 40);
		default:
			return "";
	}
}

/** Format a tool line as raw HTML with sentinel markers.
 *  The sentinel ensures convertToHtml passes it through without escaping.
 *  Display format: \u{1F527} **bash:** `ls -la /home/…/pi-tobis-extensions/` */
function formatToolLine(toolName: string, summary: string): string {
	const namePart = `<b>${escapeHtml(toolName)}:</b>`;
	const summaryPart = summary ? ` <code>${escapeHtml(summary)}</code>` : "";
	return `${TOOL_SENTINEL}\u{1F527} ${namePart}${summaryPart}\x00`;
}

/** Strip tool line sentinel and HTML for plain text preview.
 *  Converts: \x00TOOL<b>bash:</b> <code>ls -la …</code>\x00
 *  To:        \u{1F527} bash: ls -la … */
function stripToolHtml(block: string): string {
	if (!isToolBlock(block)) return block;
	// Remove sentinel markers
	let text = block.replace(/^\x00TOOL/, "").replace(/\x00$/, "");
	// Convert <b>...</b> to plain text (just strip tags)
	text = text.replace(/<b>(.*?)<\/b>/g, "$1");
	// Convert <code>...</code> to plain text
	text = text.replace(/<code>(.*?)<\/code>/g, "$1");
	return text;
}

function truncate(s: string, maxLen: number): string {
	if (s.length <= maxLen) return s;
	return s.slice(0, maxLen - 1) + "\u{2026}";
}

/** Ellipsis character used for shortened paths. */
const ELLIPSIS = "\u{2026}";

/**
 * Shorten a filesystem path to fit within maxLen characters.
 *
 * Strategy (iterative, keeps most useful parts):
 *   /this/is/a/very/long/path/with/many/segments/foo.txt
 *   → /this/…/many/segments/foo.txt   (keep first + last 2)
 *   → /this/…/segments/foo.txt        (keep first + last 1)
 *   → /this/…/foo.txt                 (keep first + filename)
 *   → …/foo.txt                       (keep only filename)
 *
 * For relative paths:
 *   ./src/extensions/telegram/outgoing.ts
 *   → ./…/outgoing.ts
 *   → …/outgoing.ts
 *
 * For home paths:
 *   ~/projects/something/deeply/nested/file.js
 *   → ~/…/nested/file.js
 *   → ~/…/file.js
 *   → …/file.js
 */
function shortenPath(path: string, maxLen: number): string {
	if (path.length <= maxLen) return path;

	const normalized = path.replace(/\\/g, "/");
	const hasRoot = normalized.startsWith("/");
	// Split on /, filter out empty segments (leading /, trailing /, //)
	const segments = normalized.split("/").filter(s => s !== "");

	// If only 0-1 segments, just truncate the whole path
	if (segments.length <= 1) {
		return truncate(path, maxLen);
	}

	const prefix = hasRoot ? "/" : "";
	const first = segments[0]; // e.g. "home", "~", ".", "src"
	const last = segments[segments.length - 1]; // filename

	// Try: <prefix><first>/…/<second-last>/<last>
	if (segments.length >= 3) {
		const secondLast = segments[segments.length - 2];
		const candidate = `${prefix}${first}/${ELLIPSIS}/${secondLast}/${last}`;
		if (candidate.length <= maxLen) return candidate;
	}

	// Try: <prefix><first>/…/<last>
	{
		const candidate = `${prefix}${first}/${ELLIPSIS}/${last}`;
		if (candidate.length <= maxLen) return candidate;
	}

	// Try: …/<last>
	{
		const candidate = `${ELLIPSIS}/${last}`;
		if (candidate.length <= maxLen) return candidate;
	}

	// Even filename is too long: truncate it
	return truncate(last, maxLen);
}

// ── Outgoing Handler ────────────────────────────────────────────────────────

/** Manages all outgoing messages from Pi to Telegram. */
export class OutgoingHandler {
	private api: TelegramApi;
	private activeChatId: number | undefined;
	/** The forum topic thread ID to send messages into (undefined = General/no topic). */
	private _threadId: number | undefined;
	get threadId(): number | undefined {
		return this._threadId;
	}

	/** Message ID of the currently streaming preview message (for editMessageText). */
	private previewMessageId: number | undefined;

	/** Last preview text sent, to skip redundant edits that would trigger "message is not modified". */
	private lastPreviewText: string | undefined;

	/** Clear the streaming preview state (message ID + cached text). */
	private clearPreview(): void {
		this.previewMessageId = undefined;
		this.lastPreviewText = undefined;
	}

	/** ID of the last user message we reacted to (for updating reaction on completion). */
	private lastUserMessageId: number | undefined;
	private lastUserChatId: number | undefined;

	/** Message ID to reply to in outgoing messages (set from the incoming user message). */
	private replyToMessageId: number | undefined;

	/** Typing indicator interval. */
	private typingInterval: ReturnType<typeof setInterval> | undefined;

	/** Throttle state for editMessageText during streaming. */
	private lastEditTime = 0;
	private pendingEdit = false;
	private editThrottleMs = 800; // throttle edits to ~1.2/sec

	/** Files queued by telegram_send_file tool, flushed on agent_end. */
	private pendingFiles: PendingFile[] = [];

	// ── Turn buffer ────────────────────────────────────────────────────────
	// Accumulates the interleaved output of a single agent turn:
	// text blocks from message_update, tool-call lines from tool_execution_start.
	// Rendered into a single message that's edited live during the turn.

	/** Finalized blocks (text segments and tool lines) from earlier in the turn. */
	private turnBlocks: string[] = [];
	/** Current streaming text from the latest message_update (not yet finalized). */
	private currentStreamingText: string = "";

	constructor(api: TelegramApi) {
		this.api = api;
	}

	/** Set the active chat ID. */
	setActiveChatId(chatId: number | undefined): void {
		this.activeChatId = chatId;
		// Reset state when chat changes
		this.resetTurnState();
		this.lastUserMessageId = undefined;
		this.lastUserChatId = undefined;
		this.stopTypingIndicator();
	}

	/** Set the forum topic thread ID for outgoing messages. */
	setThreadId(threadId: number | undefined): void {
		this._threadId = threadId;
		// Reset preview when thread changes (can't edit across topics)
		this.clearPreview();
	}

	/** Get the current thread ID (for echoing into the right topic). */
	getThreadId(): number | undefined {
		return this.threadId;
	}

	/** Remember the user message for completion reaction and reply-to. */
	setLastUserMessage(chatId: number, messageId: number): void {
		this.lastUserChatId = chatId;
		this.lastUserMessageId = messageId;
		this.replyToMessageId = messageId;
	}

	// ── Turn buffer rendering ──────────────────────────────────────────────

	/** Render the full turn content for the final HTML message.
	 *  Tool blocks retain their HTML formatting with sentinel markers. */
	private renderTurnContent(): string {
		const parts = [...this.turnBlocks];
		if (this.currentStreamingText.trim()) {
			parts.push(this.currentStreamingText.trim());
		}
		return parts.join("\n\n");
	}

	/** Render turn content for the streaming preview (plain text, no HTML).
	 *  Strips sentinel markers and converts tool HTML to plain text. */
	private renderTurnContentPlain(): string {
		const parts = [...this.turnBlocks];
		if (this.currentStreamingText.trim()) {
			parts.push(this.currentStreamingText.trim());
		}
		return parts.map(stripToolHtml).join("\n\n");
	}

	/** Reset all turn-scoped state for a new agent turn. */
	private resetTurnState(): void {
		this.turnBlocks = [];
		this.currentStreamingText = "";
		this.pendingEdit = false;
		this.clearPreview();
		this.replyToMessageId = undefined;
	}

	// ── Agent lifecycle ────────────────────────────────────────────────────

	/** Called on agent_end: finalize turn, send formatted response, flush files, set reaction. */
	async onAgentEnd(_event: { messages: unknown[] }, _ctx: ExtensionContext): Promise<void> {
		this.stopTypingIndicator();

		// Finalize any remaining streaming text
		if (this.currentStreamingText.trim()) {
			this.turnBlocks.push(this.currentStreamingText.trim());
			this.currentStreamingText = "";
		}

		const content = this.renderTurnContent();

		// No chat → nothing to send (but drain files anyway to avoid stale queue)
		if (!this.activeChatId) {
			log.debug("onAgentEnd: no activeChatId, discarding");
			this.clearPreview();
			this.drainPendingFiles(); // discard
			this.resetTurnState();
			return;
		}

		const chatId = this.activeChatId;

		// Clean up dangling preview if there's no content to replace it with
		if (!content && this.previewMessageId) {
			try {
				await this.api.deleteMessage(chatId, this.previewMessageId);
			} catch { /* already gone */ }
			this.clearPreview();
		}

		// Send final response: edit preview in-place with HTML formatting,
		// or send as new message if no preview exists.
		// Only the first chunk triggers a push notification; subsequent chunks
		// are silent (disable_notification) to avoid notification spam.
		// Edits don't trigger push notifications - the preview already notified.
		if (content) {
			let sentFirstChunk = false; // track whether the first chunk was delivered

			const htmlContent = convertToHtml(content);
			try {
				const chunks = splitMessage(htmlContent);
				log.debug({ chunks: chunks.length, contentLen: content.length }, "onAgentEnd: sending");

				if (this.previewMessageId && chunks.length > 0) {
					// Try to edit the preview message in-place with HTML
					sentFirstChunk = await this.editPreviewHtml(chatId, chunks[0]);

					if (sentFirstChunk) {
						// Send remaining chunks as new messages
						for (let i = 1; i < chunks.length; i++) {
							await this.api.sendMessage({
								chat_id: chatId,
								text: chunks[i],
								parse_mode: "HTML",
								message_thread_id: this.threadId,
								disable_notification: true,
							});
						}
					}
				}

				if (!sentFirstChunk) {
					// No preview to edit, or edit failed - send all chunks as new messages
					for (let i = 0; i < chunks.length; i++) {
						await this.api.sendMessage({
							chat_id: chatId,
							text: chunks[i],
							parse_mode: "HTML",
							message_thread_id: this.threadId,
							reply_parameters: i === 0 ? this.replyParams() : undefined,
							disable_notification: i > 0,
						});
					}
				}
			} catch {
				// HTML split/conversion failed - try plain text as last resort
				log.warn("onAgentEnd: HTML formatting failed, falling back to plain text");
				try {
					const plainChunks = splitMessage(content);
					if (this.previewMessageId && plainChunks.length > 0) {
						// Try plain text edit on the preview
						sentFirstChunk = await this.editPreviewPlain(chatId, plainChunks[0]);

						if (sentFirstChunk) {
							for (let i = 1; i < plainChunks.length; i++) {
								await this.api.sendMessage({
									chat_id: chatId,
									text: plainChunks[i],
									message_thread_id: this.threadId,
									disable_notification: true,
								});
							}
						}
					}

					if (!sentFirstChunk) {
						for (let i = 0; i < plainChunks.length; i++) {
							await this.api.sendMessage({
								chat_id: chatId,
								text: plainChunks[i],
								message_thread_id: this.threadId,
								reply_parameters: i === 0 ? this.replyParams() : undefined,
								disable_notification: i > 0,
							});
						}
					}
				} catch {
					log.warn("onAgentEnd: all send attempts failed");
					await this.setCompletionReaction("\u{1F44E}");
					this.drainPendingFiles(); // discard stale queue
					this.resetTurnState();
					return;
				}
			}
		}

		// Flush pending files from telegram_send_file tool
		const pending = this.drainPendingFiles();
		if (pending.length > 0) {
			const { errors } = await flushPendingFiles(this.api, chatId, this.threadId, pending);
			if (errors.length > 0) {
				log.warn({ errorCount: errors.length, errors: errors.slice(0, 3) }, "onAgentEnd: file send errors");
				try {
					await this.api.sendMessage({
						chat_id: chatId,
						text: `\u{26A0}\u{FE0F} Failed to send ${errors.length} file(s):\n${errors.join("\n")}`,
						message_thread_id: this.threadId,
						reply_parameters: this.replyParams(),
						disable_notification: true,
					});
				} catch { /* non-critical */ }
			}
		}

		// Set completion reaction
		if (content || pending.length > 0) {
			await this.setCompletionReaction("\u{1F44D}");
		}

		this.resetTurnState();
	}

	/** Called on message_update: streaming preview via editMessageText. */
	async onMessageUpdate(event: { message: unknown; assistantMessageEvent: unknown }, _ctx: ExtensionContext): Promise<void> {
		if (!this.activeChatId) return;

		const msg = event.message as { content?: string | Array<{ type: string; text?: string }> };
		let text: string | undefined;

		if (typeof msg.content === "string") {
			text = msg.content;
		} else if (Array.isArray(msg.content)) {
			const textParts = msg.content.filter((p): p is { type: string; text: string } => p.type === "text" && typeof p.text === "string");
			if (textParts.length > 0) {
				text = textParts.map((p) => p.text).join("\n");
			}
		}

		if (!text) return;

		// Update the current streaming text segment
		this.currentStreamingText = text;

		// Throttle edits to avoid Telegram API rate limits
		const now = Date.now();
		if (now - this.lastEditTime < this.editThrottleMs) {
			this.pendingEdit = true;
			return;
		}

		await this.sendOrEditPreview(this.renderTurnContentPlain());
		this.lastEditTime = now;
		this.pendingEdit = false;
	}

	/** Flush any pending preview edit (re-renders from turn buffer). */
	async flushPendingEdit(): Promise<void> {
		if (this.pendingEdit && this.activeChatId) {
			const content = this.renderTurnContentPlain();
			if (content) {
				await this.sendOrEditPreview(content);
			}
			this.pendingEdit = false;
		}
	}

	// ── Tool call display ──────────────────────────────────────────────────

	/** Called when a tool starts executing. Finalizes current text, appends a tool line. */
	async onToolExecutionStart(toolName: string, args: Record<string, unknown>): Promise<void> {
		// Finalize any streaming text before the tool call
		if (this.currentStreamingText.trim()) {
			this.turnBlocks.push(this.currentStreamingText.trim());
			this.currentStreamingText = "";
		}

		// Append tool line with HTML formatting: 🔧 <b>toolName:</b> <code>summary</code>
		const summary = summarizeToolInput(toolName, args);
		this.turnBlocks.push(formatToolLine(toolName, summary));

		// Edit the preview immediately - MUST await to prevent race when multiple
		// tools fire in rapid succession (otherwise previewMessageId isn't set yet
		// and a second sendMessage creates a duplicate preview)
		await this.sendOrEditPreview(this.renderTurnContentPlain());
	}

	/** Called when a tool finishes executing. No-op - no status indicators. */
	onToolExecutionEnd(_toolName: string, _args: Record<string, unknown>, _isError: boolean): void {
		// No checkmarks or status updates
	}

	// ── Reactions ──────────────────────────────────────────────────────────

	/** Set a reaction on a user message. */
	async setReaction(chatId: number | string, messageId: number, emoji: string): Promise<void> {
		try {
			await this.api.setMessageReaction({
				chat_id: chatId,
				message_id: messageId,
				reaction: [{ type: "emoji", emoji }],
			});
		} catch {
			// Reactions may fail - non-critical
		}
	}

	/** Start sending typing indicators every 4 seconds. */
	startTypingIndicator(_ctx: ExtensionContext): void {
		this.stopTypingIndicator();
		if (!this.activeChatId) return;

		const chatId = this.activeChatId;
		const sendTyping = async (): Promise<void> => {
			try {
				await this.api.sendChatAction(chatId, "typing", this.threadId);
			} catch {
				// Non-critical
			}
		};

		void sendTyping().catch(() => {});
		this.typingInterval = setInterval(() => {
			void sendTyping().catch(() => {});
		}, 4000);
	}

	/** Stop the typing indicator. */
	stopTypingIndicator(): void {
		if (this.typingInterval) {
			clearInterval(this.typingInterval);
			this.typingInterval = undefined;
		}
	}

	/** Queue a file for sending on agent_end. */
	queueFile(file: PendingFile): void {
		this.pendingFiles.push(file);
	}

	/** Drain all pending files (called by onAgentEnd to flush the queue). */
	drainPendingFiles(): PendingFile[] {
		const files = this.pendingFiles;
		this.pendingFiles = [];
		return files;
	}

	// ── TUI Input Echo ─────────────────────────────────────────────────────

	/** Echo a TUI-originated user message to Telegram.
	 *  Sent silently (no push notification) - the user already knows they typed it. */
	async sendUserEcho(text: string): Promise<void> {
		if (!this.activeChatId) return;

		try {
			await this.api.sendMessage({
				chat_id: this.activeChatId,
				text: `\u{1F464} ${text}`,
				message_thread_id: this.threadId,
				reply_parameters: this.replyParams(),
				disable_notification: true,
			});
		} catch {
			// non-critical - echo is best-effort
		}
	}

	// ── Private helpers ────────────────────────────────────────────────────

	/** Build reply_parameters if we have a message to reply to. */
	private replyParams(): { message_id: number } | undefined {
		return this.replyToMessageId ? { message_id: this.replyToMessageId } : undefined;
	}

	/** Send or edit the streaming preview message. */
	private async sendOrEditPreview(text: string): Promise<void> {
		if (!this.activeChatId) return;

		const previewText = text.length > MAX_MESSAGE_LENGTH
			? text.slice(0, MAX_MESSAGE_LENGTH - 20) + "\n\u{2026}[truncated]"
			: text;

		// Skip if the text hasn't changed since the last edit. Avoids redundant
		// API calls that would trigger "message is not modified" errors.
		if (this.previewMessageId && previewText === this.lastPreviewText) return;

		try {
			if (this.previewMessageId) {
				await this.api.editMessageText({
					chat_id: this.activeChatId,
					message_id: this.previewMessageId,
					text: previewText,
				});
			} else {
				const result = await this.api.sendMessage({
					chat_id: this.activeChatId,
					text: previewText,
					message_thread_id: this.threadId,
					reply_parameters: this.replyParams(),
					disable_notification: true, // streaming preview - not actionable
				});
				this.previewMessageId = result.message_id;
			}
			this.lastPreviewText = previewText;
		} catch {
			// editMessageText can fail if message not found or content unchanged - ignore
		}
	}

	/** Edit the preview message in-place with HTML formatting.
	 *  Returns true if the edit succeeded, false if it failed. */
	private async editPreviewHtml(chatId: number, htmlChunk: string): Promise<boolean> {
		if (!this.previewMessageId) return false;

		try {
			await this.api.editMessageText({
				chat_id: chatId,
				message_id: this.previewMessageId,
				text: htmlChunk,
				parse_mode: "HTML",
			});
			this.clearPreview();
			return true;
		} catch {
			// HTML parse error, message deleted, or content unchanged
			this.clearPreview();
			return false;
		}
	}

	/** Edit the preview message in-place with plain text (fallback when HTML fails).
	 *  Returns true if the edit succeeded, false if it failed. */
	private async editPreviewPlain(chatId: number, textChunk: string): Promise<boolean> {
		if (!this.previewMessageId) return false;

		try {
			await this.api.editMessageText({
				chat_id: chatId,
				message_id: this.previewMessageId,
				text: textChunk,
			});
			this.clearPreview();
			return true;
		} catch {
			this.clearPreview();
			return false;
		}
	}

	/** Set a reaction on the last user message (e.g. \u{1F44D} on completion). */
	private async setCompletionReaction(emoji: string): Promise<void> {
		if (this.lastUserChatId && this.lastUserMessageId) {
			try {
				await this.api.setMessageReaction({
					chat_id: this.lastUserChatId,
					message_id: this.lastUserMessageId,
					reaction: [{ type: "emoji", emoji }],
				});
			} catch {
				// Non-critical
			}
			this.lastUserChatId = undefined;
			this.lastUserMessageId = undefined;
		}
	}
}
