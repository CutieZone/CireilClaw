import { Cron } from "croner";
import * as vb from "valibot";

import type { Agent } from "#agent/index.js";
import { CronJobConfigSchema } from "#config/cron.js";
import type { CronJobConfig } from "#config/cron.js";
import type { HeartbeatConfig } from "#config/heartbeat.js";
import { loadCron, loadHeartbeat } from "#config/index.js";
import { getAgentCronJobs } from "#db/cron.js";
import colors from "#output/colors.js";
import { debug, warning } from "#output/log.js";
import { runHeartbeat } from "#scheduler/heartbeat.js";

interface StopHandle {
  stop(): void;
}

function fromTimeout(timer: NodeJS.Timeout): StopHandle {
  return {
    stop() {
      clearTimeout(timer);
    },
  };
}

export class Scheduler {
  private readonly agent: Agent;
  private readonly signal: AbortSignal;
  private heartbeatHandle: StopHandle | undefined = undefined;
  private readonly cronHandles = new Map<string, StopHandle>();

  public constructor(agent: Agent, signal: AbortSignal) {
    this.agent = agent;
    this.signal = signal;
  }

  public async start(): Promise<void> {
    if (this.signal.aborted) {
      return;
    }

    const [heartbeatCfg, cronCfg] = await Promise.all([
      loadHeartbeat(this.agent.slug),
      loadCron(this.agent.slug),
    ]);

    this.scheduleHeartbeat(heartbeatCfg);

    for (const job of cronCfg.jobs) {
      if (job.enabled) {
        this.scheduleCronJob(job);
      }
    }

    for (const row of getAgentCronJobs(this.agent.slug)) {
      if (row.type !== "one-shot" || row.status !== "pending") {
        continue;
      }
      if (row.config === null) {
        continue;
      }
      try {
        const cfg = vb.parse(CronJobConfigSchema, JSON.parse(row.config));
        this.scheduleCronJob(cfg);
      } catch (error) {
        warning(
          "Scheduler: failed to parse persisted cron job",
          colors.keyword(row.jobId),
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  }

  public stop(): void {
    this.heartbeatHandle?.stop();
    this.heartbeatHandle = undefined;

    for (const [id, handle] of this.cronHandles) {
      handle.stop();
      debug("Scheduler: stopped cron job", colors.keyword(id));
    }
    this.cronHandles.clear();
  }

  public async reload(): Promise<void> {
    this.stop();
    await this.start();
    debug("Scheduler: reloaded for agent", colors.keyword(this.agent.slug));
  }

  public scheduleDynamic(job: CronJobConfig): void {
    this.scheduleCronJob(job);
  }

  private scheduleHeartbeat(cfg: HeartbeatConfig): void {
    if (!cfg.enabled || this.signal.aborted) {
      return;
    }

    const intervalMs = cfg.interval * 1000;
    const { agent, signal } = this;
    // oxlint-disable-next-line no-this-alias no-this-assignment
    const parent = this;

    function fire(): void {
      if (signal.aborted) {
        return;
      }

      // Fire and forget: errors are caught inside the async block.
      // oxlint-disable-next-line typescript/no-floating-promises
      (async (): Promise<void> => {
        try {
          await runHeartbeat(agent, cfg);
        } catch (error: unknown) {
          warning(
            "Scheduler: heartbeat error for agent",
            colors.keyword(agent.slug),
            error instanceof Error ? error.message : String(error),
          );
        }

        if (!signal.aborted) {
          const timer = setTimeout(fire, intervalMs);
          parent.heartbeatHandle = fromTimeout(timer);
        }
      })();
    }

    const timer = setTimeout(fire, intervalMs);
    this.heartbeatHandle = fromTimeout(timer);
    debug(
      "Scheduler: heartbeat scheduled for agent",
      colors.keyword(agent.slug),
      `every ${cfg.interval}s`,
    );
  }

  private scheduleCronJob(job: CronJobConfig): void {
    if (this.signal.aborted) {
      return;
    }

    const { schedule } = job;

    if ("cron" in schedule) {
      this.scheduleCronExpression(job, schedule.cron);
      return;
    }

    let delayMs = 0;
    const recurring = "every" in schedule;

    if ("every" in schedule) {
      delayMs = schedule.every * 1000;
    } else {
      const target = new Date(schedule.at).getTime();
      delayMs = target - Date.now();

      if (delayMs <= 0) {
        debug("Scheduler: one-shot job", colors.keyword(job.id), "is in the past — skipping");
        return;
      }
    }

    const { agent, signal } = this;

    const fire = (): void => {
      if (signal.aborted) {
        return;
      }

      // cron.ts imports harness/index.ts which imports scheduler/index.ts — must stay dynamic.
      // oxlint-disable-next-line typescript/no-floating-promises
      (async (): Promise<void> => {
        try {
          const { runCronJob } = await import("#scheduler/cron.js");
          await runCronJob(agent, job);
        } catch (error: unknown) {
          warning(
            "Scheduler: cron job error",
            colors.keyword(job.id),
            error instanceof Error ? error.message : String(error),
          );
        }
      })();

      // oxlint-disable-next-line typescript/no-unnecessary-condition
      if (recurring && !signal.aborted) {
        const timer = setTimeout(fire, delayMs);
        this.cronHandles.set(job.id, fromTimeout(timer));
      } else {
        this.cronHandles.delete(job.id);
      }
    };

    const timer = setTimeout(fire, delayMs);
    this.cronHandles.set(job.id, fromTimeout(timer));
    debug("Scheduler: cron job", colors.keyword(job.id), "scheduled in", `${delayMs}ms`);
  }

  private scheduleCronExpression(job: CronJobConfig, expression: string): void {
    if (this.signal.aborted) {
      return;
    }

    const { agent, signal } = this;

    const cronJob = new Cron(expression, async () => {
      if (signal.aborted) {
        return;
      }
      try {
        const { runCronJob } = await import("#scheduler/cron.js");
        await runCronJob(agent, job);
      } catch (error: unknown) {
        warning(
          "Scheduler: cron expression job error",
          colors.keyword(job.id),
          error instanceof Error ? error.message : String(error),
        );
      }
    });

    this.cronHandles.set(job.id, cronJob);
    debug("Scheduler: cron expression job", colors.keyword(job.id), "scheduled:", expression);
  }
}
