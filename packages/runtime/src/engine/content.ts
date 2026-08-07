interface TextContent {
  type: "text";
  content: string;
  discord?: DiscordTextMetadata;
}

interface DiscordTextMetadata {
  format: "message" | "assistant";
  messageId?: string;
  timestamp: string;
  author?: { id: string; username: string; displayName: string };
  inReplyTo?: string;
  mentionsYou?: boolean;
}

function renderTextContent(content: TextContent): string {
  const metadata = content.discord;
  if (metadata === undefined) {
    return content.content;
  }
  if (metadata.format === "assistant") {
    const messageId = metadata.messageId === undefined ? "" : ` id="${metadata.messageId}"`;
    return `<assistant-context timestamp="${metadata.timestamp}"${messageId}>${content.content}</assistant-context>`;
  }
  const { author } = metadata;
  if (author === undefined) {
    return content.content;
  }
  const reply = metadata.inReplyTo === undefined ? "" : ` in-reply-to="${metadata.inReplyTo}"`;
  const mention = metadata.mentionsYou === true ? ' mentions="YOU"' : "";
  const messageId = metadata.messageId === undefined ? "" : ` id="${metadata.messageId}"`;
  return `<msg from="${author.username} <${author.id}>" displayName="${author.displayName}" timestamp="${metadata.timestamp}"${messageId}${reply}${mention}>${content.content}</msg>`;
}

interface ImageContent {
  type: "image";
  data: Uint8Array;
  mediaType: string;
  // Cached base64 encoding. Stored with the format it was encoded in so that
  // a JPEG-mode provider can detect and skip a WebP-encoded cache entry.
  memoized?: { data: string; kind: "webp" | "jpeg" };
  // Cached file-upload ID from a provider-specific files API (e.g. Kimi ms://).
  // `uploadedAt` is a Unix timestamp (ms) — these handles expire server-side,
  // so the ID is only reusable for a short window after upload.
  filesApiMemoized?: { fileId: string; mode: string; uploadedAt: number };
}

interface ImageRef {
  type: "image_ref";
  id: string;
  mediaType: string;
}

function isImageRef(obj: unknown): obj is ImageRef {
  return typeof obj === "object" && obj !== null && "type" in obj && obj.type === "image_ref";
}

interface VideoContent {
  type: "video";
  // Original CDN URL — stored so it can be serialized into a VideoRef without disk storage.
  url: string;
  // Discord attachment ID — kept for URL refresh in /repair.
  attachmentId: string;
  data: Uint8Array;
  mediaType: string;
  memoized?: { data: string };
  // Cached file-upload ID from a provider-specific files API (e.g. Kimi ms://).
  // `uploadedAt` is a Unix timestamp (ms) — these handles expire server-side,
  // so the ID is only reusable for a short window after upload.
  filesApiMemoized?: { fileId: string; mode: string; uploadedAt: number };
}

interface VideoRef {
  type: "video_ref";
  url: string;
  attachmentId: string;
  mediaType: string;
}

function isVideoRef(obj: unknown): obj is VideoRef {
  return typeof obj === "object" && obj !== null && "type" in obj && obj.type === "video_ref";
}

function isVideoContent(obj: unknown): obj is VideoContent {
  return typeof obj === "object" && obj !== null && "type" in obj && obj.type === "video";
}

interface ToolCallContent {
  type: "toolCall";
  input: unknown;
  name: string;
  id: string;
}

interface ToolResponseContent {
  type: "toolResponse";
  output: unknown;
  name: string;
  id: string;
}

// Media smuggled back through a tool response. Providers that refuse video in
// user messages (Kimi's coding endpoint) only accept it in a tool message, so
// the engine fakes a tool call and parks the blocks in `output._media`. That
// puts them one level below ordinary content parts — every pass that walks
// media (encoding, uploading, persisting) has to look here too, or the blocks
// silently skip it.
function toolResponseMedia(content: unknown): Content[] | undefined {
  if (
    typeof content !== "object" ||
    content === null ||
    !("type" in content) ||
    content.type !== "toolResponse" ||
    !("output" in content)
  ) {
    return undefined;
  }

  const { output } = content;
  if (typeof output !== "object" || output === null || !("_media" in output)) {
    return undefined;
  }

  const media = output["_media"];
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return Array.isArray(media) ? (media as Content[]) : undefined;
}

interface ThinkingContent {
  type: "thinking";
  thinking: string;
  // Anthropic-issued signature required to re-send the block in history.
  // Absent for OAI-compatible providers that use reasoning_content instead.
  signature?: string;
}

interface RedactedThinkingContent {
  type: "redacted_thinking";
  // Opaque base64 blob from Anthropic; must be echoed back verbatim.
  data: string;
}

type Content =
  | TextContent
  | ImageContent
  | ImageRef
  | VideoContent
  | VideoRef
  | ToolCallContent
  | ToolResponseContent
  | ThinkingContent
  | RedactedThinkingContent;

export { isImageRef, isVideoRef, isVideoContent, renderTextContent, toolResponseMedia };
export type {
  TextContent,
  DiscordTextMetadata,
  ImageContent,
  ImageRef,
  VideoContent,
  VideoRef,
  ToolCallContent,
  ToolResponseContent,
  ThinkingContent,
  RedactedThinkingContent,
  Content,
};
