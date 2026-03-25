import * as vb from "valibot";

// Schema for Discord session metadata stored in the meta column
const DiscordMetaSchema = vb.strictObject({
  channelId: vb.pipe(vb.string(), vb.nonEmpty()),
  guildId: vb.exactOptional(vb.pipe(vb.string(), vb.nonEmpty())),
  isNsfw: vb.exactOptional(vb.boolean()),
});

type DiscordMeta = vb.InferOutput<typeof DiscordMetaSchema>;

// Schema for Matrix session metadata
const MatrixMetaSchema = vb.strictObject({
  roomId: vb.pipe(vb.string(), vb.nonEmpty()),
});

type MatrixMeta = vb.InferOutput<typeof MatrixMetaSchema>;

// Schema for serialized history messages (loose validation for repair tool)
const SerializedMessageSchema = vb.looseObject({
  content: vb.union([vb.string(), vb.array(vb.unknown())]),
  id: vb.exactOptional(vb.string()),
  role: vb.exactOptional(vb.string()),
});

type SerializedMessage = vb.InferOutput<typeof SerializedMessageSchema>;

// Schema for parsing raw history JSON
const SerializedHistorySchema = vb.array(SerializedMessageSchema);

type SerializedHistory = vb.InferOutput<typeof SerializedHistorySchema>;

export { DiscordMetaSchema, MatrixMetaSchema, SerializedHistorySchema, SerializedMessageSchema };
export type { DiscordMeta, MatrixMeta, SerializedHistory, SerializedMessage };
