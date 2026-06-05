import { toJsonSchema } from "@valibot/to-json-schema";
import type { JsonSchema } from "@valibot/to-json-schema";
import type { GenericSchema } from "valibot";

/**
 * Recursively clones a value, replacing any `RegExp` instance with an
 * equivalent one without flags. Needed because `@valibot/to-json-schema`
 * throws on regex flags — JSON Schema's `pattern` keyword does not support
 * them.
 *
 * This is a structural clone: known valibot schema shapes are walked so the
 * result stays isomorphic to the input for valibot's purposes.
 */
function stripRegexFlags(value: unknown): unknown {
  if (value instanceof RegExp) {
    // Flags like /u are meaningless for JSON Schema pattern. The source is
    // all that matters.
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
 * Converts a Valibot schema to JSON Schema, safely handling any regex
 * actions that carry flags (which `@valibot/to-json-schema` rejects).
 */
export function toJsonSchemaSafe(
  schema: GenericSchema,
  config?: Parameters<typeof toJsonSchema>[1],
): JsonSchema {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return toJsonSchema(stripRegexFlags(schema) as Parameters<typeof toJsonSchema>[0], config);
}
