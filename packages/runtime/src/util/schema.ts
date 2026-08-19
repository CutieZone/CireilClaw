import { toJsonSchema } from "@valibot/to-json-schema";
import type { JsonSchema } from "@valibot/to-json-schema";
import type { GenericSchema } from "valibot";

/**
 * Recursively clones a value, rejecting regex flags that JSON Schema patterns
 * cannot represent. The `u` flag is implicit in JSON Schema's Unicode-aware
 * pattern semantics and is therefore safe to discard.
 *
 * This is a structural clone: known valibot schema shapes are walked so the
 * result stays isomorphic to the input for valibot's purposes.
 */
function stripRegexFlags(value: unknown): unknown {
  if (value instanceof RegExp) {
    const unsupportedFlags = value.flags.replaceAll("u", "");
    if (unsupportedFlags.length > 0) {
      throw new Error(
        `Cannot convert regex /${value.source}/${value.flags} to JSON Schema: ` +
          `unsupported flags '${unsupportedFlags}'`,
      );
    }
    // oxlint-disable-next-line eslint/require-unicode-regexp
    return new RegExp(value.source);
  }
  if (Array.isArray(value)) {
    return value.map((item) => stripRegexFlags(item));
  }
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- valibot schemas are plain dicts
    const entries = Object.entries(value as Record<string, unknown>);
    for (const [key, val] of entries) {
      result[key] = stripRegexFlags(val);
    }
    return result;
  }
  return value;
}

/**
 * Converts a Valibot schema to JSON Schema without silently changing regex
 * validation semantics.
 */
export function toJsonSchemaSafe(
  schema: GenericSchema,
  config?: Parameters<typeof toJsonSchema>[1],
): JsonSchema {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return toJsonSchema(stripRegexFlags(schema) as Parameters<typeof toJsonSchema>[0], config);
}
