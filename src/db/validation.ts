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

// Schema for image reference blocks in serialized history
const ImageRefSchema = vb.strictObject({
  id: vb.pipe(vb.string(), vb.nonEmpty()),
  mediaType: vb.pipe(vb.string(), vb.nonEmpty()),
  type: vb.literal("image_ref"),
});

type ImageRef = vb.InferOutput<typeof ImageRefSchema>;

// Helper to check if an unknown value is an ImageRef
function isImageRef(value: unknown): value is ImageRef {
  return vb.is(ImageRefSchema, value);
}

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

export {
  DiscordMetaSchema,
  ImageRefSchema,
  MatrixMetaSchema,
  SerializedHistorySchema,
  SerializedMessageSchema,
  isImageRef,
};
export type { DiscordMeta, ImageRef, MatrixMeta, SerializedHistory, SerializedMessage };
