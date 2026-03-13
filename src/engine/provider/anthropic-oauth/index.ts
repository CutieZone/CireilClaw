import type {
  ImageContent,
  TextContent,
  ToolCallContent,
  ToolResponseContent,
} from "$/engine/content.js";
import type { Context, UsageInfo } from "$/engine/context.js";
import type { AssistantMessage, Message } from "$/engine/message.js";
import type { Tool } from "$/engine/tool.js";
import { debug } from "$/output/log.js";
import { encode } from "$/util/base64.js";
import type { KeyPool } from "$/util/key-pool.js";
import { toJsonSchema } from "@valibot/to-json-schema";

const API_URL = "https://api.anthropic.com/v1/messages";

interface AnthropicTextBlock {
  type: "text";
  text: string;
}

interface AnthropicImageBlock {
  type: "image";
  source: {
    type: "base64";
    media_type: string;
    data: string;
  };
}

interface AnthropicToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

interface AnthropicToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
}

type AnthropicUserContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicToolResultBlock;
type AnthropicAssistantContentBlock = AnthropicTextBlock | AnthropicToolUseBlock;

interface AnthropicUserMessage {
  role: "user";
  content: AnthropicUserContentBlock[];
}

interface AnthropicAssistantMessage {
  role: "assistant";
  content: AnthropicAssistantContentBlock[];
}

type AnthropicMessage = AnthropicUserMessage | AnthropicAssistantMessage;

function translateText(content: TextContent): AnthropicTextBlock {
  return { text: content.content, type: "text" };
}

function translateImage(content: ImageContent): AnthropicImageBlock {
  return {
    source: {
      data: encode(content.data),
      media_type: content.mediaType,
      type: "base64",
    },
    type: "image",
  };
}

function translateToolResponse(content: ToolResponseContent): AnthropicToolResultBlock {
  const outputStr =
    typeof content.output === "object" && content.output !== null
      ? // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        JSON.stringify({ name: content.name, ...(content.output as Record<string, unknown>) })
      : JSON.stringify({ name: content.name, output: content.output });
  return {
    content: outputStr,
    tool_use_id: content.id,
    type: "tool_result",
  };
}

// Translates internal messages to Anthropic API format.
// Key differences from OAI: toolResponse messages must be merged into a single user message,
// and any immediately following user message (typically pending images) is absorbed into that block.
// Also filters out orphaned tool_result blocks that lack matching tool_use in the preceding assistant message.
function translateMessages(messages: Message[]): AnthropicMessage[] {
  const result: AnthropicMessage[] = [];
  let lastToolUseIds = new Set<string>();

  for (let idx = 0; idx < messages.length; ) {
    const msg = messages[idx];
    if (msg === undefined) {
      break;
    }

    if (msg.role === "toolResponse") {
      const blocks: AnthropicUserContentBlock[] = [];

      for (;;) {
        const current = messages[idx];
        if (current?.role !== "toolResponse") {
          break;
        }
        if (lastToolUseIds.has(current.content.id)) {
          blocks.push(translateToolResponse(current.content));
        }
        idx++;
      }

      const next = messages[idx];
      if (next?.role === "user") {
        const userContent = Array.isArray(next.content) ? next.content : [next.content];
        for (const block of userContent) {
          if (block.type === "text") {
            blocks.push(translateText(block));
          } else {
            blocks.push(translateImage(block));
          }
        }
        idx++;
      }

      if (blocks.length > 0) {
        result.push({ content: blocks, role: "user" });
      }
    } else if (msg.role === "user") {
      const userContent = Array.isArray(msg.content) ? msg.content : [msg.content];
      const blocks: AnthropicUserContentBlock[] = [];
      for (const block of userContent) {
        if (block.type === "text") {
          blocks.push(translateText(block));
        } else {
          blocks.push(translateImage(block));
        }
      }
      result.push({ content: blocks, role: "user" });
      idx++;
    } else if (msg.role === "assistant") {
      const assistantContent = Array.isArray(msg.content) ? msg.content : [msg.content];
      const blocks: AnthropicAssistantContentBlock[] = [];
      lastToolUseIds = new Set<string>();
      for (const block of assistantContent) {
        if (block.type === "toolCall") {
          blocks.push({ id: block.id, input: block.input, name: block.name, type: "tool_use" });
          lastToolUseIds.add(block.id);
        } else if (block.type === "text") {
          blocks.push({ text: block.content, type: "text" });
        }
      }
      result.push({ content: blocks, role: "assistant" });
      idx++;
    } else {
      idx++;
    }
  }

  return result;
}

function translateTool(tool: Tool): Record<string, unknown> {
  const inputSchema = toJsonSchema(tool.parameters, {
    target: "openapi-3.0",
    typeMode: "input",
  });

  return {
    description: tool.description,
    input_schema: inputSchema,
    name: tool.name,
  };
}

export async function generate(
  context: Context,
  keyPool: KeyPool,
  model: string,
  sampling: { maxTokens?: number; temperature?: number; topP?: number } = {},
): Promise<{ message: AssistantMessage; usage?: UsageInfo }> {
  // Required preamble for the claude-code-20250219 beta — the model checks for this.
  const system = `You are Claude Code, Anthropic's official CLI for Claude.\n${context.systemPrompt}`;

  const body: Record<string, unknown> = {
    cache_control: {
      type: "ephemeral",
    },
    max_tokens: sampling.maxTokens ?? 8192,
    messages: translateMessages(context.messages),
    model,
    system,
    tool_choice: { type: "any" },
    tools: context.tools.map(translateTool),
  };

  if (sampling.temperature !== undefined) {
    body["temperature"] = sampling.temperature;
  }

  if (sampling.topP !== undefined) {
    body["top_p"] = sampling.topP;
  }

  // Track attempted keys to avoid infinite loops
  const attemptedKeys = new Set<string>();

  for (;;) {
    const token = keyPool.getNextKey();

    // If we've already tried this key, all keys have been exhausted
    if (attemptedKeys.has(token)) {
      throw new Error(
        `All API keys have been rate-limited. Please try again later.\n` +
          `Request info:\n` +
          `  - Model: ${model}\n` +
          `  - Keys in pool: ${keyPool.totalCount}\n` +
          `  - Keys available: ${keyPool.availableCount}`,
      );
    }
    attemptedKeys.add(token);

    debug("Starting Anthropic message generation...");
    const resp = await fetch(API_URL, {
      body: JSON.stringify(body),
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "anthropic-beta": "oauth-2025-04-20,claude-code-20250219",
        "anthropic-version": "2023-06-01",
      },
      method: "POST",
    });
    debug("Finished Anthropic message generation...");

    if (!resp.ok) {
      // Check for rate limit (429) - try next key
      if (resp.status === 429) {
        debug(`Rate limited (429) on API key, trying next key...`);
        keyPool.reportFailure(token);
        continue;
      }

      const errorText = await resp.text();
      throw new Error(
        `Anthropic API error (${resp.status}): ${errorText}\n` +
          `  - Model: ${model}\n` +
          `  - Tools: ${context.tools.map((tool) => tool.name).join(", ")}\n` +
          `  - Messages: ${context.messages.length}`,
      );
    }

    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const data = (await resp.json()) as {
      content: {
        id?: string;
        input?: unknown;
        name?: string;
        text?: string;
        type: string;
      }[];
      stop_reason: string;
      usage: {
        input_tokens: number;
        output_tokens: number;
      };
    };

    if (data.stop_reason !== "tool_use") {
      throw new Error(
        `Expected 'tool_use' stop_reason (tool_choice is any), got '${data.stop_reason}'`,
      );
    }

    const toolUseBlocks = data.content.filter((block) => block.type === "tool_use");

    if (toolUseBlocks.length === 0) {
      throw new Error("Expected at least one tool_use block, but got none");
    }

    const message: AssistantMessage = {
      content: toolUseBlocks.map((block) => {
        if (block.id === undefined || block.name === undefined) {
          throw new Error(
            `Anthropic returned tool_use block missing id or name: ${JSON.stringify(block)}`,
          );
        }
        return {
          id: block.id,
          input: block.input ?? {},
          name: block.name,
          type: "toolCall",
        } as ToolCallContent;
      }),
      role: "assistant",
    };

    const usage: UsageInfo = {
      completionTokens: data.usage.output_tokens,
      promptTokens: data.usage.input_tokens,
      systemPromptTokensEst: Math.round(system.length / 4),
    };

    return { message, usage };
  }
}
