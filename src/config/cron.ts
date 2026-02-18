import * as vb from "valibot";

const CronModelSchema = vb.strictObject({
  apiBase: vb.pipe(vb.string(), vb.nonEmpty(), vb.url()),
  apiKey: vb.exactOptional(vb.pipe(vb.string(), vb.nonEmpty()), "not-needed"),
  model: vb.pipe(vb.string(), vb.nonEmpty()),
});

// Schedule variants:
// every: run every N seconds (min 60)
// cron: standard cron expression (parsed by croner)
// at: one-shot at a specific ISO 8601 timestamp
const EveryScheduleSchema = vb.strictObject({
  every: vb.pipe(vb.number(), vb.integer(), vb.minValue(60)),
});

const CronExpressionScheduleSchema = vb.strictObject({
  cron: vb.pipe(vb.string(), vb.nonEmpty()),
});

const AtScheduleSchema = vb.strictObject({
  at: vb.pipe(vb.string(), vb.nonEmpty()),
});

const ScheduleSchema = vb.union([
  EveryScheduleSchema,
  CronExpressionScheduleSchema,
  AtScheduleSchema,
]);

const CronJobConfigSchema = vb.strictObject({
  // How to deliver the output of isolated jobs.
  delivery: vb.exactOptional(vb.picklist(["announce", "webhook", "none"]), "announce"),
  enabled: vb.exactOptional(vb.boolean(), true),
  // Whether to run in the main session or an isolated one.
  execution: vb.exactOptional(vb.picklist(["main", "isolated"]), "isolated"),
  id: vb.pipe(vb.string(), vb.nonEmpty()),
  model: vb.exactOptional(CronModelSchema),
  prompt: vb.pipe(vb.string(), vb.nonEmpty()),
  schedule: ScheduleSchema,
  // Session target for announce delivery.
  target: vb.exactOptional(vb.pipe(vb.string(), vb.nonEmpty()), "last"),
  // Webhook URL — only required if delivery = "webhook".
  webhookUrl: vb.exactOptional(vb.pipe(vb.string(), vb.nonEmpty(), vb.url())),
});

const CronConfigSchema = vb.strictObject({
  jobs: vb.exactOptional(vb.array(CronJobConfigSchema), []),
});

type CronJobConfig = vb.InferOutput<typeof CronJobConfigSchema>;
type CronConfig = vb.InferOutput<typeof CronConfigSchema>;
type ScheduleConfig = vb.InferOutput<typeof ScheduleSchema>;

export { CronConfigSchema, CronJobConfigSchema, ScheduleSchema };
export type { CronConfig, CronJobConfig, ScheduleConfig };
