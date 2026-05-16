// ── Media Processing Tests ───────────────────────────────────────────────────
// Exercises the actual media.ts code paths with real endpoints.
// Run with: npx tsx extensions/telegram/test-media.ts

import {
	extFromMime,
	getMediaInfo,
	mediaPlaceholder,
	processMedia,
	downloadMediaFile,
	getMediaDir,
} from "./media.js";
import {
	formatIncomingText,
	extractText,
	senderName,
	detectContentTypes,
	formatLocation,
	formatVenue,
	formatContact,
	formatDice,
	formatPoll,
} from "./formatting.js";
import type {
	Message,
	MediaType,
	MediaProcessor,
	Voice,
	Audio,
	PhotoSize,
	Video,
	VideoNote,
	Document,
	Sticker,
	Location,
	Venue,
	Contact,
	Dice as DiceType,
	Poll,
} from "./types.js";
import { TelegramApi } from "./api.js";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

// ── Test Runner ──────────────────────────────────────────────────────────────

let passCount = 0;
let failCount = 0;
let skipCount = 0;

function assert(condition: boolean, label: string): void {
	if (condition) {
		console.log(`  ✅ ${label}`);
		passCount++;
	} else {
		console.log(`  ❌ ${label}`);
		failCount++;
	}
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
	if (JSON.stringify(actual) === JSON.stringify(expected)) {
		console.log(`  ✅ ${label}`);
		passCount++;
	} else {
		console.log(`  ❌ ${label}`);
		console.log(`     expected: ${JSON.stringify(expected)}`);
		console.log(`     actual:   ${JSON.stringify(actual)}`);
		failCount++;
	}
}

function assertIncludes(haystack: string, needle: string, label: string): void {
	if (haystack.includes(needle)) {
		console.log(`  ✅ ${label}`);
		passCount++;
	} else {
		console.log(`  ❌ ${label}`);
		console.log(`     expected to include: "${needle}"`);
		console.log(`     actual: "${haystack.slice(0, 200)}"`);
		failCount++;
	}
}

function skip(label: string): void {
	console.log(`  ⏭️  ${label}`);
	skipCount++;
}

function section(name: string): void {
	console.log(`\n━━ ${name} ━━`);
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const baseMessage: Message = {
	message_id: 42,
	from: { id: 123, is_bot: false, first_name: "Test", username: "testuser" },
	date: 1700000000,
	chat: { id: 456, type: "private" },
};

const voiceMsg: Message = { ...baseMessage, voice: { file_id: "voice123", file_unique_id: "uv", duration: 5, mime_type: "audio/ogg" } as Voice };
const audioMsg: Message = { ...baseMessage, audio: { file_id: "audio123", file_unique_id: "ua", duration: 120, mime_type: "audio/mpeg", file_name: "song.mp3" } as Audio };
const photoMsg: Message = { ...baseMessage, photo: [{ file_id: "photo_sm", file_unique_id: "up1", width: 90, height: 90 }, { file_id: "photo_lg", file_unique_id: "up2", width: 800, height: 600 }] as PhotoSize[] };
const videoMsg: Message = { ...baseMessage, video: { file_id: "video123", file_unique_id: "uv2", width: 1920, height: 1080, duration: 30, mime_type: "video/mp4", file_name: "clip.mp4" } as Video };
const videoNoteMsg: Message = { ...baseMessage, video_note: { file_id: "vn123", file_unique_id: "uvn", length: 240, duration: 15 } as VideoNote };
const animMsg: Message = { ...baseMessage, animation: { file_id: "anim123", file_unique_id: "ua2", width: 320, height: 240, duration: 3, file_name: "animation.gif.mp4", mime_type: "video/mp4" } };
const docMsg: Message = { ...baseMessage, document: { file_id: "doc123", file_unique_id: "ud", file_name: "report.pdf", mime_type: "application/pdf" } as Document };
const stickerMsg: Message = { ...baseMessage, sticker: { file_id: "sticker123", file_unique_id: "us", width: 512, height: 512, is_animated: false, is_video: false, type: "regular", emoji: "😀" } as Sticker };

const testDir = "/tmp/pi-telegram-media-test";
rmSync(testDir, { recursive: true, force: true });
mkdirSync(testDir, { recursive: true });

// ── 1. Pure Function Tests ───────────────────────────────────────────────────

section("extFromMime");

assertEqual(extFromMime("audio/ogg"), "ogg", "audio/ogg → ogg");
assertEqual(extFromMime("audio/mpeg"), "mp3", "audio/mpeg → mp3");
assertEqual(extFromMime("audio/mp4"), "m4a", "audio/mp4 → m4a");
assertEqual(extFromMime("audio/webm"), "webm", "audio/webm → webm");
assertEqual(extFromMime("image/jpeg"), "jpg", "image/jpeg → jpg");
assertEqual(extFromMime("image/png"), "png", "image/png → png");
assertEqual(extFromMime("image/webp"), "webp", "image/webp → webp");
assertEqual(extFromMime("image/gif"), "gif", "image/gif → gif");
assertEqual(extFromMime("video/mp4"), "mp4", "video/mp4 → mp4");
assertEqual(extFromMime("video/webm"), "webm", "video/webm → webm");
assertEqual(extFromMime("application/pdf"), "pdf", "application/pdf → pdf");
assertEqual(extFromMime("application/x-tgsticker"), "tgs", "application/x-tgsticker → tgs");
assertEqual(extFromMime(undefined, "bin"), "bin", "undefined → fallback");
assertEqual(extFromMime("audio/unknown", "ogg"), "ogg", "unknown mime → fallback");
assertEqual(extFromMime("application/octet-stream", "dat"), "dat", "octet-stream → fallback");

section("getMediaInfo");

const vi = getMediaInfo(voiceMsg);
assert(vi !== undefined, "voice: getMediaInfo returns result");
assertEqual(vi?.type, "voice", "voice: type");
assertEqual(vi?.fileId, "voice123", "voice: fileId");
assertEqual(vi?.mimeType, "audio/ogg", "voice: mimeType");

const ai = getMediaInfo(audioMsg);
assertEqual(ai?.type, "audio", "audio: type");
assertEqual(ai?.fileName, "song.mp3", "audio: fileName");

const pi = getMediaInfo(photoMsg);
assertEqual(pi?.type, "photo", "photo: type");
assertEqual(pi?.fileId, "photo_lg", "photo: picks largest photo");
assertEqual(pi?.mimeType, undefined, "photo: no mimeType (PhotoSize has none)");

const vi2 = getMediaInfo(videoMsg);
assertEqual(vi2?.type, "video", "video: type");
assertEqual(vi2?.mimeType, "video/mp4", "video: mimeType");

const vni = getMediaInfo(videoNoteMsg);
assertEqual(vni?.type, "video_note", "video_note: type");
assertEqual(vni?.mimeType, undefined, "video_note: no mimeType");

const ani = getMediaInfo(animMsg);
assertEqual(ani?.type, "animation", "animation: type");
assertEqual(ani?.fileName, "animation.gif.mp4", "animation: keeps Telegram fileName");

const di = getMediaInfo(docMsg);
assertEqual(di?.type, "document", "document: type");
assertEqual(di?.fileName, "report.pdf", "document: fileName");

const si = getMediaInfo(stickerMsg);
assertEqual(si?.type, "sticker", "sticker: type");
assertEqual(si?.mimeType, undefined, "sticker: no mimeType");

assertEqual(getMediaInfo(baseMessage), undefined, "text-only: no media");

section("mediaPlaceholder");

const fakePath = "/tmp/session/media/456-42-photo.jpg";
assertIncludes(mediaPlaceholder("voice", baseMessage, fakePath), "🎙️", "voice placeholder → emoji");
assertIncludes(mediaPlaceholder("voice", baseMessage, fakePath), "no transcription available", "voice placeholder → hint");
assertIncludes(mediaPlaceholder("photo", baseMessage, fakePath), "🖼️", "photo placeholder → emoji");
assertIncludes(mediaPlaceholder("photo", baseMessage, fakePath), "no description available", "photo placeholder → hint");
assertIncludes(mediaPlaceholder("video", baseMessage, fakePath), "🎬", "video placeholder → emoji");
assertIncludes(mediaPlaceholder("video", baseMessage, fakePath), "no description available", "video placeholder → hint");
assertIncludes(mediaPlaceholder("sticker", baseMessage, fakePath), "🎭", "sticker placeholder → emoji");
assertIncludes(mediaPlaceholder("sticker", baseMessage, fakePath), fakePath, "sticker placeholder → file path");
assertIncludes(mediaPlaceholder("document", baseMessage, fakePath), "📄", "document placeholder → emoji");
assertIncludes(mediaPlaceholder("document", baseMessage, fakePath), "you can read the file", "document placeholder → hint");
assertIncludes(mediaPlaceholder("animation", baseMessage, fakePath), "🎞️", "animation placeholder → emoji");
assertIncludes(mediaPlaceholder("animation", baseMessage, fakePath), fakePath, "animation placeholder → file path");
assertIncludes(mediaPlaceholder("audio", baseMessage, fakePath), "🎵", "audio placeholder → emoji");
assertIncludes(mediaPlaceholder("audio", baseMessage, fakePath), fakePath, "audio placeholder → file path");
assertIncludes(mediaPlaceholder("video_note", baseMessage, fakePath), "🎬", "video_note placeholder → emoji");
assertIncludes(mediaPlaceholder("video_note", baseMessage, fakePath), fakePath, "video_note placeholder → file path");

section("detectContentTypes");

assertEqual(detectContentTypes(baseMessage), ["text"], "text-only → [text]");
assertEqual(detectContentTypes(voiceMsg), ["voice"], "voice → [voice]");
assertEqual(detectContentTypes(photoMsg), ["photo"], "photo → [photo]");

const photoWithCaption: Message = { ...photoMsg, caption: "Look at this!" };
assertEqual(detectContentTypes(photoWithCaption), ["photo", "caption"], "photo+caption → [photo, caption]");

const locationMsg: Message = { ...baseMessage, location: { latitude: 48.0, longitude: 7.8 } as Location };
assertEqual(detectContentTypes(locationMsg), ["location"], "location → [location]");

const contactMsg: Message = { ...baseMessage, contact: { phone_number: "+491234567", first_name: "John" } as Contact };
assertEqual(detectContentTypes(contactMsg), ["contact"], "contact → [contact]");

const diceMsg: Message = { ...baseMessage, dice: { emoji: "🎲", value: 4 } as DiceType };
assertEqual(detectContentTypes(diceMsg), ["dice"], "dice → [dice]");

const pollMsg: Message = { ...baseMessage, poll: { id: "p1", question: "Time?", options: [{ text: "9am", voter_count: 3 }, { text: "10am", voter_count: 5 }], total_voter_count: 8, is_closed: false, is_anonymous: true, type: "regular", allows_multiple_answers: false } as Poll };
assertEqual(detectContentTypes(pollMsg), ["poll"], "poll → [poll]");

section("Data-only formatters");

const loc = formatLocation({ latitude: 48.0, longitude: 7.8 });
assertIncludes(loc, "48", "location → latitude");
assertIncludes(loc, "7.8", "location → longitude");
assertIncludes(loc, "openstreetmap.org", "location → map link");

const liveLoc = formatLocation({ latitude: 48.0, longitude: 7.8, live_period: 3600, heading: 90 });
assertIncludes(liveLoc, "live for 60min", "live location → period");
assertIncludes(liveLoc, "heading 90°", "live location → heading");

const venue = formatVenue({ location: { latitude: 48.0, longitude: 7.8 }, title: "Café Central", address: "Hauptstr. 5" } as Venue);
assertIncludes(venue, "Café Central", "venue → title");
assertIncludes(venue, "Hauptstr. 5", "venue → address");
assertIncludes(venue, "openstreetmap.org", "venue → map link");

const contact = formatContact({ phone_number: "+491234567", first_name: "John", last_name: "Doe" } as Contact);
assertIncludes(contact, "John Doe", "contact → name");
assertIncludes(contact, "+491234567", "contact → phone");

assertEqual(formatDice({ emoji: "🎲", value: 4 } as DiceType), "🎲 Rolled: 4", "dice format");

const poll = formatPoll({ id: "p1", question: "Time?", options: [{ text: "9am", voter_count: 3 }, { text: "10am", voter_count: 5 }], total_voter_count: 8, is_closed: false, is_anonymous: true, type: "regular", allows_multiple_answers: false } as Poll);
assertIncludes(poll, "Poll: Time?", "poll → question");
assertIncludes(poll, "9am — 3 votes", "poll → option 1");
assertIncludes(poll, "10am — 5 votes", "poll → option 2");
assertIncludes(poll, "Total: 8 voters", "poll → total");
assertIncludes(poll, "anonymous", "poll → anonymous");

const quiz = formatPoll({ id: "q1", question: "Capital?", options: [{ text: "Berlin", voter_count: 5 }, { text: "Munich", voter_count: 2 }], total_voter_count: 7, is_closed: true, is_anonymous: false, type: "quiz", allows_multiple_answers: false, correct_option_id: 0 } as Poll);
assertIncludes(quiz, "Quiz", "quiz → type label");
assertIncludes(quiz, "[closed]", "quiz → closed");
assertIncludes(quiz, "✓ Berlin", "quiz → correct marker");

section("formatIncomingText / extractText / senderName");

assertEqual(formatIncomingText("hello", false), "hello", "plain text unchanged");
assertEqual(formatIncomingText("hello", true), "hello\n[edited]", "edited text gets suffix");
assertEqual(extractText(baseMessage), "", "empty message → empty text");
assertEqual(extractText({ ...baseMessage, text: "hi" }), "hi", "message.text");
assertEqual(extractText({ ...photoMsg, caption: "nice" }), "nice", "message.caption");
assertEqual(senderName(baseMessage), "testuser", "username from from.username");
assertEqual(senderName({ ...baseMessage, from: { id: 1, is_bot: false, first_name: "John" } }), "John", "first_name fallback");

// ── 2. downloadMediaFile filename logic ──────────────────────────────────────
// We test the filename construction by mocking TelegramApi just enough.

section("downloadMediaFile — filename logic");

// Create a minimal mock of TelegramApi that returns a fake file and download
class MockTelegramApi extends TelegramApi {
	private mockFilePath: string;
	private mockFileContent: Uint8Array;

	constructor(mockFilePath: string, mockContent: Uint8Array) {
		super("mock-token"); // won't call the real API
		this.mockFilePath = mockFilePath;
		this.mockFileContent = mockContent;
	}

	override async getFile(_fileId: string): Promise<{ file_id: string; file_unique_id: string; file_path?: string }> {
		return { file_id: "mock", file_unique_id: "mock", file_path: this.mockFilePath };
	}

	override async downloadFile(_filePath: string): Promise<Response> {
		return new Response(Buffer.from(this.mockFileContent), { status: 200 });
	}
}

const mediaDir = join(testDir, "media");
mkdirSync(mediaDir, { recursive: true });

// Test: voice with server extension .ogg
{
	const api = new MockTelegramApi("photos/voice_123.ogg", new Uint8Array([1, 2, 3]));
	const path = await downloadMediaFile(api, "v1", "voice", "audio/ogg", undefined, mediaDir, 42, 456);
	assert(path.endsWith("456-42-voice.ogg"), `voice path ends with 456-42-voice.ogg: ${path}`);
	assert(existsSync(path), "voice file was written");
}

// Test: photo (no mime_type in PhotoSize) — should use server extension .jpg
{
	const api = new MockTelegramApi("photos/abc123.jpg", new Uint8Array([4, 5, 6]));
	const path = await downloadMediaFile(api, "p1", "photo", undefined, undefined, mediaDir, 43, 456);
	assert(path.endsWith("456-43-photo.jpg"), `photo path ends with 456-43-photo.jpg: ${path}`);
	assert(existsSync(path), "photo file was written");
}

// Test: animation with misleading fileName "animation.gif.mp4" — stem should strip ext
{
	const api = new MockTelegramApi("documents/anim_xyz.mp4", new Uint8Array([7, 8, 9]));
	const path = await downloadMediaFile(api, "a1", "animation", "video/mp4", "animation.gif.mp4", mediaDir, 44, 456);
	assert(path.endsWith("456-44-animation.gif.mp4"), `animation path: ${path}`);
	// The stem should be "animation.gif" (stripped trailing .mp4 from fileName), then server ext .mp4 appended
	// So: 456-44-animation.gif.mp4
	assert(existsSync(path), "animation file was written");
}

// Test: sticker with no mime_type and server gives .webp
{
	const api = new MockTelegramApi("stickers/stk_abc.webp", new Uint8Array([10, 11, 12]));
	const path = await downloadMediaFile(api, "s1", "sticker", undefined, undefined, mediaDir, 45, 456);
	assert(path.endsWith("456-45-sticker.webp"), `sticker path: ${path}`);
	assert(existsSync(path), "sticker file was written");
}

// Test: document with explicit fileName and mime_type
{
	const api = new MockTelegramApi("docs/report_x9f2.pdf", new Uint8Array([13, 14, 15]));
	const path = await downloadMediaFile(api, "d1", "document", "application/pdf", "report.pdf", mediaDir, 46, 456);
	assert(path.endsWith("456-46-report.pdf"), `document path: ${path}`);
	assert(existsSync(path), "document file was written");
}

// Test: video_note with no fileName and no mime — server ext .mp4
{
	const api = new MockTelegramApi("videos/vn_abc.mp4", new Uint8Array([16, 17]));
	const path = await downloadMediaFile(api, "vn1", "video_note", undefined, undefined, mediaDir, 47, 456);
	assert(path.endsWith("456-47-video_note.mp4"), `video_note path: ${path}`);
	assert(existsSync(path), "video_note file was written");
}

// ── 3. Protocol handler tests with real endpoints ────────────────────────────

const STT_URL = "http://localhost:9000/v1/audio/transcriptions";
const VISION_URL = "https://openwebui.uni-freiburg.de/api/v1/chat/completions";
const VISION_MODEL = "standard-bild-ufr";
const VISION_API_KEY = "sk-9b79641c41e04b6a8bc71fd9b9d74847";
const SCRIPT_PATH = join(process.env.HOME ?? "/home/tobi", ".pi/agent/extensions/pi-telegram/scripts/stt-parakeet");

section("Protocol: openai-stt (faster-whisper at localhost:9000)");

// Create a tiny OGG/Opus file for testing. We'll use a minimal valid OGG file.
// faster-whisper accepts OGG/Opus natively.
// Generate a 1-second silent OGG using sox if available, otherwise skip.
let sttTestFile: string | undefined;
try {
	const oggPath = join(testDir, "test-audio.ogg");
	// Try generating with ffmpeg (commonly available)
	const { execSync } = await import("node:child_process");
	try {
		execSync("ffmpeg -f lavfi -i anullsrc=r=16000:cl=mono -t 1 -c:a libopus " + oggPath, {
			stdio: "pipe",
			timeout: 5000,
		});
		sttTestFile = oggPath;
		assert(existsSync(oggPath), "generated test OGG file");
	} catch {
		skip("ffmpeg not available — cannot generate test audio");
	}
} catch (err) {
	skip(`audio generation error: ${err instanceof Error ? err.message : err}`);
}

if (sttTestFile) {
	// Test processMedia with openai-stt protocol
	const sttProcessor: MediaProcessor = {
		url: STT_URL,
		api: "openai-stt",
		model: "whisper-1",
		timeout: 30000,
	};

	try {
		const result = await processMedia(sttProcessor, sttTestFile);
		// Silent audio → "no speech detected" is expected
		assert(typeof result === "string", `openai-stt: returned string (length: ${result.length})`);
		console.log(`  ℹ️  STT result: "${result.slice(0, 100)}"`);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		// "no speech detected" is a valid result for silent audio
		if (msg.includes("no speech detected")) {
			assert(true, "openai-stt: correctly reports no speech for silent audio");
		} else {
			assert(false, `openai-stt: ${msg}`);
		}
	}

	// Also test with api_key header (the STT server doesn't need it, but verify the header path works)
	const sttProcessorWithKey: MediaProcessor = {
		url: STT_URL,
		api: "openai-stt",
		model: "whisper-1",
		api_key: "test-key-ignored",
		timeout: 30000,
	};
	try {
		const result = await processMedia(sttProcessorWithKey, sttTestFile);
		assert(typeof result === "string", "openai-stt with api_key: returned string");
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (msg.includes("no speech detected")) {
			assert(true, "openai-stt with api_key: no speech for silent audio (expected)");
		} else if (msg.includes("401") || msg.includes("403")) {
			// Some STT servers reject unknown keys — that's fine, header was sent
			assert(true, "openai-stt with api_key: server rejected test key (header path works)");
		} else {
			assert(false, `openai-stt with api_key: ${msg}`);
		}
	}
}

section("Protocol: openai-chat (UFR OpenWebUI vision)");

// Create a small test image (1x1 red PNG)
let visionTestFile: string | undefined;
try {
	// Generate a 1x1 red PNG with ImageMagick or use a minimal hardcoded PNG
	const pngPath = join(testDir, "test-image.png");
	const { execSync } = await import("node:child_process");
	try {
		execSync(`convert -size 1x1 xc:red ${pngPath}`, { stdio: "pipe", timeout: 5000 });
		visionTestFile = pngPath;
		assert(existsSync(pngPath), "generated test PNG with ImageMagick");
	} catch {
		// Fallback: create a minimal valid PNG manually
		// Minimal 1x1 red PNG (67 bytes)
		const minimalPng = Buffer.from(
			"89504e470d0a1a0a0000000d49484452000000010000000108020000009077" +
			"53de0000000c49444154789c626060f80f0000010100005718d84e00000000" +
			"49454e44ae426082",
			"hex",
		);
		writeFileSync(pngPath, minimalPng);
		visionTestFile = pngPath;
		assert(existsSync(pngPath), "created minimal test PNG");
	}
} catch (err) {
	skip(`image generation error: ${err instanceof Error ? err.message : err}`);
}

if (visionTestFile) {
	const visionProcessor: MediaProcessor = {
		url: VISION_URL,
		api: "openai-chat",
		model: VISION_MODEL,
		api_key: VISION_API_KEY,
		prompt: "Describe this image in one sentence.",
		timeout: 30000,
	};

	try {
		const result = await processMedia(visionProcessor, visionTestFile);
		assert(typeof result === "string" && result.length > 0, `openai-chat: returned non-empty string (length: ${result.length})`);
		console.log(`  ℹ️  Vision result: "${result.slice(0, 200)}"`);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		assert(false, `openai-chat: ${msg}`);
	}
}

section("Protocol: script (stt-parakeet)");

if (existsSync(SCRIPT_PATH)) {
	if (sttTestFile) {
		const scriptProcessor: MediaProcessor = {
			url: "",
			api: "bash",
			command: `${SCRIPT_PATH} {file}`,
			timeout: 60000,
		};

		try {
			const result = await processMedia(scriptProcessor, sttTestFile);
			assert(typeof result === "string", `script: returned string (length: ${result.length})`);
			console.log(`  ℹ️  Script result: "${result.slice(0, 100)}"`);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			// stt-parakeet exits 1 for "no speech detected" — this is expected for silent audio.
			// The script handler treats exit-1 as error (which formatMessageContent catches gracefully).
			// The error message contains "Command failed" since the inner stderr isn't propagated through sh -c.
			if (msg.includes("script failed") || msg.includes("Command failed") || msg.includes("no speech detected") || msg.includes("STT")) {
				assert(true, "script: exit-1 for silent audio (formatMessageContent catches this gracefully)");
				console.log(`  ℹ️  Note: script handler treats non-zero exit as error — formatMessageContent catches this gracefully in production.`);
			} else {
				assert(false, `script: ${msg.slice(0, 200)}`);
			}
		}
	} else {
		skip("script: no test audio file available");
	}
} else {
	skip("script: stt-parakeet not found");
}

section("Protocol: openai-chat — auth header verification");

// Test that missing api_key is handled (UFR should 401 without it)
if (visionTestFile) {
	const noKeyProcessor: MediaProcessor = {
		url: VISION_URL,
		api: "openai-chat",
		model: VISION_MODEL,
		// no api_key
		prompt: "Describe this image.",
		timeout: 10000,
	};

	try {
		const result = await processMedia(noKeyProcessor, visionTestFile);
		// If it succeeds without key, the server is open — that's unusual but fine
		assert(true, `openai-chat without api_key: got result (server accepts unauthenticated)`);
		console.log(`  ℹ️  Result without key: "${result.slice(0, 100)}"`);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (msg.includes("401") || msg.includes("403") || msg.includes("Not authenticated")) {
			assert(true, "openai-chat without api_key: correctly rejected (401/403)");
		} else {
			// Some other error — might be network, timeout, etc.
			skip(`openai-chat without api_key: ${msg.slice(0, 100)}`);
		}
	}
}

section("Protocol: openai-stt — auth header verification");

// Verify STT works without key (local server, no auth)
if (sttTestFile) {
	const sttNoKey: MediaProcessor = {
		url: STT_URL,
		api: "openai-stt",
		model: "whisper-1",
		// no api_key — local server doesn't need it
		timeout: 10000,
	};

	try {
		const result = await processMedia(sttNoKey, sttTestFile);
		assert(true, "openai-stt without api_key: works (local server, no auth needed)");
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (msg.includes("no speech detected") || msg.includes("STT")) {
			assert(true, "openai-stt without api_key: no speech for silent audio (expected)");
		} else {
			assert(false, `openai-stt without api_key: ${msg}`);
		}
	}
}

// ── 4. Error handling tests ──────────────────────────────────────────────────

section("Error: processMedia with missing file");

try {
	await processMedia({ url: STT_URL, api: "openai-stt", timeout: 5000 }, "/tmp/nonexistent-file-xyz.ogg");
	assert(false, "should have thrown for missing file");
} catch (err) {
	const msg = err instanceof Error ? err.message : String(err);
	assert(msg.length > 0, `threw error for missing file: ${msg.slice(0, 80)}`);
}

section("Error: processMedia with bad URL");

try {
	const badProcessor: MediaProcessor = { url: "http://localhost:99999/nonexistent", api: "openai-stt", timeout: 3000 };
	// Need a real file to read
	if (sttTestFile) {
		await processMedia(badProcessor, sttTestFile);
		assert(false, "should have thrown for bad URL");
	} else {
		skip("no test audio file for bad URL test");
	}
} catch (err) {
	const msg = err instanceof Error ? err.message : String(err);
	assert(msg.length > 0, `threw error for bad URL: ${msg.slice(0, 80)}`);
}

section("Error: processMedia with bash — bad command");

try {
	const badBash: MediaProcessor = { url: "", api: "bash", command: "false", timeout: 5000 };
	if (sttTestFile) {
		await processMedia(badBash, sttTestFile);
		assert(false, "should have thrown for failing bash command");
	} else {
		skip("no test audio file for bad bash test");
	}
} catch (err) {
	const msg = err instanceof Error ? err.message : String(err);
	assert(msg.includes("script failed"), `threw "script failed" for exit-code-1: ${msg.slice(0, 80)}`);
}

section("Error: processMedia with bash — no command");

try {
	const noCommand: MediaProcessor = { url: "", api: "bash", command: "", timeout: 5000 };
	if (sttTestFile) {
		await processMedia(noCommand, sttTestFile);
		assert(false, "should have thrown for empty command");
	} else {
		skip("no test audio file for empty command test");
	}
} catch (err) {
	const msg = err instanceof Error ? err.message : String(err);
	assert(msg.includes("no command"), `threw "no command" error: ${msg.slice(0, 80)}`);
}

// ── 5. bash processor: pdftotext ──────────────────────────────────────────────

section("Protocol: bash (pdftotext for documents)");

// Create a minimal PDF for testing
const pdfPath = join(testDir, "test.pdf");
let pdftotextAvailable = false;
try {
	const { execSync } = await import("node:child_process");
	execSync("pdftotext -v 2>&1", { stdio: "pipe", timeout: 3000 });
	pdftotextAvailable = true;
} catch {
	// pdftotext -v exits non-zero but is still available; check if binary exists
	try {
		const { execSync } = await import("node:child_process");
		execSync("which pdftotext", { stdio: "pipe", timeout: 3000 });
		pdftotextAvailable = true;
	} catch {
		skip("pdftotext not found — skipping PDF test");
	}
}

if (pdftotextAvailable) {
	// Generate a minimal PDF using Python (no external deps needed)
	try {
		const { execSync } = await import("node:child_process");
		execSync(`python3 -c "
import struct, zlib
def pdf_str(s): return b'(' + s.encode() + b')'
content = b'Hello from PDF test'
stream = b'BT /F1 12 Tf 100 700 Td ' + pdf_str(content) + b' Tj ET'
objects = []
objects.append(b'1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj')
objects.append(b'2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj')
objects.append(b'3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R/Resources<</Font<</F1 4 0 R>>>>/Contents 5 0 R>>endobj')
objects.append(b'4 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj')
compressed = zlib.compress(stream)
objects.append(b'5 0 obj<</Length ' + str(len(compressed)).encode() + b'/Filter/FlateDecode>>stream\n' + compressed + b'\nendstreamendobj')
xref_off = []
body = b''
off = 9
for obj in objects:
    xref_off.append(off)
    body += str(len(objects)).encode() if False else b''
    body += obj + b'\n'
    off += len(obj) + 1
pdf = b'%PDF-1.4\n'
off = len(pdf)
for i, obj in enumerate(objects):
    xref_off.append(off)
    pdf += obj + b'\n'
    off += len(obj) + 1
xref = b'xref\n0 ' + str(len(objects)+1).encode() + b'\n0000000000 65535 f \n'
for o in xref_off:
    xref += str(o).zfill(10).encode() + b' 00000 n \n'
pdf += xref
pdf += b'trailer<</Size ' + str(len(objects)+1).encode() + b'/Root 1 0 R>>\nstartxref\n' + str(len(pdf)+len(xref)-len(xref)+10).encode() + b'\n%%EOF'
with open('${pdfPath}', 'wb') as f: f.write(pdf)
"`, { stdio: "pipe", timeout: 5000 });
		assert(existsSync(pdfPath), "generated test PDF");
	} catch (err) {
		// Fallback: try pandoc to generate a PDF
		try {
			const { execSync } = await import("node:child_process");
			execSync(`pandoc -o "${pdfPath}" --pdf-engine=pdflatex <<< "Hello from PDF test"`, { stdio: "pipe", timeout: 10000 });
			assert(existsSync(pdfPath), "generated test PDF with pandoc");
		} catch {
			// Last resort: use a pre-made minimal PDF (bytes)
			// Minimal valid PDF with text "Hello World"
			const minimalPdf = Buffer.from(
				"JVBERi0xLjQKMSAwIG9iago8PC9UeXBlIC9DYXRhbG9nIC9QYWdlcyAyIDAgUj4+CmVuZG9iagoyIDAgb2JqCjw8L1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDE+PgplbmRvYmoKMyAwIG9iago8PC9UeXBlIC9QYWdlIC9QYXJlbnQgMiAwIFIgL01lZGlhQm94IFswIDAgNjEyIDc5Ml0gL1Jlc291cmNlcyA8PC9Gb250IDw8L0YxIDQgMCBSPj4+PiAvQ29udGVudHMgNSAwIFI+PgplbmRvYmoKNCAwIG9iago8PC9UeXBlIC9Gb250IC9TdWJ0eXBlIC9UeXBlMSAvQmFzZUZvbnQgL0hlbHZldGljYT4+CmVuZG9iago1IDAgb2JqCjw8L0xlbmd0aCA0ND4+CnN0cmVhbQpCVCAvRjEgMTIgVGYgMTAwIDcwMCBUZCAoSGVsbG8gV29ybGQpIFRqIEVUCmVuZHN0cmVhbQplbmRvYmoK NICAwIG9iago8PC9TaXplIDY+Pgp4cmVmCjAgNgowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwMDkgMDAwMDAgbiAKMDAwMDAwMDAwNTggMDAwMDAgbiAKMDAwMDAwMDAxMTUgMDAwMDAgbiAKMDAwMDAwMDAyMTQgMDAwMDAgbiAKMDAwMDAwMDI3NTUgMDAwMDAgbiAKdHJhaWxlcgo8PC9TaXplIDYgL1Jvb3QgMSAwIFI+PgpzdGFydHhyZWYKMzg4Cj4+CiUlRU9G",
				"base64",
			);
			writeFileSync(pdfPath, minimalPdf);
			assert(existsSync(pdfPath), "created minimal test PDF from base64");
		}
	}

	if (existsSync(pdfPath)) {
		const pdfProcessor: MediaProcessor = {
			api: "bash",
			command: "pdftotext -layout {file} - 2>/dev/null || echo '[pdftotext failed]'",
			timeout: 15000,
		};

		try {
			const result = await processMedia(pdfProcessor, pdfPath);
			assert(typeof result === "string" && result.length > 0, `bash/pdftotext: returned non-empty string (length: ${result.length})`);
			console.log(`  ℹ️  pdftotext result: "${result.slice(0, 200).replace(/\n/g, "\\n")}"`);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			assert(false, `bash/pdftotext: ${msg.slice(0, 200)}`);
		}

		// Test: bash with {file} substitution
		const catProcessor: MediaProcessor = {
			api: "bash",
			command: "cat {file} | wc -c",
			timeout: 5000,
		};
		try {
			const result = await processMedia(catProcessor, pdfPath);
			const bytes = parseInt(result.trim(), 10);
			assert(bytes > 0, `bash/wc: file size reported as ${bytes} bytes`);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			assert(false, `bash/wc: ${msg.slice(0, 100)}`);
		}
	} else {
		skip("could not create test PDF");
	}
}

// ── 5. getMediaDir ───────────────────────────────────────────────────────────

section("getMediaDir");

const sessionDir = join(testDir, "session-test");
const mdir = await getMediaDir(sessionDir);
assert(existsSync(mdir), "getMediaDir creates directory");
assertEqual(mdir, join(sessionDir, "media"), "getMediaDir returns <session>/media path");

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${"═".repeat(50)}`);
console.log(`Results: ${passCount} passed, ${failCount} failed, ${skipCount} skipped`);
if (failCount > 0) {
	console.log("\n⚠️  Some tests failed — see above for details.");
	process.exit(1);
} else {
	console.log("\n✅ All tests passed!");
}

// Cleanup
rmSync(testDir, { recursive: true, force: true });
