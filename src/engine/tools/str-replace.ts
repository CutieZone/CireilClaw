import type { ToolDef } from "$/engine/tools/tool-def.js";

import { root, sandboxToReal, sanitizeError } from "$/util/paths.js";
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
    "Replace a single occurrence of text in a file with exact string matching.\n\n" +
    "This tool is ideal for precise, surgical edits. The old_text must match EXACTLY (including whitespace, indentation).\n\n" +
    "Behavior:\n" +
    "- Finds and replaces exactly one occurrence\n" +
    "- Errors if old_text appears multiple times (be more specific)\n" +
    "- Errors if old_text is not found\n" +
    "- Shows context around the replacement on success\n\n" +
    "For creating new files or rewriting entire files, use the `write` tool instead.\n" +
    "To delete single lines, the old_text should be contest with the line included, and new_text without the lines to delete.",
  async execute(input: unknown): Promise<Record<string, unknown>> {
    try {
      const data = vb.parse(Schema, input);

      const path = sandboxToReal(data.path);
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
        error: sanitizeError(error, root()),
        hint: "Report this to the user, do not continue",
        message: "Error occurred during tool execution.",
        success: false,
      };
    }
  },
};
