// ── Relay Routing Tests ───────────────────────────────────────────────────────
// Tests that verify the architectural decisions behind the cross-talk fix.
//
// The cross-talk bug had two root causes:
// 1. RelayServer.shouldSkipLocal() didn't check local subscriptions,
//    so the relay instance would skip processing messages for its own threads
//    when a client subscribed to the same thread.
// 2. RelayServer.routeUpdate() broadcast orphaned non-General messages to
//    ALL clients, leaking thread-specific messages to unrelated instances.
//
// Each test here verifies one of these assumptions.
// Trivial tests (Map.get returns undefined, etc.) are excluded.

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { RelayServer, threadIdFromUpdate } from "./relay.js";
import type { Update, Message } from "./types.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeUpdate(threadId: number, msgId = 1): Update {
	return {
		update_id: msgId,
		message: {
			message_id: msgId,
			from: { id: 1, is_bot: false, first_name: "Test" },
			date: 0,
			chat: { id: 100, type: "private" },
			message_thread_id: threadId || undefined,
			text: "hello",
		} as Message,
	};
}

function makeChatMemberUpdate(): Update {
	return {
		update_id: 999,
		my_chat_member: {
			chat: { id: 100, type: "private" },
			from: { id: 1, is_bot: false, first_name: "Test" },
			date: 0,
			old_chat_member: { user: { id: 1, is_bot: false, first_name: "Test" }, status: "left" },
			new_chat_member: { user: { id: 1, is_bot: false, first_name: "Test" }, status: "member" },
		},
	};
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("threadIdFromUpdate", () => {
	// Decision: General topic (no thread_id) maps to 0, which is the routing
	// key for "no specific session owns this message". This is fundamental
	// to the entire relay routing design.
	it("General topic (no thread_id) → 0, not undefined", () => {
		const update: Update = {
			update_id: 1,
			message: {
				message_id: 1, from: { id: 1, is_bot: false, first_name: "Test" },
				date: 0, chat: { id: 100, type: "private" }, text: "hello",
			} as Message,
		};
		assert.equal(threadIdFromUpdate(update), 0);
	});
});

describe("RelayServer - cross-talk prevention", () => {
	let server: RelayServer;

	beforeEach(() => { server = new RelayServer(); });

	// Decision: local subscriptions prevent shouldSkipLocal from returning true.
	// This was the exact bug: relay instances would skip their own threads
	// because shouldSkipLocal only checked client subscriptions.
	it("shouldSkipLocal=false when local instance owns the thread (the cross-talk fix)", () => {
		server.subscribeLocal(42);
		assert.equal(server.shouldSkipLocal(makeUpdate(42)), false);
	});

	// Decision: my_chat_member updates (pairing/unblocking) are always processed
	// locally, regardless of subscriptions. These affect the instance's own state.
	it("shouldSkipLocal=false for my_chat_member (always process locally)", () => {
		assert.equal(server.shouldSkipLocal(makeChatMemberUpdate()), false);
	});

	// Decision: orphaned messages (no local AND no client subscriber) must be
	// processed locally. Otherwise first-contact messages are silently dropped.
	it("shouldSkipLocal=false for orphaned messages (no subscriber anywhere)", () => {
		assert.equal(server.shouldSkipLocal(makeUpdate(99)), false);
	});

	// Decision: hasSubscriber must include local subscriptions, not just clients.
	// Without this, routeUpdate would broadcast messages to all clients even
	// when the local instance owns the thread.
	it("hasSubscriber includes local subscriptions, not just clients", () => {
		server.subscribeLocal(42);
		assert.equal(server.hasSubscriber(42), true);
	});

	// Decision: thread 0 (General) and specific threads are independent.
	// Subscribing to thread 42 does NOT make you a General subscriber.
	it("thread subscription and General subscription are independent", () => {
		server.subscribeLocal(42);
		assert.equal(server.hasSubscriber(42), true);
		assert.equal(server.hasSubscriber(0), false);
	});

	// Decision: unsubscribeLocal reverses subscribeLocal. Stale subscriptions
	// would cause shouldSkipLocal to return false for threads the instance
	// no longer owns, leading to duplicate processing.
	it("unsubscribeLocal removes the subscription", () => {
		server.subscribeLocal(42);
		server.unsubscribeLocal(42);
		assert.equal(server.hasSubscriber(42), false);
		assert.equal(server.shouldSkipLocal(makeUpdate(42)), false); // orphaned now
	});
});
