import { loadTools } from "#config/index.js";
import type { ToolsConfig } from "#config/schemas/tools.js";
import type { Tool } from "#engine/tool.js";
import { getToolRegistry } from "#engine/tools/index.js";
import type { Session } from "#harness/session.js";
import colors from "#output/colors.js";

export async function buildTools(
  agentSlug: string,
  _session: Session,
  toolsConfig?: ToolsConfig,
): Promise<Tool[]> {
  const cfg = Object.entries(toolsConfig ?? (await loadTools(agentSlug)));

  const tools: Tool[] = [];

  for (const [tool, setting] of cfg) {
    const def = getToolRegistry()[tool];

    if (def === undefined) {
      throw new Error(`Tried to enable invalid tool ${colors.keyword(tool)}: does not exist`);
    }

    const enabledByValue = typeof setting === "boolean" && setting;
    const enabledByKey =
      typeof setting === "object" &&
      "enabled" in setting &&
      typeof setting.enabled === "boolean" &&
      setting.enabled;

    if (!(enabledByValue || enabledByKey)) {
      continue;
    }

    tools.push(def);
  }

  return tools;
}
