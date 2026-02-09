import type { ImageContent, TextContent, ToolCallContent, ToolResponseContent } from "./content.js";
import type { Role } from "./role.js";

interface BaseMessage {
  role: Role;
}

type UserContent = TextContent | ImageContent;

interface UserMessage extends BaseMessage {
  role: "user";
  content: UserContent | UserContent[];
}

interface ToolMessage extends BaseMessage {
  role: "toolResponse";
  content: ToolResponseContent;
}

type AssistantContent = TextContent | ImageContent | ToolCallContent;

interface AssistantMessage extends BaseMessage {
  role: "assistant";
  content: AssistantContent | AssistantContent[];
}

type Message = UserMessage | ToolMessage | AssistantMessage;

export type { UserMessage, ToolMessage, AssistantMessage, Message };
