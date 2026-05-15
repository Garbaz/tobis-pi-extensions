// ── Telegram Extension Config ────────────────────────────────────────────────
// Reads/writes config at ~/.pi/agent/extensions/pi-tobis-extensions/telegram.json
//
// Config = user-editable persistent settings (botToken, allowedUserId, media).
// State  = runtime cursor that changes on every message (lastUpdateId).
// Keeping them separate prevents the session from clobbering hand-edited config.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { TelegramConfig, MediaProcessor, MediaType } from "./types.js";

const CONFIG_DIR = join(homedir(), ".pi", "agent", "extensions", "pi-tobis-extensions");
const CONFIG_PATH = join(CONFIG_DIR, "telegram.json");

const DEFAULT_CONFIG: TelegramConfig = {
	botToken: undefined,
	allowedUserId: undefined,
	media: {
		voice: {
			url: "http://localhost:9000/v1/audio/transcriptions",
			api: "openai-stt",
			model: "whisper-1",
			timeout: 30000,
		},
	},
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

// ── Config (user-editable settings) ──────────────────────────────────────────

/** Read config from disk. Returns defaults if file doesn't exist. */
export async function readConfig(): Promise<TelegramConfig> {
	try {
		const raw = JSON.parse(await readFile(CONFIG_PATH, "utf8"));
		migrateLegacyConfig(raw);
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
// MOVED to relay.ts — state file now lives in ~/.pi/run/telegram/state.json
// Re-exported for backward compatibility.

export { readLastUpdateId, saveLastUpdateId, STATE_PATH } from "./relay.js";
