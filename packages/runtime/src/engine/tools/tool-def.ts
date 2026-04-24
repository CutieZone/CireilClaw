import type { PluginToolContext, Tool } from "@cireilclaw/sdk";

import type { ConditionsConfig } from "#config/schemas/conditions.js";
import type { SandboxConfig } from "#config/schemas/sandbox.js";
import type { ExecToolConfig } from "#config/schemas/tools.js";
import type { Database } from "#db/index.js";
import type { HistoryDirection, HistoryMessage } from "#harness/channel-handler.js";
import type { Session } from "#harness/session.js";
import type { Scheduler } from "#scheduler/index.js";

interface InternalToolContext extends PluginToolContext {
  db: Database;
  session: Session;
  conditions?: ConditionsConfig;
  cfg: PluginToolContext["cfg"] & {
    exec: ExecToolConfig | false;
    sandbox: SandboxConfig;
  };
  reply: PluginToolContext["reply"] & {
    sendTo: (targetSession: Session, content: string, attachments?: string[]) => Promise<void>;
  };
  channel: PluginToolContext["channel"] & {
    downloadAttachments?: (messageId: string) => Promise<{ filename: string; data: Buffer }[]>;
    fetchHistory?: (
      messageId: string,
      direction: HistoryDirection,
      limit?: number,
    ) => Promise<HistoryMessage[]>;
  };
  scheduler?: Scheduler;
}

interface ToolDef extends Tool {
  execute(input: unknown, ctx: InternalToolContext): Promise<Record<string, unknown>>;
}

export type { InternalToolContext as ToolContext, ToolDef };
