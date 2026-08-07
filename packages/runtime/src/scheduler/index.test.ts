import { describe, expect, it, vi } from "vitest";

import type { Agent } from "#agent/index.js";
import type { CronJobConfig } from "#config/cron.js";
import { MAX_TIMEOUT_MS, Scheduler, scheduleAt } from "#scheduler/index.js";

describe("scheduleAt", () => {
  it("wakes in Node-safe chunks and recomputes the remaining delay", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-07T00:00:00Z"));
    const callback = vi.fn();
    const target = Date.now() + MAX_TIMEOUT_MS + 1000;

    scheduleAt(target, callback);
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(MAX_TIMEOUT_MS);
    expect(callback).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(1000);
    expect(callback).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it("stops an existing job before replacing its ID, including cron expressions", () => {
    const scheduler = new Scheduler(
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- scheduling only reads the agent slug.
      { slug: "test" } as unknown as Agent,
      new AbortController().signal,
    );
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- inspect private handles to verify replacement.
    const jobs = scheduler as unknown as { cronHandles: Map<string, { stop(): void }> };
    const every: CronJobConfig = {
      delivery: "announce",
      enabled: true,
      execution: "isolated",
      id: "report",
      prompt: "Write report",
      schedule: { every: 60 },
      target: "last",
    };

    scheduler.scheduleDynamic(every);
    const timeoutHandle = jobs.cronHandles.get("report");
    if (timeoutHandle === undefined) {
      throw new Error("Expected timeout handle");
    }
    const stopTimeout = vi.spyOn(timeoutHandle, "stop");

    scheduler.scheduleDynamic({ ...every, schedule: { cron: "* * * * *" } });
    expect(stopTimeout).toHaveBeenCalledOnce();

    const cronHandle = jobs.cronHandles.get("report");
    if (cronHandle === undefined) {
      throw new Error("Expected cron handle");
    }
    const stopCron = vi.spyOn(cronHandle, "stop");

    scheduler.scheduleDynamic({ ...every, schedule: { cron: "*/2 * * * *" } });
    expect(stopCron).toHaveBeenCalledOnce();
    scheduler.stop();
  });
});
