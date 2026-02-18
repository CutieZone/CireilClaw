import { readFile } from "node:fs/promises";

import { sandboxToReal, sanitizeError } from "$/util/paths.js";
import * as vb from "valibot";

import type { ToolContext, ToolDef } from "./tool-def.js";

const SkillSchema = vb.strictObject({
  slug: vb.pipe(vb.string(), vb.nonEmpty()),
});

const readSkill: ToolDef = {
  description:
    "Load the full contents of a skill document by its slug. Skills are markdown files with TOML frontmatter stored in /skills/.\n\n" +
    "Your available skills are listed in the system prompt by name and summary. Call this tool when you need the complete instructions, examples, and pitfalls for a skill before following its process.\n\n" +
    "Parameters:\n" +
    '- `slug`: The skill identifier (filename without .md extension, e.g. "code-review").\n\n' +
    'If you just need to browse the /skills/ directory, use `list-dir` with path "/skills" instead.',
  async execute(input: unknown, ctx: ToolContext): Promise<Record<string, unknown>> {
    try {
      const data = vb.parse(SkillSchema, input);
      const sandboxPath = `/skills/${data.slug}.md`;
      const realPath = sandboxToReal(sandboxPath, ctx.agentSlug);
      const content = await readFile(realPath, "utf8");
      return { content, slug: data.slug, success: true };
    } catch (error: unknown) {
      if (error instanceof vb.ValiError) {
        return { error: error.message, issues: error.issues, success: false };
      }
      return { error: sanitizeError(error, ctx.agentSlug), success: false };
    }
  },
  name: "read-skill",
  parameters: SkillSchema,
};

export { readSkill as skill };
