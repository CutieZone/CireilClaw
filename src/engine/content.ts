interface TextContent {
  type: "text";
  content: string;
}

interface ImageContent {
  type: "image";
  data: ArrayBufferLike;
  mediaType: string;
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

type Content = TextContent | ImageContent | ToolCallContent | ToolResponseContent;

export type { TextContent, ImageContent, ToolCallContent, ToolResponseContent, Content };
