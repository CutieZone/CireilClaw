/* oxlint-disable eslint-plugin-unicorn/require-post-message-target-origin
   -- node:worker_threads postMessage has no targetOrigin; this rule is for browser window.postMessage */

import type { MessagePort, Worker } from "node:worker_threads";

interface PortLike {
  postMessage: (message: unknown) => void;
  on: (event: "message", handler: (message: unknown) => void) => unknown;
  off: (event: "message", handler: (message: unknown) => void) => unknown;
}

interface RpcRequest {
  kind: "req";
  id: number;
  method: string;
  args: unknown[];
}

interface RpcError {
  message: string;
  name?: string;
  hint?: string;
  stack?: string;
}

interface RpcResponseOk {
  kind: "res";
  id: number;
  ok: true;
  value: unknown;
}

interface RpcResponseErr {
  kind: "res";
  id: number;
  ok: false;
  error: RpcError;
}

type RpcMessage = RpcRequest | RpcResponseOk | RpcResponseErr;

type Handler = (args: unknown[]) => Promise<unknown>;

function isRpcMessage(value: unknown): value is RpcMessage {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const { kind, id } = value as { kind?: unknown; id?: unknown };
  return (kind === "req" || kind === "res") && typeof id === "number";
}

function extractHint(error: Error): string | undefined {
  if (!("hint" in error)) {
    return undefined;
  }
  const { hint } = error;
  return typeof hint === "string" ? hint : undefined;
}

class RpcChannel {
  private readonly port: PortLike;
  private nextId = 1;
  private closed = false;
  private readonly pending = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer?: NodeJS.Timeout;
    }
  >();
  private readonly handlers = new Map<string, Handler>();
  private readonly listener = (raw: unknown): void => {
    this.onMessage(raw);
  };

  public constructor(port: PortLike) {
    this.port = port;
    port.on("message", this.listener);
  }

  // oxlint-disable-next-line eslint/id-length -- `call` mirrors JS-RPC convention
  public async call<T = unknown>(
    method: string,
    args: unknown[] = [],
    timeoutMs?: number,
  ): Promise<T> {
    if (this.closed) {
      throw new Error("RPC channel closed");
    }
    const id = this.nextId++;
    return await new Promise<T>((resolve, reject) => {
      const entry: {
        resolve: (value: unknown) => void;
        reject: (error: Error) => void;
        timer?: NodeJS.Timeout;
      } = {
        reject,
        resolve: (value: unknown): void => {
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- generic untyped channel; caller's T is the contract
          resolve(value as T);
        },
      };
      if (timeoutMs !== undefined && timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          if (this.pending.delete(id)) {
            reject(new Error(`RPC call ${method} timed out after ${timeoutMs}ms`));
          }
        }, timeoutMs);
      }
      this.pending.set(id, entry);
      const msg: RpcRequest = { args, id, kind: "req", method };
      this.port.postMessage(msg);
    });
  }

  public handle(method: string, fn: Handler): void {
    this.handlers.set(method, fn);
  }

  public close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.port.off("message", this.listener);
    for (const { reject, timer } of this.pending.values()) {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      reject(new Error("RPC channel closed"));
    }
    this.pending.clear();
  }

  private onMessage(raw: unknown): void {
    if (!isRpcMessage(raw)) {
      return;
    }
    if (raw.kind === "req") {
      // Fire-and-forget: dispatch() already catches internally and posts error responses.
      // oxlint-disable-next-line eslint-plugin-promise/prefer-await-to-then -- intentional fire-and-forget
      this.dispatch(raw).catch(() => undefined);
      return;
    }
    const entry = this.pending.get(raw.id);
    if (entry === undefined) {
      return;
    }
    this.pending.delete(raw.id);
    if (entry.timer !== undefined) {
      clearTimeout(entry.timer);
    }
    if (raw.ok) {
      entry.resolve(raw.value);
      return;
    }
    const error = new Error(raw.error.message);
    if (raw.error.name !== undefined) {
      error.name = raw.error.name;
    }
    if (raw.error.hint !== undefined) {
      Object.assign(error, { hint: raw.error.hint });
    }
    if (raw.error.stack !== undefined) {
      error.stack = raw.error.stack;
    }
    entry.reject(error);
  }

  private async dispatch(req: RpcRequest): Promise<void> {
    const fn = this.handlers.get(req.method);
    if (fn === undefined) {
      const msg: RpcResponseErr = {
        error: { message: `Unknown RPC method: ${req.method}` },
        id: req.id,
        kind: "res",
        ok: false,
      };
      this.port.postMessage(msg);
      return;
    }
    try {
      const value = await fn(req.args);
      const msg: RpcResponseOk = { id: req.id, kind: "res", ok: true, value };
      this.port.postMessage(msg);
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      const msg: RpcResponseErr = {
        error: { hint: extractHint(err), message: err.message, name: err.name, stack: err.stack },
        id: req.id,
        kind: "res",
        ok: false,
      };
      this.port.postMessage(msg);
    }
  }
}

// Structural compatibility checks — fail at type-check time if Node's Worker/MessagePort drift.
type _WorkerCompat = Worker extends PortLike ? true : false;
type _MessagePortCompat = MessagePort extends PortLike ? true : false;
const _compatCheck: [_WorkerCompat, _MessagePortCompat] = [true, true];
// oxlint-disable-next-line eslint/no-void -- sink unused type-level marker
void _compatCheck;

export type { PortLike };
export { RpcChannel };
