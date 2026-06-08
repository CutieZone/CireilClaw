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

  // Determine which tools are enabled in this agent's config.
  const enabledTools = new Set(
    cfg
      .filter(([, setting]) => {
        const enabledByValue = typeof setting === "boolean" && setting;
        const enabledByKey =
          typeof setting === "object" &&
          "enabled" in setting &&
          typeof setting.enabled === "boolean" &&
          setting.enabled;
        return enabledByValue || enabledByKey;
      })
      .map(([toolName]) => toolName),
  );

  const editEnabled = enabledTools.has("edit");
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

    // When `edit` is also enabled, decorate `str-replace` as deprecated and
    // update `write` to point at `edit` instead.
    if (editEnabled) {
      if (tool === "str-replace") {
        tools.push({
          ...def,
          description: `**[DEPRECATED]** Prefer \`edit\` which offers fuzzy whitespace matching (indentation, trailing spaces, tab-vs-space differences are forgiven), a \`near\` anchor for scoping, and an \`all\` flag for bulk replacements.\n\n${def.description}`,
        });
        continue;
      }
      if (tool === "write") {
        tools.push({
          ...def,
          description: def.description.replace("str-replace", "edit"),
        });
        continue;
      }
    }

    tools.push(def);
  }

  return tools;
}
