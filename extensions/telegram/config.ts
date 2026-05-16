// ── Telegram Extension Config ────────────────────────────────────────────────
// Reads/writes config at ~/.pi/agent/extensions/pi-tobis-extensions/telegram.json
// and runtime state at ~/.pi/run/telegram/state.json.
//
// Config = user-editable persistent settings (botToken, allowedUserId, media).
// State  = runtime cursor that changes on every message (lastUpdateId).
// Keeping them separate prevents the session from clobbering hand-edited config.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import type { TelegramConfig, MediaProcessor, MediaType } from "./types.js";
import { ensureRunDir, RUN_DIR } from "./relay-lock.js";

const CONFIG_DIR = join(homedir(), ".pi", "agent", "extensions", "pi-tobis-extensions");
const CONFIG_PATH = join(CONFIG_DIR, "telegram.json");

/** Path to the runtime state file (~/.pi/run/telegram/state.json). */
export const STATE_PATH = join(RUN_DIR, "state.json");

/** Legacy state path (pre-relay, in /tmp). Used for migration. */
const OLD_STATE_PATH = join(tmpdir(), "pi-telegram-state.json");

const DEFAULT_CONFIG: TelegramConfig = {
	botToken: undefined,
	allowedUserId: undefined,
	whitelist: undefined,
	blacklist: undefined,
};

/** Migrate legacy inboundHandlers format to media format. */
function migrateLegacyConfig(raw: Record<string, unknown>): void {
	if (!raw.inboundHandlers || raw.media) return;

	const media: Partial<Record<MediaType, MediaProcessor>> = {};
	for (const handler of raw.inboundHandlers as Array<{ type: string; template: string; timeout: number }>) {
		if (handler.type === "voice" || handler.type === "audio") {
			media[handler.type as MediaType] = {
				url: "",
				api: "bash",
				command: handler.template,
				timeout: handler.timeout,
			};
		}
	}
	raw.media = media;
	delete raw.inboundHandlers;
}

/** Strip runtime/state fields that should never be persisted in config. */
function stripRuntimeFields(obj: Record<string, unknown>): void {
	delete obj.botId;
	delete obj.botUsername;
	delete obj.proactivePush;
	delete obj.lastUpdateId;
}

/** Migrate config: allowedUserId → whitelist if no whitelist exists yet. */
function migrateWhitelist(raw: Record<string, unknown>): void {
	if (raw.whitelist || !raw.allowedUserId) return;
	raw.whitelist = [raw.allowedUserId];
}

// ── Config (user-editable settings) ──────────────────────────────────────────

/** Read config from disk. Returns defaults if file doesn't exist. */
export async function readConfig(): Promise<TelegramConfig> {
	try {
		const raw = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
		migrateLegacyConfig(raw);
		migrateWhitelist(raw);
		stripRuntimeFields(raw);
		return { ...DEFAULT_CONFIG, ...raw };
	} catch {
		return { ...DEFAULT_CONFIG };
	}
}

/** Persist a single config field. Reads current file, updates one key, writes back.
 *  This avoids clobbering external edits (e.g. user editing media processors). */
export async function saveConfigField<K extends keyof TelegramConfig>(key: K, value: TelegramConfig[K]): Promise<void> {
	await mkdir(CONFIG_DIR, { recursive: true });

	let onDisk: Record<string, unknown> = {};
	try {
		onDisk = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
	} catch {
		// File doesn't exist yet
	}

	stripRuntimeFields(onDisk);
	onDisk[key] = value;
	await writeFile(CONFIG_PATH, JSON.stringify(onDisk, null, "\t") + "\n", "utf8");
}

/** Write the full config. Used only for /telegram setup. Prefer saveConfigField for runtime. */
export async function writeConfig(config: TelegramConfig): Promise<void> {
	await mkdir(CONFIG_DIR, { recursive: true });
	stripRuntimeFields(config as Record<string, unknown>);
	await writeFile(CONFIG_PATH, JSON.stringify(config, null, "\t") + "\n", "utf8");
}

/** Update config partially and write. Used for /telegram setup. */
export async function updateConfig(partial: Partial<TelegramConfig>): Promise<TelegramConfig> {
	const current = await readConfig();
	const updated = { ...current, ...partial };
	await writeConfig(updated);
	return updated;
}

// ── State (runtime polling cursor) ───────────────────────────────────────────
// Persisted to ~/.pi/run/telegram/state.json, separate from user config.
// The lastUpdateId is a volatile polling cursor - it changes on every message
// and should never be mixed into the user-editable config file.

/** Migrate state file from /tmp to ~/.pi/run/telegram/ if the new location doesn't exist yet. */
async function migrateStateFile(): Promise<void> {
	try {
		await readFile(STATE_PATH, "utf8");
		return; // New location exists - no migration needed
	} catch {
		// New location doesn't exist - try to migrate from old location
	}
	try {
		const oldData = await readFile(OLD_STATE_PATH, "utf8");
		await writeFile(STATE_PATH, oldData, "utf8");
	} catch {
		// Old file doesn't exist either - nothing to migrate
	}
}

/** Read lastUpdateId from state file. Returns undefined if no state exists. */
export async function readLastUpdateId(): Promise<number | undefined> {
	await ensureRunDir();
	await migrateStateFile();
	try {
		const raw = JSON.parse(await readFile(STATE_PATH, "utf8"));
		return typeof raw.lastUpdateId === "number" ? raw.lastUpdateId : undefined;
	} catch {
		return undefined;
	}
}

/** Persist lastUpdateId to state file. */
export async function saveLastUpdateId(lastUpdateId: number): Promise<void> {
	await ensureRunDir();
	await writeFile(STATE_PATH, JSON.stringify({ lastUpdateId }, null, "\t") + "\n", "utf8");
}

// ── Auth Helpers ──────────────────────────────────────────────────────────────

/** Validate media processor config at load time.
 *  Checks that bash processors have a command template containing {file}.
 *  Returns an array of warning messages for invalid processors. */
export function validateMediaConfig(config: TelegramConfig): string[] {
	const warnings: string[] = [];
	if (!config.media) return warnings;

	for (const [type, processor] of Object.entries(config.media)) {
		if (!processor) continue;
		if (processor.api === "bash") {
			if (!processor.command) {
				warnings.push(`media.${type}: bash processor has no command configured`);
			} else if (!processor.command.includes("{file}")) {
				warnings.push(`media.${type}: bash command does not contain {file} placeholder - the media file path will not be passed to the script`);
			}
		}
		if (processor.api === "openai-stt" || processor.api === "openai-chat") {
			if (!processor.url && !processor.model) {
				warnings.push(`media.${type}: ${processor.api} processor has neither url nor model configured`);
			}
		}
	}
	return warnings;
}

/** Check if a user ID is authorized based on whitelist/blacklist/allowedUserId.
 *  - blacklisted → denied
 *  - whitelisted or matches allowedUserId → allowed
 *  - unknown → needs confirmation */
export function checkUserAuth(userId: number, config: TelegramConfig): "allowed" | "blocked" | "unknown" {
	const blacklist = config.blacklist ?? [];
	if (blacklist.includes(userId)) return "blocked";

	const whitelist = config.whitelist ?? [];
	if (whitelist.includes(userId)) return "allowed";

	if (config.allowedUserId === userId) return "allowed";

	return "unknown";
}

/** Add a user to the whitelist and save. */
export async function allowUser(userId: number): Promise<void> {
	const config = await readConfig();
	const whitelist = config.whitelist ?? [];
	if (!whitelist.includes(userId)) {
		whitelist.push(userId);
	}
	const blacklist = config.blacklist ?? [];
	const filteredBlacklist = blacklist.filter((id) => id !== userId);
	await saveConfigField("whitelist", whitelist);
	if (filteredBlacklist.length !== blacklist.length) {
		await saveConfigField("blacklist", filteredBlacklist);
	}
}

/** Add a user to the blacklist and save. */
export async function blockUser(userId: number): Promise<void> {
	const config = await readConfig();
	const blacklist = config.blacklist ?? [];
	if (!blacklist.includes(userId)) {
		blacklist.push(userId);
	}
	const whitelist = config.whitelist ?? [];
	const filteredWhitelist = whitelist.filter((id) => id !== userId);
	await saveConfigField("blacklist", blacklist);
	if (filteredWhitelist.length !== whitelist.length) {
		await saveConfigField("whitelist", filteredWhitelist);
	}
}
