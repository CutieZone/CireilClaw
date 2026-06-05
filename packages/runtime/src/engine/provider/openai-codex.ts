import { createHash } from "node:crypto";

import { toJsonSchemaSafe } from "#util/schema.js";
import * as vb from "valibot";

import type { ImageContent, RedactedThinkingContent, ToolCallContent } from "#engine/content.js";
import type { Context, UsageInfo } from "#engine/context.js";
import { GenerationNoToolCallsError } from "#engine/errors.js";
import type { AssistantMessage, Message, UserContent } from "#engine/message.js";
import type { Tool } from "#engine/tool.js";
import { debug, warning } from "#output/log.js";
import { encode } from "#util/base64.js";
import { toJpeg } from "#util/image.js";
import { parseRepairedJSON } from "#util/json.js";

import { getChatGptAccountId, getValidCodexAuth } from "./openai-codex-auth.js";

const OPENAI_BETA_RESPONSES = "responses=experimental";
const ORIGINATOR_CODEX = "codex_cli_rs";

const GPT5_MINOR_VERSIONS = ["5.1", "5.2", "5.3", "5.4", "5.5"] as const;
const GENERAL_REASONING_VARIANTS = ["none", "low", "medium", "high", "xhigh"] as const;
const CODEX_REASONING_VARIANTS = ["low", "medium", "high", "xhigh"] as const;

function modelMapEntries(): [string, string][] {
  const entries: [string, string][] = [
    ["codex-mini-latest", "gpt-5.1-codex-mini"],
    ["gpt-5", "gpt-5.1"],
    ["gpt-5-codex", "gpt-5.1-codex"],
    ["gpt-5-codex-mini", "gpt-5.1-codex-mini"],
    ["gpt-5-codex-mini-high", "gpt-5.1-codex-mini"],
    ["gpt-5-codex-mini-medium", "gpt-5.1-codex-mini"],
    ["gpt-5-mini", "gpt-5.1"],
    ["gpt-5-nano", "gpt-5.1"],
  ];

  for (const minor of GPT5_MINOR_VERSIONS) {
    const general = `gpt-${minor}`;
    entries.push([general, general]);
    for (const variant of GENERAL_REASONING_VARIANTS) {
      if (variant !== "xhigh" || minor !== "5.1") {
        entries.push([`${general}-${variant}`, general]);
      }
    }

    const codex = `${general}-codex`;
    entries.push([codex, codex]);
    for (const variant of CODEX_REASONING_VARIANTS) {
      if (variant !== "xhigh" || minor !== "5.1") {
        entries.push([`${codex}-${variant}`, codex]);
      }
    }
  }

  entries.push(
    ["gpt-5.1-codex-max", "gpt-5.1-codex-max"],
    ["gpt-5.1-codex-max-high", "gpt-5.1-codex-max"],
    ["gpt-5.1-codex-max-low", "gpt-5.1-codex-max"],
    ["gpt-5.1-codex-max-medium", "gpt-5.1-codex-max"],
    ["gpt-5.1-codex-max-xhigh", "gpt-5.1-codex-max"],
    ["gpt-5.1-codex-mini", "gpt-5.1-codex-mini"],
    ["gpt-5.1-codex-mini-high", "gpt-5.1-codex-mini"],
    ["gpt-5.1-codex-mini-medium", "gpt-5.1-codex-mini"],
  );

  return entries;
}

const MODEL_MAP: Record<string, string> = Object.fromEntries(modelMapEntries());

const UnknownRecordSchema = vb.record(vb.string(), vb.unknown());

const CodexResponseSchema = vb.looseObject({
  output: vb.array(UnknownRecordSchema),
  usage: vb.exactOptional(
    vb.looseObject({
      input_tokens: vb.number(),
      output_tokens: vb.number(),
    }),
  ),
});

type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
type ReasoningSummary = "auto" | "concise" | "detailed";

interface Options {
  authId?: string;
  customHeaders?: Record<string, string | string[]>;
  forceJpeg?: boolean;
  reasoning?: boolean | string;
}

interface ReasoningConfig {
  effort: Exclude<ReasoningEffort, "minimal">;
  summary: ReasoningSummary;
}

function normalizeCodexModel(model: string | undefined): string {
  if (model === undefined || model.length === 0) {
    return "gpt-5.1-codex";
  }

  const modelId = model.includes("/") ? (model.split("/").at(-1) ?? model) : model;
  const mapped = MODEL_MAP[modelId] ?? MODEL_MAP[modelId.toLowerCase()];
  if (mapped !== undefined) {
    return mapped;
  }

  const normalized = modelId.toLowerCase().replaceAll(" ", "-");
  const versioned =
    /^gpt-5\.([1-5])(?:-(codex(?:-(?:max|mini))?))?(?:-(?:none|low|medium|high|xhigh))?$/u.exec(
      normalized,
    );
  if (versioned !== null) {
    const [, minor, family] = versioned;
    return family === undefined ? `gpt-5.${minor}` : `gpt-5.${minor}-${family}`;
  }

  if (normalized.includes("codex-max")) {
    return "gpt-5.1-codex-max";
  }
  if (normalized.includes("codex-mini")) {
    return "gpt-5.1-codex-mini";
  }
  if (normalized.includes("codex")) {
    return "gpt-5.1-codex";
  }
  if (normalized.includes("gpt-5")) {
    return "gpt-5.1";
  }
  return modelId;
}

function gpt5Minor(model: string): number | undefined {
  const match = /^gpt-5\.(\d+)/u.exec(model);
  const raw = match?.[1];
  return raw === undefined ? undefined : Number.parseInt(raw, 10);
}

function resolveCodexReasoning(
  model: string,
  configured: boolean | string | undefined,
): ReasoningConfig {
  const normalized = model.toLowerCase();
  const isCodex = normalized.includes("codex");
  const isCodexMini = normalized.includes("codex-mini");
  const minor = gpt5Minor(normalized);
  const supportsXhigh = (minor !== undefined && minor >= 2) || normalized.includes("codex-max");
  const supportsNone = !isCodex && minor !== undefined && minor >= 1 && minor <= 5;

  let effort: ReasoningEffort = "medium";
  if (configured === false) {
    effort = "none";
  } else if (typeof configured === "string") {
    effort = vb.parse(
      vb.picklist(["none", "minimal", "low", "medium", "high", "xhigh"]),
      configured,
    );
  } else if (isCodexMini) {
    effort = "medium";
  } else if (supportsXhigh) {
    effort = "high";
  }

  if (isCodexMini && (effort === "none" || effort === "minimal" || effort === "low")) {
    effort = "medium";
  }
  if (isCodexMini && effort === "xhigh") {
    effort = "high";
  }
  if (!supportsXhigh && effort === "xhigh") {
    effort = "high";
  }
  if (!supportsNone && effort === "none") {
    effort = "low";
  }
  if (effort === "minimal") {
    effort = "low";
  }

  const finalEffort: Exclude<ReasoningEffort, "minimal"> = effort;
  return {
    effort: finalEffort,
    summary: finalEffort === "high" || finalEffort === "xhigh" ? "detailed" : "auto",
  };
}

async function prepareImage(content: ImageContent, forceJpeg: boolean): Promise<string> {
  const kind = forceJpeg ? "jpeg" : "webp";
  if (content.memoized?.kind === kind) {
    return content.memoized.data;
  }
  const data = forceJpeg ? await toJpeg(content.data) : content.data;
  const encoded = encode(data);
  content.memoized = { data: encoded, kind };
  return encoded;
}

async function translateUserContent(
  content: UserContent,
  forceJpeg: boolean,
): Promise<Record<string, unknown>> {
  switch (content.type) {
    case "text":
      return { text: content.content, type: "input_text" };
    case "image":
      return {
        detail: "auto",
        image_url: `data:${content.mediaType};base64,${await prepareImage(content, forceJpeg)}`,
        type: "input_image",
      };
    case "image_ref":
      throw new Error("Image references must be hydrated before OpenAI Codex translation.");
    case "video":
    case "video_ref":
      throw new Error("The OpenAI Codex provider does not support video input.");
    default: {
      const _exhaustive: never = content;
      throw new Error(`Unsupported user content: ${String(_exhaustive)}`);
    }
  }
}

function translateTool(tool: Tool): Record<string, unknown> {
  const schema =
    tool.jsonSchema ??
    toJsonSchemaSafe(tool.parameters, {
      target: "openapi-3.0",
      typeMode: "input",
    });
  return {
    description: tool.description,
    name: tool.name,
    parameters: vb.parse(UnknownRecordSchema, schema),
    strict: false,
    type: "function",
  };
}

function stringifyToolOutput(output: unknown, name: string): string {
  if (typeof output === "object" && output !== null) {
    return JSON.stringify({ name, ...vb.parse(UnknownRecordSchema, output) });
  }
  return JSON.stringify({ name, output });
}

async function translateMessagesForCodex(
  messages: Message[],
  forceJpeg = false,
): Promise<Record<string, unknown>[]> {
  const input: Record<string, unknown>[] = [];

  for (const message of messages) {
    switch (message.role) {
      case "system":
        input.push({
          content: [{ text: message.content.content, type: "input_text" }],
          role: "system",
          type: "message",
        });
        break;
      case "user": {
        const parts = Array.isArray(message.content) ? message.content : [message.content];
        input.push({
          content: await Promise.all(
            parts.map(async (part) => await translateUserContent(part, forceJpeg)),
          ),
          role: "user",
          type: "message",
        });
        break;
      }
      case "toolResponse":
        input.push({
          call_id: message.content.id,
          output: stringifyToolOutput(message.content.output, message.content.name),
          type: "function_call_output",
        });
        break;
      case "assistant": {
        const parts = Array.isArray(message.content) ? message.content : [message.content];
        const textParts: string[] = [];
        for (const part of parts) {
          if (part.type === "toolCall") {
            input.push({
              arguments: JSON.stringify(part.input ?? {}),
              call_id: part.id,
              name: part.name,
              type: "function_call",
            });
          } else if (part.type === "redacted_thinking") {
            input.push({ encrypted_content: part.data, summary: [], type: "reasoning" });
          } else if (part.type === "text") {
            textParts.push(part.content);
          } else if (part.type === "thinking") {
            textParts.push(part.thinking);
          }
        }
        if (textParts.length > 0) {
          input.push({
            content: textParts.map((text) => ({ annotations: [], text, type: "output_text" })),
            role: "assistant",
            status: "completed",
            type: "message",
          });
        }
        break;
      }
      default: {
        const _exhaustive: never = message;
        throw new Error(`Unsupported message role: ${String(_exhaustive)}`);
      }
    }
  }

  return input;
}

function appendCustomHeaders(
  headers: Headers,
  customHeaders: Record<string, string | string[]> | undefined,
): void {
  if (customHeaders === undefined) {
    return;
  }
  for (const [key, value] of Object.entries(customHeaders)) {
    if (Array.isArray(value)) {
      headers.delete(key);
      for (const inner of value) {
        headers.append(key, inner);
      }
    } else {
      headers.set(key, value);
    }
  }
}

function createCodexHeaders(
  accessToken: string,
  accountId: string,
  sessionId: string,
  customHeaders: Record<string, string | string[]> | undefined,
): Headers {
  const headers = new Headers({
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    "OpenAI-Beta": OPENAI_BETA_RESPONSES,
    accept: "text/event-stream",
    "chatgpt-account-id": accountId,
    conversation_id: sessionId,
    originator: ORIGINATOR_CODEX,
    session_id: sessionId,
  });
  appendCustomHeaders(headers, customHeaders);
  return headers;
}

function unwrapCodexResponse(raw: unknown): unknown {
  if (vb.safeParse(CodexResponseSchema, raw).success) {
    return raw;
  }

  const parsed = vb.safeParse(UnknownRecordSchema, raw);
  if (!parsed.success) {
    return raw;
  }

  const nested = parsed.output["response"] ?? parsed.output["data"];
  if (vb.safeParse(CodexResponseSchema, nested).success) {
    return nested;
  }

  if (nested !== undefined) {
    const nestedRecord = vb.safeParse(UnknownRecordSchema, nested);
    const nestedResponse = nestedRecord.success ? nestedRecord.output["response"] : undefined;
    if (vb.safeParse(CodexResponseSchema, nestedResponse).success) {
      return nestedResponse;
    }
  }

  return raw;
}

function parseSseEventData(line: string): unknown {
  const trimmed = line.trimEnd();
  if (!trimmed.startsWith("data:")) {
    return undefined;
  }

  const data = trimmed.slice("data:".length).trim();
  if (data.length === 0 || data === "[DONE]") {
    return undefined;
  }

  try {
    return JSON.parse(data);
  } catch {
    return undefined;
  }
}

async function parseCodexResponse(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return unwrapCodexResponse(await response.json());
  }

  const text = await response.text();
  const outputItems: Record<string, unknown>[] = [];
  const eventTypes: string[] = [];
  let fallbackResponse: unknown = undefined;
  let finalResponse: unknown = undefined;

  for (const line of text.split("\n")) {
    const data = parseSseEventData(line);
    if (data === undefined) {
      continue;
    }

    const event = vb.safeParse(UnknownRecordSchema, data);
    if (!event.success) {
      continue;
    }

    const { type } = event.output;
    if (typeof type === "string") {
      eventTypes.push(type);
    }

    if (type === "response.output_item.done") {
      const { item } = event.output;
      const parsedItem = vb.safeParse(UnknownRecordSchema, item);
      if (parsedItem.success) {
        outputItems.push(parsedItem.output);
      }
      continue;
    }

    if (type === "response.created" || type === "response.incomplete") {
      fallbackResponse = unwrapCodexResponse(event.output);
      continue;
    }

    if (type === "response.failed") {
      debug("OpenAI Codex failed stream event", { event: event.output });
      fallbackResponse = unwrapCodexResponse(event.output);
      continue;
    }

    if (type !== "response.done" && type !== "response.completed") {
      continue;
    }

    const unwrapped = unwrapCodexResponse(event.output);
    if (vb.safeParse(CodexResponseSchema, unwrapped).success) {
      finalResponse = unwrapped;
    }
  }

  if (finalResponse !== undefined) {
    return finalResponse;
  }

  if (outputItems.length > 0) {
    return { output: outputItems };
  }

  if (vb.safeParse(CodexResponseSchema, fallbackResponse).success) {
    return fallbackResponse;
  }

  debug("OpenAI Codex stream ended without final response", { contentType, eventTypes, text });
  throw new Error("OpenAI Codex response stream ended without a final response event.");
}

async function fetchCodexResponse(
  apiBase: string,
  authId: string,
  sessionId: string,
  customHeaders: Record<string, string | string[]> | undefined,
  body: Record<string, unknown>,
): Promise<unknown> {
  let auth = await getValidCodexAuth(authId);
  let accountId = getChatGptAccountId(auth.accessToken);
  if (accountId === undefined) {
    auth = await getValidCodexAuth(authId, { forceRefresh: true });
    accountId = getChatGptAccountId(auth.accessToken);
  }
  if (accountId === undefined) {
    throw new Error("OpenAI Codex OAuth token does not contain a ChatGPT account ID.");
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await fetch(`${apiBase}/codex/responses`, {
      body: JSON.stringify(body),
      headers: createCodexHeaders(auth.accessToken, accountId, sessionId, customHeaders),
      method: "POST",
    });

    if (response.status === 401 && attempt === 0) {
      auth = await getValidCodexAuth(authId, { forceRefresh: true });
      accountId = getChatGptAccountId(auth.accessToken);
      if (accountId === undefined) {
        throw new Error("OpenAI Codex refreshed token does not contain a ChatGPT account ID.");
      }
      continue;
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      if (
        response.status === 404 &&
        /usage_limit_reached|usage_not_included|rate_limit_exceeded|usage limit/iu.test(text)
      ) {
        throw new Error(`OpenAI Codex usage limit reached: ${text}`);
      }
      throw new Error(`OpenAI Codex API error (${response.status}): ${text}`);
    }

    return await parseCodexResponse(response);
  }

  throw new Error("OpenAI Codex request failed after token refresh.");
}

function extractText(outputItem: Record<string, unknown>): string[] {
  const rawContent = outputItem["content"];
  if (!Array.isArray(rawContent)) {
    return [];
  }
  const text: string[] = [];
  for (const content of rawContent) {
    const parsed = vb.safeParse(UnknownRecordSchema, content);
    if (parsed.success) {
      const value = parsed.output["text"] ?? parsed.output["refusal"];
      if (typeof value === "string") {
        text.push(value);
      }
    }
  }
  return text;
}

function translateCodexOutput(
  raw: unknown,
  systemPromptLength: number,
): { message: AssistantMessage; usage?: UsageInfo } {
  const response = vb.parse(CodexResponseSchema, unwrapCodexResponse(raw));
  const toolCalls: ToolCallContent[] = [];
  const reasoningBlocks: RedactedThinkingContent[] = [];
  const textParts: string[] = [];

  for (const item of response.output) {
    const { type } = item;
    if (type === "function_call") {
      const parsed = vb.parse(
        vb.looseObject({
          arguments: vb.string(),
          call_id: vb.pipe(vb.string(), vb.nonEmpty()),
          name: vb.pipe(vb.string(), vb.nonEmpty()),
        }),
        item,
      );
      const argsJson = parsed.arguments.trim();
      if (argsJson.length === 0) {
        toolCalls.push({
          id: parsed.call_id,
          input: {},
          name: parsed.name,
          type: "toolCall",
        });
      } else {
        try {
          const result = parseRepairedJSON(argsJson);
          if (typeof result !== "object" || result === null || Array.isArray(result)) {
            const hash = createHash("sha256").update(argsJson).digest("hex").slice(0, 8);
            throw new Error(
              `Tool-call arguments parsed to non-object: length=${argsJson.length} hash=${hash}`,
            );
          }
          toolCalls.push({
            id: parsed.call_id,
            input: result,
            name: parsed.name,
            type: "toolCall",
          });
        } catch (error: unknown) {
          const hash = createHash("sha256").update(argsJson).digest("hex").slice(0, 8);
          throw new Error(
            `Failed to parse tool-call arguments: length=${argsJson.length} hash=${hash}`,
            { cause: error },
          );
        }
      }
    } else if (type === "reasoning") {
      const encrypted = item["encrypted_content"];
      if (typeof encrypted === "string" && encrypted.length > 0) {
        reasoningBlocks.push({ data: encrypted, type: "redacted_thinking" });
      }
    } else if (type === "message") {
      textParts.push(...extractText(item));
    }
  }

  if (toolCalls.length === 0) {
    throw new GenerationNoToolCallsError(
      textParts.join("\n\n") || undefined,
      "no function_call output",
    );
  }

  const usage =
    response.usage === undefined
      ? undefined
      : {
          completionTokens: response.usage.output_tokens,
          promptTokens: response.usage.input_tokens,
          systemPromptTokensEst: Math.round(systemPromptLength / 4),
        };

  return {
    message: {
      content: reasoningBlocks.length > 0 ? [...reasoningBlocks, ...toolCalls] : toolCalls,
      role: "assistant",
    },
    usage,
  };
}

async function generate(
  context: Context,
  apiBase: string,
  model: string,
  { authId = "default", customHeaders, forceJpeg = false, reasoning }: Options = {},
): Promise<{ message: AssistantMessage; usage?: UsageInfo }> {
  const normalizedModel = normalizeCodexModel(model);
  const reasoningConfig = resolveCodexReasoning(normalizedModel, reasoning);

  const body: Record<string, unknown> = {
    include: ["reasoning.encrypted_content"],
    input: await translateMessagesForCodex(context.messages, forceJpeg),
    instructions: context.systemPrompt,
    model: normalizedModel,
    parallel_tool_calls: true,
    prompt_cache_key: context.sessionId,
    reasoning: reasoningConfig,
    store: false,
    stream: true,
    text: { verbosity: "medium" },
    tool_choice: "required",
    tools: context.tools.map(translateTool),
  };

  debug("Starting OpenAI Codex response generation...");
  const response = await fetchCodexResponse(
    apiBase,
    authId,
    context.sessionId,
    customHeaders,
    body,
  );
  debug("Finished OpenAI Codex response generation...");

  try {
    return translateCodexOutput(response, context.systemPrompt.length);
  } catch (error) {
    warning("Failed to translate OpenAI Codex response", error);
    throw error;
  }
}

const OPENAI_CODEX_MODELS = Object.freeze(Object.keys(MODEL_MAP));

export {
  OPENAI_CODEX_MODELS,
  generate,
  normalizeCodexModel,
  resolveCodexReasoning,
  parseCodexResponse,
  translateCodexOutput,
  translateMessagesForCodex,
};
