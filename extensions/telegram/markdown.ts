// ── Telegram MarkdownV2 Utilities ────────────────────────────────────────────
// Escaping and splitting for Telegram's MarkdownV2 parse mode.

// Characters that MUST be escaped in MarkdownV2
const MD_V2_ESCAPE_RE = /([_*\[\]()~`>#+\-=|{}.!\\])/g;

/** Escape text for Telegram MarkdownV2 parse mode. */
export function escapeMarkdownV2(text: string): string {
	return text.replace(MD_V2_ESCAPE_RE, "\\$1");
}

/** Telegram message length limit. */
export const MAX_MESSAGE_LENGTH = 4096;

/**
 * Split text into chunks that fit within Telegram's 4096-char limit.
 * Tries to split at paragraph boundaries, then line boundaries, then word boundaries.
 */
export function splitMessage(text: string, maxLength = MAX_MESSAGE_LENGTH): string[] {
	if (text.length <= maxLength) return [text];

	const chunks: string[] = [];
	let remaining = text;

	while (remaining.length > 0) {
		if (remaining.length <= maxLength) {
			chunks.push(remaining);
			break;
		}

		// Try to split at paragraph break (double newline)
		let splitAt = remaining.lastIndexOf("\n\n", maxLength);
		if (splitAt <= 0) {
			// Try single newline
			splitAt = remaining.lastIndexOf("\n", maxLength);
		}
		if (splitAt <= 0) {
			// Try space
			splitAt = remaining.lastIndexOf(" ", maxLength);
		}
		if (splitAt <= 0) {
			// Hard split
			splitAt = maxLength;
		}

		chunks.push(remaining.slice(0, splitAt));
		remaining = remaining.slice(splitAt);

		// Trim leading whitespace on next chunk
		remaining = remaining.replace(/^\n+/, "");
	}

	return chunks;
}
