import * as vb from "valibot";
import { describe, expect, it } from "vitest";

import { CronJobConfigSchema } from "#config/cron.js";

const job = {
  id: "daily-report",
  prompt: "Write the report",
  schedule: { at: "2026-08-07T12:00:00Z" },
};

describe("CronJobConfigSchema", () => {
  it("accepts a valid one-shot date", () => {
    expect(vb.parse(CronJobConfigSchema, job).schedule).toEqual(job.schedule);
  });

  it("rejects an invalid one-shot date", () => {
    expect(() => vb.parse(CronJobConfigSchema, { ...job, schedule: { at: "not-a-date" } })).toThrow(
      "at must be a valid date",
    );
  });
});
