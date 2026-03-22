import type {
  ImageContent,
  ImageRef,
  TextContent,
  ToolCallContent,
  ToolResponseContent,
} from "$/engine/content.js";
import type { Role } from "$/engine/role.js";

interface BaseMessage {
  role: Role;
  // Unix timestamp (ms)
  timestamp?: number;
  // Optional unique ID for message deduplication across turns.
  id?: string;
}

type UserContent = TextContent | ImageContent | ImageRef;

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
  // If false, this message is included in context but not persisted to DB.
  persist?: boolean;
}

type Message = UserMessage | ToolMessage | AssistantMessage | SystemMessage;

function isMessage(msg: unknown): msg is Message {
  return typeof msg === "object" && msg !== null && "role" in msg && "content" in msg;
}

export { isMessage };
export type {
  UserMessage,
  ToolMessage,
  AssistantMessage,
  Message,
  SystemMessage,
  UserContent,
  AssistantContent,
};
