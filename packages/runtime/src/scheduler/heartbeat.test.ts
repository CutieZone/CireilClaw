import { describe, expect, it } from "vitest";

import { isWithinActiveHours } from "#scheduler/heartbeat.js";

describe("isWithinActiveHours", () => {
  it("treats an end time of 00:00 as the end of the active day", () => {
    expect(isWithinActiveHours("08:00", "08:00", "00:00")).toBe(true);
    expect(isWithinActiveHours("22:39", "08:00", "00:00")).toBe(true);
    expect(isWithinActiveHours("23:59", "08:00", "00:00")).toBe(true);
    expect(isWithinActiveHours("00:00", "08:00", "00:00")).toBe(true);
  });

  it("does not turn a midnight end into a wraparound window", () => {
    expect(isWithinActiveHours("00:01", "08:00", "00:00")).toBe(false);
    expect(isWithinActiveHours("07:59", "08:00", "00:00")).toBe(false);
  });

  it("keeps normal same-day end bounds inclusive", () => {
    expect(isWithinActiveHours("08:00", "08:00", "22:00")).toBe(true);
    expect(isWithinActiveHours("22:00", "08:00", "22:00")).toBe(true);
    expect(isWithinActiveHours("22:01", "08:00", "22:00")).toBe(false);
  });
});
