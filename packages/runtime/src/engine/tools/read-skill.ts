import { readFile } from "node:fs/promises";

import * as vb from "valibot";

import type { ToolContext, ToolDef } from "./tool-def.js";

const SkillSchema = vb.strictObject({
  slug: vb.pipe(
    vb.string(),
    vb.nonEmpty(),
    vb.description('Skill identifier — the directory name under /skills/ (e.g. "code-review").'),
  ),
});

const readSkill: ToolDef = {
  description:
    "Load the full contents of a skill document by its slug. Skills are stored as /skills/{slug}/SKILL.md.\n\n" +
    "Your available skills are listed in the system prompt by slug and description. Call this tool when you need the complete instructions, examples, and pitfalls for a skill before following its process.\n\n" +
    'If you just need to browse available skills, use `list-dir` with path "/skills/" instead.',
  async execute(input: unknown, ctx: ToolContext): Promise<Record<string, unknown>> {
    const data = vb.parse(SkillSchema, input);
    const sandboxPath = `/skills/${data.slug}/SKILL.md`;
    const realPath = await ctx.paths.resolve(sandboxPath);
    const content = await readFile(realPath, "utf8");
    return { content, slug: data.slug, success: true };
  },
  name: "read-skill",
  parameters: SkillSchema,
};

export { readSkill as skill };
