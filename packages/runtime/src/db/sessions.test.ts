import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";

import { getDb, initDb } from "#db/index.js";
import { images, sessions } from "#db/schema.js";
import {
  flushAllSessions,
  hashImage,
  loadSessions,
  resetSession,
  saveSession,
  updateSessionImages,
} from "#db/sessions.js";
import { NamedInternalSession } from "#harness/session.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

function initTestDb(): { slug: string } {
  const home = mkdtempSync(path.join(tmpdir(), "cireilclaw-db-test-"));
  vi.stubEnv("HOME", home);

  const slug = `agent-${randomUUID()}`;
  mkdirSync(path.join(home, ".cireilclaw", "agents", slug), { recursive: true });
  initDb(slug);
  return { slug };
}

function insertSession(
  slug: string,
  values: { history: unknown; historyCursor?: number; id?: string },
): string {
  const id = values.id ?? "internal:test";
  getDb(slug)
    .insert(sessions)
    .values({
      activeFileSections: "{}",
      channel: "internal",
      history: JSON.stringify(values.history),
      historyCursor: values.historyCursor ?? 0,
      id,
      meta: "{}",
      openedFiles: "[]",
    })
    .run();
  return id;
}

describe("session persistence", () => {
  it("does not persist assistant messages marked persist=false", () => {
    const { slug } = initTestDb();
    const session = new NamedInternalSession("ephemeral-assistant");
    session.history.push(
      { content: { content: "visible", type: "text" }, role: "user" },
      { content: { content: "hidden", type: "text" }, persist: false, role: "assistant" },
    );

    saveSession(slug, session);
    flushAllSessions();

    const row = getDb(slug).select().from(sessions).where(eq(sessions.id, session.id())).get();
    expect(row).toBeDefined();
    expect(JSON.parse(row?.history ?? "[]")).toEqual([
      { content: { content: "visible", type: "text" }, role: "user" },
    ]);
  });

  it("loads sessions with missing image files by dropping the missing image", async () => {
    const { slug } = initTestDb();
    const sessionId = insertSession(slug, {
      history: [
        {
          content: [
            { content: "keep", type: "text" },
            { id: "missing", mediaType: "image/webp", type: "image_ref" },
          ],
          role: "user",
        },
      ],
      id: "internal:missing-image",
    });

    const loaded = await loadSessions(slug);
    expect(loaded.get(sessionId)?.history).toEqual([
      { content: [{ content: "keep", type: "text" }], role: "user" },
    ]);
  });

  it("resets the persisted history cursor with conversation state", () => {
    const { slug } = initTestDb();
    const sessionId = insertSession(slug, {
      history: [{ content: { content: "old", type: "text" }, role: "user" }],
      historyCursor: 3,
    });

    resetSession(slug, sessionId);

    const row = getDb(slug).select().from(sessions).where(eq(sessions.id, sessionId)).get();
    expect(row?.history).toBe("[]");
    expect(row?.historyCursor).toBe(0);
  });

  it("repairs one image while preserving untouched image refs and array history", () => {
    const { slug } = initTestDb();
    const untouchedId = hashImage(new Uint8Array([2]));
    const sessionId = insertSession(slug, {
      history: [
        {
          content: { id: "old-id", mediaType: "image/webp", type: "image_ref" },
          id: "msg-1",
          role: "user",
        },
        {
          content: { id: untouchedId, mediaType: "image/webp", type: "image_ref" },
          id: "msg-2",
          role: "user",
        },
      ],
    });
    getDb(slug)
      .insert(images)
      .values([
        { id: "old-id", mediaType: "image/webp", sessionId },
        { id: untouchedId, mediaType: "image/webp", sessionId },
      ])
      .run();

    const repaired = new Uint8Array([3]);
    const repairedId = hashImage(repaired);
    updateSessionImages(slug, sessionId, new Map([["msg-1", repaired]]));

    const row = getDb(slug).select().from(sessions).where(eq(sessions.id, sessionId)).get();
    const history = JSON.parse(row?.history ?? "null") as unknown;
    expect(Array.isArray(history)).toBe(true);
    expect(history).toEqual([
      {
        content: { id: repairedId, mediaType: "image/webp", type: "image_ref" },
        id: "msg-1",
        role: "user",
      },
      {
        content: { id: untouchedId, mediaType: "image/webp", type: "image_ref" },
        id: "msg-2",
        role: "user",
      },
    ]);

    const imageRows = getDb(slug)
      .select({ id: images.id, mediaType: images.mediaType, sessionId: images.sessionId })
      .from(images)
      .where(eq(images.sessionId, sessionId))
      .all()
      .toSorted((left, right) => left.id.localeCompare(right.id));

    expect(imageRows).toEqual(
      [
        { id: repairedId, mediaType: "image/webp", sessionId },
        { id: untouchedId, mediaType: "image/webp", sessionId },
      ].toSorted((left, right) => left.id.localeCompare(right.id)),
    );
  });

  it("canonicalizes legacy internal session IDs during load", async () => {
    const { slug } = initTestDb();
    insertSession(slug, {
      history: [],
      id: "heartbeat",
    });

    const loaded = await loadSessions(slug);

    expect(loaded.has("heartbeat")).toBe(false);
    expect(loaded.has("internal:heartbeat")).toBe(true);
    expect(
      getDb(slug).select().from(sessions).where(eq(sessions.id, "heartbeat")).get(),
    ).toBeUndefined();
    expect(
      getDb(slug).select().from(sessions).where(eq(sessions.id, "internal:heartbeat")).get(),
    ).toBeDefined();
  });
});
