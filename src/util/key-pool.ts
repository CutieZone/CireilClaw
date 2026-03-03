import { debug } from "$/output/log.js";

const DEFAULT_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes

interface KeyFailure {
  timestamp: number;
}

export class KeyPool {
  private readonly keys: string[];
  private readonly cooldownMs: number;
  private readonly failures = new Map<string, KeyFailure>();
  private currentIndex = 0;

  constructor(keys: string | string[], cooldownMs = DEFAULT_COOLDOWN_MS) {
    // Normalize single key to array
    this.keys = Array.isArray(keys) ? keys : [keys];
    this.cooldownMs = cooldownMs;

    if (this.keys.length === 0) {
      throw new Error("KeyPool requires at least one API key");
    }
  }

  /**
   * Get the next available key, skipping any that are in cooldown.
   * Throws if all keys are in cooldown.
   */
  getNextKey(): string {
    // Clean up expired cooldowns first
    const now = Date.now();
    for (const [key, failure] of this.failures) {
      if (now - failure.timestamp >= this.cooldownMs) {
        this.failures.delete(key);
        debug("KeyPool: Removed key from cooldown (expired)");
      }
    }

    // Try to find a key not in cooldown
    let attempts = 0;

    while (attempts < this.keys.length) {
      const key = this.keys[this.currentIndex];
      this.currentIndex = (this.currentIndex + 1) % this.keys.length;
      attempts++;

      if (key !== undefined && !this.failures.has(key)) {
        return key;
      }
    }

    // All keys are in cooldown - find the one that will recover soonest
    let soonestKey: string | undefined = undefined;
    let soonestRecovery = Infinity;

    for (const key of this.keys) {
      const failure = this.failures.get(key);
      if (failure !== undefined) {
        const recoveryIn = failure.timestamp + this.cooldownMs - now;
        if (recoveryIn < soonestRecovery) {
          soonestRecovery = recoveryIn;
          soonestKey = key;
        }
      }
    }

    if (soonestKey !== undefined) {
      const waitSeconds = Math.ceil(soonestRecovery / 1000);
      throw new Error(
        `All API keys are rate-limited. Next key available in ~${waitSeconds} seconds.`,
      );
    }

    // Fallback - should not happen if we have at least one key
    const [fallback] = this.keys;
    if (fallback === undefined) {
      throw new Error("KeyPool has no keys available");
    }
    return fallback;
  }

  /**
   * Report that a key has hit a rate limit (429).
   * This puts the key in cooldown.
   */
  reportFailure(key: string): void {
    this.failures.set(key, { timestamp: Date.now() });
    debug(`KeyPool: Key rate-limited, entering cooldown for ${this.cooldownMs / 60_000} minutes`);
  }

  /**
   * Get the number of keys currently available (not in cooldown).
   */
  get availableCount(): number {
    const now = Date.now();
    return this.keys.filter((key) => {
      const failure = this.failures.get(key);
      return failure === undefined || now - failure.timestamp >= this.cooldownMs;
    }).length;
  }

  /**
   * Get total number of keys in the pool.
   */
  get totalCount(): number {
    return this.keys.length;
  }
}
