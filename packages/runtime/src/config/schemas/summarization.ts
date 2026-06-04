import * as vb from "valibot";

import { nonEmptyString } from "#config/schemas/shared.js";

const SummarizationConfigSchema = vb.strictObject({
  model: vb.exactOptional(nonEmptyString, undefined),
  provider: vb.exactOptional(nonEmptyString, undefined),
});

type SummarizationConfig = vb.InferOutput<typeof SummarizationConfigSchema>;

export { SummarizationConfigSchema };
export type { SummarizationConfig };
