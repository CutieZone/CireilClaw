import { setTimeout as sleep } from "node:timers/promises";

import { warning } from "#output/log.js";

const DISCORD_REST_RETRY_DELAYS_MS = [1000, 3000] as const;
const DISCORD_REST_SLOW_WARNING_MS = 10_000;

function isDiscordRestTimeout(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  const name = "name" in error ? error.name : undefined;
  if (name === "AbortError") {
    return true;
  }

  const message = "message" in error ? error.message : undefined;
  if (typeof message !== "string") {
    return false;
  }

  const normalized = message.toLowerCase();
  return (
    normalized.includes("request timed out") ||
    normalized.includes("timed out (") ||
    normalized.includes("operation was aborted")
  );
}

function isDiscordRestConnectionError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  const name = "name" in error ? error.name : undefined;
  if (name === "AbortError") {
    return false;
  }

  const message = "message" in error ? error.message : undefined;
  if (typeof message !== "string") {
    return false;
  }

  const normalized = message.toLowerCase();

  // Node.js fetch() wraps network errors as TypeError with a cause property.
  if (normalized === "fetch failed") {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const errRecord = error as Record<string, unknown>;
    const { cause } = errRecord;
    if (typeof cause === "object" && cause !== null) {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      const causeRecord = cause as Record<string, unknown>;
      const { code } = causeRecord;
      if (
        code === "ECONNRESET" ||
        code === "EAI_AGAIN" ||
        code === "ETIMEDOUT" ||
        code === "EPIPE" ||
        code === "ENOTFOUND" ||
        code === "ECONNREFUSED" ||
        code === "ENETUNREACH"
      ) {
        return true;
      }
    }
    return true; // Any fetch failure is worth retrying
  }

  return (
    normalized.includes("econnreset") ||
    normalized.includes("eai_again") ||
    normalized.includes("etimedout") ||
    normalized.includes("econnrefused") ||
    normalized.includes("enetunreach") ||
    normalized.includes("fetch failed")
  );
}

function isRetryableError(error: unknown): boolean {
  return isDiscordRestTimeout(error) || isDiscordRestConnectionError(error);
}

/**
 * Wraps a promise with a timeout that rejects if it doesn't settle within the
 * given duration. This guards against oceanic.js's REST handler leaking
 * promises on certain network errors (e.g. ECONNRESET) where it emits the
 * error on the client event but never rejects the request promise.
 */
// oxlint-disable-next-line typescript/promise-function-async
function withTimeout<Result>(
  promise: Promise<Result>,
  timeoutMs: number,
  label: string,
): Promise<Result> {
  let rejectTimeout: ((reason: Error) => void) | undefined = undefined;
  const timeout = new Promise<Result>((_resolve, reject) => {
    rejectTimeout = reject;
  });
  const timer = setTimeout(() => {
    rejectTimeout?.(new Error(`Discord REST operation timed out (>${timeoutMs}ms) on ${label}`));
  }, timeoutMs);

  return (async (): Promise<Result> => {
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      clearTimeout(timer);
    }
  })();
}

async function runDiscordRestWithRetries<Result>(
  label: string,
  operation: () => Promise<Result>,
  retryDelaysMs: readonly number[] = DISCORD_REST_RETRY_DELAYS_MS,
  timeoutMs?: number,
): Promise<Result> {
  let failedAttempts = 0;

  for (;;) {
    const started = performance.now();
    try {
      let resultPromise = operation();

      // oceanic.js can hang promises on network errors like ECONNRESET.
      // Apply a safety timeout to prevent indefinite hangs.
      if (timeoutMs !== undefined) {
        resultPromise = withTimeout(resultPromise, timeoutMs, label);
      }

      const result = await resultPromise;
      const elapsedMs = Math.round(performance.now() - started);
      if (elapsedMs >= DISCORD_REST_SLOW_WARNING_MS) {
        warning("Slow Discord REST operation", label, "completed in", `${elapsedMs}ms`);
      }
      return result;
    } catch (error: unknown) {
      const elapsedMs = Math.round(performance.now() - started);
      const retryDelayMs = retryDelaysMs[failedAttempts];
      if (!isRetryableError(error) || retryDelayMs === undefined) {
        throw error;
      }

      failedAttempts += 1;

      const qualifier = isDiscordRestConnectionError(error) ? "connection error" : "timed out";

      warning(
        "Discord REST operation",
        label,
        `${qualifier} after`,
        `${elapsedMs}ms;`,
        "retrying in",
        `${retryDelayMs}ms`,
        `(attempt ${failedAttempts + 1}/${retryDelaysMs.length + 1})`,
      );
      await sleep(retryDelayMs);
    }
  }
}

export {
  isDiscordRestConnectionError,
  isDiscordRestTimeout,
  isRetryableError,
  runDiscordRestWithRetries,
  withTimeout,
};
