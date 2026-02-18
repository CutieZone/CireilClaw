// oxlint-disable sort-keys
import type { Agent } from "$/agent/index.js";
import type { CronJobConfig } from "$/config/cron.js";
import type { HeartbeatConfig } from "$/config/heartbeat.js";

import { loadCron, loadHeartbeat } from "$/config/index.js";
import { getAgentCronJobs } from "$/db/cron.js";
import colors from "$/output/colors.js";
import { debug, warning } from "$/output/log.js";
import { runHeartbeat } from "$/scheduler/heartbeat.js";
import { Cron } from "croner";

// Uniform handle interface covering both setTimeout and croner jobs.
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
  private readonly _agent: Agent;
  private readonly _signal: AbortSignal;
  private _heartbeatHandle: StopHandle | undefined = undefined;
  // keyed by job ID
  private readonly _cronHandles = new Map<string, StopHandle>();

  constructor(agent: Agent, signal: AbortSignal) {
    this._agent = agent;
    this._signal = signal;
  }

  async start(): Promise<void> {
    if (this._signal.aborted) {
      return;
    }

    const [heartbeatCfg, cronCfg] = await Promise.all([
      loadHeartbeat(this._agent.slug),
      loadCron(this._agent.slug),
    ]);

    this._scheduleHeartbeat(heartbeatCfg);

    for (const job of cronCfg.jobs) {
      if (job.enabled) {
        this._scheduleCronJob(job);
      }
    }

    // Load and schedule persisted one-shot jobs from the DB.
    for (const row of getAgentCronJobs(this._agent.slug)) {
      if (row.type !== "one-shot" || row.status !== "pending") {
        continue;
      }
      if (row.config === null) {
        continue;
      }
      try {
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        const cfg = JSON.parse(row.config) as CronJobConfig;
        this._scheduleCronJob(cfg);
      } catch (error) {
        warning(
          "Scheduler: failed to parse persisted cron job",
          colors.keyword(row.jobId),
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  }

  stop(): void {
    this._heartbeatHandle?.stop();
    this._heartbeatHandle = undefined;

    for (const [id, handle] of this._cronHandles) {
      handle.stop();
      debug("Scheduler: stopped cron job", colors.keyword(id));
    }
    this._cronHandles.clear();
  }

  async reload(): Promise<void> {
    this.stop();
    await this.start();
    debug("Scheduler: reloaded for agent", colors.keyword(this._agent.slug));
  }

  // Register a runtime one-shot job created via the schedule tool.
  scheduleDynamic(job: CronJobConfig): void {
    this._scheduleCronJob(job);
  }

  private _scheduleHeartbeat(cfg: HeartbeatConfig): void {
    if (!cfg.enabled || this._signal.aborted) {
      return;
    }

    const intervalMs = cfg.interval * 1000;
    const agent = this._agent;
    const signal = this._signal;
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
          parent._heartbeatHandle = fromTimeout(timer);
        }
      })();
    }

    const timer = setTimeout(fire, intervalMs);
    this._heartbeatHandle = fromTimeout(timer);
    debug(
      "Scheduler: heartbeat scheduled for agent",
      colors.keyword(agent.slug),
      `every ${cfg.interval}s`,
    );
  }

  private _scheduleCronJob(job: CronJobConfig): void {
    if (this._signal.aborted) {
      return;
    }

    const { schedule } = job;

    if ("cron" in schedule) {
      this._scheduleCronExpression(job, schedule.cron);
      return;
    }

    let delayMs = 0;
    const recurring = "every" in schedule;

    if ("every" in schedule) {
      delayMs = schedule.every * 1000;
    } else {
      // at: one-shot ISO timestamp
      const target = new Date(schedule.at).getTime();
      delayMs = target - Date.now();

      if (delayMs <= 0) {
        debug("Scheduler: one-shot job", colors.keyword(job.id), "is in the past — skipping");
        return;
      }
    }

    const agent = this._agent;
    const signal = this._signal;

    const fire = (): void => {
      if (signal.aborted) {
        return;
      }

      // cron.ts imports harness/index.ts which imports scheduler/index.ts — must stay dynamic.
      // oxlint-disable-next-line typescript/no-floating-promises
      (async (): Promise<void> => {
        try {
          const { runCronJob } = await import("$/scheduler/cron.js");
          await runCronJob(agent, job);
        } catch (error: unknown) {
          warning(
            "Scheduler: cron job error",
            colors.keyword(job.id),
            error instanceof Error ? error.message : String(error),
          );
        }
      })();

      if (recurring && !signal.aborted) {
        const timer = setTimeout(fire, delayMs);
        this._cronHandles.set(job.id, fromTimeout(timer));
      } else {
        this._cronHandles.delete(job.id);
      }
    };

    const timer = setTimeout(fire, delayMs);
    this._cronHandles.set(job.id, fromTimeout(timer));
    debug("Scheduler: cron job", colors.keyword(job.id), "scheduled in", `${delayMs}ms`);
  }

  private _scheduleCronExpression(job: CronJobConfig, expression: string): void {
    if (this._signal.aborted) {
      return;
    }

    const agent = this._agent;
    const signal = this._signal;

    const cronJob = new Cron(expression, async () => {
      if (signal.aborted) {
        return;
      }
      try {
        const { runCronJob } = await import("$/scheduler/cron.js");
        await runCronJob(agent, job);
      } catch (error: unknown) {
        warning(
          "Scheduler: cron expression job error",
          colors.keyword(job.id),
          error instanceof Error ? error.message : String(error),
        );
      }
    });

    this._cronHandles.set(job.id, cronJob);
    debug("Scheduler: cron expression job", colors.keyword(job.id), "scheduled:", expression);
  }
}
