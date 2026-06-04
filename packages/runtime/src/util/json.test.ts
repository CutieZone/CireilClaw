import { describe, expect, it } from "vitest";

import { parseRepairedJSON, repairJsonEscapes } from "#util/json.js";

describe("repairJsonEscapes", () => {
  it("passes valid JSON through unchanged", () => {
    const valid = '{"key": "value"}';
    expect(repairJsonEscapes(valid)).toBe(valid);
  });

  it(String.raw`preserves valid JSON escape \\`, () => {
    const input = String.raw`{"pattern": "\\d"}`;
    expect(repairJsonEscapes(input)).toBe(input);
    expect(JSON.parse(repairJsonEscapes(input))).toEqual({ pattern: "\\d" });
  });

  it(String.raw`preserves valid JSON escape \"`, () => {
    const input = String.raw`{"key": "he\"llo"}`;
    expect(repairJsonEscapes(input)).toBe(input);
    expect(JSON.parse(repairJsonEscapes(input))).toEqual({ key: 'he"llo' });
  });

  it(String.raw`preserves valid JSON escape \n`, () => {
    const input = String.raw`{"key": "line1\nline2"}`;
    expect(repairJsonEscapes(input)).toBe(input);
    expect(JSON.parse(repairJsonEscapes(input))).toEqual({ key: "line1\nline2" });
  });

  it(String.raw`preserves valid JSON escape \t`, () => {
    const input = String.raw`{"key": "col1\tcol2"}`;
    expect(repairJsonEscapes(input)).toBe(input);
  });

  it(String.raw`preserves valid JSON escape \/`, () => {
    const input = String.raw`{"url": "https:\/\/example.com"}`;
    expect(repairJsonEscapes(input)).toBe(input);
  });

  it(String.raw`preserves valid JSON escape \uXXXX`, () => {
    const input = String.raw`{"key": "\u0041"}`;
    expect(repairJsonEscapes(input)).toBe(input);
    expect(JSON.parse(repairJsonEscapes(input))).toEqual({ key: "A" });
  });

  it(String.raw`repairs \| to \\|`, () => {
    const input = String.raw`{"pattern": "not.*but\|is not"}`;
    const repaired = repairJsonEscapes(input);
    expect(repaired).toBe(String.raw`{"pattern": "not.*but\\|is not"}`);
    expect(JSON.parse(repaired)).toEqual({ pattern: "not.*but\\|is not" });
  });

  it(String.raw`repairs \s to \\s (regex whitespace)`, () => {
    const raw = String.raw`{"pattern": "\s+word"}`;
    expect(() => {
      JSON.parse(raw);
    }).toThrow();
    const repaired = repairJsonEscapes(raw);
    expect(repaired).toBe(String.raw`{"pattern": "\\s+word"}`);
    expect(JSON.parse(repaired)).toEqual({ pattern: "\\s+word" });
  });

  it(String.raw`repairs \( to \\( (regex group)`, () => {
    const raw = String.raw`{"pattern": "\(group\)"}`;
    expect(() => {
      JSON.parse(raw);
    }).toThrow();
    const repaired = repairJsonEscapes(raw);
    expect(JSON.parse(repaired)).toEqual({ pattern: "\\(group\\)" });
  });

  it("repairs the exact error case from grep arguments", () => {
    const raw = String.raw`{"command": "grep", "args": ["-n","-i","not.*but\|isn't.*it's\|is not.*it is","file.md"]}`;
    expect(() => {
      JSON.parse(raw);
    }).toThrow();
    const repaired = repairJsonEscapes(raw);
    const parsed: unknown = JSON.parse(repaired);
    expect(parsed).toEqual({
      args: ["-n", "-i", String.raw`not.*but\|isn't.*it's\|is not.*it is`, "file.md"],
      command: "grep",
    });
  });

  it(String.raw`repairs \d to \\d (regex digit)`, () => {
    const raw = String.raw`{"pattern": "\d+"}`;
    expect(() => {
      JSON.parse(raw);
    }).toThrow();
    const repaired = repairJsonEscapes(raw);
    expect(JSON.parse(repaired)).toEqual({ pattern: "\\d+" });
  });

  it(String.raw`repairs \w to \\w (regex word)`, () => {
    const raw = String.raw`{"pattern": "\w+"}`;
    expect(() => {
      JSON.parse(raw);
    }).toThrow();
    const repaired = repairJsonEscapes(raw);
    expect(JSON.parse(repaired)).toEqual({ pattern: "\\w+" });
  });

  it("does not crash on a trailing backslash before end of input", () => {
    // The JSON is truncated: {"key": "trailing\  (no closing quote)
    // repairJsonEscapes escapes the dangling backslash but the result is
    // still invalid JSON (unterminated string). Verify it doesn't crash.
    const raw = '{"key": "trailing\\';
    const repaired = repairJsonEscapes(raw);
    expect(repaired).toBe(String.raw`{"key": "trailing\\`);
    expect(() => {
      JSON.parse(repaired);
    }).toThrow();
  });

  it(String.raw`preserves already-correct \\|`, () => {
    const raw = String.raw`{"pattern": "\\|"}`;
    expect(() => {
      JSON.parse(raw);
    }).not.toThrow();
    expect(JSON.parse(raw)).toEqual({ pattern: "\\|" });
    expect(repairJsonEscapes(raw)).toBe(raw);
  });

  it("handles mixed valid and invalid escapes", () => {
    const raw = String.raw`{"a": "\n\t", "b": "\|"}`;
    expect(() => {
      JSON.parse(raw);
    }).toThrow();
    const repaired = repairJsonEscapes(raw);
    const parsed: unknown = JSON.parse(repaired);
    // oxlint-disable-next-line id-length
    expect(parsed).toEqual({ a: "\n\t", b: "\\|" });
  });

  it("is a no-op on valid JSON with no escapes", () => {
    const input = '{"key": "simple value", "num": 42}';
    expect(repairJsonEscapes(input)).toBe(input);
  });

  it("handles empty string", () => {
    expect(repairJsonEscapes("")).toBe("");
  });
});

describe("parseRepairedJSON", () => {
  it("parses valid JSON normally", () => {
    expect(parseRepairedJSON('{"key": "value"}')).toEqual({ key: "value" });
  });

  it("repairs and parses invalid JSON with bad escapes", () => {
    const raw = String.raw`{"pattern": "\s+"}`;
    expect(parseRepairedJSON(raw)).toEqual({ pattern: "\\s+" });
  });

  it("throws original error when repair also fails", () => {
    expect(() => parseRepairedJSON("not json at all {")).toThrow(SyntaxError);
  });

  it("handles empty object", () => {
    expect(parseRepairedJSON("{}")).toEqual({});
  });

  it("handles escaped quotes in repaired content", () => {
    const raw = String.raw`{"key": "he\"llo \| world"}`;
    expect(parseRepairedJSON(raw)).toEqual({ key: 'he"llo \\| world' });
  });
});
