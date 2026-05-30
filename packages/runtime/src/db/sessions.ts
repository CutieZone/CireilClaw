import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { blake3 } from "@noble/hashes/blake3.js";
import { and, eq, inArray, notInArray } from "drizzle-orm";
import * as vb from "valibot";

import { nonEmptyString } from "#config/schemas/shared.js";
import { getDb } from "#db/index.js";
import { images, sessions, summaries as summariesTable } from "#db/schema.js";
import type { Content, ImageContent, ImageRef, VideoContent, VideoRef } from "#engine/content.js";
import { isImageRef, isVideoContent, isVideoRef } from "#engine/content.js";
import { isMessage } from "#engine/message.js";
import type { AssistantContent, Message, UserContent } from "#engine/message.js";
import type { Session, Summary } from "#harness/session.js";
import {
  DiscordSession,
  MatrixSession,
  NamedInternalSession,
  TuiSession,
} from "#harness/session.js";
import { warning } from "#output/log.js";
import { agentRoot } from "#util/paths.js";

// ---------------------------------------------------------------------------
// Image file helpers
// ---------------------------------------------------------------------------

const MEDIA_TYPE_EXT: Record<string, string> = {
  "image/gif": ".gif",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
};

function imageDir(agentSlug: string): string {
  return join(agentRoot(agentSlug), "images");
}

function imagePath(agentSlug: string, id: string, mediaType: string): string {
  const ext = MEDIA_TYPE_EXT[mediaType] ?? ".bin";
  return join(imageDir(agentSlug), `${id}${ext}`);
}

function hashImage(data: Uint8Array): string {
  return Buffer.from(blake3(data)).toString("hex");
}

// ---------------------------------------------------------------------------
// Serialized message format
// ---------------------------------------------------------------------------

// On-disk, ImageContent is replaced with a lean reference — the ArrayBuffer
// stays in a file, not in the JSON blob.
interface PendingImage {
  id: string;
  mediaType: string;
  path: string;
  data: Uint8Array;
}

function isImageContent(ct: unknown): ct is ImageContent {
  return typeof ct === "object" && ct !== null && "type" in ct && ct.type === "image";
}

function serializeHistory(
  history: Message[],
  agentSlug: string,
): { json: string; pendingImages: PendingImage[] } {
  const pendingImages: PendingImage[] = [];

  function serializeContent(ct: unknown): unknown {
    if (isImageContent(ct)) {
      const img = ct;
      const id = hashImage(img.data);
      const path = imagePath(agentSlug, id, img.mediaType);
      pendingImages.push({ data: img.data, id, mediaType: img.mediaType, path });
      return { id, mediaType: img.mediaType, type: "image_ref" } satisfies ImageRef;
    }
    // Videos are not stored on disk — just keep the URL and attachmentId as a ref.
    if (isVideoContent(ct)) {
      return {
        attachmentId: ct.attachmentId,
        mediaType: ct.mediaType,
        type: "video_ref",
        url: ct.url,
      } satisfies VideoRef;
    }
    return ct;
  }

  // Filter out non-persistent messages (e.g., reply context, summarizer prompts).
  const persistable = history.filter((msg) => !("persist" in msg && msg.persist === false));

  const serialized = persistable.map((msg) => ({
    ...msg,
    content: Array.isArray(msg.content)
      ? msg.content.map(serializeContent)
      : serializeContent(msg.content),
  }));

  return { json: JSON.stringify(serialized), pendingImages };
}

async function deserializeHistory(json: string, agentSlug: string): Promise<Message[]> {
  function deserializeImageRef(ref: ImageRef): ImageContent | undefined {
    const path = imagePath(agentSlug, ref.id, ref.mediaType);
    try {
      const data = readFileSync(path);
      return { data, mediaType: ref.mediaType, type: "image" } satisfies ImageContent;
    } catch (error) {
      warning(
        "Failed to restore image for session:",
        path,
        error instanceof Error ? error.message : String(error),
      );
      // Drop the image from the restored message rather than making the whole session unreadable.
      return undefined;
    }
  }

  async function deserializeUserContent(ct: Content | ImageRef): Promise<UserContent | undefined> {
    if (ct.type === "image_ref") {
      return deserializeImageRef(ct);
    }

    if (ct.type === "video_ref") {
      const ref = ct;
      try {
        const response = await fetch(ref.url);
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const data = new Uint8Array(await response.arrayBuffer());
        return {
          attachmentId: ref.attachmentId,
          data,
          mediaType: ref.mediaType,
          type: "video",
          url: ref.url,
        } satisfies VideoContent;
      } catch (error) {
        warning(
          "Failed to re-fetch video for session restore:",
          ref.url,
          error instanceof Error ? error.message : String(error),
        );
        // Drop the video from the restored message rather than crashing.
        return undefined;
      }
    }

    if (ct.type === "text" || ct.type === "image" || ct.type === "video") {
      return ct;
    }

    throw new Error(`Invalid content type for user (found ${ct.type})`);
  }

  function deserializeAssistantContent(ct: Content | ImageRef): AssistantContent | undefined {
    if (ct.type === "image_ref") {
      return deserializeImageRef(ct);
    }

    if (
      ct.type === "text" ||
      ct.type === "image" ||
      ct.type === "toolCall" ||
      ct.type === "thinking" ||
      ct.type === "redacted_thinking"
    ) {
      return ct;
    }

    throw new Error(`Invalid content type for assistant (found ${ct.type})`);
  }

  const raw = vb.parse(vb.record(vb.string(), vb.unknown()), JSON.parse(json));
  const entries = Object.values(raw).filter((it) => isMessage(it));

  const messages: Message[] = [];
  for (const msg of entries) {
    if (msg.role === "user") {
      if (Array.isArray(msg.content)) {
        const resolved = await Promise.all(msg.content.map(deserializeUserContent));
        const content = resolved.filter((it): it is UserContent => it !== undefined);
        messages.push({
          ...msg,
          content: content.length > 0 ? content : { content: "", type: "text" },
        });
      } else {
        const resolved = await deserializeUserContent(msg.content);
        // If the sole content was media that failed to restore, use an empty
        // text block to avoid a malformed message.
        const content = resolved ?? ({ content: "", type: "text" } as const);
        messages.push({ ...msg, content });
      }
    } else if (msg.role === "assistant") {
      if (Array.isArray(msg.content)) {
        const content = msg.content
          .map((it) => deserializeAssistantContent(it))
          .filter((it): it is AssistantContent => it !== undefined);
        messages.push({
          ...msg,
          content: content.length > 0 ? content : { content: "", type: "text" },
        });
      } else {
        const content =
          deserializeAssistantContent(msg.content) ?? ({ content: "", type: "text" } as const);
        messages.push({ ...msg, content });
      }
    } else {
      messages.push(msg);
    }
  }

  return messages;
}

// ---------------------------------------------------------------------------
// Channel meta
// ---------------------------------------------------------------------------

const LastContextWarningCursorSchema = vb.pipe(vb.number(), vb.integer(), vb.minValue(0));

const DiscordMetaSchema = vb.object({
  channelId: nonEmptyString,
  guildId: vb.exactOptional(nonEmptyString),
  isNsfw: vb.exactOptional(vb.boolean()),
  lastContextWarningCursor: vb.exactOptional(LastContextWarningCursorSchema),
  selectedModel: vb.exactOptional(nonEmptyString),
  selectedProvider: vb.exactOptional(nonEmptyString),
});

type DiscordMeta = vb.InferOutput<typeof DiscordMetaSchema>;

const MatrixMetaSchema = vb.object({
  lastContextWarningCursor: vb.exactOptional(LastContextWarningCursorSchema),
  roomId: nonEmptyString,
  selectedModel: vb.exactOptional(nonEmptyString),
  selectedProvider: vb.exactOptional(nonEmptyString),
});

// type MatrixMeta = vb.InferOutput<typeof MatrixMetaSchema>;

// ---------------------------------------------------------------------------
// Debounce
// ---------------------------------------------------------------------------

const DEBOUNCE_MS = 2000;

// Store the flush callback so flushAllSessions() can drain without needing
// to re-fetch the session from somewhere.
const _pending = new Map<string, { timer: NodeJS.Timeout; flush: () => void }>();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// Flushes all pending debounced saves immediately — call before process exit
// so in-flight data isn't lost.
function flushAllSessions(): void {
  for (const { timer, flush } of _pending.values()) {
    clearTimeout(timer);
    flush();
  }
}

function _flushSession(agentSlug: string, session: Session): void {
  // Ephemeral sessions are never persisted.
  if (session.ephemeral) {
    return;
  }

  const db = getDb(agentSlug);
  const sessionId = session.id();

  const { json: historyJson, pendingImages } = serializeHistory(session.history, agentSlug);

  let meta: object | undefined = undefined;
  if (session.channel === "discord") {
    meta = {
      channelId: session.channelId,
      guildId: session.guildId,
      isNsfw: session.isNsfw,
      lastContextWarningCursor: session.lastContextWarningCursor,
      selectedModel: session.selectedModel,
      selectedProvider: session.selectedProvider,
    } satisfies DiscordMeta;
  } else if (session.channel === "matrix") {
    meta = {
      lastContextWarningCursor: session.lastContextWarningCursor,
      roomId: session.roomId,
      selectedModel: session.selectedModel,
      selectedProvider: session.selectedProvider,
    };
  } else {
    meta = {
      lastContextWarningCursor: session.lastContextWarningCursor,
      selectedModel: session.selectedModel,
      selectedProvider: session.selectedProvider,
    };
  }

  const lastActivity =
    session.lastActivity > 0 ? new Date(session.lastActivity).toISOString() : undefined;

  // Serialize activeFileSections: Map<string, Set<string>> → Record<string, string[]>
  const activeFileSections: Record<string, string[]> = {};
  for (const [path, sections] of session.activeFileSections) {
    activeFileSections[path] = [...sections];
  }

  // Upsert the session row first so that the images FK constraint is satisfied.
  db.insert(sessions)
    .values({
      activeFileSections: JSON.stringify(activeFileSections),
      channel: session.channel,
      history: historyJson,
      historyCursor: session.historyCursor,
      id: sessionId,
      lastActivity,
      meta: JSON.stringify(meta),
      openedFiles: JSON.stringify([...session.openedFiles]),
    })
    .onConflictDoUpdate({
      set: {
        activeFileSections: JSON.stringify(activeFileSections),
        history: historyJson,
        historyCursor: session.historyCursor,
        lastActivity,
        meta: JSON.stringify(meta),
        openedFiles: JSON.stringify([...session.openedFiles]),
      },
      target: sessions.id,
    })
    .run();

  // Write image files and index them after the session row exists.
  if (pendingImages.length > 0) {
    mkdirSync(imageDir(agentSlug), { recursive: true });
    for (const img of pendingImages) {
      if (!existsSync(img.path)) {
        writeFileSync(img.path, Buffer.from(img.data));
      }
      db.insert(images)
        .values({ id: img.id, mediaType: img.mediaType, sessionId })
        .onConflictDoNothing()
        .run();
    }
  }
}

async function loadSessions(agentSlug: string): Promise<Map<string, Session>> {
  const db = getDb(agentSlug);
  // All sessions in this DB belong to this agent — no slug filter needed.
  const rows = db.select().from(sessions).all();
  const map = new Map<string, Session>();

  for (const row of rows) {
    let rowId = row.id;
    const history = await deserializeHistory(row.history, agentSlug);
    const openedFiles = new Set(vb.parse(vb.array(vb.string()), JSON.parse(row.openedFiles)));

    // Parse activeFileSections: JSON {path: [section_ids]} → Map<string, Set<string>>
    const activeFileSectionsRaw = vb.safeParse(
      vb.record(vb.string(), vb.array(vb.string())),
      JSON.parse(row.activeFileSections),
    );
    const activeFileSections = new Map<string, Set<string>>();
    if (activeFileSectionsRaw.success) {
      for (const [path, sections] of Object.entries(activeFileSectionsRaw.output)) {
        activeFileSections.set(path, new Set(sections));
      }
    }

    const metaJson: unknown = JSON.parse(row.meta);

    let session: Session | undefined = undefined;
    if (row.channel === "discord") {
      const meta = vb.parse(DiscordMetaSchema, metaJson);
      session = new DiscordSession({
        channelId: meta.channelId,
        guildId: meta.guildId,
        isNsfw: meta.isNsfw,
        selectedModel: meta.selectedModel,
        selectedProvider: meta.selectedProvider,
      });
    } else if (row.channel === "matrix") {
      const meta = vb.parse(MatrixMetaSchema, metaJson);
      session = new MatrixSession(meta.roomId);
      session.selectedModel = meta.selectedModel;
      session.selectedProvider = meta.selectedProvider;
    } else if (row.channel === "internal") {
      const legacyInternalId = !row.id.startsWith("internal:");
      const name = legacyInternalId ? row.id : row.id.slice("internal:".length);
      session = new NamedInternalSession(name);
      if (legacyInternalId) {
        const newId = session.id();
        const existing = db
          .select({ id: sessions.id })
          .from(sessions)
          .where(eq(sessions.id, newId))
          .get();
        if (existing !== undefined) {
          warning(
            "Skipping legacy internal session because a canonical row already exists:",
            row.id,
            newId,
          );
          continue;
        }
        db.insert(sessions)
          .values({
            activeFileSections: row.activeFileSections,
            channel: row.channel,
            history: row.history,
            historyCursor: row.historyCursor,
            id: newId,
            lastActivity: row.lastActivity,
            meta: row.meta,
            openedFiles: row.openedFiles,
          })
          .run();
        db.update(images).set({ sessionId: newId }).where(eq(images.sessionId, row.id)).run();
        db.update(summariesTable)
          .set({ sessionId: newId })
          .where(eq(summariesTable.sessionId, row.id))
          .run();
        db.delete(sessions).where(eq(sessions.id, row.id)).run();
        rowId = newId;
      }
    } else if (row.channel === "tui") {
      // TUI session in DB is primarily for history inspection.
      // We don't have the bridge here, it will be injected by the TUI app if needed.
      session = new TuiSession();
    } else {
      // Unknown or legacy channel type — skip.
      continue;
    }

    const common = vb.safeParse(
      vb.looseObject({
        lastContextWarningCursor: vb.exactOptional(LastContextWarningCursorSchema),
        selectedModel: vb.exactOptional(nonEmptyString),
        selectedProvider: vb.exactOptional(nonEmptyString),
      }),
      metaJson,
    );
    if (common.success) {
      session.lastContextWarningCursor = common.output.lastContextWarningCursor;
      session.selectedModel ??= common.output.selectedModel;
      session.selectedProvider ??= common.output.selectedProvider;
    }
    session.history = history;
    session.historyCursor = row.historyCursor;
    session.openedFiles = openedFiles;
    session.activeFileSections = activeFileSections;

    session.lastActivity = row.lastActivity === null ? 0 : Date.parse(row.lastActivity);
    map.set(rowId, session);
  }

  // Load all summaries and attach them to their sessions.
  const summaryRows = db.select().from(summariesTable).all();
  for (const sumRow of summaryRows) {
    const session = map.get(sumRow.sessionId);
    if (session === undefined) {
      continue;
    }
    const preserve = vb.safeParse(vb.array(vb.string()), JSON.parse(sumRow.preserve));
    session.summaries.push({
      createdAt: sumRow.createdAt,
      displayName: sumRow.displayName,
      endMessageId: sumRow.endMessageId,
      id: sumRow.id,
      preserve: preserve.success ? preserve.output : [],
      slug: sumRow.slug,
      startMessageId: sumRow.startMessageId,
      summary: sumRow.summary,
    });
  }

  return map;
}

// Deletes a session and prunes image files that are no longer referenced by
// any remaining session.
function deleteSession(agentSlug: string, sessionId: string): void {
  const db = getDb(agentSlug);

  const referenced = db
    .select({ id: images.id, mediaType: images.mediaType })
    .from(images)
    .where(eq(images.sessionId, sessionId))
    .all();

  if (referenced.length > 0) {
    const ids = referenced.map((ref) => ref.id);

    // IDs still referenced by other sessions — keep their files.
    const stillShared = new Set(
      db
        .select({ id: images.id })
        .from(images)
        .where(and(notInArray(images.sessionId, [sessionId]), inArray(images.id, ids)))
        .all()
        .map((ref) => ref.id),
    );

    for (const img of referenced) {
      if (stillShared.has(img.id)) {
        continue;
      }
      const path = imagePath(agentSlug, img.id, img.mediaType);
      try {
        unlinkSync(path);
      } catch {
        // Already gone — fine.
      }
    }
  }

  db.delete(images).where(eq(images.sessionId, sessionId)).run();
  db.delete(summariesTable).where(eq(summariesTable.sessionId, sessionId)).run();
  db.delete(sessions).where(eq(sessions.id, sessionId)).run();
}

// Clears conversation state (history, images, opened files) for a session
// while keeping the session row and its meta (provider/model selections).
function resetSession(agentSlug: string, sessionId: string): void {
  const db = getDb(agentSlug);

  // Prune image files that are no longer referenced by any other session.
  const referenced = db
    .select({ id: images.id, mediaType: images.mediaType })
    .from(images)
    .where(eq(images.sessionId, sessionId))
    .all();

  if (referenced.length > 0) {
    const ids = referenced.map((ref) => ref.id);

    const stillShared = new Set(
      db
        .select({ id: images.id })
        .from(images)
        .where(and(notInArray(images.sessionId, [sessionId]), inArray(images.id, ids)))
        .all()
        .map((ref) => ref.id),
    );

    for (const img of referenced) {
      if (stillShared.has(img.id)) {
        continue;
      }
      const path = imagePath(agentSlug, img.id, img.mediaType);
      try {
        unlinkSync(path);
      } catch {
        // Already gone.
      }
    }
  }

  db.delete(images).where(eq(images.sessionId, sessionId)).run();
  db.delete(summariesTable).where(eq(summariesTable.sessionId, sessionId)).run();
  db.update(sessions)
    .set({ activeFileSections: "{}", history: "[]", historyCursor: 0, openedFiles: "[]" })
    .where(eq(sessions.id, sessionId))
    .run();
}

// Schedules a save after DEBOUNCE_MS. Resets the timer on repeated calls so
// rapid back-to-back turns only produce one write.
function saveSession(agentSlug: string, session: Session): void {
  const key = `${agentSlug}:${session.id()}`;
  const existing = _pending.get(key);
  if (existing !== undefined) {
    clearTimeout(existing.timer);
  }

  function flush(): void {
    _pending.delete(key);
    _flushSession(agentSlug, session);
  }

  _pending.set(key, { flush, timer: setTimeout(flush, DEBOUNCE_MS) });
}

// Updates images for a session by replacing the image data in history
// and rewriting the image files. Called after re-fetching from Discord.
function updateSessionImages(
  agentSlug: string,
  sessionId: string,
  newImages: Map<string, Uint8Array>, // messageId -> image data (converted to webp)
): void {
  const db = getDb(agentSlug);

  // Get the current session row
  const row = db.select().from(sessions).where(eq(sessions.id, sessionId)).get();
  if (row === undefined) {
    return;
  }

  // Parse history, find messages with matching IDs, and update their images.
  // History is normally an array; tolerate legacy object-shaped rows produced by older repair code.
  const raw: unknown = JSON.parse(row.history);
  const entries = Array.isArray(raw)
    ? raw.filter((it) => isMessage(it))
    : Object.values(vb.parse(vb.record(vb.string(), vb.unknown()), raw)).filter((it) =>
        isMessage(it),
      );

  // First pass: update image_ref IDs in messages
  for (const msg of entries) {
    if (msg.role !== "user" || msg.id === undefined) {
      continue;
    }
    const msgId = msg.id;
    const newData = newImages.get(msgId);
    if (newData === undefined) {
      continue;
    }

    // Update the image content in this message
    const { content } = msg;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === "image_ref") {
          // Replace this image_ref with new data
          const ref: ImageRef = block;
          const newId = hashImage(newData);
          ref.id = newId;
          ref.mediaType = "image/webp";
        }
      }
    } else if (content.type === "image_ref") {
      const ref: ImageRef = content;
      const newId = hashImage(newData);
      ref.id = newId;
      ref.mediaType = "image/webp";
    }
  }

  // Write updated history back without changing its container shape.
  const updatedHistory = JSON.stringify(raw);

  // Collect every image_ref that remains in history so the image index stays in
  // lockstep with the serialized conversation after repair.
  const referencedImages = new Map<string, ImageRef>();
  const pendingImages: PendingImage[] = [];
  for (const msg of entries) {
    const content = Array.isArray(msg.content) ? msg.content : [msg.content];
    for (const block of content) {
      if (!isImageRef(block)) {
        continue;
      }

      const key = `${block.id}\0${block.mediaType}`;
      referencedImages.set(key, { id: block.id, mediaType: block.mediaType, type: "image_ref" });

      if (msg.role === "user" && msg.id !== undefined) {
        const data = newImages.get(msg.id);
        if (data !== undefined) {
          const path = imagePath(agentSlug, block.id, block.mediaType);
          pendingImages.push({ data, id: block.id, mediaType: block.mediaType, path });
        }
      }
    }
  }

  const oldImages = db
    .select({ id: images.id, mediaType: images.mediaType })
    .from(images)
    .where(eq(images.sessionId, sessionId))
    .all();

  // Write new image files before repointing the DB row at them.
  if (pendingImages.length > 0) {
    mkdirSync(imageDir(agentSlug), { recursive: true });
    for (const img of pendingImages) {
      if (!existsSync(img.path)) {
        writeFileSync(img.path, Buffer.from(img.data));
      }
    }
  }

  db.update(sessions).set({ history: updatedHistory }).where(eq(sessions.id, sessionId)).run();

  db.delete(images).where(eq(images.sessionId, sessionId)).run();
  for (const ref of referencedImages.values()) {
    db.insert(images)
      .values({ id: ref.id, mediaType: ref.mediaType, sessionId })
      .onConflictDoNothing()
      .run();
  }

  const stillReferencedHere = new Set(referencedImages.keys());
  for (const img of oldImages) {
    if (stillReferencedHere.has(`${img.id}\0${img.mediaType}`)) {
      continue;
    }

    const shared = db
      .select({ id: images.id })
      .from(images)
      .where(and(notInArray(images.sessionId, [sessionId]), eq(images.id, img.id)))
      .get();

    if (shared !== undefined) {
      continue;
    }

    const path = imagePath(agentSlug, img.id, img.mediaType);
    try {
      unlinkSync(path);
    } catch {
      // Already gone — fine.
    }
  }
}

// Updates video_ref URLs in session history JSON. Called after /repair re-fetches
// fresh Discord CDN URLs for expired video attachments. No files are written —
// videos are not stored on disk.
function updateSessionVideoRefs(
  agentSlug: string,
  sessionId: string,
  newUrls: Map<string, string>, // attachmentId -> fresh CDN URL
): void {
  if (newUrls.size === 0) {
    return;
  }

  const db = getDb(agentSlug);
  const row = db.select().from(sessions).where(eq(sessions.id, sessionId)).get();
  if (row === undefined) {
    return;
  }

  const raw = vb.parse(vb.record(vb.string(), vb.unknown()), JSON.parse(row.history));
  const entries = Object.values(raw).filter((it) => isMessage(it));

  for (const msg of entries) {
    const contentArr = Array.isArray(msg.content) ? msg.content : [msg.content];
    for (const block of contentArr) {
      if (isVideoRef(block)) {
        const freshUrl = newUrls.get(block.attachmentId);
        if (freshUrl !== undefined) {
          block.url = freshUrl;
        }
      }
    }
  }

  const updatedHistory = JSON.stringify(raw);
  db.update(sessions).set({ history: updatedHistory }).where(eq(sessions.id, sessionId)).run();
}

// Persists a new summary to the database and returns the assigned ID.
function saveSummary(agentSlug: string, sessionId: string, summary: Summary): number {
  const db = getDb(agentSlug);
  const result = db
    .insert(summariesTable)
    .values({
      createdAt: summary.createdAt,
      displayName: summary.displayName,
      endMessageId: summary.endMessageId,
      preserve: JSON.stringify(summary.preserve),
      sessionId,
      slug: summary.slug,
      startMessageId: summary.startMessageId,
      summary: summary.summary,
    })
    .run();
  return Number(result.lastInsertRowid);
}

// Deletes a summary by session and slug.
function deleteSummary(agentSlug: string, sessionId: string, slug: string): void {
  const db = getDb(agentSlug);
  db.delete(summariesTable)
    .where(and(eq(summariesTable.sessionId, sessionId), eq(summariesTable.slug, slug)))
    .run();
}

export {
  flushAllSessions,
  hashImage,
  loadSessions,
  saveSession,
  deleteSession,
  resetSession,
  saveSummary,
  deleteSummary,
  updateSessionImages,
  updateSessionVideoRefs,
};
