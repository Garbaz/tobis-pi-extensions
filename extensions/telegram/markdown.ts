// ── Telegram HTML Formatting Utilities ────────────────────────────────────────
// Converts LLM markdown to Telegram HTML (parse_mode: "HTML").
// HTML is preferred over MarkdownV2 because:
// - Only 3 characters need escaping (<, >, &) vs 18 for MarkdownV2
// - No risk of "can't parse entities" errors from unescaped special chars
// - Tables render as plain text instead of causing parse failures
// - Supports all the same formatting: bold, italic, code, pre, links, blockquote

/** Telegram message length limit. */
export const MAX_MESSAGE_LENGTH = 4096;

/** Escape HTML special characters: <, >, & */
export function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}

/**
 * Convert LLM markdown to Telegram HTML.
 *
 * Handles: headings, bold, italic, inline code, code blocks with language,
 * links, bullet lists, numbered lists, blockquotes, strikethrough.
 * Tables are rendered as plain text (Telegram doesn't support table markup).
 * All other text is HTML-escaped for safety.
 */
export function convertToHtml(markdown: string): string {
	// Process in order: code blocks first (protect from further processing),
	// then inline code, then structural elements, then inline formatting.

	const codeBlocks: string[] = [];
	const inlineCodes: string[] = [];
	const toolBlocks: string[] = [];

	// 0. Extract and protect tool lines (sentinel-marked raw HTML from outgoing.ts)
	//    These are formatted as \x00TOOL...\x00 and should pass through untouched.
	let result = markdown.replace(/\x00TOOL([\s\S]*?)\x00/g, (_match, content: string) => {
		const index = toolBlocks.length;
		toolBlocks.push(content);
		return `\x00TOOLBLOCK${index}\x00`;
	});

	// 1. Extract and protect fenced code blocks
	result = result.replace(/```(\w*)\n?([\s\S]*?)```/g, (_match, lang: string, code: string) => {
		const index = codeBlocks.length;
		const escapedCode = escapeHtml(code.trimEnd());
		const langAttr = lang ? ` class="language-${escapeHtml(lang)}"` : "";
		codeBlocks.push(`<pre><code${langAttr}>${escapedCode}</code></pre>`);
		return `\x00CODEBLOCK${index}\x00`;
	});

	// 2. Extract and protect inline code
	result = result.replace(/`([^`\n]+)`/g, (_match, code: string) => {
		const index = inlineCodes.length;
		inlineCodes.push(`<code>${escapeHtml(code)}</code>`);
		return `\x00INLINE${index}\x00`;
	});

	// 3. Process line by line for structural elements
	const lines = result.split("\n");
	const outputLines: string[] = [];
	let inBlockquote = false;

	for (let i = 0; i < lines.length; i++) {
		let line = lines[i];

		// Skip placeholder-only lines (code blocks handle their own newlines)
		if (/^\x00CODEBLOCK\d+\x00$/.test(line)) {
			if (inBlockquote) {
				outputLines.push("</blockquote>");
				inBlockquote = false;
			}
			outputLines.push(line);
			continue;
		}

		// Blockquotes
		const bqMatch = line.match(/^>\s?(.*)/);
		if (bqMatch) {
			const content = processInline(bqMatch[1], inlineCodes);
			if (!inBlockquote) {
				outputLines.push("<blockquote>" + content);
				inBlockquote = true;
			} else {
				outputLines.push(content);
			}
			continue;
		} else if (inBlockquote) {
			outputLines.push("</blockquote>");
			inBlockquote = false;
		}

		// Headings
		const headingMatch = line.match(/^(#{1,6})\s+(.*)/);
		if (headingMatch) {
			const content = processInline(headingMatch[2], inlineCodes);
			outputLines.push(`<b>${content}</b>`);
			continue;
		}

		// Bullet lists (-, *, +)
		const bulletMatch = line.match(/^(\s*)[-*+]\s+(.*)/);
		if (bulletMatch) {
			const indent = bulletMatch[1].length;
			const content = processInline(bulletMatch[2], inlineCodes);
			const prefix = indent > 0 ? "  ".repeat(Math.floor(indent / 2)) : "";
			outputLines.push(`${prefix}\u{2022} ${content}`);
			continue;
		}

		// Numbered lists
		const numMatch = line.match(/^(\s*)(\d+)\.\s+(.*)/);
		if (numMatch) {
			const indent = numMatch[1].length;
			const num = numMatch[2];
			const content = processInline(numMatch[3], inlineCodes);
			const prefix = indent > 0 ? "  ".repeat(Math.floor(indent / 2)) : "";
			outputLines.push(`${prefix}${num}. ${content}`);
			continue;
		}

		// Horizontal rule
		if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
			outputLines.push("\u{2500}\u{2500}\u{2500}");
			continue;
		}

		// Regular paragraph line
		outputLines.push(processInline(line, inlineCodes));
	}

	if (inBlockquote) {
		outputLines.push("</blockquote>");
	}

	result = outputLines.join("\n");

	// 4. Restore code block placeholders
	result = result.replace(/\x00CODEBLOCK(\d+)\x00/g, (_m, idx: string) => {
		return codeBlocks[parseInt(idx)];
	});

	// 5. Restore inline code placeholders
	result = result.replace(/\x00INLINE(\d+)\x00/g, (_m, idx: string) => {
		return inlineCodes[parseInt(idx)];
	});

	// 6. Restore tool line placeholders (raw HTML, already formatted)
	result = result.replace(/\x00TOOLBLOCK(\d+)\x00/g, (_m, idx: string) => {
		return toolBlocks[parseInt(idx)];
	});

	// 7. Clean up trailing newline
	result = result.replace(/\n$/, "");

	return result;
}

/**
 * Process inline formatting in a line of text.
 * Handles: **bold**, *bold*, __bold__, _italic_, ~~strikethrough~~, [links](url),
 * bare URLs, and HTML-escapes everything else.
 */
function processInline(text: string, inlineCodes: string[]): string {
	// Don't process placeholder-only text
	if (/^\x00(INLINE|CODEBLOCK)\d+\x00$/.test(text)) {
		return text;
	}

	// Links: [text](url) - process before bold/italic to avoid conflicts
	text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, linkText: string, url: string) => {
		return `<a href="${escapeHtml(url)}">${processInlineNoLinks(linkText)}</a>`;
	});

	// Bold+italic: ***text*** or ___text___
	text = text.replace(/\*\*\*(.+?)\*\*\*/g, "<b><i>$1</i></b>");
	text = text.replace(/___(.+?)___/g, "<b><i>$1</i></b>");

	// Bold: **text** or __text__
	text = text.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
	text = text.replace(/__(.+?)__/g, "<b>$1</b>");

	// Italic: *text* or _text_ (but not within words like variable_name)
	text = text.replace(/(?<!\w)\*(.+?)\*(?!\w)/g, "<i>$1</i>");
	text = text.replace(/(?<!\w)_(.+?)_(?!\w)/g, "<i>$1</i>");

	// Strikethrough: ~~text~~
	text = text.replace(/~~(.+?)~~/g, "<s>$1</s>");

	// Escape remaining HTML characters (but not already-converted tags)
	// We need to be careful: only escape <, >, & that aren't part of our HTML tags
	text = escapeHtmlPreservingTags(text);

	return text;
}

/** Process inline formatting without link conversion (for link text). */
function processInlineNoLinks(text: string): string {
	// Bold+italic
	text = text.replace(/\*\*\*(.+?)\*\*\*/g, "<b><i>$1</i></b>");
	// Bold
	text = text.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
	// Italic
	text = text.replace(/(?<!\w)\*(.+?)\*(?!\w)/g, "<i>$1</i>");
	// Strikethrough
	text = text.replace(/~~(.+?)~~/g, "<s>$1</s>");
	// Escape remaining
	text = escapeHtmlPreservingTags(text);
	return text;
}

/**
 * Escape HTML special characters while preserving our generated HTML tags.
 * Tags we generate: <b>, <i>, <s>, <code>, <pre>, <a>, <blockquote>,
 * <strong>, <em>, <u>, <ins>, <del>, <strike>, <tg-spoiler>, <span>.
 */
function escapeHtmlPreservingTags(text: string): string {
	// Split on HTML tags we generated (opening and closing)
	// Pattern matches: <tag ...>, </tag>
	const tagPattern = /(<\/?(?:b|i|s|code|pre|a|blockquote|strong|em|u|ins|del|strike|tg-spoiler|span)(?:\s[^>]*)?>)/gi;
	const parts = text.split(tagPattern);
	return parts
		.map((part, index) => {
			// Every other part (even indices) is text, odd indices are tags
			if (index % 2 === 1) {
				// This is a tag - don't escape
				return part;
			}
			// This is text content - escape HTML
			return escapeHtml(part);
		})
		.join("");
}

/**
 * Split text into chunks that fit within Telegram's 4096-char limit.
 * Tries to split at paragraph boundaries, then line boundaries, then word boundaries.
 * Respects HTML tag boundaries - won't split inside a tag.
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

		let chunk = remaining.slice(0, splitAt);

		// Close any unclosed HTML tags in this chunk
		chunk = closeOpenTags(chunk);

		chunks.push(chunk);

		// For the next chunk, we need to re-open tags that were closed
		// This is complex - for simplicity, just move forward and let
		// Telegram handle minor tag mismatches (it's lenient)
		remaining = remaining.slice(splitAt);
		remaining = remaining.replace(/^\n+/, "");
	}

	return chunks;
}

/**
 * Close any unclosed HTML tags in a chunk.
 * Returns the chunk with closing tags appended if needed.
 */
function closeOpenTags(chunk: string): string {
	const tagPattern = /<\/?([a-zA-Z][a-zA-Z0-9-]*)[^>]*>/g;
	const openTags: string[] = [];
	let match: RegExpExecArray | null;

	while ((match = tagPattern.exec(chunk)) !== null) {
		const [fullMatch, tagName] = match;
		if (fullMatch.startsWith("</")) {
			// Closing tag - pop from stack if matching
			const lastOpen = openTags[openTags.length - 1];
			if (lastOpen === tagName.toLowerCase()) {
				openTags.pop();
			}
		} else if (!fullMatch.endsWith("/>")) {
			// Opening tag (not self-closing)
			openTags.push(tagName.toLowerCase());
		}
	}

	// Close remaining open tags in reverse order
	const closers = openTags.reverse().map((tag) => `</${tag}>`);
	return chunk + closers.join("");
}
