import * as vb from "valibot";

import { nonEmptyString } from "#config/schemas/shared.js";

const SummarizationConfigSchema = vb.strictObject({
  // The model to use for summarization calls. Defaults to the provider's defaultModel.
  model: vb.exactOptional(nonEmptyString, undefined),
  // The provider backend to use for summarization (must match a key in engine.toml providers).
  provider: vb.exactOptional(nonEmptyString, undefined),
});

type SummarizationConfig = vb.InferOutput<typeof SummarizationConfigSchema>;

export { SummarizationConfigSchema };
export type { SummarizationConfig };
