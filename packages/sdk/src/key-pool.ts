import { blake3 } from "@noble/hashes/blake3.js";

const DEFAULT_COOLDOWN_MS = 30 * 60 * 1000;

interface KeyFailure {
  timestamp: number;
}

function poolKeyForKeys(keys: string | string[]): string {
  const normalized = Array.isArray(keys) ? keys : [keys];
  const input = new TextEncoder().encode(normalized.join("|"));
  return Buffer.from(blake3(input)).toString("hex");
}

class KeyPool {
  private readonly keys: string[];
  private readonly cooldownMs: number;
  private readonly failures = new Map<string, KeyFailure>();
  private currentIndex = 0;

  constructor(keys: string | string[], cooldownMs = DEFAULT_COOLDOWN_MS) {
    this.keys = Array.isArray(keys) ? keys : [keys];
    this.cooldownMs = cooldownMs;

    if (this.keys.length === 0) {
      throw new Error("KeyPool requires at least one API key");
    }
  }

  getNextKey(): string {
    const now = Date.now();
    for (const [key, failure] of this.failures) {
      if (now - failure.timestamp >= this.cooldownMs) {
        this.failures.delete(key);
      }
    }

    let attempts = 0;

    while (attempts < this.keys.length) {
      const key = this.keys[this.currentIndex];
      this.currentIndex = (this.currentIndex + 1) % this.keys.length;
      attempts++;

      if (key !== undefined && !this.failures.has(key)) {
        return key;
      }
    }

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

    const [fallback] = this.keys;
    if (fallback === undefined) {
      throw new Error("KeyPool has no keys available");
    }
    return fallback;
  }

  reportFailure(key: string): void {
    this.failures.set(key, { timestamp: Date.now() });
  }

  get availableCount(): number {
    const now = Date.now();
    return this.keys.filter((key) => {
      const failure = this.failures.get(key);
      return failure === undefined || now - failure.timestamp >= this.cooldownMs;
    }).length;
  }

  get totalCount(): number {
    return this.keys.length;
  }
}

class KeyPoolManagerClass {
  private readonly pools = new Map<string, KeyPool>();

  getPool(keys: string | string[], cooldownMs = DEFAULT_COOLDOWN_MS): KeyPool {
    const key = poolKeyForKeys(keys);
    let pool = this.pools.get(key);

    if (pool === undefined) {
      pool = new KeyPool(keys, cooldownMs);
      this.pools.set(key, pool);
    }

    return pool;
  }

  clear(): void {
    this.pools.clear();
  }

  get size(): number {
    return this.pools.size;
  }
}

const KeyPoolManager = new KeyPoolManagerClass();

export { KeyPool, KeyPoolManager };
