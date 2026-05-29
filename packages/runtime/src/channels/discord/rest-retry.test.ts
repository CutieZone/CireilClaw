import { afterEach, describe, expect, it, vi } from "vitest";

import { isDiscordRestTimeout, runDiscordRestWithRetries } from "./rest-retry.js";

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
});
