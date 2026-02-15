import type { ImageContent } from "$/engine/content.js";
import type { Message } from "$/engine/message.js";
import type { Session } from "$/harness/session.js";

import { DiscordSession, MatrixSession } from "$/harness/session.js";
import { agentRoot } from "$/util/paths.js";
import { blake3 } from "@noble/hashes/blake3.js";
import { and, eq, inArray, notInArray } from "drizzle-orm";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getDb } from "./index.js";
import { images, sessions } from "./schema.js";

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

function hashImage(data: ArrayBuffer): string {
  return Buffer.from(blake3(new Uint8Array(data))).toString("hex");
}

// ---------------------------------------------------------------------------
// Serialized message format
// ---------------------------------------------------------------------------

// On-disk, ImageContent is replaced with a lean reference — the ArrayBuffer
// stays in a file, not in the JSON blob.
interface ImageRef {
  type: "image_ref";
  id: string;
  mediaType: string;
}

interface PendingImage {
  id: string;
  mediaType: string;
  path: string;
  data: ArrayBuffer;
}

function serializeHistory(
  history: Message[],
  agentSlug: string,
): { json: string; pendingImages: PendingImage[] } {
  const pendingImages: PendingImage[] = [];

  function serializeContent(ct: unknown): unknown {
    if (
      typeof ct === "object" &&
      ct !== null &&
      "type" in ct &&
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      (ct as { type: string }).type === "image"
    ) {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      const img = ct as ImageContent;
      const id = hashImage(img.data);
      const path = imagePath(agentSlug, id, img.mediaType);
      pendingImages.push({ data: img.data, id, mediaType: img.mediaType, path });
      return { id, mediaType: img.mediaType, type: "image_ref" } satisfies ImageRef;
    }
    return ct;
  }

  const serialized = history.map((msg) => ({
    ...msg,
    content: Array.isArray(msg.content)
      ? msg.content.map(serializeContent)
      : serializeContent(msg.content),
  }));

  return { json: JSON.stringify(serialized), pendingImages };
}

function deserializeHistory(json: string, agentSlug: string): Message[] {
  function deserializeContent(ct: unknown): unknown {
    if (
      typeof ct === "object" &&
      ct !== null &&
      "type" in ct &&
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      (ct as { type: string }).type === "image_ref"
    ) {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      const ref = ct as ImageRef;
      const path = imagePath(agentSlug, ref.id, ref.mediaType);
      const data = readFileSync(path).buffer;
      return { data, mediaType: ref.mediaType, type: "image" } satisfies ImageContent;
    }
    return ct;
  }

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const raw = JSON.parse(json) as Record<string, unknown>[];
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return raw.map((msg) => ({
    ...msg,
    content: Array.isArray(msg["content"])
      ? msg["content"].map(deserializeContent)
      : deserializeContent(msg["content"]),
  })) as Message[];
}

// ---------------------------------------------------------------------------
// Channel meta
// ---------------------------------------------------------------------------

interface DiscordMeta {
  channelId: string;
  guildId?: string;
  isNsfw?: boolean;
}

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

// Flushes all pending debounced saves immediately — call before process exit
// so in-flight data isn't lost.
function flushAllSessions(): void {
  for (const { timer, flush } of _pending.values()) {
    clearTimeout(timer);
    flush();
  }
}

function _flushSession(agentSlug: string, session: Session): void {
  const db = getDb();
  const sessionId = session.id();

  const { json: historyJson, pendingImages } = serializeHistory(session.history, agentSlug);

  // Write any new image files first (skip ones already on disk — same hash
  // means same content, so no overwrite needed).
  if (pendingImages.length > 0) {
    mkdirSync(imageDir(agentSlug), { recursive: true });
    for (const img of pendingImages) {
      if (!existsSync(img.path)) {
        writeFileSync(img.path, Buffer.from(img.data));
      }
      db.insert(images)
        .values({ agentSlug, id: img.id, mediaType: img.mediaType, sessionId })
        .onConflictDoNothing()
        .run();
    }
  }

  let meta: object | undefined = undefined;
  if (session.channel === "discord") {
    meta = {
      channelId: session.channelId,
      guildId: session.guildId,
      isNsfw: session.isNsfw,
    } satisfies DiscordMeta;
  } else {
    meta = { roomId: session.roomId };
  }

  db.insert(sessions)
    .values({
      agentSlug,
      channel: session.channel,
      history: historyJson,
      id: sessionId,
      meta: JSON.stringify(meta),
      openedFiles: JSON.stringify([...session.openedFiles]),
    })
    .onConflictDoUpdate({
      set: {
        history: historyJson,
        openedFiles: JSON.stringify([...session.openedFiles]),
      },
      target: sessions.id,
    })
    .run();
}

function loadSessions(agentSlug: string): Map<string, Session> {
  const db = getDb();
  const rows = db.select().from(sessions).where(eq(sessions.agentSlug, agentSlug)).all();
  const map = new Map<string, Session>();

  for (const row of rows) {
    const history = deserializeHistory(row.history, agentSlug);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const openedFiles = new Set(JSON.parse(row.openedFiles) as string[]);

    let session: Session | undefined = undefined;
    if (row.channel === "discord") {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      const meta = JSON.parse(row.meta) as DiscordMeta;
      session = new DiscordSession(meta.channelId, meta.guildId, meta.isNsfw);
    } else {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      const meta = JSON.parse(row.meta) as { roomId: string };
      session = new MatrixSession(meta.roomId);
    }

    session.history = history;
    session.openedFiles = openedFiles;
    map.set(row.id, session);
  }

  return map;
}

// Deletes a session and prunes image files that are no longer referenced by
// any remaining session.
function deleteSession(sessionId: string): void {
  const db = getDb();

  const referenced = db
    .select({ agentSlug: images.agentSlug, id: images.id, mediaType: images.mediaType })
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
      const path = imagePath(img.agentSlug, img.id, img.mediaType);
      try {
        unlinkSync(path);
      } catch {
        // Already gone — fine.
      }
    }
  }

  db.delete(images).where(eq(images.sessionId, sessionId)).run();
  db.delete(sessions).where(eq(sessions.id, sessionId)).run();
}

export { flushAllSessions, loadSessions, saveSession, deleteSession };
