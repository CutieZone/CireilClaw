import { ApiKeySchema } from "$/config/schemas/shared.js";
import * as vb from "valibot";

const BraveSearchSchema = vb.strictObject({
  apiKey: ApiKeySchema,
});

const IntegrationsConfigSchema = vb.partial(
  vb.strictObject({
    brave: BraveSearchSchema,
  }),
);

type IntegrationsConfig = vb.InferOutput<typeof IntegrationsConfigSchema>;

export { IntegrationsConfigSchema };
export type { IntegrationsConfig };
