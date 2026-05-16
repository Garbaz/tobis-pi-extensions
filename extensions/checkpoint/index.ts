import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue, isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { resolve } from "node:path";
import { CheckpointManager, sessionCheckpointDir, type CaptureResult, type CheckpointEntry, type TurnTag } from "./checkpoint.js";

// ── Types ────────────────────────────────────────────────────────────────────

/** A selectable checkpoint item (one per file edit) */
interface CheckpointItem {
	ref: string;       // SHA to restore from
	file: string;      // File path
	tool: string;      // "edit" or "write"
	turn: number;      // Turn number (0 if unknown)
	timestamp: string; // ISO timestamp
	label: string;     // Display label for the select dialog
}

/** Turn header with prompt preview */
interface TurnGroup {
	turn: number;
	promptPrefix: string; // First ~80 chars of the user's prompt
	items: CheckpointItem[];
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Extract user message text from a session entry's message */
function getUserText(msg: unknown): string | null {
	if (!msg || typeof msg !== "object") return null;
	const m = msg as { role?: string; content?: unknown };
	if (m.role !== "user") return null;
	if (typeof m.content === "string") return m.content;
	if (Array.isArray(m.content)) {
		// Concatenate TextContent parts
		const texts: string[] = [];
		for (const part of m.content) {
			if (part && typeof part === "object" && "type" in part && part.type === "text" && typeof part.text === "string") {
				texts.push(part.text);
			}
		}
		return texts.join(" ") || null;
	}
	return null;
}

/** Build a map of turn number → user prompt prefix from session entries */
function buildTurnPromptMap(sessionEntries: unknown[]): Map<number, string> {
	const map = new Map<number, string>();
	let turnIndex = 0;
	for (const entry of sessionEntries) {
		if (!entry || typeof entry !== "object") continue;
		const e = entry as { type?: string; message?: unknown };
		if (e.type !== "message") continue;
		const text = getUserText(e.message);
		if (text !== null) {
			// Pi uses 0-based turn indices (turn_start with turnIndex=0 for first turn)
			map.set(turnIndex, text.replace(/\n/g, " ").trim());
			turnIndex++;
		}
	}
	return map;
}

/** Format a timestamp for display: "2026-05-14 10:30:15" */
function formatTimestamp(iso: string): string {
	// ISO format: "2026-05-14T10:30:15.123Z" → "2026-05-14 10:30:15"
	return iso.replace(/(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2}).*/, "$1 $2");
}

/** Truncate a string to maxLen, adding "…" if truncated */
function truncate(s: string, maxLen: number): string {
	if (s.length <= maxLen) return s;
	return s.slice(0, maxLen - 1) + "…";
}

/** Build checkpoint items grouped by turn for display */
function buildTurnGroups(
	entries: CheckpointEntry[],
	turnPromptMap: Map<number, string>,
): TurnGroup[] {
	// Use the 'turn' field from CheckpointEntry (set during capture)
	// Group by turn, most recent turn first
	const groupMap = new Map<number, CheckpointItem[]>();
	for (const e of entries) {
		const t = e.turn ?? 0;
		if (!groupMap.has(t)) groupMap.set(t, []);
		groupMap.get(t)!.push({
			ref: e.sha,
			file: e.file,
			tool: e.tool,
			turn: t,
			timestamp: e.timestamp,
			label: "", // filled in below
		});
	}

	// Build turn groups, sorted by turn number descending
	const turnNumbers = [...groupMap.keys()].sort((a, b) => b - a);
	const groups: TurnGroup[] = [];

	for (const t of turnNumbers) {
		const items = groupMap.get(t)!;
		const prompt = turnPromptMap.get(t) ?? "";
		groups.push({
			turn: t,
			promptPrefix: prompt,
			items,
		});
	}

	return groups;
}

/** Build a flat select list with turn headers and file entries.
 *  Returns { options, itemMap, turnMap } where:
 *  - itemMap maps file labels → CheckpointItem
 *  - turnMap maps turn header labels → TurnGroup */
function buildFlatSelectOptions(groups: TurnGroup[]): {
	options: string[];
	itemMap: Map<string, CheckpointItem>;
	turnMap: Map<string, TurnGroup>;
} {
	const options: string[] = [];
	const itemMap = new Map<string, CheckpointItem>();
	const turnMap = new Map<string, TurnGroup>();

	for (const group of groups) {
		const fileCount = group.items.length;
		const header = group.turn >= 0
			? `Turn ${group.turn}: ${truncate(group.promptPrefix, 60)} (${fileCount} ${fileCount === 1 ? "file" : "files"})`
			: `${truncate(group.promptPrefix, 60) || "Before first turn"} (${fileCount} ${fileCount === 1 ? "file" : "files"})`;
		options.push(header);
		turnMap.set(header, group);

		for (const item of group.items) {
			const toolTag = item.tool === "edit" ? "EDIT " : "WRITE";
			const label = `  ${formatTimestamp(item.timestamp)}  ${toolTag}  ${item.file}`;
			item.label = label;
			options.push(label);
			itemMap.set(label, item);
		}
	}

	return { options, itemMap, turnMap };
}

/** Show a diff preview for a checkpoint, truncated for display */
async function previewDiff(manager: CheckpointManager, ref: string, maxLen = 5000): Promise<string> {
	try {
		const diff = await manager.getDiff(ref);
		if (!diff.trim()) return "(no diff content)";
		return diff.length > maxLen
			? diff.slice(0, maxLen) + `\n... (${diff.length} chars total)`
			: diff;
	} catch (err) {
		return `Diff failed: ${err}`;
	}
}

/** Restore all files in a turn using the turn tag as the git ref.
 *  Returns results per file. */
async function restoreTurnFiles(
	manager: CheckpointManager,
	group: TurnGroup,
	ctx: ExtensionContext,
): Promise<{ restored: string[]; failed: string[] }> {
	const turnTag = `turn-${group.turn}`;
	// Deduplicate files (same file may be edited multiple times in one turn)
	const uniqueFiles = [...new Set(group.items.map((item) => item.file))];
	const restored: string[] = [];
	const failed: string[] = [];

	for (const file of uniqueFiles) {
		const absolutePath = resolve(ctx.cwd, file);
		try {
			await withFileMutationQueue(absolutePath, async () => {
				const success = await manager.restoreFile(turnTag, file);
				if (success) {
					restored.push(file);
				} else {
					failed.push(file);
				}
			});
		} catch (err) {
			failed.push(file);
		}
	}

	return { restored, failed };
}

/** Core interactive flow: select from flat list → confirm → restore.
 *  Selecting a file checkpoint restores that file; selecting a turn header restores all files in that turn.
 *  Used by the /checkpoint command. */
async function interactiveCheckpointRestore(
	manager: CheckpointManager,
	ctx: ExtensionContext,
): Promise<{ restored: boolean; files?: string[]; ref?: string; error?: string }> {
	const { turns, entries } = manager.listCheckpoints();

	if (entries.length === 0 && turns.length === 0) {
		ctx.ui.notify("No checkpoints yet. Checkpoints are created automatically before file edits.", "info");
		return { restored: false };
	}

	if (entries.length === 0) {
		ctx.ui.notify("No file checkpoints yet. Turn checkpoints exist — use /checkpoint diff <turn-tag> to inspect them.", "info");
		return { restored: false };
	}

	// Build turn → prompt map from session entries
	let turnPromptMap = new Map<number, string>();
	try {
		const sessionEntries = ctx.sessionManager.getEntries();
		turnPromptMap = buildTurnPromptMap(sessionEntries);
	} catch { /* session entries may not be available in all contexts */ }

	// Build flat select list with turn headers and file entries
	const groups = buildTurnGroups(entries, turnPromptMap);
	const { options, itemMap, turnMap } = buildFlatSelectOptions(groups);

	if (options.length === 0) {
		ctx.ui.notify("No checkpoints available.", "info");
		return { restored: false };
	}

	// Step 1: Select from the list
	const choice = await ctx.ui.select("Select a checkpoint to restore:", options);

	if (choice === undefined) {
		ctx.ui.notify("Cancelled", "info");
		return { restored: false };
	}

	// Step 2: Determine what was selected and confirm
	const turnGroup = turnMap.get(choice);
	if (turnGroup) {
		// ── Turn header selected: restore all files in this turn ──
		const uniqueFiles = [...new Set(turnGroup.items.map((item) => item.file))];
		const turnTag = `turn-${turnGroup.turn}`;

		let confirmMsg: string;
		if (uniqueFiles.length <= 2) {
			// Show diffs for small turns
			const diffParts: string[] = [];
			for (const file of uniqueFiles) {
				const diff = await previewDiff(manager, turnTag, 3000);
				if (diff && diff !== "(no diff content)") {
					diffParts.push(`--- ${file} ---\n${diff}`);
				}
			}
			confirmMsg = `Restore ${uniqueFiles.length} ${uniqueFiles.length === 1 ? "file" : "files"} to state before Turn ${turnGroup.turn}?\n\n${diffParts.join("\n\n") || "(no diff content)"}`;
		} else {
			// List files for larger turns
			const fileList = uniqueFiles.map((f) => `  ${f}`).join("\n");
			confirmMsg = `Restore ${uniqueFiles.length} files to state before Turn ${turnGroup.turn}?\n\nFiles:\n${fileList}`;
		}

		const confirmed = await ctx.ui.confirm("Restore turn?", confirmMsg);
		if (!confirmed) {
			ctx.ui.notify("Cancelled", "info");
			return { restored: false };
		}

		const { restored, failed } = await restoreTurnFiles(manager, turnGroup, ctx);
		if (restored.length > 0) {
			ctx.ui.notify(`Restored ${restored.length} ${restored.length === 1 ? "file" : "files"} to ${turnTag}${failed.length > 0 ? ` (${failed.length} failed)` : ""}`, "info");
			return { restored: true, files: restored, ref: turnTag };
		}
		ctx.ui.notify(`Failed to restore files from ${turnTag}`, "error");
		return { restored: false, error: "all files failed" };
	}

	const selected = itemMap.get(choice);
	if (!selected) {
		ctx.ui.notify("Invalid selection.", "error");
		return { restored: false };
	}

	// ── File checkpoint selected: restore single file ──
	const diff = await previewDiff(manager, selected.ref);
	ctx.ui.notify(diff, "info");

	const confirmed = await ctx.ui.confirm(
		"Restore file?",
		`Restore ${selected.file} to state at ${selected.ref.slice(0, 8)}?`,
	);

	if (!confirmed) {
		ctx.ui.notify("Cancelled", "info");
		return { restored: false };
	}

	const absolutePath = resolve(ctx.cwd, selected.file);
	try {
		return await withFileMutationQueue(absolutePath, async () => {
			const success = await manager.restoreFile(selected.ref, selected.file);
			if (success) {
				ctx.ui.notify(`Restored ${selected.file} to ${selected.ref.slice(0, 8)}`, "info");
				return { restored: true, files: [selected.file], ref: selected.ref };
			}
			ctx.ui.notify(`Failed to restore ${selected.file}`, "error");
			return { restored: false, error: "restoreFile returned false" };
		});
	} catch (err) {
		ctx.ui.notify(`Restore failed: ${err}`, "error");
		return { restored: false, error: String(err) };
	}
}

/** Build a text-based checkpoint listing with SHA values (for agent tool list action)
 *  Format: grouped by turn, each entry shows SHA, tool, timestamp, and file path. */
function buildAgentListing(
	turns: TurnTag[],
	entries: CheckpointEntry[],
	turnPromptMap: Map<number, string>,
): string {
	const groups = buildTurnGroups(entries, turnPromptMap);
	const lines: string[] = [];

	for (const group of groups) {
		const promptLine = group.turn >= 0
			? `Turn ${group.turn}: ${truncate(group.promptPrefix, 72)}`
			: truncate(group.promptPrefix, 72) || "Before first turn";
		lines.push(promptLine);

		for (const item of group.items) {
			const toolTag = item.tool === "edit" ? "EDIT " : "WRITE";
			const sha = item.ref.slice(0, 8);
			lines.push(`  ${sha}  ${formatTimestamp(item.timestamp)}  ${toolTag}  ${item.file}`);
		}

		lines.push(""); // blank line between groups
	}

	return lines.join("\n").trimEnd();
}

/** Build a text-based checkpoint listing (for non-interactive /checkpoint command fallback) */
function buildTextListing(
	turns: TurnTag[],
	entries: CheckpointEntry[],
	turnPromptMap: Map<number, string>,
): string {
	const groups = buildTurnGroups(entries, turnPromptMap);
	const lines: string[] = [];

	for (const group of groups) {
		const promptLine = group.turn >= 0
			? `Turn ${group.turn}: ${truncate(group.promptPrefix, 72)}`
			: truncate(group.promptPrefix, 72) || "Before first turn";
		lines.push(promptLine);

		for (const item of group.items) {
			const toolTag = item.tool === "edit" ? "EDIT " : "WRITE";
			lines.push(`  ${formatTimestamp(item.timestamp)}  ${toolTag}  ${item.file}`);
		}

		lines.push(""); // blank line between groups
	}

	return lines.join("\n").trimEnd();
}

// ── Extension ────────────────────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	let manager: CheckpointManager | null = null;

	// ── Events ─────────────────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		const sessionFile = ctx.sessionManager.getSessionFile();
		if (!sessionFile) return;

		manager = new CheckpointManager(sessionCheckpointDir(sessionFile), ctx.cwd);

		try {
			await manager.init();
		} catch (err) {
			ctx.ui.notify(`pi-checkpoint: init failed: ${err}`, "error");
		}
	});

	pi.on("turn_start", async (event) => {
		if (!manager) return;
		try {
			await manager.startTurn(event.turnIndex);
		} catch { /* checkpointing must not break the agent */ }
	});

	pi.on("tool_call", async (event) => {
		if (!manager) return;

		let filePath: string;
		let toolName: "edit" | "write";

		if (isToolCallEventType("edit", event)) {
			filePath = event.input.path;
			toolName = "edit";
		} else if (isToolCallEventType("write", event)) {
			filePath = event.input.path;
			toolName = "write";
		} else {
			return;
		}

		let result: CaptureResult;
		try {
			result = await manager.captureBeforeChange(toolName, filePath, event.toolCallId);
		} catch (err) {
			// Unhandled exception from the manager itself — block the edit
			return { block: true, reason: `pi-checkpoint: capture failed unexpectedly: ${err}` };
		}

		if (!result.ok) {
			return { block: true, reason: `pi-checkpoint: ${result.error}` };
		}
		// result.ok === true: either skipped (valid reason) or captured successfully
		// In both cases, allow the tool call to proceed
	});

	pi.on("session_shutdown", async () => {
		manager = null;
	});

	// ── /checkpoint command ────────────────────────────────────────────────

	pi.registerCommand("checkpoint", {
		description: "Browse and restore file checkpoints (interactive list with preview and confirmation)",
		getArgumentCompletions: (prefix: string) => {
			const actions = ["list", "diff", "restore", "log"];
			const matched = actions.filter((a) => a.startsWith(prefix));
			return matched.length > 0 ? matched.map((a) => ({ value: a, label: a })) : null;
		},
		handler: async (args, ctx) => {
			if (!manager) {
				ctx.ui.notify("pi-checkpoint: no session active", "warning");
				return;
			}
			const mgr = manager;

			await mgr.init();
			const [sub, ...rest] = args.trim().split(/\s+/);

			// Default: interactive browser (like /fork)
			if (!sub || sub === "list") {
				if (!ctx.hasUI) {
					// Non-interactive fallback: grouped text listing
					const { turns, entries } = mgr.listCheckpoints();
					if (entries.length === 0 && turns.length === 0) {
						ctx.ui.notify("No checkpoints yet. Checkpoints are created automatically before file edits.", "info");
						return;
					}
					let turnPromptMap = new Map<number, string>();
					try {
						turnPromptMap = buildTurnPromptMap(ctx.sessionManager.getEntries());
					} catch { /* ok */ }
					ctx.ui.notify(buildTextListing(turns, entries, turnPromptMap) || "No checkpoints", "info");
					return;
				}

				await interactiveCheckpointRestore(mgr, ctx);
				return;
			}

			// Advanced subcommands for power users / non-interactive use
			switch (sub) {
				case "log": {
					const count = rest[0] ? parseInt(rest[0], 10) : 20;
					const log = await mgr.getLog(count);
					ctx.ui.notify(log || "No commits in checkpoint repo", "info");
					return;
				}

				case "diff": {
					if (!rest[0]) {
						ctx.ui.notify("Usage: /checkpoint diff <sha> [sha2]  (sha = older, sha2 = newer)", "warning");
						return;
					}
					try {
						const diff = rest[1]
							? await mgr.getDiffRange(rest[0], rest[1])
							: await mgr.getDiff(rest[0]);
						if (!diff.trim()) {
							ctx.ui.notify("No changes", "info");
							return;
						}
						ctx.ui.notify(diff.length > 10000 ? diff.slice(0, 10000) + `\n... (${diff.length} chars total)` : diff, "info");
					} catch (err) {
						ctx.ui.notify(`Diff failed: ${err}`, "error");
					}
					return;
				}

				case "restore": {
					if (!rest[0]) {
						ctx.ui.notify("Usage: /checkpoint restore <sha|tag> [file]  (omit file to restore all files in a turn)", "warning");
						return;
					}
					const ref = rest[0];

					// Turn-level restore: ref is a turn tag and no file specified
					if (!rest[1] && ref.startsWith("turn-")) {
						const turnNum = parseInt(ref.slice(5), 10);
						if (isNaN(turnNum)) {
							ctx.ui.notify(`Invalid turn tag '${ref}'. Expected format: turn-N`, "error");
							return;
						}
						const { entries } = mgr.listCheckpoints();
						const turnEntries = entries.filter((e) => (e.turn ?? 0) === turnNum);
						if (turnEntries.length === 0) {
							ctx.ui.notify(`No checkpoints found for ${ref}.`, "warning");
							return;
						}
						const uniqueFiles = [...new Set(turnEntries.map((e) => e.file))];

						// Build confirmation message
						let confirmMsg: string;
						if (uniqueFiles.length <= 2) {
							const diffParts: string[] = [];
							for (const file of uniqueFiles) {
								const diff = await previewDiff(mgr, ref, 3000);
								if (diff && diff !== "(no diff content)") {
									diffParts.push(`--- ${file} ---\n${diff}`);
								}
							}
							confirmMsg = `Restore ${uniqueFiles.length} ${uniqueFiles.length === 1 ? "file" : "files"} to state before ${ref}?\n\n${diffParts.join("\n\n") || "(no diff content)"}`;
						} else {
							const fileList = uniqueFiles.map((f) => `  ${f}`).join("\n");
							confirmMsg = `Restore ${uniqueFiles.length} files to state before ${ref}?\n\nFiles:\n${fileList}`;
						}

						if (ctx.hasUI) {
							const ok = await ctx.ui.confirm("Restore turn?", confirmMsg);
							if (!ok) { ctx.ui.notify("Cancelled", "info"); return; }
						}

						const restored: string[] = [];
						const failed: string[] = [];
						for (const file of uniqueFiles) {
							const absolutePath = resolve(ctx.cwd, file);
							try {
								await withFileMutationQueue(absolutePath, async () => {
									const success = await mgr.restoreFile(ref, file);
									if (success) restored.push(file);
									else failed.push(file);
								});
							} catch (err) {
								failed.push(file);
							}
						}

						if (restored.length > 0) {
							ctx.ui.notify(`Restored ${restored.length} ${restored.length === 1 ? "file" : "files"} to ${ref}${failed.length > 0 ? ` (${failed.length} failed)` : ""}`, "info");
						} else {
							ctx.ui.notify(`Failed to restore files from ${ref}`, "error");
						}
						return;
					}

					// Single file restore
					if (!rest[1]) {
						ctx.ui.notify("Usage: /checkpoint restore <sha> <file>  (omit file only for turn tags like 'turn-3')", "warning");
						return;
					}
					const filePath = rest[1];
					if (ctx.hasUI) {
						const ok = await ctx.ui.confirm("Restore file?", `Restore ${filePath} to state at ${ref}?`);
						if (!ok) { ctx.ui.notify("Cancelled", "info"); return; }
					}
					const absolutePath = resolve(ctx.cwd, filePath);
					try {
						await withFileMutationQueue(absolutePath, async () => {
							const success = await mgr.restoreFile(ref, filePath);
							ctx.ui.notify(success ? `Restored ${filePath} to ${ref}` : `Failed to restore ${filePath}`, success ? "info" : "error");
						});
					} catch (err) {
						ctx.ui.notify(`Restore failed: ${err}`, "error");
					}
					return;
				}

				default:
					ctx.ui.notify(`Unknown subcommand '${sub}'. Use: /checkpoint (interactive), or /checkpoint list|diff|restore|log`, "warning");
					return;
			}
		},
	});

	// ── checkpoint tool (for agent use) ────────────────────────────────────

	pi.registerTool({
		name: "checkpoint",
		label: "Checkpoint",
		description:
			"Browse and restore file checkpoints. Checkpoints are automatically created before each file edit. " +
			"Use 'list' to see all checkpoints with their SHAs, 'diff' to inspect changes at a checkpoint, " +
			"and 'restore' to revert a file or an entire turn to a previous state (requires user confirmation).",
		promptSnippet: "checkpoint (list|diff <ref>|restore <ref> [file])",
		promptGuidelines: [
			"Use checkpoint to review file change history and restore files to previous states if edits went wrong.",
			"First call 'list' to get checkpoint SHAs, then 'diff' to inspect, then 'restore' with the SHA and file path.",
			"To revert all changes from a turn, use 'restore' with a turn tag (e.g. 'turn-3') and no file — this restores every file edited in that turn.",
			"'restore' always requires interactive user confirmation before proceeding.",
		],
		parameters: Type.Object({
			action: StringEnum(["list", "diff", "restore"] as const, { description: "Action to perform" }),
			ref: Type.Optional(Type.String({ description: "SHA or tag for diff/restore (e.g. 'abc1234' or 'turn-3')" })),
			file: Type.Optional(Type.String({ description: "File path to restore. Omit to restore all files edited in the turn (only with turn tags)" })),
		}, { additionalProperties: false }),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!manager) {
				return { content: [{ type: "text", text: "Error: no active checkpoint session" }], details: undefined };
			}
			const mgr = manager;

			await mgr.init();
			const action = params.action?.toLowerCase();

			switch (action) {
				case "list": {
					const { turns, entries } = mgr.listCheckpoints();
					if (entries.length === 0 && turns.length === 0) {
						return { content: [{ type: "text", text: "No checkpoints yet. Checkpoints are created automatically before each file edit." }], details: undefined };
					}
					let turnPromptMap = new Map<number, string>();
					try {
						turnPromptMap = buildTurnPromptMap(ctx.sessionManager.getEntries());
					} catch { /* ok */ }
					const listing = buildAgentListing(turns, entries, turnPromptMap);
					return { content: [{ type: "text", text: listing || "No checkpoints" }], details: undefined };
				}

				case "diff": {
					if (!params.ref) {
						return { content: [{ type: "text", text: "Error: 'ref' is required for diff action. Usage: checkpoint diff <sha|tag>" }], details: undefined };
					}
					try {
						const parts = params.ref.trim().split(/\s+/);
						const diff = parts.length > 1
							? await mgr.getDiffRange(parts[0], parts[1])
							: await mgr.getDiff(params.ref);
						if (!diff.trim()) {
							return { content: [{ type: "text", text: "No changes at this checkpoint." }], details: undefined };
						}
						const truncated = diff.length > 8000 ? diff.slice(0, 8000) + `\n... (${diff.length} chars total)` : diff;
						return { content: [{ type: "text", text: truncated }], details: undefined };
					} catch (err) {
						return { content: [{ type: "text", text: `Diff failed: ${err}` }], details: undefined };
					}
				}

				case "restore": {
					if (!params.ref) {
						return { content: [{ type: "text", text: "Error: 'ref' is required for restore action. Usage: checkpoint restore <sha|tag> [file]" }], details: undefined };
					}
					const { ref } = params;

					// Turn-level restore: ref is a turn tag and no file specified
					if (!params.file && ref.startsWith("turn-")) {
						const turnNum = parseInt(ref.slice(5), 10);
						if (isNaN(turnNum)) {
							return { content: [{ type: "text", text: `Error: Invalid turn tag '${ref}'. Expected format: turn-N` }], details: undefined };
						}
						const { entries } = mgr.listCheckpoints();
						const turnEntries = entries.filter((e) => (e.turn ?? 0) === turnNum);
						if (turnEntries.length === 0) {
							return { content: [{ type: "text", text: `No checkpoints found for ${ref}.` }], details: undefined };
						}
						const uniqueFiles = [...new Set(turnEntries.map((e) => e.file))];

						// Build confirmation message
						let confirmMsg: string;
						if (uniqueFiles.length <= 2) {
							const diffParts: string[] = [];
							for (const file of uniqueFiles) {
								const diff = await previewDiff(mgr, ref, 3000);
								if (diff && diff !== "(no diff content)") {
									diffParts.push(`--- ${file} ---\n${diff}`);
								}
							}
							confirmMsg = `Restore ${uniqueFiles.length} ${uniqueFiles.length === 1 ? "file" : "files"} to state before ${ref}?\n\n${diffParts.join("\n\n") || "(no diff content)"}`;
						} else {
							const fileList = uniqueFiles.map((f) => `  ${f}`).join("\n");
							confirmMsg = `Restore ${uniqueFiles.length} files to state before ${ref}?\n\nFiles:\n${fileList}`;
						}

						if (ctx.hasUI) {
							const confirmed = await ctx.ui.confirm("Restore turn?", confirmMsg);
							if (!confirmed) {
								return { content: [{ type: "text", text: "Restore cancelled by user." }], details: undefined };
							}
						}

						const restored: string[] = [];
						const failed: string[] = [];
						for (const file of uniqueFiles) {
							const absolutePath = resolve(ctx.cwd, file);
							try {
								await withFileMutationQueue(absolutePath, async () => {
									const success = await mgr.restoreFile(ref, file);
									if (success) restored.push(file);
									else failed.push(file);
								});
							} catch (err) {
								failed.push(file);
							}
						}

						const result = restored.length > 0
							? `Restored ${restored.length} ${restored.length === 1 ? "file" : "files"} to ${ref}${failed.length > 0 ? ` (${failed.length} failed: ${failed.join(", ")})` : ""}`
							: `Failed to restore files from ${ref}`;
						return { content: [{ type: "text", text: result }], details: undefined };
					}

					// Single file restore
					if (!params.file) {
						return { content: [{ type: "text", text: "Error: 'file' is required when restoring by SHA. Usage: checkpoint restore <sha> <file>  (omit file only for turn tags like 'turn-3')" }], details: undefined };
					}
					const { file } = params;

					// Show diff preview in the confirmation dialog
					const diff = await previewDiff(mgr, ref, 2000);
					const preview = diff.length > 2000 ? diff.slice(0, 2000) + "..." : diff;

					// Require user confirmation with diff context
					if (ctx.hasUI) {
						const confirmed = await ctx.ui.confirm(
							"Restore file?",
							`Restore ${file} to state at ${ref}?\n\nChanges that will be applied:\n${preview}`,
						);
						if (!confirmed) {
							return { content: [{ type: "text", text: "Restore cancelled by user." }], details: undefined };
						}
					}
					const absolutePath = resolve(ctx.cwd, file);
					return withFileMutationQueue(absolutePath, async () => {
						try {
							const success = await mgr.restoreFile(ref, file);
							if (success) {
								return { content: [{ type: "text", text: `Restored ${file} to ${ref}` }], details: undefined };
							}
							return { content: [{ type: "text", text: `Failed to restore ${file}. The ref or file may not exist in the checkpoint history.` }], details: undefined };
						} catch (err) {
							return { content: [{ type: "text", text: `Restore failed: ${err}` }], details: undefined };
						}
					});
				}

				default:
					return { content: [{ type: "text", text: `Unknown action '${action}'. Use: list, diff, restore` }], details: undefined };
			}
		},
	});
}
