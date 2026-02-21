import type { Content, ToolCallContent } from "$/engine/content.js";
import type { Context } from "$/engine/context.js";
import type { AssistantMessage, Message } from "$/engine/message.js";
import type { Tool } from "$/engine/tool.js";
import { debug } from "$/output/log.js";
import { encode } from "$/util/base64.js";
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

function translateContent(
  content: Content,
): ChatCompletionContentPartImage | ChatCompletionContentPartText {
  switch (content.type) {
    case "text":
      return {
        text: content.content,
        type: "text",
      };
    case "image":
      return {
        image_url: {
          url: `data:${content.mediaType};base64,${encode(content.data)}`,
        },
        type: "image_url",
      };
    case "toolCall":
    case "toolResponse":
      throw new Error(
        `Content type '${content.type}' should not be translated via translateContent - handled separately in translateMsg`,
      );
    default:
      throw new Error("Unreachable");
  }
}

function translateMsg(message: Message): ChatCompletionMessageParam {
  switch (message.role) {
    case "user":
      if (Array.isArray(message.content)) {
        return {
          content: message.content.map(translateContent),
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
        return {
          role: "assistant",
          tool_calls: message.content
            .filter((it) => it.type === "toolCall")
            .map(
              (it) =>
                ({
                  function: {
                    arguments: JSON.stringify(it.input),
                    name: it.name,
                  },
                  id: it.id,
                  type: "function",
                }) as ChatCompletionMessageToolCall,
            ),
        };
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
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const parameters = toJsonSchema(tool.parameters, {
    target: "openapi-3.0",
    typeMode: "input",
  }) as OpenAI.FunctionParameters;

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
  apiKey: string,
  model: string,
): Promise<AssistantMessage> {
  const client = new OpenAI({
    apiKey: apiKey,
    baseURL: apiBase,
  });

  let resp: Awaited<ReturnType<typeof client.chat.completions.create>> | undefined = undefined;
  try {
    debug("Starting chat completion generation...");
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

    resp = await client.chat.completions.create(params);
    debug("Finished chat completion generation...");
  } catch (error) {
    if (error instanceof APIError) {
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
    debug("Content:", choice.message.content);
    throw new Error(
      `Expected 'tool_calls' finish reason (tool_choice is required), got '${reason}'`,
    );
  }

  if (choice.message.tool_calls === undefined) {
    throw new Error("Expected tool calls, but got undefined");
  }

  if (choice.message.tool_calls.length === 0) {
    throw new Error("Expected at least one tool call, but got empty array");
  }

  return {
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
}
