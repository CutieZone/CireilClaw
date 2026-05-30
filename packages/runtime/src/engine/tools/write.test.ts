import { describe, expect, it } from "vitest";

import type { ToolContext } from "#engine/tools/tool-def.js";
import { write } from "#engine/tools/write.js";

describe("write tool schema", () => {
  it("rejects the /blocks directory as a file target", async () => {
    await expect(
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      write.execute({ content: "", path: "/blocks" }, {} as ToolContext),
    ).rejects.toThrow("Files in /blocks/ must end with .md extension");
  });
});
