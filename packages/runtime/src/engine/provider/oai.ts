import type { KeyPool } from "@cireilclaw/sdk";
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

import type { Content, ThinkingContent, ToolCallContent } from "#engine/content.js";
import type { Context, UsageInfo } from "#engine/context.js";
import { GenerationNoToolCallsError } from "#engine/errors.js";
import type { AssistantMessage, Message } from "#engine/message.js";
import type { Tool } from "#engine/tool.js";
import { debug, warning } from "#output/log.js";
import { encode } from "#util/base64.js";
import { toJpeg } from "#util/image.js";

// Per-apiBase JPEG requirement flag. Set on first WebP rejection so subsequent
// turns skip the doomed WebP attempt entirely.
const jpegRequiredEndpoints = new Set<string>();

async function prepareMedia(messages: Message[], useJpeg: boolean): Promise<void> {
  const wantKind = useJpeg ? "jpeg" : "webp";
  for (const msg of messages) {
    const parts = Array.isArray(msg.content) ? msg.content : [msg.content];
    for (const part of parts) {
      if (part.type === "image") {
        if (part.memoized?.kind === wantKind) {
          continue;
        }
        const rawData = useJpeg ? await toJpeg(part.data) : part.data;
        part.memoized = { data: encode(rawData), kind: wantKind };
      } else if (part.type === "video" && part.memoized === undefined) {
        part.memoized = { data: encode(part.data) };
      }
    }
  }
}

async function uploadKimiFile(
  apiBase: string,
  apiKey: string,
  data: Uint8Array,
  mediaType: string,
): Promise<string> {
  const extension = mediaType.split("/")[1] ?? "bin";
  const filename = `upload.${extension}`;
  const blob = new Blob([Buffer.from(data)], { type: mediaType });
  const formData = new FormData();
  formData.append("file", blob, filename);
  formData.append("purpose", "video");

  const resp = await fetch(`${apiBase}/files`, {
    body: formData,
    headers: { Authorization: `Bearer ${apiKey}` },
    method: "POST",
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Kimi file upload failed (${resp.status}): ${text}`);
  }

  const json = vb.parse(vb.object({ id: vb.string() }), await resp.json());
  return json.id;
}

async function uploadMedia(
  messages: Message[],
  apiBase: string,
  keyPool: KeyPool,
  useFilesApi: "kimi" | false,
): Promise<void> {
  if (useFilesApi === false) {
    return;
  }

  for (const msg of messages) {
    const parts = Array.isArray(msg.content) ? msg.content : [msg.content];
    for (const part of parts) {
      if (part.type !== "video") {
        continue;
      }
      if (part.filesApiMemoized?.mode === useFilesApi) {
        continue;
      }

      const apiKey = keyPool.getNextKey();
      const fileId = await uploadKimiFile(apiBase, apiKey, part.data, part.mediaType);
      part.filesApiMemoized = { fileId, mode: useFilesApi };
    }
  }
}

function translateContent(
  content: Content,
):
  | ChatCompletionContentPartImage
  | ChatCompletionContentPartText
  | { type: "video_url"; video_url: { url: string }; fps?: number } {
  switch (content.type) {
    case "text":
      return {
        text: content.content,
        type: "text",
      };
    case "image": {
      const encoded = content.memoized?.data ?? encode(content.data);
      return {
        image_url: {
          url: `data:${content.mediaType};base64,${encoded}`,
        },
        type: "image_url",
      };
    }
    case "video": {
      if (content.filesApiMemoized?.fileId !== undefined) {
        return {
          type: "video_url",
          video_url: { url: `ms://${content.filesApiMemoized.fileId}` },
        };
      }
      const encoded = content.memoized?.data ?? encode(content.data);
      content.memoized = { data: encoded };
      return {
        fps: 10,
        type: "video_url",
        video_url: { url: `data:${content.mediaType};base64,${encoded}` },
      };
    }
    case "toolCall":
    case "toolResponse":
      throw new Error(
        `Content type '${content.type}' should not be translated via translateContent - handled separately in translateMsg`,
      );
    case "thinking":
    case "redacted_thinking":
      throw new Error(
        `Content type '${content.type}' should not be translated via translateContent - handled separately in translateMsg`,
      );
    case "image_ref":
      throw new Error("Content type 'image_ref' should never end up here. How did it?");
    case "video_ref": {
      // Video_ref has no data — it was serialized to disk. Fall back to URL reference.
      return {
        type: "video_url",
        video_url: { url: content.url },
      };
    }
    default:
      throw new Error("Unreachable");
  }
}

function translateMsg(message: Message): ChatCompletionMessageParam {
  switch (message.role) {
    case "user":
      if (Array.isArray(message.content)) {
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        return {
          content: message.content.map((it) => translateContent(it)),
          role: "user",
        } as unknown as ChatCompletionMessageParam;
      }
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      return {
        content: [translateContent(message.content)],
        role: "user",
      } as unknown as ChatCompletionMessageParam;

    case "toolResponse": {
      if (
        typeof message.content.output === "object" &&
        message.content.output !== null &&
        "_media" in message.content.output
      ) {
        debug(
          `useFilesApi=kimi: translating _media tool response (${message.content.name}) with ${vb.parse(vb.array(vb.unknown()), (message.content.output as Record<string, unknown>)["_media"]).length} part(s)`,
        );
        const media = vb.parse(
          vb.array(vb.unknown()),
          (message.content.output as Record<string, unknown>)["_media"],
        );

        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        return {
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion
          content: media.map((it) =>
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion
            translateContent(it as Content),
          ) as unknown as ChatCompletionMessageParam["content"],
          role: "tool",
          tool_call_id: message.content.id,
        } as unknown as ChatCompletionMessageParam;
      }
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
    }

    case "assistant": {
      if (Array.isArray(message.content)) {
        const toolCalls = message.content.filter((it) => it.type === "toolCall");
        const textBlocks = message.content.filter((it) => it.type === "text");
        const thinkingBlocks = message.content.filter(
          (it): it is ThinkingContent => it.type === "thinking",
        );

        // reasoning_content is not in the SDK types but is accepted by providers
        // like DeepSeek and QwQ that expose reasoning in OAI-compat responses.
        const msg: Record<string, unknown> = { role: "assistant" };

        if (thinkingBlocks.length > 0) {
          msg["reasoning_content"] = thinkingBlocks.map((it) => it.thinking).join("\n\n");
        }

        if (toolCalls.length > 0) {
          msg["tool_calls"] = toolCalls.map(
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

        if (textBlocks.length > 0) {
          msg["content"] = textBlocks.map((it) => ({ text: it.content, type: "text" }) as const);
        }

        // oxlint-disable-next-line typescript/no-unsafe-type-assertions
        return msg as unknown as ChatCompletionMessageParam;
      }
      if (message.content.type === "text") {
        return {
          content: message.content.content,
          role: "assistant",
        };
      }
      if (message.content.type === "thinking") {
        // Single thinking block, so send as reasoning_content with no text content.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertions
        return {
          reasoning_content: message.content.thinking,
          role: "assistant",
        } as unknown as ChatCompletionMessageParam;
      }
      throw new Error(
        `Invalid translation: cannot convert ${message.content.type} into an OAI-compatible format`,
      );
    }

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
  const schema =
    tool.jsonSchema ??
    toJsonSchema(tool.parameters, {
      target: "openapi-3.0",
      typeMode: "input",
    });
  const parameters = vb.parse(vb.record(vb.string(), vb.unknown()), schema);

  return {
    function: {
      description: tool.description,
      name: tool.name,
      parameters,
    },
    type: "function",
  };
}

interface Options {
  forceJpeg?: boolean;
  customHeaders?: Record<string, string | string[]>;
  useToolChoiceAuto?: boolean;
  useFilesApi?: "kimi" | false;
}

const knownKimiOffenders = ["2.5", "-for-code"];

export async function generate(
  context: Context,
  apiBase: string,
  keyPool: KeyPool,
  model: string,
  { forceJpeg = false, customHeaders, useToolChoiceAuto = false, useFilesApi = false }: Options,
): Promise<{ message: AssistantMessage; usage?: UsageInfo }> {
  let useJpeg = forceJpeg || jpegRequiredEndpoints.has(apiBase);
  await prepareMedia(context.messages, useJpeg);
  await uploadMedia(context.messages, apiBase, keyPool, useFilesApi);

  if (useFilesApi === "kimi") {
    for (const msg of context.messages) {
      if (msg.role === "user") {
        const userMsg = msg;
        if (Array.isArray(userMsg.content)) {
          const hadVideo = userMsg.content.some(
            (it) => it.type === "video" || it.type === "video_ref",
          );
          const filtered = userMsg.content.filter(
            (it) => it.type !== "video" && it.type !== "video_ref",
          );
          if (hadVideo) {
            debug(
              `useFilesApi=kimi: stripped ${userMsg.content.length - filtered.length} video(s) from user message`,
            );
          }
          userMsg.content =
            filtered.length > 0 ? filtered : { content: "[video removed]", type: "text" };
        } else if (userMsg.content.type === "video" || userMsg.content.type === "video_ref") {
          debug("useFilesApi=kimi: stripped 1 video from user message");
          userMsg.content = { content: "[video removed]", type: "text" };
        }
      }
    }
  }

  const params: ChatCompletionCreateParamsNonStreaming = {
    messages: [
      { content: context.systemPrompt, role: "system" },
      ...context.messages.map(translateMsg),
    ],
    model,
    tool_choice: "required",
    tools: context.tools.map(translateTool),
  };

  if (
    useToolChoiceAuto ||
    (model.includes("kimi") && knownKimiOffenders.some((it) => model.includes(it)))
  ) {
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
      apiKey,
      baseURL: apiBase,
      defaultHeaders: {
        "HTTP-Referer": "https://github.com/CutieZone/CireilClaw",
        "X-OpenRouter-Categories": "personal-agent,cli-agent",
        "X-OpenRouter-Title": "CireilClaw",
        ...customHeaders,
      },
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
            `Model '${model}' rejected tool_choice: required, falling back to tool_choice: auto`,
          );
          params.tool_choice = "auto";
          params.messages.push({
            content:
              "You MUST call a tool. You are not allowed to respond with plain text. Call a tool NOW.",
            role: "system",
          });
          // This is a model-compatibility retry, not a key failure. Reset so we can reuse the same key.
          attemptedKeys.clear();
          continue;
        }

        // llama.cpp (and forks) reject WebP images with this message.
        // Re-encode all images to JPEG, remember for subsequent turns, and retry.
        if (!useJpeg && error.message.includes("Failed to load image or audio file")) {
          warning(`Backend '${apiBase}' rejected WebP images, switching to JPEG for this endpoint`);
          useJpeg = true;
          jpegRequiredEndpoints.add(apiBase);
          await prepareMedia(context.messages, true);
          // Rebuild only messages — preserves any tool_choice mutations already applied.
          params.messages = [
            { content: context.systemPrompt, role: "system" },
            ...context.messages.map(translateMsg),
          ];
          // This is a format retry, not a key failure — reset so we can reuse the same key.
          attemptedKeys.clear();
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
    try {
      if (!Array.isArray(resp.choices)) {
        debug("Got unexpected response", resp);
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
        const rawText =
          typeof choice.message.content === "string" ? choice.message.content : undefined;
        throw new GenerationNoToolCallsError(rawText, "undefined tool_calls");
      }

      if (choice.message.tool_calls.length === 0) {
        const rawText =
          typeof choice.message.content === "string" ? choice.message.content : undefined;
        throw new GenerationNoToolCallsError(rawText, "empty tool_calls");
      }

      const toolCallBlocks: ToolCallContent[] = choice.message.tool_calls.map((it) => {
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
              { cause: error },
            );
          }
        }
        throw new Error("custom not supported");
      });

      // Some OAI-compatible providers (DeepSeek R1, QwQ, etc.) expose their
      // chain-of-thought as reasoning_content on the message object.
      const rawMsg = choice.message as typeof choice.message & {
        reasoning_content?: string;
      };
      const messageContent: AssistantMessage["content"] =
        typeof rawMsg.reasoning_content === "string" && rawMsg.reasoning_content.length > 0
          ? [{ thinking: rawMsg.reasoning_content, type: "thinking" }, ...toolCallBlocks]
          : toolCallBlocks;

      const message: AssistantMessage = {
        content: messageContent,
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
    } catch (error) {
      keyPool.reuseLastKey();
      throw error;
    }
  }
}
