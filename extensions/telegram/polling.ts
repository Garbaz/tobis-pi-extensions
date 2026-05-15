// ── Telegram Long Polling ────────────────────────────────────────────────────
// AbortController-based polling loop for getUpdates.

import type { TelegramApi } from "./api.js";
import type { Update } from "./types.js";

/** Update types we subscribe to. Keep minimal — reduces traffic. */
const ALLOWED_UPDATES = ["message", "edited_message", "callback_query", "my_chat_member"] as const;

/** Long-poll timeout in seconds. Must be positive; 0 = short polling (test only). */
const POLL_TIMEOUT = 30;

/** Max updates per getUpdates call. */
const POLL_LIMIT = 100;

export interface PollingCallbacks {
	/** Called for each update received. */
	onUpdate: (update: Update) => void | Promise<void>;
	/** Called on unrecoverable polling error (e.g., invalid token). */
	onError: (error: Error) => void;
	/** Called when polling starts. */
	onStart?: () => void;
	/** Called when polling stops cleanly. */
	onStop?: () => void;
}

export class TelegramPolling {
	private api: TelegramApi;
	private callbacks: PollingCallbacks;
	private abortController: AbortController | undefined;
	private pollingPromise: Promise<void> | undefined;
	private running = false;

	constructor(api: TelegramApi, callbacks: PollingCallbacks) {
		this.api = api;
		this.callbacks = callbacks;
	}

	/** Whether the polling loop is currently running. */
	isRunning(): boolean {
		return this.running;
	}

	/** Start polling. If already running, this is a no-op. */
	start(lastUpdateId?: number): void {
		if (this.running) return;
		this.running = true;
		this.abortController = new AbortController();
		this.pollingPromise = this.pollLoop(lastUpdateId ?? 0);
		this.callbacks.onStart?.();
	}

	/** Stop polling. Returns a promise that resolves when the loop exits. */
	async stop(): Promise<void> {
		if (!this.running) return;
		this.running = false;
		this.abortController?.abort();
		try {
			await this.pollingPromise;
		} catch {
			// AbortError is expected
		}
		this.abortController = undefined;
		this.pollingPromise = undefined;
		this.callbacks.onStop?.();
	}

	private async pollLoop(initialOffset: number): Promise<void> {
		let offset = initialOffset;

		while (this.running) {
			try {
				const updates = await this.api.getUpdates(
					{
						offset: offset > 0 ? offset : undefined,
						limit: POLL_LIMIT,
						timeout: POLL_TIMEOUT,
						allowed_updates: [...ALLOWED_UPDATES],
					},
					this.abortController?.signal,
				);

				for (const update of updates) {
					// Confirm update by setting offset = update_id + 1
					offset = update.update_id + 1;

					try {
						await this.callbacks.onUpdate(update);
					} catch (err) {
						// Log but don't crash the loop — individual update handlers
						// should not break polling
						console.error(`[telegram] Error handling update ${update.update_id}:`, err);
					}
				}
			} catch (err) {
				if (!this.running) break; // Aborted — expected

				if (err instanceof DOMException && err.name === "AbortError") break;

				const message = err instanceof Error ? err.message : String(err);
				console.error(`[telegram] Polling error: ${message}`);

				// Unrecoverable errors
				if (message.includes("401") || message.includes("Unauthorized")) {
					this.callbacks.onError(err instanceof Error ? err : new Error(message));
					break;
				}

				// Backoff on transient errors before retrying
				await sleep(3000);
				if (!this.running) break;
			}
		}
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
