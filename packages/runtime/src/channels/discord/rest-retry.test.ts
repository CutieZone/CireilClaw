import { afterEach, describe, expect, it, vi } from "vitest";

import {
  isDiscordRestConnectionError,
  isDiscordRestTimeout,
  isRetryableError,
  runDiscordRestWithRetries,
  withTimeout,
} from "./rest-retry.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("isDiscordRestTimeout", () => {
  it("recognizes Oceanic request timeout errors", () => {
    expect(
      isDiscordRestTimeout(new Error("Request Timed Out (>30000ms) on GET /channels/{id}")),
    ).toBe(true);
  });

  it("recognizes abort errors from the REST client", () => {
    expect(
      isDiscordRestTimeout({ message: "This operation was aborted", name: "AbortError" }),
    ).toBe(true);
  });

  it("does not classify unrelated REST errors as timeouts", () => {
    expect(isDiscordRestTimeout(new Error("Missing Permissions"))).toBe(false);
  });
});

describe("isDiscordRestConnectionError", () => {
  it("detects ECONNRESET wrapped as fetch failed with cause", () => {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const cause = new Error("read ECONNRESET") as unknown as Record<string, unknown>;
    cause["code"] = "ECONNRESET";

    const error = new TypeError("fetch failed");
    error.cause = cause;

    expect(isDiscordRestConnectionError(error)).toBe(true);
  });

  it("detects ECONNRESET in message text", () => {
    expect(isDiscordRestConnectionError(new Error("socket ECONNRESET"))).toBe(true);
  });

  it("detects EAI_AGAIN (DNS resolution failure)", () => {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const cause = new Error("getaddrinfo EAI_AGAIN") as unknown as Record<string, unknown>;
    cause["code"] = "EAI_AGAIN";

    const error = new TypeError("fetch failed");
    error.cause = cause;

    expect(isDiscordRestConnectionError(error)).toBe(true);
  });

  it("does not classify Discord HTTP errors as connection errors", () => {
    expect(isDiscordRestConnectionError(new Error("Missing Permissions"))).toBe(false);
  });

  it("does not classify timeouts as connection errors", () => {
    expect(
      isDiscordRestConnectionError(new Error("Request Timed Out (>30000ms) on GET /channels/{id}")),
    ).toBe(false);
  });
});

describe("isRetryableError", () => {
  it("returns true for timeout errors", () => {
    expect(isRetryableError(new Error("Request Timed Out (>30000ms) on GET /channels/{id}"))).toBe(
      true,
    );
  });

  it("returns true for connection errors", () => {
    expect(isRetryableError(new Error("socket ECONNRESET"))).toBe(true);
  });

  it("returns false for non-retryable errors", () => {
    expect(isRetryableError(new Error("Missing Permissions"))).toBe(false);
  });
});

describe("withTimeout", () => {
  it("resolves when the inner promise settles in time", async () => {
    const result = await withTimeout(Promise.resolve("ok"), 2000, "test");
    expect(result).toBe("ok");
  });

  it("rejects when the inner promise throws", async () => {
    await expect(withTimeout(Promise.reject(new Error("oops")), 2000, "test")).rejects.toThrow(
      "oops",
    );
  });

  it("rejects when the timeout is exceeded", async () => {
    await expect(
      withTimeout(
        new Promise(() => {
          // never settles — simulates oceanic.js hanging on ECONNRESET
        }),
        50,
        "GET /channels/{id}",
      ),
    ).rejects.toThrow("Discord REST operation timed out (>50ms) on GET /channels/{id}");
  }, 1000);
});

describe("runDiscordRestWithRetries", () => {
  it("retries timeout failures and returns the eventual result", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let attempts = 0;

    const result = await runDiscordRestWithRetries(
      "GET /channels/{id}",
      async () => {
        await Promise.resolve();
        attempts += 1;
        if (attempts < 3) {
          throw new Error("Request Timed Out (>30000ms) on GET /channels/{id}");
        }
        return "ok";
      },
      [0, 0],
    );

    expect(result).toBe("ok");
    expect(attempts).toBe(3);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("does not retry non-timeout failures", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let attempts = 0;

    await expect(
      runDiscordRestWithRetries(
        "GET /channels/{id}",
        async () => {
          await Promise.resolve();
          attempts += 1;
          throw new Error("Missing Permissions");
        },
        [0, 0],
      ),
    ).rejects.toThrow("Missing Permissions");

    expect(attempts).toBe(1);
  });

  it("rethrows timeout failures after retry budget is exhausted", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let attempts = 0;

    await expect(
      runDiscordRestWithRetries(
        "GET /channels/{id}",
        async () => {
          await Promise.resolve();
          attempts += 1;
          throw new Error("Request Timed Out (>30000ms) on GET /channels/{id}");
        },
        [0, 0],
      ),
    ).rejects.toThrow("Request Timed Out");

    expect(attempts).toBe(3);
  });

  it("retries ECONNRESET connection errors", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let attempts = 0;

    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const cause = new Error("read ECONNRESET") as unknown as Record<string, unknown>;
    cause["code"] = "ECONNRESET";

    const result = await runDiscordRestWithRetries(
      "GET /channels/{id}",
      async () => {
        await Promise.resolve();
        attempts += 1;
        if (attempts < 2) {
          const error = new TypeError("fetch failed");
          error.cause = cause;
          throw error;
        }
        return "ok";
      },
      [0],
    );

    expect(result).toBe("ok");
    expect(attempts).toBe(2);
  });

  it("uses withTimeout when timeoutMs is provided and oceanic hangs", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let attempts = 0;

    await expect(
      runDiscordRestWithRetries(
        "GET /channels/{id}",
        async () => {
          await Promise.resolve();
          attempts += 1;
          // Simulate oceanic.js hanging: promise never settles
          return new Promise(() => {
            /* never resolves */
          });
        },
        [0],
        50,
      ),
    ).rejects.toThrow("Discord REST operation timed out (>50ms) on GET /channels/{id}");

    // First attempt hangs, caught by timeout wrapper, retried; second attempt also hangs
    expect(attempts).toBe(2);
  }, 2000);
});
