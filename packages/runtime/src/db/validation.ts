import * as vb from "valibot";

// Schema for serialized history messages (loose validation for repair tool)
const SerializedMessageSchema = vb.looseObject({
  content: vb.union([vb.string(), vb.array(vb.unknown()), vb.object({})]),
  id: vb.exactOptional(vb.string()),
  role: vb.exactOptional(vb.string()),
});

type SerializedMessage = vb.InferOutput<typeof SerializedMessageSchema>;

// Schema for parsing raw history JSON
const SerializedHistorySchema = vb.array(SerializedMessageSchema);

type SerializedHistory = vb.InferOutput<typeof SerializedHistorySchema>;

export { SerializedHistorySchema, SerializedMessageSchema };
export type { SerializedHistory, SerializedMessage };
