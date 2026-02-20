import * as vb from "valibot";

import { EngineOverrideSchema } from "./schemas.js";

const ActiveHoursSchema = vb.strictObject({
  end: vb.pipe(vb.string(), vb.nonEmpty(), vb.regex(/^\d{2}:\d{2}$/, "Must be HH:MM format")),
  start: vb.pipe(vb.string(), vb.nonEmpty(), vb.regex(/^\d{2}:\d{2}$/, "Must be HH:MM format")),
  timezone: vb.pipe(vb.string(), vb.nonEmpty()),
});

const HeartbeatVisibilitySchema = vb.strictObject({
  // Whether to send non-OK (alert) responses to the channel.
  showAlerts: vb.exactOptional(vb.boolean(), true),
  // Whether to send HEARTBEAT_OK responses to the channel.
  showOk: vb.exactOptional(vb.boolean(), false),
  // Whether to show a typing indicator while the heartbeat runs.
  useIndicator: vb.exactOptional(vb.boolean(), true),
});

const HeartbeatConfigSchema = vb.strictObject({
  activeHours: vb.exactOptional(ActiveHoursSchema),
  enabled: vb.exactOptional(vb.boolean(), false),
  // Interval in seconds between heartbeat pulses. Minimum 60s.
  interval: vb.exactOptional(vb.pipe(vb.number(), vb.integer(), vb.minValue(60)), 1800),
  model: vb.exactOptional(EngineOverrideSchema),
  // Session target: "last" = most recently active session, "none" = skip, or a specific session ID.
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
