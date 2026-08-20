import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import { debug, setLogFile } from "#output/log.js";

const tempDirectory = mkdtempSync(path.join(os.tmpdir(), "cireilclaw-log-"));

afterAll(() => {
  rmSync(tempDirectory, { force: true, recursive: true });
});

describe("logging nested values", () => {
  it("prints nested objects without shallow [Object] placeholders", () => {
    const consoleDebug = vi.spyOn(console, "debug").mockImplementation(() => undefined);
    const input = {
      edits: [
        {
          end: { column: 12, line: 4 },
          start: { column: 1, line: 3 },
        },
      ],
    };

    debug("Tool call", { input });

    const output = consoleDebug.mock.calls[0]?.map(String).join(" ");
    expect(output).toContain("edits");
    expect(output).toContain("column: 12");
    expect(output).not.toContain("[Object]");
    consoleDebug.mockRestore();
  });

  it("keeps nested values intact in the log file", () => {
    const logFile = path.join(tempDirectory, "cireilclaw.log");
    setLogFile(logFile);
    const input = {
      edits: [
        {
          end: { column: 12, line: 4 },
          start: { column: 1, line: 3 },
        },
      ],
    };
    const consoleDebug = vi.spyOn(console, "debug").mockImplementation(() => undefined);

    debug("Tool call", { input });

    const line = readFileSync(logFile, "utf8").trim();
    expect(JSON.parse(line)).toMatchObject({ input });
    expect(line).not.toContain("[Object]");
    consoleDebug.mockRestore();
  });
});
