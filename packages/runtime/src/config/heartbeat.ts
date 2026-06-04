import * as vb from "valibot";

import { nonEmptyString } from "#config/schemas/shared.js";

const ActiveHoursSchema = vb.strictObject({
  end: vb.pipe(vb.string(), vb.nonEmpty(), vb.regex(/^\d{2}:\d{2}$/, "Must be HH:MM format")),
  start: vb.pipe(vb.string(), vb.nonEmpty(), vb.regex(/^\d{2}:\d{2}$/, "Must be HH:MM format")),
  timezone: vb.pipe(vb.string(), vb.nonEmpty()),
});

const HeartbeatVisibilitySchema = vb.strictObject({
  showAlerts: vb.exactOptional(vb.boolean(), true),
  showOk: vb.exactOptional(vb.boolean(), false),
  useIndicator: vb.exactOptional(vb.boolean(), true),
});

const HeartbeatConfigSchema = vb.strictObject({
  activeHours: vb.exactOptional(ActiveHoursSchema),
  enabled: vb.exactOptional(vb.boolean(), false),
  interval: vb.exactOptional(vb.pipe(vb.number(), vb.integer(), vb.minValue(60)), 1800),
  model: vb.exactOptional(nonEmptyString),
  provider: vb.exactOptional(nonEmptyString),
  target: vb.exactOptional(vb.pipe(vb.string(), vb.nonEmpty()), "last"),
  visibility: vb.exactOptional(HeartbeatVisibilitySchema, {
    showAlerts: true,
    showOk: false,
    useIndicator: true,
  }),
});

type HeartbeatConfig = vb.InferOutput<typeof HeartbeatConfigSchema>;

export { HeartbeatConfigSchema };
export type { HeartbeatConfig };
