import { describe, expect, it, vi } from "vitest";

import { schedule } from "./schedule.js";

const { upsertCronJob } = vi.hoisted(() => ({ upsertCronJob: vi.fn() }));

vi.mock("#db/cron.js", () => ({ upsertCronJob }));

describe("schedule", () => {
  it("binds the default current target to the session that creates the job", async () => {
    await schedule.execute(
      { at: "2030-01-01T00:00:00Z", id: "reminder", prompt: "Remind me" },
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- this tool only reads agentSlug and session.id().
      { agentSlug: "test-agent", session: { id: () => "discord:dm-channel" } } as Parameters<
        typeof schedule.execute
      >[1],
    );

    expect(upsertCronJob).toHaveBeenCalledWith(
      "test-agent",
      "reminder",
      expect.objectContaining({
        // oxlint-disable-next-line typescript/no-unsafe-assignment -- Vitest matchers return any.
        config: expect.stringContaining('"target":"discord:dm-channel"'),
      }),
    );
  });
});
