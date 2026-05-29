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
  return normalized.includes("request timed out") || normalized.includes("operation was aborted");
}

async function runDiscordRestWithRetries<Result>(
  label: string,
  operation: () => Promise<Result>,
  retryDelaysMs: readonly number[] = DISCORD_REST_RETRY_DELAYS_MS,
): Promise<Result> {
  let failedAttempts = 0;

  for (;;) {
    const started = performance.now();
    try {
      const result = await operation();
      const elapsedMs = Math.round(performance.now() - started);
      if (elapsedMs >= DISCORD_REST_SLOW_WARNING_MS) {
        warning("Slow Discord REST operation", label, "completed in", `${elapsedMs}ms`);
      }
      return result;
    } catch (error: unknown) {
      const elapsedMs = Math.round(performance.now() - started);
      const retryDelayMs = retryDelaysMs[failedAttempts];
      if (!isDiscordRestTimeout(error) || retryDelayMs === undefined) {
        throw error;
      }

      failedAttempts += 1;
      warning(
        "Discord REST operation",
        label,
        "timed out after",
        `${elapsedMs}ms;`,
        "retrying in",
        `${retryDelayMs}ms`,
        `(attempt ${failedAttempts + 1}/${retryDelaysMs.length + 1})`,
      );
      await sleep(retryDelayMs);
    }
  }
}

export { isDiscordRestTimeout, runDiscordRestWithRetries };
