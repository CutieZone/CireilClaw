import * as vb from "valibot";

const ProviderKindSchema = vb.picklist(["openai", "anthropic", "openai-codex"]);
type ProviderKind = vb.InferOutput<typeof ProviderKindSchema>;

export { ProviderKindSchema };
export type { ProviderKind };
