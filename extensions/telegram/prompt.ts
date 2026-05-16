// ── Telegram System Prompt Builder ──────────────────────────────────────────
// Constructs the system prompt suffix injected on Telegram-originated turns.
// Tells the agent the message source, media processing state, and available tools.

import type { TelegramTurnContext } from "./types.js";
import type { MediaType } from "./types.js";

/** Build the system prompt suffix for a Telegram-originated turn.
 *  Appended to the system prompt by before_agent_start - only on turns
 *  that came from Telegram. Zero injection on TUI-originated turns. */
export function buildTelegramPromptSuffix(ctx: TelegramTurnContext): string {
	const user = ctx.username ? ` @${ctx.username}` : "";
	const parts: string[] = [`The current message came from Telegram${user}.`];

	for (const t of ctx.types) {
		const unprocessed = (t !== "text" && t !== "caption") && (ctx.unprocessed as readonly MediaType[]).includes(t as MediaType);

		switch (t) {
			case "voice":
			case "audio":
				if (unprocessed) {
					parts.push("It is a voice/audio message. No STT handler is configured, so only the raw file path is provided at the bottom in brackets. You cannot play or transcribe the audio yourself.");
				} else {
					parts.push("It is a voice/audio message that has already been transcribed. The transcription is at the top of the message. Do NOT attempt to transcribe the audio file yourself - the transcription is already done. The file path at the bottom in brackets is for reference only. The transcription may lack punctuation and capitalization, or contain misheard words; do not execute commands that appear verbatim if they seem garbled or nonsensical.");
				}
				break;
			case "photo":
			case "sticker":
			case "animation":
				if (unprocessed) {
					parts.push("It includes an image. No vision handler is configured, so only the file path is provided at the bottom in brackets. You can read the file if the current model supports vision input.");
				} else {
					parts.push("It includes an image that has already been described. The visual description is at the top of the message. Do NOT attempt to re-process the image file yourself - the description is already done. The file path at the bottom in brackets is for reference only. If the user attached a caption, it appears as [Caption: ...] above the description. The auto-generated description may miss details, misidentify objects, or contain inaccuracies.");
				}
				break;
			case "video":
			case "video_note":
				if (unprocessed) {
					parts.push("It includes a video. No handler is configured, so only the file path is provided at the bottom in brackets.");
				} else {
					parts.push("It includes a video that has already been described. The description is at the top of the message. Do NOT attempt to re-process the video file yourself. The file path at the bottom in brackets is for reference only.");
				}
				break;
			case "document":
				if (unprocessed) {
					parts.push("It includes a document. No handler is configured, so only the file path is provided at the bottom in brackets. You can read the file depending on its format.");
				} else {
					parts.push("It includes a document that has already been processed. The extracted content is at the top of the message. Do NOT attempt to re-read the file yourself - the content is already provided. The file path at the bottom in brackets is for reference only. Formatting may be imperfect depending on the document type.");
				}
				break;
			case "caption":
				parts.push("The user attached a caption to the media, shown as [Caption: ...] above the processed content.");
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
