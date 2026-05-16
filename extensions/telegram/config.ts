// ── Telegram Extension Config ────────────────────────────────────────────────
// Reads/writes config at <agentDir>/extensions/pi-tobis-extensions/telegram.json
// and runtime state at <agentDir>/run/telegram/state.json.
// All paths derived from pi's getAgentDir() — see paths.ts.
//
// Config = user-editable persistent settings (botToken, allowedUserId, media).
// State  = runtime cursor that changes on every message (lastUpdateId).
// Keeping them separate prevents the session from clobbering hand-edited config.
//
// Schema validation: telegram.schema.json is the single source of truth.
// TypeBox Value.Check/Default/Errors provide runtime validation.
// Semantic validation (bash {file} placeholder, API url/model) is separate.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import type { TelegramConfig, MediaProcessor, MediaType } from "./types.js";
import { checkConfig, applyDefaults, validateConfig as schemaValidate, configSchema } from "./schema.js";
import { CONFIG_DIR, CONFIG_PATH, STATE_PATH, ensureRunDir } from "./paths.js";
import { createLogger } from "./log.js";
const log = createLogger("config");

const DEFAULT_CONFIG: TelegramConfig = {
	botToken: undefined,
	allowedUserId: undefined,
	whitelist: undefined,
	blacklist: undefined,
};

// ── Migration Helpers ────────────────────────────────────────────────────────

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

/** Run all migrations and sanitization on a raw config object. */
function migrateAndClean(raw: Record<string, unknown>): void {
	migrateLegacyConfig(raw);
	migrateWhitelist(raw);
	stripRuntimeFields(raw);
}

// ── Config (user-editable settings) ──────────────────────────────────────────

/** Read config from disk. Applies schema defaults and migrations.
 *  Returns warnings for schema violations (never throws on bad config). */
export async function readConfig(): Promise<TelegramConfig> {
	let raw: Record<string, unknown>;
	try {
		raw = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
	} catch {
		return { ...DEFAULT_CONFIG };
	}

	migrateAndClean(raw);

	// Apply schema defaults (e.g. topics: true)
	const withDefaults = applyDefaults(raw) as Record<string, unknown>;

	// Validate against schema and collect warnings
	const errors = schemaValidate(withDefaults);
	if (errors.length > 0) {
		// Check for additional properties and include the key names
		const allowedKeys = new Set(Object.keys((configSchema as { properties?: Record<string, unknown> }).properties ?? {}));
		const extraKeys = Object.keys(withDefaults).filter((k) => !allowedKeys.has(k) && !k.startsWith('$'));
		if (extraKeys.length > 0) {
			log.warn({ extraKeys }, "config: unknown keys will be ignored");
			for (const key of extraKeys) {
				delete withDefaults[key];
			}
		}
		for (const err of errors.filter((e) => !e.includes("additional properties"))) {
			log.warn({ error: err }, "config: validation warning");
		}
	}

	return { ...DEFAULT_CONFIG, ...withDefaults };
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
// Persisted to <agentDir>/run/telegram/state.json, separate from user config.
// The lastUpdateId is a volatile polling cursor - it changes on every message
// and should never be mixed into the user-editable config file.

/** Read lastUpdateId from state file. Returns undefined if no state exists. */
export async function readLastUpdateId(): Promise<number | undefined> {
	await ensureRunDir();
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

// ── Semantic Validation ──────────────────────────────────────────────────────
// Schema validation checks types/structure. Semantic validation checks that
// the config values make sense (e.g. bash commands contain {file}).

/** Validate media processor config at load time.
 *  Checks that bash processors have a command template containing {file},
 *  and that API processors have url or model configured.
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

// ── Auth Helpers ──────────────────────────────────────────────────────────────

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
