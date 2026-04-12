import type { ConditionsConfig } from "$/config/schemas/conditions.js";
import type { IntegrationsConfig } from "$/config/schemas/integrations.js";
import type { SandboxConfig } from "$/config/schemas/sandbox.js";
import type { ExecToolConfig } from "$/config/schemas/tools.js";
import type { Database } from "$/db/index.js";
import type { Session } from "$/harness/session.js";
import type { Scheduler } from "$/scheduler/index.js";
import type { PluginToolContext, Tool } from "cireilclaw-sdk";

interface InternalToolContext extends PluginToolContext {
  db: Database;
  session: Session;
  conditions?: ConditionsConfig;
  cfg: PluginToolContext["cfg"] & {
    exec: ExecToolConfig | false;
    integrations: IntegrationsConfig;
    sandbox: SandboxConfig;
  };
  scheduler?: Scheduler;
}

interface ToolDef extends Tool {
  execute(input: unknown, ctx: InternalToolContext): Promise<Record<string, unknown>>;
}

export type { InternalToolContext as ToolContext, ToolDef };
