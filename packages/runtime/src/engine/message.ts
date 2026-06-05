import type {
  ImageContent,
  ImageRef,
  RedactedThinkingContent,
  TextContent,
  ThinkingContent,
  ToolCallContent,
  ToolResponseContent,
  VideoContent,
  VideoRef,
} from "#engine/content.js";
import type { Role } from "#engine/role.js";

interface BaseMessage {
  role: Role;
  // Unix timestamp (ms)
  timestamp?: number;
  // Optional unique ID for message deduplication across turns.
  id?: string;
  // Additional message IDs for the same logical message (e.g. chunked Discord messages).
  // The primary `id` holds the first chunk's ID; messageIds holds all chunk IDs.
  messageIds?: string[];
}

type UserContent = TextContent | ImageContent | ImageRef | VideoContent | VideoRef;

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
  // If false, excluded from persistence. Used for ephemeral prompts like summarizer instructions.
  persist?: boolean;
}

interface ToolMessage extends BaseMessage {
  role: "toolResponse";
  content: ToolResponseContent;
}

type AssistantContent =
  | TextContent
  | ImageContent
  | ToolCallContent
  | ThinkingContent
  | RedactedThinkingContent;

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
