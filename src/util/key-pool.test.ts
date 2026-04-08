import { KeyPool, KeyPoolManager } from "$/util/key-pool.js";
import { afterEach, describe, expect, it, vi } from "vitest";

describe("KeyPool", () => {
  it("rotates through keys in order", () => {
    const pool = new KeyPool(["key1", "key2", "key3"], 30_000);
    expect(pool.getNextKey()).toBe("key1");
    expect(pool.getNextKey()).toBe("key2");
    expect(pool.getNextKey()).toBe("key3");
    expect(pool.getNextKey()).toBe("key1");
  });

  it("wraps a single key", () => {
    const pool = new KeyPool("solo-key", 30_000);
    expect(pool.getNextKey()).toBe("solo-key");
    expect(pool.getNextKey()).toBe("solo-key");
  });

  it("throws when constructed with empty array", () => {
    expect(() => new KeyPool([], 30_000)).toThrow("at least one API key");
  });

  it("skips keys in cooldown", () => {
    const pool = new KeyPool(["a", "b", "c"], 30_000);
    pool.reportFailure("b");
    expect(pool.getNextKey()).toBe("a");
    expect(pool.getNextKey()).toBe("c");
    expect(pool.getNextKey()).toBe("a");
  });

  it("reports availableCount correctly", () => {
    const pool = new KeyPool(["a", "b", "c"], 30_000);
    expect(pool.availableCount).toBe(3);
    expect(pool.totalCount).toBe(3);

    pool.reportFailure("a");
    expect(pool.availableCount).toBe(2);
  });

  it("recovers keys after cooldown expires", () => {
    vi.useFakeTimers();
    const pool = new KeyPool(["a", "b"], 1000);

    pool.reportFailure("a");
    expect(pool.availableCount).toBe(1);

    vi.advanceTimersByTime(999);
    expect(pool.availableCount).toBe(1);

    vi.advanceTimersByTime(1);
    expect(pool.availableCount).toBe(2);
    vi.useRealTimers();
  });

  it("throws when all keys are rate-limited", () => {
    const pool = new KeyPool(["a", "b"], 30_000);
    pool.reportFailure("a");
    pool.reportFailure("b");
    expect(() => pool.getNextKey()).toThrow("All API keys are rate-limited");
  });

  it("gives a time estimate when all keys are rate-limited", () => {
    vi.useFakeTimers();
    const pool = new KeyPool(["a", "b"], 5000);
    pool.reportFailure("a");

    vi.advanceTimersByTime(2000);
    pool.reportFailure("b");

    try {
      pool.getNextKey();
      expect.unreachable("Should have thrown");
    } catch (error) {
      expect(error instanceof Error && error.message).toContain("seconds");
    }
    vi.useRealTimers();
  });

  it("removes expired cooldowns on getNextKey", () => {
    vi.useFakeTimers();
    const pool = new KeyPool(["a", "b"], 1000);

    pool.reportFailure("a");
    expect(pool.availableCount).toBe(1);

    vi.advanceTimersByTime(1000);
    const key = pool.getNextKey();
    expect(key).toBeDefined();
    expect(pool.availableCount).toBe(2);
    vi.useRealTimers();
  });
});

describe("KeyPoolManager", () => {
  afterEach(() => {
    KeyPoolManager.clear();
  });

  it("returns the same pool for identical keys", () => {
    const pool1 = KeyPoolManager.getPool(["a", "b"]);
    const pool2 = KeyPoolManager.getPool(["a", "b"]);
    expect(pool1).toBe(pool2);
  });

  it("returns different pools for different keys", () => {
    const pool1 = KeyPoolManager.getPool(["a"]);
    const pool2 = KeyPoolManager.getPool(["b"]);
    expect(pool1).not.toBe(pool2);
  });

  it("tracks pool count", () => {
    expect(KeyPoolManager.size).toBe(0);
    KeyPoolManager.getPool("key1");
    expect(KeyPoolManager.size).toBe(1);
    KeyPoolManager.getPool("key2");
    expect(KeyPoolManager.size).toBe(2);
  });

  it("clear resets all pools", () => {
    KeyPoolManager.getPool("key1");
    KeyPoolManager.getPool("key2");
    KeyPoolManager.clear();
    expect(KeyPoolManager.size).toBe(0);
  });
});
