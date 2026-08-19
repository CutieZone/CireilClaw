import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchWithTimeout } from "./network.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("fetchWithTimeout", () => {
  it("clears its timer after the response arrives", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("ok")));

    await expect(fetchWithTimeout("https://example.test", {}, 1000)).resolves.toBeInstanceOf(
      Response,
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects and aborts when the deadline expires", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn().mockReturnValue(
      new Promise<Response>(() => {
        // Deliberately never resolves so the request deadline is exercised.
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const request = fetchWithTimeout("https://example.test", {}, 1000);
    const rejection = expect(request).rejects.toThrow("timed out after 1000ms");
    await vi.advanceTimersByTimeAsync(1000);

    await rejection;
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
