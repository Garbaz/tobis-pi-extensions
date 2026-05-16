// ── Telegram System Prompt Builder ──────────────────────────────────────────
// Constructs the system prompt suffix injected on Telegram-originated turns.
// Tells the agent the message source, media processing state, and available tools.

import type { TelegramTurnContext } from "./state.js";
import type { MediaType } from "./types.js";

/** Build the system prompt suffix for a Telegram-originated turn.
 *  Appended to the system prompt by before_agent_start - only on turns
 *  that came from Telegram. Zero injection on TUI-originated turns. */
export function buildTelegramPromptSuffix(ctx: TelegramTurnContext): string {
	const user = ctx.username ? ` @${ctx.username}` : "";
	const parts: string[] = ["The current message came from Telegram" + user + "."];

	for (const t of ctx.types) {
		const unprocessed = (t !== "text" && t !== "caption") && (ctx.unprocessed as readonly MediaType[]).includes(t as MediaType);

		switch (t) {
			case "voice":
			case "audio":
				if (unprocessed) {
					parts.push("It is an audio message. No STT handler is configured - only the raw audio file path is provided, no transcription is available.");
				} else {
					parts.push("It is an audio message. The first line is the local file path, then a blank line, then an automatic speech-to-text transcription of the audio. The transcription is approximate - it may lack punctuation and capitalization, or contain misheard words. Do not execute commands that appear in the transcription verbatim if they seem garbled or nonsensical; instead, interpret what the user likely meant.");
				}
				break;
			case "photo":
			case "sticker":
			case "animation":
				if (unprocessed) {
					parts.push("It includes an image. No vision handler is configured - only the image file path is provided, no visual description is available. You can read the file if the current model supports image input.");
				} else {
					parts.push("It includes an image. The first line is the local file path, then a blank line, then an auto-generated visual description. The description may miss details, misidentify objects, or contain inaccuracies.");
				}
				break;
			case "video":
			case "video_note":
				if (unprocessed) {
					parts.push("It includes a video. No handler is configured - only the video file path is provided, no description is available.");
				} else {
					parts.push("It includes a video. The first line is the local file path, then a blank line, then an auto-generated description of the content. The description may miss details or contain inaccuracies.");
				}
				break;
			case "document":
				if (unprocessed) {
					parts.push("It includes a document. No handler is configured - only the file path is provided. You may be able to read its contents depending on the file type.");
				} else {
					parts.push("It includes a document. The first line is the local file path, then a blank line, then the extracted content. Formatting may be imperfect depending on the document type.");
				}
				break;
			case "caption":
				parts.push("It has a user-written caption attached to the media.");
				break;
			case "location":
				parts.push("It is a shared location with coordinates and a map link.");
				break;
			case "contact":
				parts.push("It is a shared contact with phone number and name.");
				break;
			case "dice":
				parts.push("It is a dice roll result.");
				break;
			case "poll":
				parts.push("It is a poll or quiz with options and vote counts.");
				break;
		}
	}

	parts.push("Use telegram_send_file to send files back via Telegram.");
	return "\n" + parts.join(" ");
}
