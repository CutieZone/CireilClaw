import type { Content, ToolCallContent } from "$/engine/content.js";
import type { Context, UsageInfo } from "$/engine/context.js";
import { GenerationNoToolCallsError } from "$/engine/errors.js";
import type { AssistantMessage, Message } from "$/engine/message.js";
import type { Tool } from "$/engine/tool.js";
import { debug, warning } from "$/output/log.js";
import { encode } from "$/util/base64.js";
import type { KeyPool } from "$/util/key-pool.js";
import { toJsonSchema } from "@valibot/to-json-schema";
import { OpenAI } from "openai/client.js";
import { APIError } from "openai/error.js";
import type {
  ChatCompletionContentPartImage,
  ChatCompletionContentPartText,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
  ChatCompletionTool,
} from "openai/resources";
import * as vb from "valibot";

function translateContent(
  content: Content,
): ChatCompletionContentPartImage | ChatCompletionContentPartText {
  switch (content.type) {
    case "text":
      return {
        text: content.content,
        type: "text",
      };
    case "image": {
      const encoded = content.memoizedBase64 ?? encode(content.data);
      content.memoizedBase64 = encoded;
      return {
        image_url: {
          url: `data:${content.mediaType};base64,${encoded}`,
        },
        type: "image_url",
      };
    }
    case "toolCall":
    case "toolResponse":
      throw new Error(
        `Content type '${content.type}' should not be translated via translateContent - handled separately in translateMsg`,
      );
    case "image_ref":
      throw new Error("Content type 'image_ref' should never end up here. How did it?");
    default:
      throw new Error("Unreachable");
  }
}

function translateMsg(message: Message): ChatCompletionMessageParam {
  switch (message.role) {
    case "user":
      if (Array.isArray(message.content)) {
        return {
          content: message.content.map((it) => translateContent(it)),
          role: "user",
        };
      }
      return {
        content: [translateContent(message.content)],
        role: "user",
      };

    case "toolResponse":
      if (typeof message.content.output === "object") {
        return {
          content: JSON.stringify({
            name: message.content.name,
            ...message.content.output,
          }),
          role: "tool",
          tool_call_id: message.content.id,
        };
      }
      return {
        content: JSON.stringify({
          name: message.content.name,
          output: message.content.output,
        }),
        role: "tool",
        tool_call_id: message.content.id,
      };

    case "assistant":
      if (Array.isArray(message.content)) {
        const toolCalls = message.content.filter((it) => it.type === "toolCall");
        const otherContent = message.content.filter((it) => it.type !== "toolCall");

        const result: ChatCompletionMessageParam = { role: "assistant" };

        if (toolCalls.length > 0) {
          result.tool_calls = toolCalls.map(
            (it) =>
              ({
                function: {
                  arguments: JSON.stringify(it.input),
                  name: it.name,
                },
                id: it.id,
                type: "function",
              }) as ChatCompletionMessageToolCall,
          );
        }

        if (otherContent.length > 0) {
          result.content = otherContent
            .filter((it): it is Extract<typeof it, { type: "text" }> => it.type === "text")
            .map((it) => ({ text: it.content, type: "text" }) as const);
        }

        return result;
      }
      if (message.content.type === "text") {
        return {
          content: message.content.content,
          role: "assistant",
        };
      }
      throw new Error(
        `Invalid translation: cannot convert ${message.content.type} into an OAI-compatible format`,
      );

    case "system":
      return {
        content: message.content.content,
        role: "system",
      };

    default:
      throw new Error("Unreachable");
  }
}

function translateTool(tool: Tool): ChatCompletionTool {
  const parameters = vb.parse(
    vb.record(vb.string(), vb.unknown()),
    toJsonSchema(tool.parameters, {
      target: "openapi-3.0",
      typeMode: "input",
    }),
  );

  return {
    function: {
      description: tool.description,
      name: tool.name,
      parameters,
    },
    type: "function",
  };
}

export async function generate(
  context: Context,
  apiBase: string,
  keyPool: KeyPool,
  model: string,
): Promise<{ message: AssistantMessage; usage?: UsageInfo }> {
  // Build params once - they don't change between retries
  const params: ChatCompletionCreateParamsNonStreaming = {
    messages: [
      { content: context.systemPrompt, role: "system" },
      ...context.messages.map(translateMsg),
    ],
    model: model,
    tool_choice: "required",
    tools: context.tools.map(translateTool),
  };

  if (model.includes("kimi") && model.includes("2.5")) {
    params.tool_choice = "auto";
    params.messages.push({
      content: "You ***must*** use a tool to do anything. A text response *will* fail.",
      role: "system",
    });
  }

  // Track attempted keys to avoid infinite loops
  const attemptedKeys = new Set<string>();

  for (;;) {
    const apiKey = keyPool.getNextKey();

    // If we've already tried this key, all keys have been exhausted
    if (attemptedKeys.has(apiKey)) {
      throw new Error(
        `All API keys have been rate-limited. Please try again later.\n` +
          `Request info:\n` +
          `  - Model: ${model}\n` +
          `  - API Base: ${apiBase}\n` +
          `  - Keys in pool: ${keyPool.totalCount}\n` +
          `  - Keys available: ${keyPool.availableCount}`,
      );
    }
    attemptedKeys.add(apiKey);

    const client = new OpenAI({
      apiKey: apiKey,
      baseURL: apiBase,
    });

    let resp: Awaited<ReturnType<typeof client.chat.completions.create>> | undefined = undefined;
    try {
      debug("Starting chat completion generation...");
      resp = await client.chat.completions.create(params);
      debug("Finished chat completion generation...");
    } catch (error) {
      if (error instanceof APIError) {
        // Check for rate limit (429) - try next key
        if (error.status === 429) {
          debug(`Rate limited (429) on API key, trying next key...`);
          keyPool.reportFailure(apiKey);
          continue;
        }

        // Some providers reject tool_choice: "required" with a 400.
        // Fall back to tool_choice: "auto" with a stern message and retry.
        if (error.status === 400 && error.message.toLowerCase().includes("tool_choice")) {
          warning(
            `Model '${model}' rejected tool_choice: required — falling back to tool_choice: auto`,
          );
          params.tool_choice = "auto";
          params.messages.push({
            content:
              "You MUST call a tool. You are not allowed to respond with plain text. Call a tool NOW.",
            role: "system",
          });
          continue;
        }

        const apiErrorDetails: Record<string, unknown> = {
          code: error.code,
          error: error.error,
          message: error.message,
          param: error.param,
          requestID: error.requestID,
          status: error.status,
          type: error.type,
        };
        throw new Error(
          `API Error (${error.status}): ${error.message}\n` +
            `Details: ${JSON.stringify(apiErrorDetails, undefined, 2)}\n` +
            `Request info:\n` +
            `  - Model: ${model}\n` +
            `  - API Base: ${apiBase}\n` +
            `  - Tools: ${context.tools.map((tool) => tool.name).join(", ")}\n` +
            `  - Messages: ${context.messages.length}\n` +
            `  - System prompt length: ${context.systemPrompt.length}`,
          { cause: error },
        );
      }
      throw error;
    }

    // Process successful response
    if (!Array.isArray(resp.choices)) {
      throw new TypeError(
        `Unexpected API response: 'choices' is ${String(resp.choices)} — the model may not support vision, or the request was rejected`,
      );
    }
    const [choice] = resp.choices;

    if (choice === undefined) {
      throw new Error("Could not generate response: unknown reason");
    }

    const reason = choice.finish_reason;

    if (reason === "content_filter") {
      throw new Error("Hit `content_filter`", {
        cause: choice.message.refusal,
      });
    }

    if (reason !== "tool_calls") {
      debug("Failing due to wrong end reason.");
      debug("Message object:", choice.message);

      if (choice.message.tool_calls !== undefined && choice.message.tool_calls.length > 0) {
        debug("Had at least one tool call.");
      }

      const rawText =
        typeof choice.message.content === "string" ? choice.message.content : undefined;
      throw new GenerationNoToolCallsError(rawText, reason);
    }

    if (choice.message.tool_calls === undefined) {
      throw new Error("Expected tool calls, but got undefined");
    }

    if (choice.message.tool_calls.length === 0) {
      throw new Error("Expected at least one tool call, but got empty array");
    }

    const message: AssistantMessage = {
      content: choice.message.tool_calls.map((it) => {
        if (it.type === "function") {
          try {
            return {
              id: it.id,
              input: it.function.arguments.trim() === "" ? {} : JSON.parse(it.function.arguments),
              name: it.function.name,
              type: "toolCall",
            } as ToolCallContent;
          } catch (error: unknown) {
            throw new Error(
              `Failed to parse tool-call arguments into a json object\n ${it.function.arguments}`,
              {
                cause: error,
              },
            );
          }
        }
        throw new Error("custom not supported");
      }),
      role: "assistant",
    };

    let usage: UsageInfo | undefined = undefined;
    if (resp.usage !== undefined) {
      usage = {
        completionTokens: resp.usage.completion_tokens,
        promptTokens: resp.usage.prompt_tokens,
        systemPromptTokensEst: Math.round(context.systemPrompt.length / 4),
      };
    }

    return { message, usage };
  }
}
