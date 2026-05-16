// ── Telegram Config Schema ────────────────────────────────────────────────────
// Loads telegram.schema.json as the single source of truth and provides
// TypeBox-compatible validation functions.
//
// The JSON Schema file is the canonical schema. This module wraps it for
// runtime use: validation, defaults, error reporting.
// Peer dependency: typebox (provided by pi at runtime)

import type { TSchema } from "typebox";
import { Check, Default, Errors } from "typebox/value";
import schemaJson from "./telegram.schema.json" with { type: "json" };

// Cast the loaded JSON Schema to TSchema for TypeBox Value functions.
// TypeBox schemas are JSON Schema internally, so this is safe.
export const configSchema = schemaJson as unknown as TSchema;

// ── Validation ────────────────────────────────────────────────────────────────

/** Check if a value matches the config schema. */
export function checkConfig(value: unknown): boolean {
	return Check(configSchema, value);
}

/** Apply schema defaults to a partial config. Returns the patched value. */
export function applyDefaults(value: unknown): unknown {
	return Default(configSchema, value);
}

/** Validate config and return human-readable error messages. Empty = valid. */
export function validateConfig(value: unknown): string[] {
	if (checkConfig(value)) return [];
	const errors = Errors(configSchema, value);
	return errors.map((e) => {
		const path = e.instancePath || "(root)";
		return `${path}: ${e.message}`;
	});
}
