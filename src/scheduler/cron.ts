import type { Agent } from "$/agent/index.js";
import type { CronJobConfig } from "$/config/cron.js";
import { deleteCronJob, updateLastRun } from "$/db/cron.js";
import { saveSession } from "$/db/sessions.js";
import { Engine } from "$/engine/index.js";
import { Harness } from "$/harness/index.js";
import type { Session } from "$/harness/session.js";
import { InternalSession } from "$/harness/session.js";
import colors from "$/output/colors.js";
import { debug, warning } from "$/output/log.js";

// Returns the best session to target based on a target string.
function resolveTarget(agent: Agent, target: string): Session | undefined {
  if (target === "none") {
    return undefined;
  }

  const { sessions } = agent;

  if (target === "last") {
    let best: Session | undefined = undefined;
    for (const session of sessions.values()) {
      if (best === undefined || session.lastActivity > best.lastActivity) {
        best = session;
      }
    }
    return best;
  }

  return sessions.get(target);
}

async function deliverOutput(agent: Agent, job: CronJobConfig, content: string): Promise<void> {
  const { delivery } = job;

  if (delivery === "none") {
    debug("Cron: job", colors.keyword(job.id), "delivery=none — discarding output");
    return;
  }

  if (delivery === "webhook") {
    if (job.webhookUrl === undefined) {
      warning("Cron: job", colors.keyword(job.id), "has delivery=webhook but no webhookUrl");
      return;
    }
    try {
      await fetch(job.webhookUrl, {
        body: JSON.stringify({ agentSlug: agent.slug, content, jobId: job.id }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
    } catch (error) {
      warning(
        "Cron: webhook delivery failed for job",
        colors.keyword(job.id),
        error instanceof Error ? error.message : String(error),
      );
    }
    return;
  }

  // delivery === "announce"
  const target = resolveTarget(agent, job.target);
  if (target === undefined) {
    debug("Cron: no target session to announce for job", colors.keyword(job.id));
    return;
  }

  try {
    await Harness.get().send(target, content);
  } catch (error) {
    warning(
      "Cron: announce delivery failed for job",
      colors.keyword(job.id),
      error instanceof Error ? error.message : String(error),
    );
  }
}

async function runMainSession(agent: Agent, job: CronJobConfig): Promise<void> {
  const session = resolveTarget(agent, job.target);
  if (session === undefined) {
    debug("Cron: no target session for job", colors.keyword(job.id), "— skipping");
    return;
  }

  if (session.busy) {
    debug(
      "Cron: session",
      colors.keyword(session.id()),
      "busy — skipping job",
      colors.keyword(job.id),
    );
    return;
  }

  session.busy = true;
  const historyLengthBefore = session.history.length;
  session.history.push({ content: { content: job.prompt, type: "text" }, role: "user" });

  try {
    const engine =
      job.model === undefined
        ? agent.engine
        : new Engine({
            apiBase: job.model.apiBase,
            apiKey: job.model.apiKey,
            model: job.model.model,
          });

    await engine.runTurn(session, agent.slug);
    debug("Cron: main-session job", colors.keyword(job.id), "completed");
  } catch (error) {
    session.history.length = historyLengthBefore;
    warning(
      "Cron: error in main-session job",
      colors.keyword(job.id),
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    session.busy = false;
    saveSession(agent.slug, session);
  }
}

async function runIsolatedSession(agent: Agent, job: CronJobConfig): Promise<void> {
  const session = new InternalSession(`${agent.slug}:${job.id}`);

  // Capture all respond output rather than forwarding it immediately.
  let capturedContent: string | undefined = undefined;
  session.sendFilter = (content: string): boolean => {
    capturedContent = content;
    return false;
  };

  session.history.push({ content: { content: job.prompt, type: "text" }, role: "user" });

  try {
    const engine =
      job.model === undefined
        ? agent.engine
        : new Engine({
            apiBase: job.model.apiBase,
            apiKey: job.model.apiKey,
            model: job.model.model,
          });

    await engine.runTurn(session, agent.slug);
    debug("Cron: isolated job", colors.keyword(job.id), "completed");
  } catch (error) {
    warning(
      "Cron: error in isolated job",
      colors.keyword(job.id),
      error instanceof Error ? error.message : String(error),
    );
    return;
  }

  const cc = capturedContent as string | undefined;

  if (cc === undefined || cc.trim().length === 0) {
    return;
  }

  await deliverOutput(agent, job, cc);
}

async function runCronJob(agent: Agent, job: CronJobConfig): Promise<void> {
  debug("Cron: firing job", colors.keyword(job.id), "for agent", colors.keyword(agent.slug));

  const isOneShot = "at" in job.schedule;

  if (job.execution === "main") {
    await runMainSession(agent, job);
  } else {
    await runIsolatedSession(agent, job);
  }

  if (isOneShot) {
    deleteCronJob(agent.slug, job.id);
  } else {
    updateLastRun(agent.slug, job.id, new Date().toISOString());
  }
}

export { runCronJob };
