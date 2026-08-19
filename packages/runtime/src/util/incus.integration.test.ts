import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IncusConfig, Mount } from "#config/schemas/sandbox.js";

import { destroyIncus, execIncus, restartIncus, stopIncus } from "./incus.js";
import { root } from "./paths.js";

const enabled = process.env["CIREILCLAW_RUN_INCUS_INTEGRATION"] === "1";
const agentSlug = `integration-${process.pid}-${randomUUID().slice(0, 8)}`;
const agentPath = path.join(root(), "agents", agentSlug);
const project = process.env["CIREILCLAW_INCUS_PROJECT"];
const config: IncusConfig = {
  image: process.env["CIREILCLAW_INCUS_IMAGE"] ?? "images:debian/12",
  profiles: (process.env["CIREILCLAW_INCUS_PROFILES"] ?? "")
    .split(",")
    .map((profile) => profile.trim())
    .filter((profile) => profile.length > 0),
  ...(project === undefined ? {} : { project }),
};
const fixtureV1 = path.join(agentPath, "integration-mount-v1");
const fixtureV2 = path.join(agentPath, "integration-mount-v2");
const mountV1: Mount = { mode: "ro", source: fixtureV1, target: "fixture" };
const mountV2: Mount = { mode: "ro", source: fixtureV2, target: "fixture" };

function projectArgs(): string[] {
  return project === undefined ? [] : ["--project", project];
}

async function forceDeleteInstance(): Promise<void> {
  await new Promise<void>((resolve) => {
    const child = spawn(
      "incus",
      [...projectArgs(), "delete", "--force", `cireilclaw-${agentSlug}`],
      {
        stdio: "ignore",
      },
    );
    child.once("close", () => {
      resolve();
    });
    child.once("error", () => {
      resolve();
    });
  });
}

const describeIncus = describe.skipIf(!enabled);

describeIncus("Incus integration", () => {
  let destroyed = false;

  beforeAll(async () => {
    await Promise.all(
      ["blocks", "memories", "skills", "tasks", "workspace"].map(async (directory) => {
        await mkdir(path.join(agentPath, directory), { recursive: true });
      }),
    );
    await mkdir(fixtureV1, { recursive: true });
    await mkdir(fixtureV2, { recursive: true });
    await writeFile(path.join(fixtureV1, "input.txt"), "fixture-v1\n");
    await writeFile(path.join(fixtureV2, "input.txt"), "fixture-v2\n");
  });

  afterAll(async () => {
    if (!destroyed) {
      await forceDeleteInstance();
    }
    await rm(agentPath, { force: true, recursive: true });
  });

  it("executes as the host identity, reconciles mounts, and survives restart", async () => {
    const first = await execIncus({
      agentSlug,
      args: ["/workspace/fixture/input.txt"],
      command: "cat",
      envVars: [],
      incus: config,
      mounts: [mountV1],
      timeout: 30_000,
    });
    if (first.type === "error") {
      throw new Error(first.error);
    }
    expect(first.stdout).toBe("fixture-v1\n");

    const writeAttempt = await execIncus({
      agentSlug,
      args: ["/workspace/fixture/should-not-exist"],
      command: "touch",
      envVars: [],
      incus: config,
      mounts: [mountV1],
      timeout: 30_000,
    });
    if (writeAttempt.type === "error") {
      throw new Error(writeAttempt.error);
    }
    expect(writeAttempt.exitCode).not.toBe(0);

    const uid = await execIncus({
      agentSlug,
      args: ["-u"],
      command: "id",
      envVars: [],
      incus: config,
      mounts: [mountV1],
      timeout: 30_000,
    });
    if (uid.type === "error") {
      throw new Error(uid.error);
    }
    expect(uid.stdout.trim()).toBe(String(process.getuid?.()));

    const gid = await execIncus({
      agentSlug,
      args: ["-g"],
      command: "id",
      envVars: [],
      incus: config,
      mounts: [mountV1],
      timeout: 30_000,
    });
    if (gid.type === "error") {
      throw new Error(gid.error);
    }
    expect(gid.stdout.trim()).toBe(String(process.getgid?.()));

    const second = await execIncus({
      agentSlug,
      args: ["/workspace/fixture/input.txt"],
      command: "cat",
      envVars: [],
      incus: config,
      mounts: [mountV2],
      timeout: 30_000,
    });
    if (second.type === "error") {
      throw new Error(second.error);
    }
    expect(second.stdout).toBe("fixture-v2\n");

    await restartIncus(config, agentSlug);

    const afterRestart = await execIncus({
      agentSlug,
      args: ["/workspace/fixture/input.txt"],
      command: "cat",
      envVars: [],
      incus: config,
      mounts: [mountV2],
      timeout: 30_000,
    });
    if (afterRestart.type === "error") {
      throw new Error(afterRestart.error);
    }
    expect(afterRestart.stdout).toBe("fixture-v2\n");

    await stopIncus(config, agentSlug);
    await destroyIncus(config, agentSlug);
    destroyed = true;
  }, 120_000);
});
