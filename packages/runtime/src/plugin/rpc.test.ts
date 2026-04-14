import { MessageChannel } from "node:worker_threads";

import { describe, it, expect, afterEach } from "vitest";

import { RpcChannel } from "./rpc.js";

const channels: RpcChannel[] = [];

function pair(): [RpcChannel, RpcChannel] {
  const mc = new MessageChannel();
  const client = new RpcChannel(mc.port1);
  const server = new RpcChannel(mc.port2);
  channels.push(client, server);
  return [client, server];
}

async function hangForever(): Promise<unknown> {
  return await new Promise(() => {
    // never resolves
  });
}

function isNumberPair(value: unknown): value is [number, number] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === "number" &&
    typeof value[1] === "number"
  );
}

afterEach(() => {
  for (const chan of channels.splice(0)) {
    chan.close();
  }
});

describe("RpcChannel", () => {
  it("round-trips a call and response", async () => {
    const [client, server] = pair();
    server.handle("add", async (args) => {
      if (!isNumberPair(args)) {
        throw new TypeError("expected [number, number]");
      }
      return await Promise.resolve(args[0] + args[1]);
    });
    const result = await client.call<number>("add", [2, 3]);
    expect(result).toBe(5);
  });

  it("propagates errors with name, message, and hint", async () => {
    const [client, server] = pair();
    server.handle("boom", async () => {
      const err = new Error("kaboom");
      err.name = "ToolError";
      Object.assign(err, { hint: "try again" });
      return await Promise.reject(err);
    });
    await expect(client.call("boom")).rejects.toMatchObject({
      hint: "try again",
      message: "kaboom",
      name: "ToolError",
    });
  });

  it("rejects with 'Unknown RPC method' for unhandled methods", async () => {
    const [client] = pair();
    await expect(client.call("nope")).rejects.toThrow("Unknown RPC method: nope");
  });

  it("times out a pending call when timeoutMs elapses", async () => {
    const [client, server] = pair();
    server.handle("hang", async () => await hangForever());
    await expect(client.call("hang", [], 50)).rejects.toThrow(/timed out after 50ms/);
  });

  it("clears timer when response arrives before timeout", async () => {
    const [client, server] = pair();
    server.handle("fast", async () => await Promise.resolve("ok"));
    const result = await client.call<string>("fast", [], 1000);
    expect(result).toBe("ok");
  });

  it("close() rejects all pending calls", async () => {
    const [client, server] = pair();
    server.handle("hang", async () => await hangForever());
    const p1 = client.call("hang");
    const p2 = client.call("hang");
    client.close();
    await expect(p1).rejects.toThrow("RPC channel closed");
    await expect(p2).rejects.toThrow("RPC channel closed");
  });

  it("call() after close throws immediately", async () => {
    const [client] = pair();
    client.close();
    await expect(client.call("anything")).rejects.toThrow("RPC channel closed");
  });

  it("close() is idempotent", () => {
    const [client] = pair();
    client.close();
    expect(() => {
      client.close();
    }).not.toThrow();
  });
});
