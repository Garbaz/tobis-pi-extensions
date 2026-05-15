// ── Telegram Action Tools ────────────────────────────────────────────────────
// Registered as Pi tools so the agent can send files via Telegram.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TelegramApi } from "./api.js";
import type { TelegramBridge } from "./bridge.js";

/** Register all Telegram action tools with Pi. */
export function registerTools(pi: ExtensionAPI, api: TelegramApi, bridge: TelegramBridge | undefined): void {
	// ── telegram_send_file ───────────────────────────────────────────────────
	// Queue files to be sent as attachments with the next response.

	pi.registerTool({
		name: "telegram_send_file",
		description: "Send files to the Telegram chat. Use this to deliver files (code, images, documents) directly to the user's Telegram conversation.",
		parameters: {
			type: "object",
			properties: {
				paths: {
					type: "array",
					items: { type: "string" },
					description: "File paths to attach",
				},
			},
			required: ["paths"],
		} as const,
		label: "Telegram Attach",
		execute: async (_toolCallId: string, params: { paths: string[] }, _signal: AbortSignal | undefined, _onUpdate: unknown, _ctx: ExtensionContext) => {
			// TODO: implement file attachment queue
			return {
				content: [{ type: "text" as const, text: `Queued ${params.paths.length} file(s) for Telegram attachment. (Not yet implemented)` }],
				details: undefined as unknown,
			};
		},
	});
}
