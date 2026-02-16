import { sandboxToReal, sanitizeError } from "$/util/paths.js";
import { readFile } from "node:fs/promises";
import * as vb from "valibot";

import type { ToolContext, ToolDef } from "./tool-def.js";

const SkillSchema = vb.strictObject({
  slug: vb.pipe(vb.string(), vb.nonEmpty()),
});

const readSkill: ToolDef = {
  description:
    "Load the full contents of a skill. Use when a task matches one of your available skills and you need the detailed process, pitfalls, and examples before proceeding.",
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
