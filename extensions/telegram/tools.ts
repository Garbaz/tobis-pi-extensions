// ── Telegram Action Tools ────────────────────────────────────────────────────
// Registered as Pi tools so the agent can send files via Telegram.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFile, stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import type { TelegramApi } from "./api.js";
import type { Instance } from "./instance.js";

/** Queued file to send as a Telegram attachment. */
export interface PendingFile {
	/** Absolute path to the file on disk. */
	path: string;
	/** Optional caption (max 1024 chars for documents, 2048 for photos). */
	caption?: string;
}

/** File type classification for choosing the right Telegram API method. */
type FileCategory = "photo" | "voice" | "document";

/** Extensions that should be sent as photos. */
const PHOTO_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp"]);

/** Extensions that should be sent as voice notes. */
const VOICE_EXTENSIONS = new Set([".ogg", ".mp3", ".m4a"]);

/** Classify a file by its extension to choose the right send method. */
function classifyFile(filePath: string): FileCategory {
	const ext = extname(filePath).toLowerCase();
	if (PHOTO_EXTENSIONS.has(ext)) return "photo";
	if (VOICE_EXTENSIONS.has(ext)) return "voice";
	return "document";
}

/** MIME type lookup for common extensions. */
const MIME_TYPES: Record<string, string> = {
	".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
	".gif": "image/gif", ".webp": "image/webp",
	".ogg": "audio/ogg", ".mp3": "audio/mpeg", ".m4a": "audio/mp4",
	".pdf": "application/pdf", ".zip": "application/zip",
	".txt": "text/plain", ".json": "application/json",
	".csv": "text/csv", ".md": "text/markdown",
	".py": "text/x-python", ".ts": "text/typescript", ".js": "text/javascript",
	".rs": "text/rust", ".go": "text/go",
};

/** Get MIME type for a file extension, falling back to application/octet-stream. */
function mimeTypeFor(filePath: string): string {
	return MIME_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

/** Max file size Telegram accepts (50 MB for documents, 10 MB for photos, 20 MB for voice). */
const MAX_DOCUMENT_SIZE = 50 * 1024 * 1024;
const MAX_PHOTO_SIZE = 10 * 1024 * 1024;
const MAX_VOICE_SIZE = 20 * 1024 * 1024;

/** Send a single queued file via the Telegram API. */
async function sendFile(
	api: TelegramApi,
	chatId: number,
	threadId: number | undefined,
	file: PendingFile,
	signal?: AbortSignal,
): Promise<{ ok: true } | { ok: false; error: string }> {
	try {
		const data = await readFile(file.path);
		const filename = basename(file.path);
		const category = classifyFile(file.path);
		const mime = mimeTypeFor(file.path);

		// Check size limits
		const maxSize = category === "photo" ? MAX_PHOTO_SIZE : category === "voice" ? MAX_VOICE_SIZE : MAX_DOCUMENT_SIZE;
		if (data.byteLength > maxSize) {
			return { ok: false, error: `${filename}: file too large (${Math.round(data.byteLength / 1024 / 1024)}MB, limit ${Math.round(maxSize / 1024 / 1024)}MB)` }; 
		}

		const blob = new Blob([data], { type: mime });

		if (category === "photo") {
			await api.sendPhoto({
				chat_id: chatId,
				photo: { data: blob, filename },
				caption: file.caption,
				message_thread_id: threadId,
				disable_notification: true, // files follow the response - not actionable
			}, signal);
		} else if (category === "voice") {
			await api.sendVoice({
				chat_id: chatId,
				voice: { data: blob, filename },
				caption: file.caption,
				message_thread_id: threadId,
				disable_notification: true,
			}, signal);
		} else {
			await api.sendDocument({
				chat_id: chatId,
				document: { data: blob, filename },
				caption: file.caption,
				message_thread_id: threadId,
				disable_notification: true,
			}, signal);
		}

		return { ok: true };
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return { ok: false, error: `${basename(file.path)}: ${msg}` };
	}
}

/** Flush all pending files from an OutgoingHandler's queue. */
export async function flushPendingFiles(
	api: TelegramApi,
	chatId: number | undefined,
	threadId: number | undefined,
	pending: PendingFile[],
	signal?: AbortSignal,
): Promise<{ sent: number; errors: string[] }> {
	if (!chatId || pending.length === 0) return { sent: 0, errors: [] };

	let sent = 0;
	const errors: string[] = [];

	for (const file of pending) {
		const result = await sendFile(api, chatId, threadId, file, signal);
		if (result.ok) {
			sent++;
		} else {
			errors.push(result.error);
		}
	}

	return { sent, errors };
}

/** Register all Telegram action tools with Pi. */
export function registerTools(pi: ExtensionAPI, instance: Instance): void {
	// ── telegram_send_file ───────────────────────────────────────────────────
	// Queue files to be sent as attachments when the agent turn ends.

	pi.registerTool({
		name: "telegram_send_file",
		description: "Send files to the Telegram chat. Queued files are delivered as attachments after the agent's response. Images are sent as photos, audio as voice notes, everything else as documents. Supports files up to 50MB (10MB for images).",
		parameters: {
			type: "object",
			properties: {
				paths: {
					type: "array",
					items: { type: "string" },
					description: "Absolute or relative file paths to send",
				},
				caption: {
					type: "string",
					description: "Optional caption for the first file (max 1024 chars for documents, 2048 for photos)",
				},
			},
			required: ["paths"],
			additionalProperties: false,
		} as const,
		label: "Telegram Send File",
		execute: async (_toolCallId: string, params: { paths: string[]; caption?: string }, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: ExtensionContext) => {
			if (!instance.api) {
				return {
					content: [{ type: "text" as const, text: "Telegram is not connected. Files cannot be sent." }],
					details: undefined as unknown,
				};
			}

			const resolvedPaths: string[] = [];
			const errors: string[] = [];

			for (const p of params.paths) {
				// Resolve relative paths against cwd
				const resolved = p.startsWith("/") ? p : new URL(p, `file://${ctx.cwd}/`).pathname;
				try {
					// Verify the file exists and is readable
					const info = await stat(resolved);
					if (!info.isFile()) {
						errors.push(`${p}: not a file`);
						continue;
					}
				} catch {
					errors.push(`${p}: file not found or unreadable`);
					continue;
				}
				resolvedPaths.push(resolved);
			}

			if (resolvedPaths.length === 0) {
				return {
					content: [{ type: "text" as const, text: errors.length > 0 ? `No valid files to send.\n${errors.join("\n")}` : "No files specified." }],
					details: undefined as unknown,
				};
			}

			// Queue files on the active session's outgoing handler
			const activeSession = instance.lastActiveSessionId
				? instance.sessions.get(instance.lastActiveSessionId)
				: undefined;
			const caption = params.caption;
			for (let i = 0; i < resolvedPaths.length; i++) {
				activeSession?.outgoing?.queueFile({
					path: resolvedPaths[i],
					caption: i === 0 ? caption : undefined,
				});
			}

			const fileNames = resolvedPaths.map((p) => basename(p));
			const resultLines = [`Queued ${resolvedPaths.length} file(s) for Telegram delivery:`, ...fileNames.map((n) => `  • ${n}`)];
			if (errors.length > 0) {
				resultLines.push("", "Skipped:", ...errors.map((e) => `  • ${e}`));
			}

			return {
				content: [{ type: "text" as const, text: resultLines.join("\n") }],
				details: undefined as unknown,
			};
		},
	});
}
