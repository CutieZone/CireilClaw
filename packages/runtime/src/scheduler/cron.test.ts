import { describe, expect, it, vi } from "vitest";

import type { Agent } from "#agent/index.js";
import type { CronJobConfig } from "#config/cron.js";
import { runCronJob } from "#scheduler/cron.js";

const { deleteCronJob, updateLastRun } = vi.hoisted(() => ({
  deleteCronJob: vi.fn(),
  updateLastRun: vi.fn(),
}));

vi.mock("#db/cron.js", () => ({ deleteCronJob, updateLastRun }));
vi.mock("#db/sessions.js", () => ({ saveSession: vi.fn() }));

const job: CronJobConfig = {
  delivery: "none",
  enabled: true,
  execution: "main",
  id: "report",
  prompt: "Write report",
  schedule: { at: "2026-08-07T12:00:00Z" },
  target: "last",
};

describe("runCronJob", () => {
  it("keeps a one-shot pending when its target is busy", async () => {
    const agent = {
      resolveTarget: vi.fn().mockResolvedValue({ busy: true, id: (): string => "session" }),
      slug: "test",
    };

    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- this path only resolves a target.
    await expect(runCronJob(agent as unknown as Agent, job)).resolves.toBe(false);
    expect(deleteCronJob).not.toHaveBeenCalled();
  });

  it("keeps a one-shot pending when the target is missing", async () => {
    const agent = {
      resolveTarget: vi.fn().mockResolvedValue(undefined),
      slug: "test",
    };

    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- this path only resolves a target.
    await expect(runCronJob(agent as unknown as Agent, job)).resolves.toBe(false);
    expect(deleteCronJob).not.toHaveBeenCalled();
  });

  it("keeps a one-shot pending when execution fails", async () => {
    const session = { busy: false, history: [], id: (): string => "session" };
    const agent = {
      resolveTarget: vi.fn().mockResolvedValue(session),
      runScheduledTurn: vi.fn().mockRejectedValue(new Error("failed")),
      send: vi.fn(),
      slug: "test",
    };

    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- mocked agent exposes this execution path.
    await expect(runCronJob(agent as unknown as Agent, job)).resolves.toBe(false);
    expect(deleteCronJob).not.toHaveBeenCalled();
  });

  it("deletes a one-shot only after it runs", async () => {
    const session = { busy: false, history: [], id: (): string => "session" };
    const agent = {
      resolveTarget: vi.fn().mockResolvedValue(session),
      runScheduledTurn: vi.fn().mockResolvedValue(undefined),
      slug: "test",
    };

    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- mocked agent exposes this execution path.
    await expect(runCronJob(agent as unknown as Agent, job)).resolves.toBe(true);
    expect(deleteCronJob).toHaveBeenCalledWith("test", "report");
    expect(updateLastRun).not.toHaveBeenCalled();
  });
});
