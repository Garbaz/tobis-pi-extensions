// ── Telegram Media Processing ────────────────────────────────────────────────
// Downloads media from Telegram, processes it via configured API handlers,
// and returns text for forwarding to Pi.

import type { TelegramApi } from "./api.js";
import type { Message, MediaType, MediaProcessor } from "./types.js";
import { mediaNoProcessorHint } from "./formatting.js";
import { execFile } from "node:child_process";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join, basename } from "node:path";

// ── Processor Output Limits ──────────────────────────────────────────────────

/** Maximum processor output included inline in the agent message (characters).
 *  Longer output is truncated and the full result written to a .processor.txt file. */
const MAX_PROCESSOR_OUTPUT = 4000;

// ── Session Media Dir ────────────────────────────────────────────────────────
// Media directories are per-session, not per-CWD. They follow the same naming
// convention as session companion files:
//
//   <timestamp>_<sessionId>.jsonl           (pi's session file)
//   <timestamp>_<sessionId>-telegram.json   (telegram companion data)
//   <timestamp>_<sessionId>-media/           (telegram media downloads)
//
// This avoids cross-talk when two pi instances share the same CWD.
// Falls back to the session directory (per-CWD) if sessionFile is unavailable.

/** Derive the per-session media directory from the session file path.
 *  Returns undefined if sessionFile is undefined (in-memory session). */
export function mediaDirPath(sessionFile: string | undefined): string | undefined {
	if (!sessionFile) return undefined;
	const base = sessionFile.replace(/\.jsonl$/, "");
	return `${base}-media`;
}

/** Get or create the per-session media directory.
 *  Uses the session-file-derived path if available, falls back to <sessionDir>/media. */
export async function getMediaDir(sessionFile: string | undefined, fallbackDir: string): Promise<string> {
	const dir = mediaDirPath(sessionFile) ?? join(fallbackDir, "media");
	await mkdir(dir, { recursive: true });
	return dir;
}

// ── Message → Media Mapping ──────────────────────────────────────────────────

/** Extracted media info from a Telegram message. */
export interface MediaInfo {
	type: MediaType;
	fileId: string;
	mimeType?: string;
	fileName?: string;
}

/** Map a Telegram message to its media type and file_id, or undefined if no media. */
export function getMediaInfo(message: Message): MediaInfo | undefined {
	if (message.voice) return { type: "voice", fileId: message.voice.file_id, mimeType: message.voice.mime_type };
	if (message.audio) return { type: "audio", fileId: message.audio.file_id, mimeType: message.audio.mime_type, fileName: message.audio.file_name };
	if (message.photo && message.photo.length > 0) {
		const photo = message.photo[message.photo.length - 1];
		return { type: "photo", fileId: photo.file_id };
	}
	if (message.video) return { type: "video", fileId: message.video.file_id, mimeType: message.video.mime_type, fileName: message.video.file_name };
	if (message.video_note) return { type: "video_note", fileId: message.video_note.file_id };
	if (message.animation) return { type: "animation", fileId: message.animation.file_id, mimeType: message.animation.mime_type, fileName: message.animation.file_name };
	if (message.document) return { type: "document", fileId: message.document.file_id, mimeType: message.document.mime_type, fileName: message.document.file_name };
	if (message.sticker) return { type: "sticker", fileId: message.sticker.file_id };
	return undefined;
}

// ── File Helpers ─────────────────────────────────────────────────────────────

/** Infer file extension from mime type. */
export function extFromMime(mimeType?: string, fallback = "bin"): string {
	if (!mimeType) return fallback;
	const map: Record<string, string> = {
		"audio/ogg": "ogg",
		"audio/mpeg": "mp3",
		"audio/mp4": "m4a",
		"audio/webm": "webm",
		"audio/x-m4a": "m4a",
		"image/jpeg": "jpg",
		"image/png": "png",
		"image/webp": "webp",
		"image/gif": "gif",
		"video/mp4": "mp4",
		"video/webm": "webm",
		"video/quicktime": "mov",
		"application/pdf": "pdf",
		"application/x-tgsticker": "tgs",
	};
	return map[mimeType] ?? fallback;
}

/** Default mime types for media types where Telegram doesn't provide one. */
function defaultMimeType(mediaType: MediaType): string {
	switch (mediaType) {
		case "photo": return "image/jpeg";        // Telegram always sends photos as JPEG
		case "sticker": return "image/webp";      // Static stickers are webp (animated=tgs, video=webm)
		case "video_note": return "video/mp4";     // Video notes are always mp4
		default: return "application/octet-stream";
	}
}

/** Download a Telegram file and save it to the session media dir. Returns the local path.
 *
 *  Filename strategy: `<chatId>-<messageId>-<stem>.<ext>`
 *  - chatId + messageId make the file unique and traceable to the source message
 *  - stem comes from the original fileName (sanitized) or the media type
 *  - ext comes from the Telegram server file_path (most reliable), then
 *    mime_type, then default per media type
 */
export async function downloadMediaFile(
	api: TelegramApi,
	fileId: string,
	mediaType: MediaType,
	mimeType: string | undefined,
	fileName: string | undefined,
	mediaDir: string,
	messageId: number,
	chatId: number | string,
): Promise<string> {
	const file = await api.getFile(fileId);
	if (!file.file_path) {
		throw new Error("file not accessible via Bot API");
	}

	const buffer = await api.downloadFile(file.file_path);

	// Determine extension - prefer server-assigned from file_path (most reliable),
	// then mime_type, then default per media type
	const serverExt = file.file_path.split(".").pop()?.toLowerCase();
	const mimeExt = extFromMime(mimeType ?? defaultMimeType(mediaType), "bin");
	const ext = (serverExt && serverExt.length <= 5 && /^[a-z0-9]+$/.test(serverExt)) ? serverExt : mimeExt;

	// Build stem from original fileName, sanitized, without extension
	const stemName = fileName
		? fileName.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/\.[^.]+$/, "")
		: mediaType;

	const path = join(mediaDir, `${chatId}-${messageId}-${stemName}.${ext}`);
	await writeFile(path, buffer);
	return path;
}

/** Build a placeholder string for a media type with no processor configured.
 *  Format: content first, file path at the bottom in brackets.
 *  localPath is the downloaded file path so the agent can still access it. */
export function mediaPlaceholder(type: MediaType, _message: Message, localPath: string): string {
	const hint = mediaNoProcessorHint(type);
	const parts: string[] = [hint];
	if (localPath) parts.push(`[${localPath}]`);
	return parts.join("\n\n");
}

/** Truncate processor output if it exceeds MAX_PROCESSOR_OUTPUT.
 *  Writes the full output to a `.processor.txt` file next to the media file.
 *  Returns the truncated text with a pi-style notice pointing to the full file.
 *  If output fits within the limit, returns it unchanged. */
export async function truncateProcessorOutput(output: string, mediaFilePath: string): Promise<string> {
	if (output.length <= MAX_PROCESSOR_OUTPUT) return output;

	// Write full output to .processed.txt next to the media file
	const processorPath = mediaFilePath + ".processed.txt";
	await writeFile(processorPath, output, "utf-8");

	const shown = output.slice(0, MAX_PROCESSOR_OUTPUT);
	return `${shown}\n\n[Showing first ${MAX_PROCESSOR_OUTPUT} of ${output.length} characters. Full output: ${processorPath}]`;
}

// ── Protocol Handlers ────────────────────────────────────────────────────────
// Each takes a MediaProcessor config and a local file path, returns text.

/** openai-stt: POST multipart/form-data to /v1/audio/transcriptions. Response: {"text":"..."} */
async function handleOpenaiStt(processor: MediaProcessor, filePath: string): Promise<string> {
	const fileBuffer = await readFile(filePath);
	const fileName = filePath.split("/").pop() ?? "audio.ogg";

	const formData = new FormData();
	formData.append("file", new Blob([fileBuffer]), fileName);
	formData.append("response_format", "json");
	if (processor.model) formData.append("model", processor.model);

	if (!processor.url) throw new Error("no url configured for openai-stt processor");
	const headers: Record<string, string> = {};
	if (processor.api_key) {
		headers["Authorization"] = `Bearer ${processor.api_key}`;
	}

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), processor.timeout ?? 30000);

	try {
		const response = await fetch(processor.url, {
			method: "POST",
			body: formData,
			headers,
			signal: controller.signal,
		});

		if (!response.ok) {
			const body = await response.text().catch(() => "");
			throw new Error(`HTTP ${response.status}: ${body.slice(0, 200)}`);
		}

		const json = await response.json() as { text?: string; error?: { message?: string } };
		if (json.error) {
			const msg = typeof json.error === "object" ? json.error.message ?? JSON.stringify(json.error) : String(json.error);
			throw new Error(msg);
		}
		if (!json.text?.trim()) {
			throw new Error("no speech detected");
		}
		return json.text.trim();
	} finally {
		clearTimeout(timeout);
	}
}

/** openai-chat: POST JSON to /v1/chat/completions with base64 content. Response: {"choices":[{"message":{"content":"..."}}]} */
async function handleOpenaiChat(processor: MediaProcessor, filePath: string): Promise<string> {
	const fileBuffer = await readFile(filePath);
	const base64 = Buffer.from(fileBuffer).toString("base64");

	// Infer mime type from extension
	const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
	const mimeMap: Record<string, string> = {
		jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
		webp: "image/webp", gif: "image/gif",
		ogg: "audio/ogg", mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav",
		mp4: "video/mp4", webm: "video/webm",
	};
	const mimeType = mimeMap[ext] ?? "application/octet-stream";
	const dataUrl = `data:${mimeType};base64,${base64}`;

	const prompt = processor.prompt ?? "Describe this content concisely.";

	const body: Record<string, unknown> = {
		model: processor.model ?? "gpt-4o",
		messages: [
			{
				role: "user",
				content: [
					{ type: "text", text: prompt },
					{ type: "image_url", image_url: { url: dataUrl } },
				],
			},
		],
		max_tokens: 1024,
	};

	if (!processor.url) throw new Error("no url configured for openai-chat processor");
	const headers: Record<string, string> = { "Content-Type": "application/json" };
	if (processor.api_key) {
		headers["Authorization"] = `Bearer ${processor.api_key}`;
	}

	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), processor.timeout ?? 30000);

	try {
		const response = await fetch(processor.url, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
			signal: controller.signal,
		});

		if (!response.ok) {
			const body = await response.text().catch(() => "");
			throw new Error(`HTTP ${response.status}: ${body.slice(0, 200)}`);
		}

		const json = await response.json() as {
			choices?: Array<{ message?: { content?: string } }>;
			error?: { message?: string };
		};
		if (json.error) {
			const msg = json.error.message ?? JSON.stringify(json.error);
			throw new Error(msg);
		}
		const content = json.choices?.[0]?.message?.content?.trim();
		if (!content) {
			throw new Error("empty response from vision model");
		}
		return content;
	} finally {
		clearTimeout(timeout);
	}
}

/** bash: Execute a shell command with {file} replaced by the local file path.
 *
 *  Bash processor contract:
 *  - Exit 0 → stdout = result text (success, including empty/zero results)
 *  - Exit non-zero → failure; stdout+stderr included in error message
 *  - "No result" is NOT a failure - exit 0 with a descriptive message (e.g. "[no speech detected]")
 */
async function handleBash(processor: MediaProcessor, filePath: string): Promise<string> {
	const command = (processor.command ?? "").replace("{file}", filePath);
	if (!command) throw new Error("no command configured for bash processor");
	const timeout = processor.timeout ?? 30000;

	return new Promise<string>((resolve, reject) => {
		execFile("sh", ["-c", command], { timeout }, (err: Error | null, stdout: string, stderr: string) => {
			if (err) {
				reject(new Error(`script failed: ${err.message}\n${stderr}`));
			} else {
				resolve(stdout.trim());
			}
		});
	});
}

/** Process a media file using the configured processor. Returns text result. */
export async function processMedia(processor: MediaProcessor, filePath: string): Promise<string> {
	switch (processor.api) {
		case "openai-stt":
			return handleOpenaiStt(processor, filePath);
		case "openai-chat":
			return handleOpenaiChat(processor, filePath);
		case "bash":
			return handleBash(processor, filePath);
	}
}
