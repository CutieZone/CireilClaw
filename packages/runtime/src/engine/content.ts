interface TextContent {
  type: "text";
  content: string;
}

interface ImageContent {
  type: "image";
  data: Uint8Array;
  mediaType: string;
  // Cached base64 encoding. Stored with the format it was encoded in so that
  // a JPEG-mode provider can detect and skip a WebP-encoded cache entry.
  memoized?: { data: string; kind: "webp" | "jpeg" };
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
  // Cached base64 encoding.
  memoized?: { data: string };
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

export { isImageRef, isVideoRef, isVideoContent };
export type {
  TextContent,
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
