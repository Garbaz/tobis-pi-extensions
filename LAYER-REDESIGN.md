# Layer Redesign Proposal

## Problem

The current code has three documented layers (Relay, Instance, Session) but the boundaries are blurred:

1. **Relay/Instance confusion**: `state.ts` mixes relay-layer fields (`isRelay`, `relayServer`, `relayClient`, `polling`, `lastUpdateId`) with instance-layer fields (`api`, `bridge`, `botUsername`, `config`, `pendingUsers`). The relay IS the instance when it wins the lock -- it's a role, not a separate process.

2. **Session state scattered**: `SessionState` holds `sessionId`/`sessionFile`/`topicRenamed`/`ctx`, but threadId/topicName lives in `TopicManager` (in-memory map), persistence lives in `TelegramSessionData` (topics.ts), and `bridge.ts` holds `outgoingBySession` + `currentSessionId`.

3. **Bridge is a god object**: `TelegramBridge` does incoming routing, outgoing dispatch, session registration, topic management delegation, callback dispatch, turn context tracking, and reaction tracking. Every module touches it.

4. **Relay routing is broken**: `localSubscriptions`/`localSubscribedGeneral` fields exist but have no population methods or routing logic. The General-subscriber fallback leaks non-General messages to all clients.

## Responsibilities Catalog

I traced every responsibility in the codebase and grouped them by nature:

### A. Telegram Bot API interaction (api.ts)
- Raw HTTP calls to Telegram Bot API
- Rate-limit retry (429)
- Multipart upload support
- **Layer: utility, used by all**

### B. Long polling (polling.ts)
- AbortController-based getUpdates loop
- Offset tracking, error handling, backoff
- **Layer: relay**

### C. Update distribution (relay.ts)
- Unix socket server for distributing updates to clients
- Unix socket client for receiving routed updates
- Wire protocol (JSON-lines: hello/sub/unsub/update/cursor/ping/pong/bye)
- Thread-based routing: each client subscribes to thread IDs
- Cursor broadcast for failover
- **Layer: relay**

### D. Relay election (relay-lock.ts)
- PID-file based lock acquisition
- Stale lock detection
- **Layer: relay**

### E. Relay failover (lifecycle.ts)
- On relay disconnect: try to acquire lock, become relay, or reconnect as client
- Re-subscribe all known sessions after failover
- **Layer: relay/instance boundary**

### F. Telegram connection lifecycle (lifecycle.ts)
- connect(): verify token, create bridge, start relay or client
- disconnect(): stop relay or client, clear runtime state
- shutdown(): full teardown for process exit
- **Layer: instance**

### G. Bot API client ownership (state.ts, lifecycle.ts)
- TelegramApi instance (one per process, created on connect)
- Bot username, topicsEnabled (from getMe())
- **Layer: instance**

### H. Auth model (incoming.ts, config.ts)
- User whitelist/blacklist/allowedUserId
- Pending user queue
- Auto-pairing on first message
- **Layer: instance**

### I. Incoming message processing (incoming.ts, bridge.ts)
- Auth check, command dispatch (/start, /model, /stop, /compact, /new, /status)
- Media download + processing
- Content formatting (text, media, location, etc.)
- Forwarding to pi.sendUserMessage()
- Callback query dispatch
- Chat member update handling
- **Layer: instance, but with session-scoped routing**

### J. Session-topic mapping (topics.ts, bridge.ts)
- In-memory sessionId <-> threadId mapping
- Topic CRUD (create, restore, rename, close, delete)
- Session data persistence (readSessionData/saveSessionFields)
- **Layer: session**

### K. Session lifecycle (index.ts, session.ts)
- session_start: auto-connect on resume/reload, create/restore topic, subscribe to relay
- session_shutdown: close topic, unsubscribe from relay, teardown (or not on quit -- bug)
- Topic naming from first message
- **Layer: session**

### L. Outgoing message handling (outgoing.ts, bridge.ts)
- Per-session OutgoingHandler (streaming preview, edit-in-place, tool progress)
- Message splitting, HTML formatting
- Reaction tracking (hourglass on user message, checkmark on completion)
- Typing indicator
- File queue (telegram_send_file tool)
- TUI echo
- **Layer: session** (one OutgoingHandler per session)

### M. Relay subscription management (bridge.ts, session.ts)
- When a session registers a topic: subscribe(threadId) on relay client
- When a session shuts down: unsubscribe(threadId)
- When the relay instance has its own session: subscribeLocal(threadId) on relay server
- **Layer: session/relay boundary**

### N. General topic routing (bridge.ts, incoming.ts)
- Messages in General topic (no thread_id) routed to "current" session
- Echo into session topic, reaction on original
- **Layer: instance, but touches session routing**

### O. System prompt injection (prompt.ts, bridge.ts, index.ts)
- before_agent_start: consume _lastTelegramContext, inject prompt suffix
- Turn context: username, content types, unprocessed media
- **Layer: session**

### P. Config I/O (config.ts)
- Read/write telegram.json
- Schema validation, migration, defaults
- read-merge-write pattern
- **Layer: instance**

### Q. Paths (paths.ts)
- All path constants derived from getAgentDir()
- **Layer: utility**

### R. Logging (log.ts)
- Pino-based structured logging
- Module child loggers
- **Layer: utility**

## Proposed Architecture: Two Layers + Utility

### Key Insight: The relay is a ROLE, not a layer

The current "three-layer" model is misleading. The relay is not a separate layer -- it's a role that one instance assumes. Every pi instance is an instance; some instances also serve as the relay poller. The relay server and client are IPC mechanisms, not architectural layers.

The real separation is:

```
┌─────────────────────────────────────────────────────┐
│                   INSTANCE LAYER                     │
│   Lifetime: process (pi start → pi quit)            │
│                                                     │
│   ┌───────────┐  ┌──────────┐  ┌──────────────┐   │
│   │ Connection │  │  Relay   │  │  Auth &      │   │
│   │ Manager    │  │  Role    │  │  Config      │   │
│   └───────────┘  └──────────┘  └──────────────┘   │
│                                                     │
│   ┌──────────────────────────────────────────────┐  │
│   │              Session Registry                 │  │
│   │   (threadId → sessionId, activeSession)       │  │
│   └──────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────┘
          │                    │
          │ owns               │ routes to
          ▼                    ▼
┌─────────────────────────────────────────────────────┐
│                    SESSION LAYER                      │
│   Lifetime: pi session (/new, /resume, /fork, etc.) │
│                                                     │
│   ┌────────────┐  ┌─────────────┐  ┌────────────┐  │
│   │  Incoming  │  │  Outgoing   │  │  Topic      │  │
│   │  Handler   │  │  Handler    │  │  Manager    │  │
│   └────────────┘  └─────────────┘  └────────────┘  │
│                                                     │
│   ┌──────────────────────────────────────────────┐  │
│   │           Session Data (persistent)           │  │
│   │   connected, threadId, topicName              │  │
│   └──────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────┘
```

### Instance Layer

Owns everything that survives across session changes within a single process.

**State (process-lifetime singleton):**
```typescript
interface InstanceState {
  // Connection
  api: TelegramApi | undefined;           // Bot API client (created on connect)
  botUsername: string | undefined;        // from getMe()
  topicsEnabled: boolean;                 // from getMe()

  // Relay role (this instance IS the relay when isRelay=true)
  isRelay: boolean;
  relayServer: RelayServer | undefined;   // only when isRelay
  relayClient: RelayClient | undefined;   // only when !isRelay
  polling: TelegramPolling | undefined;   // only when isRelay

  // Routing
  sessionRegistry: SessionRegistry;       // threadId ↔ sessionId mapping

  // Auth
  config: TelegramConfig;
  pendingUsers: Map<number, PendingUser>;

  // Extension API (set once during init)
  pi: ExtensionAPI | undefined;
}
```

**Modules:**

| Module | Responsibility | Depends on |
|--------|---------------|------------|
| `connection.ts` | connect/disconnect/shutdown lifecycle, relay election, failover | api, polling, relay, relay-lock, config, session-registry |
| `relay.ts` | Unix socket server/client, wire protocol, routing | (utility only) |
| `relay-lock.ts` | PID-file lock election | (utility only) |
| `polling.ts` | Long-polling loop | api |
| `auth.ts` (extract from incoming.ts) | User whitelist/blacklist/pending, auto-pairing | config, api |
| `config.ts` | Config I/O, validation, migration | paths |
| `session-registry.ts` | threadId↔sessionId mapping, active session, General routing | (pure data structure) |

**Key change: SessionRegistry replaces scattered routing state.**

Currently, threadId→sessionId mapping lives in `TopicManager`, outgoing handlers live in `bridge.ts`, and "current session" lives in `state.ts`. The `SessionRegistry` consolidates this:

```typescript
class SessionRegistry {
  // threadId → sessionId (for incoming message routing)
  private threadMap: Map<number, string>;
  // sessionId → session handle (for outgoing dispatch, topic info)
  private sessions: Map<string, SessionHandle>;

  register(sessionId: string, threadId: number, outgoing: OutgoingHandler): void;
  unregister(sessionId: string): void;
  getSessionByThread(threadId: number): SessionHandle | undefined;
  getActiveSession(): SessionHandle | undefined;
  setActive(sessionId: string): void;
  // General topic routing
  routeGeneral(threadId: number): SessionHandle | undefined;
}
```

### Session Layer

Owns everything tied to a specific pi session (created on session_start, destroyed on session_shutdown).

**State (per-session):**
```typescript
interface SessionHandle {
  sessionId: string;
  sessionFile: string | undefined;
  threadId: number | undefined;
  topicName: string | undefined;
  topicRenamed: boolean;
  outgoing: OutgoingHandler;
  ctx: ExtensionContext | undefined;    // refreshed by every event handler
}
```

**Modules:**

| Module | Responsibility | Depends on |
|--------|---------------|------------|
| `outgoing.ts` | Streaming preview, edit-in-place, tool progress, reactions, typing, file queue, TUI echo | api |
| `incoming.ts` | Command dispatch, media processing, content formatting, sendUserMessage | api, config, session-registry |
| `topics.ts` | Topic CRUD, session data persistence | api |
| `session-lifecycle.ts` | session_start/shutdown handlers, topic setup/teardown, relay subscription | connection, session-registry, topics |
| `prompt.ts` | System prompt suffix for Telegram turns | (pure function) |

**Key changes:**

1. **OutgoingHandler is per-session and self-contained.** It already is -- just needs to be owned by the SessionHandle, not by the bridge.

2. **Incoming handling is session-aware.** The incoming handler receives the target session from the registry (via threadId routing), not from bridge state. Commands like `/model`, `/stop` use the session's ctx.

3. **Topic persistence stays in topics.ts** but TopicManager becomes instance-scoped (one per chat, manages the Telegram API calls). The threadId↔sessionId mapping moves to SessionRegistry.

4. **No more "bridge" god object.** The bridge is dissolved. Its responsibilities move to:
   - Incoming routing → SessionRegistry + incoming handler
   - Outgoing dispatch → OutgoingHandler (per-session, already self-contained)
   - Session registration → SessionRegistry
   - Topic management → TopicManager (instance-scoped)
   - Turn context → SessionHandle
   - Callback dispatch → Instance layer (or a simple registry)

### Relay Role

The relay is a role the instance assumes when it wins the lock. It's not a separate layer.

**When this instance is the relay:**
- It owns the `TelegramPolling` loop
- It owns the `RelayServer` (distributes updates to clients)
- It processes updates locally via `shouldSkipLocal()` -- only for threads it owns
- It subscribes its own sessions to `localSubscriptions` on the relay server

**When this instance is a client:**
- It owns a `RelayClient` (receives routed updates)
- It subscribes its sessions via `client.subscribe(threadId, sessionId)`
- It saves cursors from the relay for failover

**Relay subscription flow (the fix for the cross-talk bug):**

```
session_start → register in SessionRegistry → subscribe to relay
  if isRelay: relayServer.subscribeLocal(threadId)
  if !isRelay: relayClient.subscribe(threadId, sessionId)

session_shutdown → unregister from SessionRegistry → unsubscribe from relay
  if isRelay: relayServer.unsubscribeLocal(threadId)
  if !isRelay: relayClient.unsubscribe(threadId)
```

**Routing logic (in RelayServer.routeUpdate):**

```
1. my_chat_member → broadcast to ALL clients + process locally
2. threadId matches a client subscription → route to that client
3. threadId matches localSubscriptions → process locally (don't forward)
4. threadId === 0 (General) → route to General subscribers + process locally if localSubscribedGeneral
5. No subscriber → broadcast to all (first message / pairing scenario)
```

**Relay failover:**

On relay disconnect, clients attempt to acquire the lock. Current approach (fixed backoff) has a minor race risk. Proposed improvement: **random jitter** -- each client waits `baseDelay * (1 + Math.random())` before attempting to acquire the lock, reducing the chance of two clients racing.

### Surface Area Between Layers

The key design constraint is **minimal surface area** between instance and session layers:

| Direction | Interface | Description |
|-----------|-----------|-------------|
| Session → Instance | `SessionRegistry` | Register/unregister sessions, look up by threadId, get active session |
| Session → Instance | `ConnectionState` | Is telegram connected? Is this instance the relay? Get API client |
| Instance → Session | `SessionHandle.outgoing` | Dispatch outgoing events (agent_end, message_update, etc.) |
| Instance → Session | `SessionHandle.ctx` | Execute commands (/model, /stop) |
| Session → Relay | `subscribe(threadId)` / `unsubscribe(threadId)` | Subscribe to updates for a thread |
| Relay → Instance | `routeUpdate(update)` | Distribute incoming updates |

**What DOES NOT cross the boundary:**
- Session never directly accesses `RelayServer` or `RelayClient`
- Session never directly accesses `TelegramPolling`
- Instance never directly manages `OutgoingHandler` internals
- Config is read at instance level, passed down (not accessed directly by sessions)

### Dissolving the Bridge

The `TelegramBridge` class currently has these methods/responsibilities:

| Current method | Moves to |
|----------------|----------|
| `handleUpdate()` | `IncomingHandler` (new, per-update function) |
| `consumeTelegramContext()` | `SessionHandle` field |
| `registerSession()` | `SessionRegistry.register()` + `TopicManager.createTopic()` |
| `restoreSession()` | `SessionRegistry.register()` + `TopicManager.restoreSession()` |
| `unregisterSession()` | `SessionRegistry.unregister()` + `TopicManager.closeTopic()` |
| `activateSession()` | `SessionRegistry.setActive()` |
| `getOutgoing()` | `SessionRegistry.getActiveSession()?.outgoing` |
| `lockToChat()` / `unlock()` | Instance state (`activeChatId`) |
| `setTopicsEnabled()` | Instance state |
| `onAgentEnd()` | `SessionHandle.outgoing.onAgentEnd()` |
| `onMessageUpdate()` | `SessionHandle.outgoing.onMessageUpdate()` |
| `routeToSession()` | `SessionRegistry` + incoming handler |
| `trackUserMessage()` | `SessionHandle.outgoing.setLastUserMessage()` + `setReaction()` |
| `sendUserEcho()` | `SessionHandle.outgoing.sendUserEcho()` |
| `onToolExecutionStart/End()` | `SessionHandle.outgoing.onToolExecutionStart/End()` |
| `queueFile()` | `SessionHandle.outgoing.queueFile()` |
| `registerCallbackHandler()` | Instance-level callback registry |
| `dispatchCallbackQuery()` | Instance-level callback dispatch |

The bridge is completely dissolved. Its state moves to:
- `SessionRegistry` (session↔thread mapping, active session, outgoing dispatch)
- `SessionHandle` (turn context, outgoing handler)
- Instance state (activeChatId, topicsEnabled, callback handlers)

### File Map (proposed)

| File | Layer | Purpose |
|------|-------|---------|
| `api.ts` | utility | Telegram Bot API client |
| `paths.ts` | utility | Path constants |
| `log.ts` | utility | Pino logger factory |
| `formatting.ts` | utility | Message formatting helpers |
| `markdown.ts` | utility | HTML conversion, message splitting |
| `types.ts` | utility | Telegram API type definitions |
| `schema.ts` | utility | TypeBox config validation |
| `config.ts` | instance | Config I/O, validation, auth helpers |
| `auth.ts` | instance | User whitelist/blacklist/pending (extracted from incoming.ts) |
| `relay.ts` | instance | Unix socket server/client, wire protocol |
| `relay-lock.ts` | instance | PID-file lock election |
| `polling.ts` | instance | Long-polling loop |
| `connection.ts` | instance | connect/disconnect/shutdown, relay election/failover (extracted from lifecycle.ts) |
| `session-registry.ts` | instance | threadId↔sessionId mapping, active session, routing |
| `state.ts` | instance | InstanceState singleton (slimmed down) |
| `topics.ts` | instance+session | Topic CRUD (API calls = instance), session data persistence |
| `outgoing.ts` | session | Streaming, reactions, typing, file queue, TUI echo |
| `incoming.ts` | session | Command dispatch, media, content formatting, sendUserMessage |
| `session-lifecycle.ts` | session | Pi event handlers, topic setup/teardown, relay sub/unsub |
| `prompt.ts` | session | System prompt suffix |
| `tools.ts` | session | telegram_send_file tool |
| `media.ts` | session | Media download + processing |
| `index.ts` | entry | Extension factory: registers commands, events, tools |

### Migration Strategy

1. **Create `session-registry.ts`** -- extract threadId↔sessionId mapping from `TopicManager` + outgoing dispatch from `bridge.ts`. Wire it into `state.ts`.

2. **Create `connection.ts`** -- extract connect/disconnect/shutdown from `lifecycle.ts` (rename). Slim down `state.ts` to hold `InstanceState`.

3. **Extract `auth.ts`** -- pull `PendingUser`, `checkUserAuth`, `allowUser`, `blockUser`, pending user handling from `incoming.ts` and `state.ts`.

4. **Dissolve `bridge.ts`** -- move methods to `SessionRegistry`, `SessionHandle`, `incoming.ts`, instance state. Delete the file.

5. **Fix relay routing** -- add `subscribeLocal`/`unsubscribeLocal` to `RelayServer`, update `routeUpdate()` and `shouldSkipLocal()`.

6. **Fix session_shutdown** -- call `teardownSession()` before `shutdown()` on quit.

7. **Consolidate session state** -- `SessionHandle` becomes the single place for all per-session data (currently split across `SessionState`, `TopicManager`, `bridge.outgoingBySession`).

8. **Add relay subscription flow** -- session_start subscribes to relay, session_shutdown unsubscribes.

### Open Questions

1. **TopicManager scope**: Currently one TopicManager per chat (set on `lockToChat`). Should it be part of SessionRegistry or stay independent? Leaning: stay independent (it manages Telegram API calls for topic CRUD), but the mapping moves to SessionRegistry.

2. **Incoming handler session resolution**: When a message arrives with a threadId, who resolves it to a session? Currently `bridge.routeToSession()` does this. Proposed: `SessionRegistry.getSessionByThread()` returns the `SessionHandle`, incoming handler dispatches to it. General-topic messages go to `SessionRegistry.getActiveSession()`.

3. **`pendingNewSession` flag**: Currently an instance-layer global that leaks into session logic. Proposed fix: on `session_shutdown(reason=new)`, if the current session was telegram-connected, write a flag to the *next* session's data (or to instance state scoped to the transition). This needs more design.

4. **Random jitter for failover**: The current fixed 500ms backoff may cause races. Add `100ms + Math.random() * 900ms` delay before lock acquisition attempt? Or is the PID-file check sufficient?

5. **Should `connection.ts` handle the relay subscription flow?** Or should `session-lifecycle.ts` call relay subscribe/unsubscribe directly? Leaning: `session-lifecycle.ts` calls `connection.subscribeThread(threadId)` / `connection.unsubscribeThread(threadId)`, which dispatches to relay server or client as appropriate. This keeps the relay IPC details behind the connection interface.
