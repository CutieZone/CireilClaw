import type { ImageContent, TextContent, ToolCallContent, ToolResponseContent } from "./content.js";
import type { Role } from "./role.js";

interface BaseMessage {
  role: Role;
}

type UserContent = TextContent | ImageContent;

interface UserMessage extends BaseMessage {
  role: "user";
  content: UserContent | UserContent[];
  // If false, this message is included in context but not persisted to DB.
  // Used for reply chain context that shouldn't pollute long-term history.
  persist?: boolean;
}

interface SystemMessage extends BaseMessage {
  role: "system";
  content: TextContent;
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

type Message = UserMessage | ToolMessage | AssistantMessage | SystemMessage;

export type { UserMessage, ToolMessage, AssistantMessage, Message, SystemMessage };
