import * as vb from "valibot";

const ProviderKindSchema = vb.picklist(["openai", "anthropic-oauth"]);
type ProviderKind = vb.InferOutput<typeof ProviderKindSchema>;

export { ProviderKindSchema };
export type { ProviderKind };
