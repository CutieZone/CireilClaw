// oxlint-disable-next-line import/no-namespace
import * as vb from "valibot";

const EngineConfigSchema = vb.strictObject({
  alias: vb.exactOptional(vb.pipe(vb.string(), vb.nonEmpty(), vb.slug())),
  apiBase: vb.pipe(vb.string(), vb.nonEmpty(), vb.url()),
  apiKey: vb.exactOptional(vb.pipe(vb.string(), vb.nonEmpty()), "not-needed"),
  model: vb.pipe(vb.string(), vb.nonEmpty()),
});

type EngineConfig = vb.InferOutput<typeof EngineConfigSchema>;

export { EngineConfigSchema };
export type { EngineConfig };
