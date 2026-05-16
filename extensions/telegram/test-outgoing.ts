// ── Tests for outgoing.ts utility functions ──────────────────────────────────
// Standalone test — no Pi dependencies needed, just the pure functions.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

function truncate(s: string, maxLen: number): string {
	if (s.length <= maxLen) return s;
	return s.slice(0, maxLen - 1) + "\u{2026}";
}

const ELLIPSIS = "\u{2026}";

function shortenPath(path: string, maxLen: number): string {
	if (path.length <= maxLen) return path;

	const normalized = path.replace(/\\/g, "/");
	const hasRoot = normalized.startsWith("/");
	const segments = normalized.split("/").filter(s => s !== "");

	if (segments.length <= 1) {
		return truncate(path, maxLen);
	}

	const prefix = hasRoot ? "/" : "";
	const first = segments[0];
	const last = segments[segments.length - 1];

	if (segments.length >= 3) {
		const secondLast = segments[segments.length - 2];
		const candidate = `${prefix}${first}/${ELLIPSIS}/${secondLast}/${last}`;
		if (candidate.length <= maxLen) return candidate;
	}

	{
		const candidate = `${prefix}${first}/${ELLIPSIS}/${last}`;
		if (candidate.length <= maxLen) return candidate;
	}

	{
		const candidate = `${ELLIPSIS}/${last}`;
		if (candidate.length <= maxLen) return candidate;
	}

	return truncate(last, maxLen);
}

function summarizeToolInput(toolName: string, args: Record<string, unknown>): string {
	switch (toolName) {
		case "bash": {
			const cmd = String(args.command ?? "");
			return truncate(cmd.replace(/\n/g, " \u{21B5} "), 60);
		}
		case "read":
		case "write":
		case "edit":
			return shortenPath(String(args.path ?? args.file ?? ""), 40);
		case "grep":
			return truncate(String(args.pattern ?? ""), 30);
		case "find":
			return truncate(String(args.pattern ?? ""), 30);
		case "ls":
			return shortenPath(String(args.path ?? "."), 40);
		default:
			return "";
	}
}

describe("shortenPath", () => {
	it("short paths unchanged", () => {
		assert.equal(shortenPath("/home/tobi/file.ts", 40), "/home/tobi/file.ts");
		assert.equal(shortenPath("src/index.ts", 40), "src/index.ts");
		assert.equal(shortenPath("file.ts", 40), "file.ts");
	});

	it("absolute path: keeps first segment + ellipsis + tail", () => {
		const long = "/this/is/a/very/long/path/that/goes/on/and/on/foo.ts";
		const result = shortenPath(long, 40);
		assert.ok(result.length <= 40, `result "${result}" length ${result.length} > 40`);
		assert.ok(result.startsWith("/this/"), `starts with /this/: "${result}"`);
		assert.ok(result.includes(ELLIPSIS), `contains ellipsis: "${result}"`);
		assert.ok(result.endsWith("foo.ts"), `ends with filename: "${result}"`);
	});

	it("absolute path: very long shortens to /first/\u{2026}/filename", () => {
		const veryLong = "/this/is/a/very/long/path/that/goes/on/and/on/and/on/with/many/directory/segments/that/make/it/quite/lengthy/indeed/foo.txt";
		const result = shortenPath(veryLong, 40);
		assert.ok(result.length <= 40, `result "${result}" length ${result.length} > 40`);
		assert.ok(result.endsWith("foo.txt"), `ends with filename: "${result}"`);
		assert.ok(result.startsWith("/this/"), `starts with /this/: "${result}"`);
		assert.ok(result.includes(ELLIPSIS), `contains ellipsis: "${result}"`);
	});

	it("absolute path: drops to \u{2026}/filename when first segment is long", () => {
		// First segment is very long so /verylongseg/…/filename still exceeds limit
		const extreme = "/verylongsegmentthatisquiteextensive/subdir/another/file.ts";
		const result = shortenPath(extreme, 30);
		assert.ok(result.length <= 30, `result "${result}" length ${result.length} > 30`);
		assert.ok(result.includes(ELLIPSIS), `contains ellipsis: "${result}"`);
		assert.ok(result.endsWith("file.ts"), `ends with filename: "${result}"`);
	});

	it("tilde path: keeps ~ + ellipsis + tail", () => {
		const long = "~/projects/something/deeply/nested/subdirectory/structure/file.js";
		const result = shortenPath(long, 40);
		assert.ok(result.length <= 40, `result "${result}" length ${result.length} > 40`);
		assert.ok(result.startsWith("~/"), `starts with ~/: "${result}"`);
		assert.ok(result.endsWith("file.js"), `ends with filename: "${result}"`);
		assert.ok(result.includes(ELLIPSIS), `contains ellipsis: "${result}"`);
	});

	it("relative path: keeps first segment + ellipsis + tail", () => {
		const long = "src/extensions/telegram/subdirectory/deep/nested/file.ts";
		const result = shortenPath(long, 40);
		assert.ok(result.length <= 40, `result "${result}" length ${result.length} > 40`);
		assert.ok(result.startsWith("src/"), `starts with src/: "${result}"`);
		assert.ok(result.endsWith("file.ts"), `ends with filename: "${result}"`);
		assert.ok(result.includes(ELLIPSIS), `contains ellipsis: "${result}"`);
	});

	it("dot-relative path: keeps ./ + ellipsis + tail", () => {
		const long = "./src/extensions/telegram/subdirectory/deep/nested/outgoing.ts";
		const result = shortenPath(long, 40);
		assert.ok(result.length <= 40, `result "${result}" length ${result.length} > 40`);
		assert.ok(result.endsWith("outgoing.ts"), `ends with filename: "${result}"`);
		assert.ok(result.includes(ELLIPSIS), `contains ellipsis: "${result}"`);
	});

	it("single segment: just truncates", () => {
		const long = "a_really_long_filename_that_exceeds_the_maximum_allowed_length_for_display_purposes.ts";
		const result = shortenPath(long, 40);
		assert.ok(result.length <= 40, `result "${result}" length ${result.length} > 40`);
		assert.ok(result.endsWith("\u{2026}"), `truncated with ellipsis: "${result}"`);
	});

	it("two segments: first/last fits", () => {
		const path = "verylongdirectoryname/filename.ts";
		const result = shortenPath(path, 40);
		// With only 2 segments, shortenPath does first/…/last
		assert.equal(result, "verylongdirectoryname/filename.ts");
	});

	it("exact length: unchanged", () => {
		const path = "/home/tobi/p/project/file.ts";
		assert.equal(shortenPath(path, path.length), path);
	});

	it("iterative shortening: 3+ segments keeps second-to-last", () => {
		// Path where /home/…/src/index.ts fits in 25 chars
		const path = "/home/tobi/p/project/src/index.ts";
		const result = shortenPath(path, 25);
		assert.ok(result.length <= 25, `result "${result}" length ${result.length} > 25`);
		// Should be /home/…/src/index.ts (24 chars)
		assert.ok(result.includes(ELLIPSIS));
		assert.ok(result.endsWith("index.ts"));
	});

	it("very long filename: truncates filename itself", () => {
		const path = "/a/this_is_a_really_extremely_long_filename_that_will_not_fit.ts";
		const result = shortenPath(path, 20);
		assert.ok(result.length <= 20, `result "${result}" length ${result.length} > 20`);
	});
});

describe("summarizeToolInput", () => {
	it("bash: truncates long commands", () => {
		const result = summarizeToolInput("bash", { command: "cd /very/long/path/that/goes/on/and/on/and/on/and/on/and/on/forever" });
		assert.ok(result.length <= 60);
		assert.ok(result.endsWith("\u{2026}"));
	});

	it("bash: replaces newlines with \u{21B5}", () => {
		const result = summarizeToolInput("bash", { command: "echo hello\necho world" });
		assert.equal(result, "echo hello \u{21B5} echo world");
	});

	it("edit: shows shortened path", () => {
		const result = summarizeToolInput("edit", { path: "/home/tobi/p/pi-tobis-extensions/extensions/telegram/bridge.ts" });
		assert.ok(result.length <= 40, `length ${result.length} > 40: "${result}"`);
		assert.ok(result.endsWith("bridge.ts"), `ends with filename: "${result}"`);
		assert.ok(result.includes(ELLIPSIS), `contains ellipsis: "${result}"`);
	});

	it("read: shows shortened path for long paths", () => {
		const result = summarizeToolInput("read", { path: "/home/tobi/p/pi-tobis-extensions/extensions/telegram/outgoing.ts" });
		assert.ok(result.length <= 40, `length ${result.length} > 40: "${result}"`);
		assert.ok(result.endsWith("outgoing.ts"), `ends with filename: "${result}"`);
	});

	it("read: short path unchanged", () => {
		const result = summarizeToolInput("read", { path: "/home/tobi/README.md" });
		assert.equal(result, "/home/tobi/README.md");
	});

	it("grep: shows pattern", () => {
		const result = summarizeToolInput("grep", { pattern: "handleCallback", path: "/src" });
		assert.equal(result, "handleCallback");
	});

	it("find: shows pattern", () => {
		const result = summarizeToolInput("find", { pattern: "*.ts" });
		assert.equal(result, "*.ts");
	});

	it("ls: shows shortened path", () => {
		const result = summarizeToolInput("ls", { path: "/home/tobi/p/pi-tobis-extensions/extensions/telegram" });
		assert.ok(result.length <= 40, `length ${result.length} > 40: "${result}"`);
	});

	it("unknown tool: empty summary", () => {
		const result = summarizeToolInput("custom_tool", { foo: "bar" });
		assert.equal(result, "");
	});
});

describe("truncate", () => {
	it("short strings unchanged", () => {
		assert.equal(truncate("hello", 10), "hello");
	});
	it("long strings truncated", () => {
		assert.equal(truncate("hello world", 8), "hello w\u{2026}");
	});
});
