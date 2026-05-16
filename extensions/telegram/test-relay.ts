// ── Relay Routing Tests ───────────────────────────────────────────────────────
//
// Architecture decisions verified:
//
//   D1: The relay instance must not skip locally-owned threads just because a
//       client also subscribes. Without local subscription tracking, the relay
//       would silently drop its own messages (the original cross-talk bug).
//
//   D2: my_chat_member updates (pairing/unblocking) are always processed locally
//       AND broadcast to all clients. These affect instance-level auth state.
//
//   D3: Orphaned messages (no local AND no client subscriber) must be processed
//       locally. Otherwise first-contact messages are silently dropped.
//
//   D4: hasSubscriber must include local subscriptions, not just clients.
//       Without this, routeUpdate would broadcast messages to all clients even
//       when the local instance owns the thread.
//
//   D5: Thread subscriptions and General subscriptions are independent.
//       Subscribing to thread 42 does NOT make you a General subscriber.
//
//   D6: routeUpdate for my_chat_member always broadcasts to ALL clients,
//       regardless of subscriptions. Auth changes affect every instance.
//
//   D7: routeUpdate for orphaned messages (no subscriber at all) broadcasts
//       to all clients. This handles first-contact/pairing scenarios.
//
//   D8: routeUpdate for a thread with a client subscriber routes only to
//       that client, not to all. Thread-specific messages don't leak.
//
//   D9: General topic (no message_thread_id) maps to threadId 0, not
//       undefined. This is the routing key for "no specific session owns
//       this message" and drives the General echo behavior.

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
			chat: { id: 100, type: "supergroup" },
			message_thread_id: threadId || undefined,
			text: "hello",
		} as Message,
	};
}

function makeChatMemberUpdate(): Update {
	return {
		update_id: 999,
		my_chat_member: {
			chat: { id: 100, type: "supergroup" },
			from: { id: 1, is_bot: false, first_name: "Test" },
			date: 0,
			old_chat_member: { user: { id: 1, is_bot: false, first_name: "Test" }, status: "left" },
			new_chat_member: { user: { id: 1, is_bot: false, first_name: "Test" }, status: "member" },
		},
	};
}

/** Create a mock client socket that records sent messages. */
function createMockClient(): { socket: any; sent: any[] } {
	const sent: any[] = [];
	const socket = {
		write: (data: string) => { sent.push(...data.split("\n").filter(Boolean).map((l) => JSON.parse(l))); },
		on: () => {},
		destroy: () => {},
	};
	return { socket, sent };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("threadIdFromUpdate", () => {
	// D9: General topic (no thread_id) maps to 0, which is the routing key
	// for "no specific session owns this message". If this returned undefined,
	// General messages would be silently dropped instead of routed to the
	// active session.
	it("General topic (no thread_id) → 0, not undefined", () => {
		const update: Update = {
			update_id: 1,
			message: {
				message_id: 1, from: { id: 1, is_bot: false, first_name: "Test" },
				date: 0, chat: { id: 100, type: "supergroup" }, text: "hello",
			} as Message,
		};
		assert.equal(threadIdFromUpdate(update), 0);
	});
});

describe("RelayServer - cross-talk prevention", () => {
	let server: RelayServer;

	beforeEach(() => { server = new RelayServer(); });

	// D1: shouldSkipLocal must check local subscriptions. The original cross-talk
	// bug was: relay instance skipped its own threads because shouldSkipLocal
	// only checked client subscriptions. A client subscribing to the same thread
	// would cause the relay to drop the message.
	it("shouldSkipLocal=false when local instance owns the thread", () => {
		server.subscribeLocal(42);
		assert.equal(server.shouldSkipLocal(makeUpdate(42)), false);
	});

	// D2: my_chat_member updates (pairing/unblocking) affect instance-level auth
	// state. They must always be processed locally, even if a client subscribes
	// to the same chat.
	it("shouldSkipLocal=false for my_chat_member (always process locally)", () => {
		assert.equal(server.shouldSkipLocal(makeChatMemberUpdate()), false);
	});

	// D3: If no subscriber (client or local) owns a thread, the relay must
	// process the message locally. Otherwise first-contact messages from
	// unknown users are silently dropped.
	it("shouldSkipLocal=false for orphaned messages (no subscriber anywhere)", () => {
		assert.equal(server.shouldSkipLocal(makeUpdate(99)), false);
	});

	// D4: hasSubscriber must include local subscriptions. If it only checked
	// clients, the relay would think a thread has no owner and broadcast
	// thread-specific messages to all clients.
	it("hasSubscriber includes local subscriptions, not just clients", () => {
		server.subscribeLocal(42);
		assert.equal(server.hasSubscriber(42), true);
	});

	// D5: Subscribing to thread 42 does NOT subscribe to General (threadId 0).
	// These are independent subscription channels. If they were coupled, a
	// thread-specific subscriber would receive all General messages.
	it("thread subscription and General subscription are independent", () => {
		server.subscribeLocal(42);
		assert.equal(server.hasSubscriber(42), true);
		assert.equal(server.hasSubscriber(0), false);
	});

	// D1 (reverse): unsubscribeLocal must remove the subscription so that
	// shouldSkipLocal behaves correctly after session shutdown.
	it("unsubscribeLocal removes the subscription", () => {
		server.subscribeLocal(42);
		server.unsubscribeLocal(42);
		assert.equal(server.hasSubscriber(42), false);
		assert.equal(server.shouldSkipLocal(makeUpdate(42)), false); // orphaned now
	});

	// D6: my_chat_member updates are broadcast to ALL clients regardless of
	// subscriptions. Auth changes (pairing, unblocking) affect every instance.
	it("routeUpdate broadcasts my_chat_member to all clients", () => {
		const client1 = createMockClient();
		const client2 = createMockClient();
		// Manually inject mock clients into the server
		(server as any).clients.set(client1.socket, {
			socket: client1.socket,
			subscriptions: new Map(),
			subscribedGeneral: false,
		});
		(server as any).clients.set(client2.socket, {
			socket: client2.socket,
			subscriptions: new Map(),
			subscribedGeneral: false,
		});

		server.routeUpdate(makeChatMemberUpdate());

		const updates1 = client1.sent.filter((m) => m.type === "update");
		const updates2 = client2.sent.filter((m) => m.type === "update");
		assert.equal(updates1.length, 1, "client 1 should receive my_chat_member");
		assert.equal(updates2.length, 1, "client 2 should receive my_chat_member");
	});

	// D7: Messages with no subscriber at all (no client, no local) are
	// broadcast to all clients. This handles the first-contact scenario where
	// an unknown user sends a message to the bot.
	it("routeUpdate broadcasts orphaned messages to all clients", () => {
		const client1 = createMockClient();
		const client2 = createMockClient();
		(server as any).clients.set(client1.socket, {
			socket: client1.socket,
			subscriptions: new Map([[10, "sess-a"]]),
			subscribedGeneral: false,
		});
		(server as any).clients.set(client2.socket, {
			socket: client2.socket,
			subscriptions: new Map([[20, "sess-b"]]),
			subscribedGeneral: false,
		});
		// Thread 99 has no client subscriber and no local subscriber
		server.routeUpdate(makeUpdate(99));

		const updates1 = client1.sent.filter((m) => m.type === "update");
		const updates2 = client2.sent.filter((m) => m.type === "update");
		assert.equal(updates1.length, 1, "orphaned message broadcast to client 1");
		assert.equal(updates2.length, 1, "orphaned message broadcast to client 2");
	});

	// D8: When a client subscribes to a thread, routeUpdate sends to that
	// client only, not all clients. Thread-specific messages must not leak.
	it("routeUpdate routes thread-specific messages to subscriber only", () => {
		const subscriber = createMockClient();
		const other = createMockClient();
		(server as any).clients.set(subscriber.socket, {
			socket: subscriber.socket,
			subscriptions: new Map([[42, "sess-1"]]),
			subscribedGeneral: false,
		});
		(server as any).clients.set(other.socket, {
			socket: other.socket,
			subscriptions: new Map([[99, "sess-2"]]),
			subscribedGeneral: false,
		});

		server.routeUpdate(makeUpdate(42));

		const subscriberUpdates = subscriber.sent.filter((m) => m.type === "update");
		const otherUpdates = other.sent.filter((m) => m.type === "update");
		assert.equal(subscriberUpdates.length, 1, "subscriber receives the message");
		assert.equal(otherUpdates.length, 0, "non-subscriber does not receive the message");
	});
});
