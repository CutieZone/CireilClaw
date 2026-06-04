// oxlint-disable id-length
const VALID_JSON_ESCAPE_CHARS: Record<string, true> = {
  '"': true,
  "/": true,
  "\\": true,
  b: true,
  f: true,
  n: true,
  r: true,
  t: true,
};
// oxlint-enable id-length

const HEX_DIGIT = /^[0-9A-Fa-f]$/u;

/**
 * Repair invalid JSON escape sequences in a string by doubling backslashes
 * that precede characters not recognized as valid JSON escape sequences.
 *
 * LLMs sometimes emit tool-call arguments with regex patterns containing
 * unescaped backslashes (e.g. `\|`, `\s`, `\(`). These are invalid JSON.
 * This function converts them to properly escaped `\\|`, `\\s`, `\\(`, etc.
 *
 * Valid JSON escapes (`\\`, `\"`, `\/`, `\b`, `\f`, `\n`, `\r`, `\t`,
 * `\uXXXX`) are left untouched. Already-escaped backslashes (`\\`) are
 * recognized and preserved.
 *
 * This is a no-op on valid JSON.
 */
function repairJsonEscapes(json: string): string {
  const parts: string[] = [];
  // oxlint-disable id-length
  let i = 0;
  // oxlint-enable id-length

  while (i < json.length) {
    const ch = json.charAt(i);
    if (ch === "\\") {
      const next = json[i + 1];
      if (next === undefined) {
        // Trailing backslash at end of input — escape it.
        parts.push(String.raw`\\`);
        i += 1;
      } else if (next === "u") {
        // \uXXXX — only valid if followed by exactly 4 hex digits.
        if (
          HEX_DIGIT.test(json.charAt(i + 2)) &&
          HEX_DIGIT.test(json.charAt(i + 3)) &&
          HEX_DIGIT.test(json.charAt(i + 4)) &&
          HEX_DIGIT.test(json.charAt(i + 5))
        ) {
          parts.push(
            "\\",
            "u",
            json.charAt(i + 2),
            json.charAt(i + 3),
            json.charAt(i + 4),
            json.charAt(i + 5),
          );
          i += 6;
        } else {
          // Malformed \u — escape the backslash.
          parts.push(String.raw`\\`, "u");
          i += 2;
        }
      } else if (VALID_JSON_ESCAPE_CHARS[next] === undefined) {
        // Invalid escape — insert an extra backslash.
        parts.push(String.raw`\\`, next);
        i += 2;
      } else {
        // Valid JSON escape — pass through unchanged.
        parts.push("\\", next);
        i += 2;
      }
    } else {
      parts.push(ch);
      i += 1;
    }
  }

  return parts.join("");
}

/**
 * Attempt to parse a JSON string, repairing invalid escape sequences if the
 * initial parse fails. Returns the parsed value on success, or throws the
 * original SyntaxError if repair also fails.
 */
function parseRepairedJSON(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch (originalError) {
    try {
      return JSON.parse(repairJsonEscapes(json));
    } catch {
      throw originalError;
    }
  }
}

export { parseRepairedJSON, repairJsonEscapes };
