import { upsertCronJob } from "$/db/cron.js";
import { ToolError } from "$/engine/errors.js";
import type { ToolContext, ToolDef } from "$/engine/tools/tool-def.js";
import { Harness } from "$/harness/index.js";
import * as vb from "valibot";

const Schema = vb.strictObject({
  at: vb.pipe(
    vb.string(),
    vb.nonEmpty(),
    vb.description(
      "ISO 8601 timestamp for when to run (e.g. 2026-02-20T15:00:00Z). Must be in the future.",
    ),
  ),
  delivery: vb.pipe(
    vb.optional(vb.nullable(vb.picklist(["announce", "none"]))),
    vb.transform((val): "announce" | "none" => val ?? "announce"),
    vb.description(
      'How to deliver the output — "announce" sends it to the session that created the job, "none" discards it. Defaults to "announce".',
    ),
  ),
  id: vb.pipe(
    vb.string(),
    vb.nonEmpty(),
    vb.regex(/^[a-z0-9-]+$/, "ID must be lowercase alphanumeric with hyphens"),
    vb.description(
      "Unique slug-format identifier for this job (e.g. meeting-reminder). Lowercase alphanumeric with hyphens.",
    ),
  ),
  prompt: vb.pipe(
    vb.string(),
    vb.nonEmpty(),
    vb.description("The instruction to execute at the scheduled time."),
  ),
  target: vb.pipe(
    vb.optional(vb.nullable(vb.pipe(vb.string(), vb.nonEmpty()))),
    vb.transform((val): string => val ?? "last"),
    vb.description(
      'Which session to announce results to. Defaults to "last" (most recently active session). You can get the current session id in the correct format by using the session-info tool.',
    ),
  ),
});

const schedule: ToolDef = {
  description: "Schedule a one-shot task to run at a specific time in the future.",
  // oxlint-disable-next-line typescript/require-await
  async execute(input: unknown, ctx: ToolContext): Promise<Record<string, unknown>> {
    const data = vb.parse(Schema, input);

    const at = new Date(data.at);
    if (Number.isNaN(at.getTime())) {
      throw new ToolError("Invalid ISO 8601 timestamp in `at`");
    }
    if (at.getTime() <= Date.now()) {
      throw new ToolError("`at` must be in the future");
    }

    const job = {
      // The schema transforms guarantee these defaults, but valibot's type
      // inference doesn't narrow through vb.optional in a pipe, so we reassert.
      delivery: data.delivery ?? "announce",
      enabled: true as const,
      execution: "isolated" as const,
      id: data.id,
      prompt: data.prompt,
      schedule: { at: data.at },
      target: data.target ?? "last",
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
  },
  name: "schedule",
  parameters: Schema,
};

export { schedule };
