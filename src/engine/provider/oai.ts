import type { Content, ToolCallContent } from "$/engine/content.js";
import type { Context } from "$/engine/context.js";
import type { AssistantMessage, Message } from "$/engine/message.js";
import type { Tool } from "$/engine/tool.js";
import type {
  ChatCompletionContentPartImage,
  ChatCompletionContentPartText,
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
  ChatCompletionTool,
} from "openai/resources";

import { encode } from "$/util/base64.js";
import { toJsonSchema } from "@valibot/to-json-schema";
import { OpenAI } from "openai/client.js";

function translateContent(
  content: Content,
): ChatCompletionContentPartImage | ChatCompletionContentPartText {
  // oxlint-disable-next-line default-case
  switch (content.type) {
    case "text":
      return {
        text: content.content,
        type: "text",
      };
    case "image":
      return {
        image_url: { url: encode(content.data) },
        type: "image_url",
      };
    case "toolCall":
    case "toolResponse":
      throw new Error(
        `Content type '${content.type}' should not be translated via translateContent - handled separately in translateMsg`,
      );
  }
}

function translateMsg(message: Message): ChatCompletionMessageParam {
  // oxlint-disable-next-line default-case
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

  const resp = await client.chat.completions.create({
    messages: context.messages.map(translateMsg),
    model: model,
    tool_choice: "required",
    tools: context.tools.map(translateTool),
  });

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
    throw new Error(
      `Expected 'tool_calls' finish reason (tool_choice is required), got '${reason ?? "unknown"}'`,
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
        return {
          id: it.id,
          input: JSON.parse(it.function.arguments),
          name: it.function.name,
          type: "toolCall",
        } as ToolCallContent;
      }
      throw new Error("custom not supported");
    }),
    role: "assistant",
  };
}
