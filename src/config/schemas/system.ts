import * as vb from "valibot";

const SystemConfigSchema = vb.strictObject({
  timezone: vb.exactOptional(vb.pipe(vb.string(), vb.nonEmpty())),
});

type SystemConfig = vb.InferOutput<typeof SystemConfigSchema>;

export { SystemConfigSchema };
export type { SystemConfig };
