import * as vb from "valibot";

import { nonEmptyString } from "#config/schemas/shared.js";

const EveryScheduleSchema = vb.strictObject({
  every: vb.pipe(vb.number(), vb.integer(), vb.minValue(60)),
});

const CronExpressionScheduleSchema = vb.strictObject({
  cron: nonEmptyString,
});

const AtScheduleSchema = vb.strictObject({
  at: nonEmptyString,
});

const ScheduleSchema = vb.union([
  EveryScheduleSchema,
  CronExpressionScheduleSchema,
  AtScheduleSchema,
]);

const CronJobConfigSchema = vb.strictObject({
  delivery: vb.exactOptional(vb.picklist(["announce", "webhook", "none"]), "announce"),
  enabled: vb.exactOptional(vb.boolean(), true),
  execution: vb.exactOptional(vb.picklist(["main", "isolated"]), "isolated"),
  id: nonEmptyString,
  model: vb.exactOptional(nonEmptyString, undefined),
  prompt: nonEmptyString,
  provider: vb.exactOptional(nonEmptyString, undefined),
  schedule: ScheduleSchema,
  target: vb.exactOptional(nonEmptyString, "last"),
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
