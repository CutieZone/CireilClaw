import { describe, expect, it, vi } from "vitest";

import type { Agent } from "#agent/index.js";
import { Scheduler } from "#scheduler/index.js";

const { getAgentCronJobs, runCronJob } = vi.hoisted(() => ({
  getAgentCronJobs: vi.fn(),
  runCronJob: vi.fn(),
}));

vi.mock("#config/index.js", () => ({
  loadCron: vi.fn().mockResolvedValue({ jobs: [] }),
  loadHeartbeat: vi.fn().mockResolvedValue({ enabled: false }),
}));
vi.mock("#db/cron.js", () => ({ getAgentCronJobs }));
vi.mock("#scheduler/cron.js", () => ({ runCronJob }));

describe("Scheduler.start", () => {
  it("runs a persisted overdue one-shot promptly", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-07T12:00:00Z"));
    getAgentCronJobs.mockReturnValue([
      {
        config: JSON.stringify({
          id: "overdue-report",
          prompt: "Write report",
          schedule: { at: "2026-08-07T11:00:00Z" },
        }),
        jobId: "overdue-report",
        status: "pending",
        type: "one-shot",
      },
    ]);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- scheduler startup needs only the slug.
    const agent = { slug: "test" } as unknown as Agent;
    const scheduler = new Scheduler(agent, new AbortController().signal);

    await scheduler.start();
    await vi.runAllTimersAsync();

    expect(runCronJob).toHaveBeenCalledWith(
      agent,
      expect.objectContaining({ id: "overdue-report" }),
    );
    scheduler.stop();
    vi.useRealTimers();
  });
});
