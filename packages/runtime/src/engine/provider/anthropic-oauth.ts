import { DefaultReasoningBudget } from "$/config/schemas/engine.js";
import type {
  ImageContent,
  RedactedThinkingContent,
  TextContent,
  ThinkingContent,
  ToolCallContent,
  ToolResponseContent,
} from "$/engine/content.js";
import type { Context, UsageInfo } from "$/engine/context.js";
import { GenerationNoToolCallsError } from "$/engine/errors.js";
import type { AssistantMessage, Message } from "$/engine/message.js";
import type { Tool } from "$/engine/tool.js";
import { debug } from "$/output/log.js";
import { encode } from "$/util/base64.js";
import { scaleForAnthropic } from "$/util/image.js";
import type { KeyPool } from "@cireilclaw/sdk";
import { toJsonSchema } from "@valibot/to-json-schema";
import * as vb from "valibot";

interface AnthropicTextBlock {
  cache_control?: { type: "ephemeral" };
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

interface AnthropicThinkingBlock {
  type: "thinking";
  thinking: string;
  signature: string;
}

interface AnthropicRedactedThinkingBlock {
  type: "redacted_thinking";
  data: string;
}

type AnthropicUserContentBlock =
  | AnthropicTextBlock
  | AnthropicImageBlock
  | AnthropicToolResultBlock;
type AnthropicAssistantContentBlock =
  | AnthropicTextBlock
  | AnthropicToolUseBlock
  | AnthropicThinkingBlock
  | AnthropicRedactedThinkingBlock;

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

async function translateImage(content: ImageContent): Promise<AnthropicImageBlock> {
  if (content.memoized?.kind === "webp") {
    return {
      source: {
        data: content.memoized.data,
        media_type: content.mediaType,
        type: "base64",
      },
      type: "image",
    };
  }

  const scaled = await scaleForAnthropic(content.data);
  const encoded = encode(scaled);
  content.memoized = { data: encoded, kind: "webp" };

  return {
    source: {
      data: encoded,
      media_type: content.mediaType,
      type: "base64",
    },
    type: "image",
  };
}

function translateToolResponse(content: ToolResponseContent): AnthropicToolResultBlock {
  const outputStr =
    typeof content.output === "object" && content.output !== null
      ? JSON.stringify({
          name: content.name,
          ...vb.parse(vb.record(vb.string(), vb.unknown()), content.output),
        })
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
async function translateMessages(messages: Message[]): Promise<AnthropicMessage[]> {
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
          if (block.type === "image_ref") {
            throw new Error("A block of type image_ref should not exist here.");
          }
          if (block.type === "video" || block.type === "video_ref") {
            throw new Error(
              "Anthropic provider does not support video content — set supportsVideo: false",
            );
          }

          if (block.type === "text") {
            blocks.push(translateText(block));
          } else {
            blocks.push(await translateImage(block));
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
        if (block.type === "image_ref") {
          throw new Error("A block of type image_ref should not exist here.");
        }
        if (block.type === "video" || block.type === "video_ref") {
          throw new Error(
            "Anthropic provider does not support video content — set supportsVideo: false",
          );
        }

        if (block.type === "text") {
          blocks.push(translateText(block));
        } else {
          blocks.push(await translateImage(block));
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
          blocks.push({
            id: block.id,
            input: block.input,
            name: block.name,
            type: "tool_use",
          });
          lastToolUseIds.add(block.id);
        } else if (block.type === "text") {
          blocks.push({ text: block.content, type: "text" });
        } else if (block.type === "thinking" && block.signature !== undefined) {
          // Signature is required to re-send Anthropic thinking blocks.
          blocks.push({
            signature: block.signature,
            thinking: block.thinking,
            type: "thinking",
          });
        } else if (block.type === "redacted_thinking") {
          blocks.push({ data: block.data, type: "redacted_thinking" });
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

interface Options {
  reasoning?: boolean;
  reasoningBudget?: number;
  customHeaders?: Record<string, string | string[]>;
}

export async function generate(
  context: Context,
  apiBase: string,
  keyPool: KeyPool,
  model: string,
  { reasoning = true, reasoningBudget = DefaultReasoningBudget, customHeaders }: Options,
): Promise<{ message: AssistantMessage; usage?: UsageInfo }> {
  // Required preamble for the claude-code-20250219 beta — the model checks for this.
  const system = `You are Claude Code, Anthropic's official CLI for Claude.`;

  const body: Record<string, unknown> = {
    max_tokens: 64_000,
    messages: [
      {
        content: [
          {
            cache_control: {
              type: "ephemeral",
            },
            text: context.systemPrompt,
            type: "text",
          },
        ],
        role: "assistant",
      } satisfies AnthropicMessage,
      ...(await translateMessages(context.messages)),
    ],
    model,
    system,
    tool_choice: { type: "any" },
    tools: context.tools.map((tool, idx, arr) => {
      const translated = translateTool(tool);
      if (idx === arr.length - 1) {
        translated["cache_control"] = { type: "ephemeral" };
      }
      return translated;
    }),
  };

  if (reasoning && reasoningBudget > 0) {
    // Anthropic rejects tool_choice: any when thinking is enabled.
    body["tool_choice"] = { type: "auto" };
    body["thinking"] = { budget_tokens: reasoningBudget, type: "enabled" };
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
    const resp = await fetch(`${apiBase}/messages`, {
      body: JSON.stringify(body),
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "anthropic-beta": "oauth-2025-04-20,claude-code-20250219,interleaved-thinking-2025-05-14",
        "anthropic-version": "2023-06-01",
        ...customHeaders,
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

    const AnthropicResponseSchema = vb.object({
      content: vb.array(
        vb.object({
          data: vb.exactOptional(vb.string()),
          id: vb.exactOptional(vb.string()),
          input: vb.exactOptional(vb.unknown()),
          name: vb.exactOptional(vb.string()),
          signature: vb.exactOptional(vb.string()),
          text: vb.exactOptional(vb.string()),
          thinking: vb.exactOptional(vb.string()),
          type: vb.string(),
        }),
      ),
      stop_reason: vb.string(),
      usage: vb.object({
        input_tokens: vb.number(),
        output_tokens: vb.number(),
      }),
    });

    const data = vb.parse(AnthropicResponseSchema, await resp.json());

    if (data.stop_reason !== "tool_use") {
      const textBlock = data.content.find((block) => block.type === "text");
      throw new GenerationNoToolCallsError(
        typeof textBlock?.text === "string" ? textBlock.text : undefined,
        data.stop_reason,
      );
    }

    const toolUseBlocks = data.content.filter((block) => block.type === "tool_use");

    if (toolUseBlocks.length === 0) {
      throw new Error("Expected at least one tool_use block, but got none");
    }

    // Preserve thinking/redacted_thinking blocks so they can be re-sent in
    // subsequent turns (retained reasoning). Order matters: thinking blocks
    // must appear before the tool_use blocks they preceded.
    const contentBlocks: AssistantMessage["content"] = [];

    for (const block of data.content) {
      if (
        block.type === "thinking" &&
        block.thinking !== undefined &&
        block.signature !== undefined
      ) {
        contentBlocks.push({
          signature: block.signature,
          thinking: block.thinking,
          type: "thinking",
        } as ThinkingContent);
      } else if (block.type === "redacted_thinking" && block.data !== undefined) {
        contentBlocks.push({
          data: block.data,
          type: "redacted_thinking",
        } as RedactedThinkingContent);
      } else if (block.type === "tool_use") {
        if (block.id === undefined || block.name === undefined) {
          throw new Error(
            `Anthropic returned tool_use block missing id or name: ${JSON.stringify(block)}`,
          );
        }
        contentBlocks.push({
          id: block.id,
          input: block.input ?? {},
          name: block.name,
          type: "toolCall",
        } as ToolCallContent);
      }
    }

    const message: AssistantMessage = {
      content: contentBlocks,
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
