// ── Telegram Message Formatting ──────────────────────────────────────────────
// Helpers for extracting and formatting incoming Telegram messages.

import type { Message, Location, Venue, Contact, Dice, Poll, MediaType } from "./types.js";

/** Format a text message from Telegram for Pi. No prefix - the system prompt tells the agent the source. */
export function formatIncomingText(text: string, isEdit: boolean): string {
	if (isEdit) return text + "\n[edited]";
	return text;
}

/** Extract text content from a Telegram message. */
export function extractText(message: Message): string {
	return (message.text || message.caption || "").trim();
}

/** Extract sender display name. */
export function senderName(message: Message): string | undefined {
	return message.from?.username ?? message.from?.first_name;
}

/** Content types detectable in a Telegram message. */
export type ContentType = "text" | "voice" | "audio" | "photo" | "video" | "video_note" | "animation" | "document" | "sticker" | "location" | "contact" | "dice" | "poll" | "caption";

/** Emoji for each media type - used in formatted output and status bar. */
export function mediaEmoji(type: MediaType): string {
	switch (type) {
		case "voice": return "\u{1F3A4}\u{FE0F}";
		case "audio": return "\u{1F3B5}";
		case "photo": return "\u{1F5BC}\u{FE0F}";
		case "sticker": return "\u{1F3AD}";
		case "video": return "\u{1F3AC}";
		case "video_note": return "\u{1F3AC}";
		case "animation": return "\u{1F39E}\u{FE0F}";
		case "document": return "\u{1F4C4}";
	}
}

/** Human-readable label for a media type. */
export function mediaLabel(type: MediaType): string {
	switch (type) {
		case "voice": return "voice message";
		case "audio": return "audio";
		case "photo": return "photo";
		case "sticker": return "sticker";
		case "video": return "video";
		case "video_note": return "video note";
		case "animation": return "animation";
		case "document": return "document";
	}
}

/** Hint for when no processor is configured, telling the agent what it can do. */
export function mediaNoProcessorHint(type: MediaType): string {
	switch (type) {
		case "voice": case "audio": return "no transcription available";
		case "photo": case "sticker": case "animation": return "no description available; you can read the image file if the model supports vision";
		case "video": case "video_note": return "no description available";
		case "document": return "you can read the file depending on its format";
	}
}

/** Detect which content types are present in a Telegram message. */
export function detectContentTypes(message: Message): ContentType[] {
	const types: ContentType[] = [];
	if (message.text) types.push("text");
	if (message.voice) types.push("voice");
	if (message.audio) types.push("audio");
	if (message.photo && message.photo.length > 0) types.push("photo");
	if (message.video) types.push("video");
	if (message.video_note) types.push("video_note");
	if (message.animation) types.push("animation");
	if (message.document) types.push("document");
	if (message.sticker) types.push("sticker");
	if (message.location || message.venue) types.push("location");
	if (message.contact) types.push("contact");
	if (message.dice) types.push("dice");
	if (message.poll) types.push("poll");
	if (message.caption && !message.text) types.push("caption");
	if (types.length === 0) types.push("text"); // fallback
	return types;
}

// ── Data-Only Message Formatters ───────────────────────────────────────────
// These message types carry structured data, not files.

/** Format a location as a text message with a map link. */
export function formatLocation(location: Location): string {
	const { latitude, longitude } = location;
	const mapUrl = `https://www.openstreetmap.org/?mlat=${latitude}&mlon=${longitude}#map=17/${latitude}/${longitude}`;
	let text = `\u{1F4CD} Location: ${latitude}, ${longitude}`;
	if (location.live_period) {
		const mins = Math.round(location.live_period / 60);
		text += ` (live for ${mins}min)`;
	}
	if (location.heading !== undefined) text += `, heading ${location.heading}°`;
	text += `\n${mapUrl}`;
	return text;
}

/** Format a venue (named location) as a text message. */
export function formatVenue(venue: Venue): string {
	let text = `\u{1F4CD} Venue: ${venue.title}\n${venue.address}`;
	if (venue.foursquare_id) text += `\nFoursquare: ${venue.foursquare_id}`;
	const mapUrl = `https://www.openstreetmap.org/?mlat=${venue.location.latitude}&mlon=${venue.location.longitude}#map=17/${venue.location.latitude}/${venue.location.longitude}`;
	text += `\n${mapUrl}`;
	return text;
}

/** Format a shared contact as a text message. */
export function formatContact(contact: Contact): string {
	let text = `\u{1F464} Contact: ${contact.first_name}`;
	if (contact.last_name) text += ` ${contact.last_name}`;
	text += `\n\u{1F4F1} ${contact.phone_number}`;
	if (contact.vcard) text += `\n[vCard attached]`;
	return text;
}

/** Format a dice roll as a text message. */
export function formatDice(dice: Dice): string {
	return `${dice.emoji} Rolled: ${dice.value}`;
}

/** Format a poll as a text message. */
export function formatPoll(poll: Poll): string {
	const typeLabel = poll.type === "quiz" ? "Quiz" : "Poll";
	const status = poll.is_closed ? " [closed]" : "";
	let text = `\u{1F4CA} ${typeLabel}: ${poll.question}${status}`;
	for (const opt of poll.options) {
		const marker = poll.correct_option_id !== undefined && poll.options[poll.correct_option_id] === opt ? "✓" : " ";
		text += `\n ${marker} ${opt.text} - ${opt.voter_count} vote${opt.voter_count !== 1 ? "s" : ""}`;
	}
	text += `\nTotal: ${poll.total_voter_count} voter${poll.total_voter_count !== 1 ? "s" : ""}`;
	if (poll.is_anonymous) text += " (anonymous)";
	return text;
}
