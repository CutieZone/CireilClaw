import type { ToolContext, ToolDef } from "$/engine/tools/tool-def.js";

import { sandboxToReal, sanitizeError } from "$/util/paths.js";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import * as vb from "valibot";

const Schema = vb.strictObject({
  new_text: vb.pipe(vb.string(), vb.nonEmpty()),
  old_text: vb.pipe(vb.string(), vb.nonEmpty()),
  path: vb.pipe(vb.string(), vb.nonEmpty()),
});

// oxlint-disable-next-line sort-keys
export const strReplace: ToolDef = {
  name: "str-replace",
  parameters: Schema,
  description:
    "Find and replace exactly one occurrence of a literal string in an existing file.\n\n" +
    "Both `old_text` and `new_text` must be non-empty. The match is exact — whitespace, indentation, and newlines all matter. On success, returns a few lines of context around the replacement.\n\n" +
    "Error conditions:\n" +
    "- `old_text` not found in the file → include more surrounding context to verify your match.\n" +
    "- `old_text` found more than once → include additional surrounding lines to disambiguate.\n\n" +
    "Tips:\n" +
    "- To delete lines, set `new_text` to the surrounding context with the target lines removed.\n" +
    "- Use `read` or `open-file` first to see the current file contents and craft an accurate match.\n\n" +
    "When NOT to use:\n" +
    "- Creating new files or rewriting an entire file — use `write` instead.\n" +
    "- The file doesn't exist yet — use `write` instead.",
  async execute(input: unknown, ctx: ToolContext): Promise<Record<string, unknown>> {
    try {
      const data = vb.parse(Schema, input);

      const path = sandboxToReal(data.path, ctx.agentSlug);
      if (!existsSync(path)) {
        return {
          error: `File at ${data.path} does not exist.`,
          hint: "Did you mean to use the 'write' tool?",
          success: false,
        };
      }

      const content = await readFile(path, "utf8");

      if (!content.includes(data.old_text)) {
        return {
          error: `File does not contain old_text`,
          success: false,
        };
      }

      let instances = 0;
      let idx: number | undefined = undefined;

      while ((idx = content.indexOf(data.old_text, idx)) !== -1) {
        instances++;
        idx += data.old_text.length;
      }

      if (instances > 1) {
        return {
          error: `File contains ${instances} instances of old_text.`,
          hint: "Add more context to get a precise match.",
          success: false,
        };
      }

      const newContent = content.replace(data.old_text, data.new_text);
      await writeFile(path, newContent, "utf8");

      // Find line numbers for context (from new content)
      // Use the position of old_text in the original content to find the right spot
      const oldTextPos = content.indexOf(data.old_text);
      const lineIndex = newContent.slice(0, oldTextPos).split("\n").length;
      const contextLines = 2;
      const newLines = newContent.split("\n");
      const contextStart = Math.max(0, lineIndex - contextLines - 1);
      const contextEnd = Math.min(newLines.length, lineIndex + contextLines);

      return {
        context: newLines.slice(contextStart, contextEnd).join("\n"),
        success: true,
      };
    } catch (error: unknown) {
      if (error instanceof vb.ValiError) {
        return {
          error: error.cause,
          issues: error.issues,
          message: error.message,
          success: false,
        };
      }

      return {
        error: sanitizeError(error, ctx.agentSlug),
        hint: "Report this to the user, do not continue",
        message: "Error occurred during tool execution.",
        success: false,
      };
    }
  },
};
