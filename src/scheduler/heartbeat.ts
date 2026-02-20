import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { Agent } from "$/agent/index.js";
import type { HeartbeatConfig } from "$/config/heartbeat.js";
import { saveSession } from "$/db/sessions.js";
import { Engine } from "$/engine/index.js";
import type { Session } from "$/harness/session.js";
import colors from "$/output/colors.js";
import { debug, warning } from "$/output/log.js";
import { agentRoot } from "$/util/paths.js";

const HEARTBEAT_OK = "HEARTBEAT_OK";

// Returns the most recently active session from the agent's session map,
// or undefined if there are none.
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

// Check whether the current time falls within the configured active hours window.
function isInActiveHours(activeHours: NonNullable<HeartbeatConfig["activeHours"]>): boolean {
  try {
    const now = new Date();
    const fmt = new Intl.DateTimeFormat("en-US", {
      hour: "2-digit",
      hour12: false,
      minute: "2-digit",
      timeZone: activeHours.timezone,
    });

    const parts = fmt.formatToParts(now);
    const hour = parts.find((part) => part.type === "hour")?.value ?? "00";
    const minute = parts.find((part) => part.type === "minute")?.value ?? "00";
    const current = `${hour}:${minute}`;

    return current >= activeHours.start && current <= activeHours.end;
  } catch {
    // Malformed timezone or format — allow the heartbeat to proceed.
    return true;
  }
}

export async function runHeartbeat(agent: Agent, cfg: HeartbeatConfig): Promise<void> {
  debug("Heartbeat: firing for agent", colors.keyword(agent.slug));

  if (cfg.activeHours !== undefined && !isInActiveHours(cfg.activeHours)) {
    debug("Heartbeat: outside active hours — skipping");
    return;
  }

  const checklistPath = join(agentRoot(agent.slug), "workspace", "HEARTBEAT.md");
  if (!existsSync(checklistPath)) {
    debug("Heartbeat: no HEARTBEAT.md found — skipping");
    return;
  }

  const checklist = await readFile(checklistPath, "utf8").catch(() => "");
  if (checklist.trim().length === 0) {
    debug("Heartbeat: HEARTBEAT.md is empty — skipping");
    return;
  }

  const session = resolveTarget(agent, cfg.target);
  if (session === undefined) {
    debug("Heartbeat: no target session found — skipping");
    return;
  }

  if (session.busy) {
    debug("Heartbeat: session", colors.keyword(session.id()), "is busy — skipping");
    return;
  }

  session.busy = true;

  // Capture the respond output and check for HEARTBEAT_OK.
  let capturedContent: string | undefined = undefined;
  const previousFilter = session.sendFilter;
  session.sendFilter = (content: string): boolean => {
    capturedContent = content;
    const isOk = content.trim() === HEARTBEAT_OK;

    if (isOk) {
      return cfg.visibility.showOk;
    }
    return cfg.visibility.showAlerts;
  };

  const historyLengthBefore = session.history.length;
  session.history.push({
    content: {
      content: `[HEARTBEAT] Evaluate your heartbeat checklist.\n\n${checklist}`,
      type: "text",
    },
    role: "user",
  });

  try {
    const engine =
      cfg.model === undefined
        ? agent.engine
        : new Engine({
            apiBase: cfg.model.apiBase ?? agent.engine.apiBase,
            apiKey: cfg.model.apiKey ?? agent.engine.apiKey,
            channel: agent.engine.overrides,
            model: cfg.model.model ?? agent.engine.model,
          });

    await engine.runTurn(session, agent.slug);

    const cc = capturedContent as string | undefined;
    debug(
      "Heartbeat: completed for agent",
      colors.keyword(agent.slug),
      cc?.trim() === HEARTBEAT_OK ? "(OK)" : "(alert)",
    );
  } catch (error) {
    // Roll back history on failure to avoid a stranded heartbeat message.
    session.history.length = historyLengthBefore;
    warning(
      "Heartbeat: error during turn for agent",
      colors.keyword(agent.slug),
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    session.sendFilter = previousFilter;
    session.busy = false;
    saveSession(agent.slug, session);
  }
}
