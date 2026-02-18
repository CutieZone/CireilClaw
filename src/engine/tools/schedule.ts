import type { ToolContext, ToolDef } from "$/engine/tools/tool-def.js";

import { upsertCronJob } from "$/db/cron.js";
import { Harness } from "$/harness/index.js";
import * as vb from "valibot";

const Schema = vb.strictObject({
  at: vb.pipe(vb.string(), vb.nonEmpty()),
  delivery: vb.exactOptional(vb.picklist(["announce", "none"]), "announce"),
  id: vb.pipe(
    vb.string(),
    vb.nonEmpty(),
    vb.regex(/^[a-z0-9-]+$/, "ID must be lowercase alphanumeric with hyphens"),
  ),
  prompt: vb.pipe(vb.string(), vb.nonEmpty()),
  target: vb.exactOptional(vb.pipe(vb.string(), vb.nonEmpty()), "last"),
});

const schedule: ToolDef = {
  description:
    "Schedule a one-shot task to run at a specific time in the future.\n\n" +
    "Parameters:\n" +
    "- `id`: A unique slug-format identifier for this job (e.g. `meeting-reminder`).\n" +
    "- `at`: ISO 8601 timestamp for when to run (e.g. `2026-02-20T15:00:00Z`).\n" +
    "- `prompt`: The instruction to execute at the scheduled time.\n" +
    "- `delivery` (optional, default `announce`): How to deliver the output — `announce` sends it to the session that created the job, `none` discards it.\n" +
    "- `target` (optional, default `last`): Which session to announce to.",
  // oxlint-disable-next-line typescript/require-await
  async execute(input: unknown, ctx: ToolContext): Promise<Record<string, unknown>> {
    try {
      const data = vb.parse(Schema, input);

      const at = new Date(data.at);
      if (Number.isNaN(at.getTime())) {
        return { error: "Invalid ISO 8601 timestamp in `at`", success: false };
      }
      if (at.getTime() <= Date.now()) {
        return { error: "`at` must be in the future", success: false };
      }

      const job = {
        delivery: data.delivery,
        enabled: true as const,
        execution: "isolated" as const,
        id: data.id,
        prompt: data.prompt,
        schedule: { at: data.at },
        target: data.target,
      };

      // Persist the job so it survives a restart.
      upsertCronJob(ctx.agentSlug, data.id, {
        config: JSON.stringify(job),
        createdAt: new Date().toISOString(),
        nextRun: data.at,
        status: "pending",
        type: "one-shot",
      });

      // Register with the live scheduler.
      const scheduler = Harness.get().getScheduler(ctx.agentSlug);
      if (scheduler !== undefined) {
        scheduler.scheduleDynamic(job);
      }

      return { at: data.at, id: data.id, scheduled: true };
    } catch (error: unknown) {
      if (error instanceof vb.ValiError) {
        return { error: error.message, issues: error.issues, success: false };
      }
      return {
        error: error instanceof Error ? error.message : String(error),
        success: false,
      };
    }
  },
  name: "schedule",
  parameters: Schema,
};

export { schedule };
