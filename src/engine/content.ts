interface TextContent {
  type: "text";
  content: string;
}

interface ImageContent {
  type: "image";
  data: Uint8Array;
  mediaType: string;
}

interface ImageRef {
  type: "image_ref";
  id: string;
  mediaType: string;
}

function isImageRef(obj: unknown): obj is ImageRef {
  return typeof obj === "object" && obj !== null && "type" in obj && obj.type === "image_ref";
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

type Content = TextContent | ImageContent | ImageRef | ToolCallContent | ToolResponseContent;

export { isImageRef };
export type { TextContent, ImageContent, ImageRef, ToolCallContent, ToolResponseContent, Content };
