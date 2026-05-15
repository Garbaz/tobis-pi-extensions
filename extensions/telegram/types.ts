// ── Telegram Bot API Types ───────────────────────────────────────────────────
// Minimal typed subset of the Telegram Bot API (10.0) — only what we need.

// ── Primitives ───────────────────────────────────────────────────────────────

export interface User {
	id: number;
	is_bot: boolean;
	first_name: string;
	last_name?: string;
	username?: string;
	language_code?: string;
	is_premium?: true;
}

export interface Chat {
	id: number;
	type: "private" | "group" | "supergroup" | "channel";
	title?: string;
	username?: string;
	first_name?: string;
	last_name?: string;
}

export interface MessageEntity {
	type: string;
	offset: number;
	length: number;
	url?: string;
	user?: User;
	language?: string;
	custom_emoji_id?: string;
}

export interface PhotoSize {
	file_id: string;
	file_unique_id: string;
	width: number;
	height: number;
	file_size?: number;
}

export interface Document {
	file_id: string;
	file_unique_id: string;
	file_name?: string;
	mime_type?: string;
	file_size?: number;
}

export interface Voice {
	file_id: string;
	file_unique_id: string;
	duration: number;
	mime_type?: string;
	file_size?: number;
}

export interface Audio {
	file_id: string;
	file_unique_id: string;
	duration: number;
	performer?: string;
	title?: string;
	file_name?: string;
	mime_type?: string;
	file_size?: number;
}

export interface Video {
	file_id: string;
	file_unique_id: string;
	width: number;
	height: number;
	duration: number;
	file_name?: string;
	mime_type?: string;
	file_size?: number;
}

export interface Sticker {
	file_id: string;
	file_unique_id: string;
	width: number;
	height: number;
	is_animated: boolean;
	is_video: boolean;
	emoji?: string;
	set_name?: string;
	file_size?: number;
}

export interface VideoNote {
	file_id: string;
	file_unique_id: string;
	length: number;
	duration: number;
	file_size?: number;
}

export interface File {
	file_id: string;
	file_unique_id: string;
	file_size?: number;
	file_path?: string;
}

export interface ReactionType {
	type: "emoji" | "custom_emoji";
	emoji?: string;
	custom_emoji_id?: string;
}

// ── Data-Only Message Types (no file download) ──────────────────────────────

export interface Location {
	latitude: number;
	longitude: number;
	horizontal_accuracy?: number;
	live_period?: number;
	heading?: number;
	proximity_alert_radius?: number;
}

export interface Venue {
	location: Location;
	title: string;
	address: string;
	foursquare_id?: string;
	foursquare_type?: string;
	google_place_id?: string;
	google_place_type?: string;
}

export interface Contact {
	phone_number: string;
	first_name: string;
	last_name?: string;
	vcard?: string;
	user_id?: number;
}

export interface Dice {
	emoji: string;
	value: number;
}

export interface PollOption {
	text: string;
	voter_count: number;
}

export interface Poll {
	id: string;
	question: string;
	options: PollOption[];
	total_voter_count: number;
	is_closed: boolean;
	is_anonymous: boolean;
	type: "regular" | "quiz";
	allows_multiple_answers: boolean;
	correct_option_id?: number;
}

// ── Inline Keyboard ─────────────────────────────────────────────────────────

export interface InlineKeyboardButton {
	text: string;
	url?: string;
	callback_data?: string;
	/** 1-64 bytes */
	pay?: boolean;
	web_app?: { url: string };
	icon_custom_emoji_id?: string;
	style?: string;
}

export interface InlineKeyboardMarkup {
	inline_keyboard: InlineKeyboardButton[][];
}

// ── Reply Parameters ────────────────────────────────────────────────────────

export interface ReplyParameters {
	message_id: number;
	chat_id?: number | string;
	allow_sending_without_reply?: boolean;
	quote?: string;
	quote_parse_mode?: string;
}

// ── Link Preview ─────────────────────────────────────────────────────────────

export interface LinkPreviewOptions {
	is_disabled?: boolean;
	url?: string;
	prefer_small_media?: boolean;
	prefer_large_media?: boolean;
	show_above_text?: boolean;
}

// ── Message ──────────────────────────────────────────────────────────────────

export interface Message {
	message_id: number;
	message_thread_id?: number;
	from?: User;
	sender_chat?: Chat;
	date: number;
	chat: Chat;
	forward_origin?: MessageOrigin;
	reply_to_message?: Message;
	edit_date?: number;
	text?: string;
	entities?: MessageEntity[];
	/** Link preview options */
	link_preview_options?: LinkPreviewOptions;
	/** Media fields — at most one is set */
	photo?: PhotoSize[];
	document?: Document;
	voice?: Voice;
	audio?: Audio;
	video?: Video;
	sticker?: Sticker;
	video_note?: VideoNote;
	animation?: { file_id: string; file_unique_id: string; width: number; height: number; duration: number; file_name?: string; mime_type?: string; file_size?: number };
	caption?: string;
	caption_entities?: MessageEntity[];
	/** Data-only messages (no file download) */
	location?: Location;
	venue?: Venue;
	contact?: Contact;
	dice?: Dice;
	poll?: Poll;
	/** Service messages */
	new_chat_members?: User[];
	left_chat_member?: User;
	group_chat_created?: true;
	supergroup_chat_created?: true;
	/** Forum topic service messages (Bot API 9.4+) */
	forum_topic_created?: ForumTopicCreated;
	forum_topic_edited?: ForumTopicEdited;
	forum_topic_closed?: true;
	forum_topic_reopened?: true;
	general_forum_topic_hidden?: true;
	general_forum_topic_unhidden?: true;
	/** True if the message is sent to a forum topic. */
	is_topic_message?: boolean;
	/** Guest mode (Bot API 10.0) */
	guest_query_id?: string;
	guest_bot_caller_user?: User;
	guest_bot_caller_chat?: Chat;
	/** Inline keyboard attached to this message */
	reply_markup?: InlineKeyboardMarkup;
}

export interface MessageOrigin {
	type: "user" | "hidden_user" | "chat" | "channel";
	date: number;
	user?: User;
	sender_user_name?: string;
	chat?: Chat;
}

// ── Callback Query ───────────────────────────────────────────────────────────

export interface CallbackQuery {
	id: string;
	from: User;
	message?: Message;
	inline_message_id?: string;
	chat_instance: string;
	data?: string;
	game_short_name?: string;
}

// ── Chat Member ──────────────────────────────────────────────────────────────

export interface ChatMemberUpdated {
	chat: Chat;
	from: User;
	date: number;
	old_chat_member: ChatMember;
	new_chat_member: ChatMember;
}

export interface ChatMember {
	user: User;
	status: "creator" | "administrator" | "member" | "restricted" | "left" | "kicked";
}

// ── Updates ──────────────────────────────────────────────────────────────────

export interface Update {
	update_id: number;
	message?: Message;
	edited_message?: Message;
	channel_post?: Message;
	edited_channel_post?: Message;
	guest_message?: Message;
	callback_query?: CallbackQuery;
	my_chat_member?: ChatMemberUpdated;
	message_reaction?: MessageReactionUpdated;
	inline_query?: unknown;
	chosen_inline_result?: unknown;
}

export interface MessageReactionUpdated {
	chat: Chat;
	message_id: number;
	user?: User;
	actor_chat?: Chat;
	date: number;
	old_reaction: ReactionType[];
	new_reaction: ReactionType[];
}

// ── API Response ─────────────────────────────────────────────────────────────

export interface TelegramApiResponse<T> {
	ok: boolean;
	result?: T;
	description?: string;
	error_code?: number;
	parameters?: {
		migrate_to_chat_id?: number;
		retry_after?: number;
	};
}

// ── getMe ────────────────────────────────────────────────────────────────────

export interface BotUser extends User {
	can_join_groups?: boolean;
	can_read_all_group_messages?: boolean;
	supports_inline_queries?: boolean;
	supports_guest_queries?: boolean;
	can_connect_to_business?: boolean;
	/** True if the bot has forum topic mode enabled in private chats. Bot API 9.4+. */
	has_topics_enabled?: boolean;
	/** True if the bot allows users to create and delete topics in private chats. Bot API 9.4+. */
	allows_users_to_create_topics?: boolean;
}

// ── Forum Topic ──────────────────────────────────────────────────────────────

export interface ForumTopic {
	/** Unique identifier of the forum topic. */
	message_thread_id: number;
	/** Name of the topic. */
	name: string;
	/** Color of the topic icon in RGB format. */
	icon_color?: number;
	/** Unique identifier of the custom emoji shown as the topic icon. */
	icon_custom_emoji_id?: string;
	/** True if the name wasn't specified explicitly and likely needs changing. */
	is_name_implicit?: true;
}

/** Service message: forum topic created. */
export interface ForumTopicCreated {
	name: string;
	icon_color?: number;
	icon_custom_emoji_id?: string;
	is_name_implicit?: true;
}

/** Service message: forum topic edited. */
export interface ForumTopicEdited {
	name?: string;
	icon_custom_emoji_id?: string;
}

// ── sendMessage result ───────────────────────────────────────────────────────

export type SendMessageResult = Message;

// ── Config ───────────────────────────────────────────────────────────────────

// ── Media Processing ────────────────────────────────────────────────────────

/** Supported media processing API formats. */
export type MediaApiType = "openai-stt" | "openai-chat" | "bash";

/** Configuration for processing a Telegram media type.
 *  Each key in TelegramConfig.media maps a Telegram message field
 *  (voice, photo, document, etc.) to a MediaProcessor. */
export interface MediaProcessor {
	/** API endpoint URL (not used by bash mode). */
	url?: string;
	/** Request/response format. */
	api: MediaApiType;
	/** Model name (used by openai-stt and openai-chat). */
	model?: string;
	/** API key for authentication (sent as Bearer token). */
	api_key?: string;
	/** Prompt for vision/audio description (used by openai-chat). */
	prompt?: string;
	/** Shell command template for script mode. {file} is replaced with the downloaded file path. */
	command?: string;
	/** Timeout in milliseconds. Defaults to 30000. */
	timeout?: number;
}

/** Telegram message types that can have media processors. */
export type MediaType = "voice" | "audio" | "photo" | "sticker" | "video" | "video_note" | "animation" | "document";

// ── Config ────────────────────────────────────────────────────────────────────

export interface TelegramConfig {
	botToken?: string;
	allowedUserId?: number;
	/** Whether to use forum topics for per-session routing.
	 *  When true (default), creates a topic per Pi session if the bot supports it.
	 *  Set to false to disable topics even if the bot supports them. */
	topics?: boolean;
	/** Media processors keyed by Telegram message type.
	 *  null = explicitly disabled; absent = not configured (same effect: placeholder message). */
	media?: Partial<Record<MediaType, MediaProcessor | null>>;
}
