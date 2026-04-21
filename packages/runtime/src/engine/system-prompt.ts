import { readFile, stat } from "node:fs/promises";

import type { ConditionsConfig } from "$/config/schemas/conditions.js";
import type { ChannelCapabilities } from "$/harness/channel-handler.js";
import { InternalSession } from "$/harness/session.js";
import type { Session } from "$/harness/session.js";
import {
  loadBlocks,
  loadBaseInstructions,
  loadConditionalBlocks,
  loadSkills,
} from "$/util/load.js";
import { sandboxToReal } from "$/util/paths.js";

const NO_CAPABILITIES: ChannelCapabilities = {
  supportsAttachments: false,
  supportsDownloadAttachments: false,
  supportsReactions: false,
};

async function buildSystemPrompt(
  agentSlug: string,
  session: Session,
  capabilities: ChannelCapabilities,
  conditions?: ConditionsConfig,
): Promise<string> {
  const baseInstructions = await loadBaseInstructions(agentSlug);
  const blocks = await loadBlocks(agentSlug);
  const conditionalBlocks = conditions
    ? await loadConditionalBlocks(agentSlug, conditions, session)
    : [];

  const lines: string[] = [
    "<base_instructions>",
    baseInstructions.trim(),
    "</base_instructions>",
    "<memory_blocks>",
    "The following blocks are engaged in your memory:",
    "",
  ];

  for (const [key, value] of Object.entries(blocks)) {
    lines.push(
      `<${key}>`,
      "<description>",
      value.description.trim(),
      "</description>",
      "<metadata>",
      `- chars_current: ${value.metadata.chars_current}`,
      `- file_path: ${value.filePath}`,
      "</metadata>",
      "<content>",
      value.content.trim(),
      "</content>",
      `</${key}>`,
      "",
    );
  }

  // Add conditional blocks if any were loaded
  for (const block of conditionalBlocks) {
    lines.push(
      `<${block.label}>`,
      "<description>",
      block.description.trim(),
      "</description>",
      "<metadata>",
      `- chars_current: ${block.metadata.chars_current}`,
      `- file_path: ${block.filePath}`,
      "- conditional: true",
      "</metadata>",
      "<content>",
      block.content.trim(),
      "</content>",
      `</${block.label}>`,
      "",
    );
  }

  lines.push("</memory_blocks>");

  const skills = await loadSkills(agentSlug);

  if (skills.length > 0) {
    lines.push("<skills>");

    for (const skill of skills) {
      lines.push(
        `<skill slug="${skill.slug}">`,
        `<description>${skill.description}</description>`,
        `</skill>`,
      );
    }

    lines.push("</skills>");
  }

  if (session.openedFiles.size > 0) {
    lines.push("<opened_files>", "These are your currently open files:", "");

    for (const file of session.openedFiles) {
      const realPath = sandboxToReal(file, agentSlug);
      const content = await readFile(realPath, "utf8");
      const { size } = await stat(realPath);

      lines.push(`<file path="${file}" size="${size}">`, content, "</file>", "");
    }

    lines.push("</opened_files>");
  }

  lines.push("<metadata>", `The current session is on the platform: ${session.channel}`);

  if (session.channel === "discord") {
    lines.push(`The channel id is: ${session.channelId}`);
    if (session.guildId === undefined) {
      lines.push("SFW/NSFW depending on the user");
    } else {
      lines.push(`This is considered a ${session.isNsfw ? "NSFW" : "SFW"} session`);
    }
  } else if (session instanceof InternalSession) {
    lines.push(`This is an internal cron session (job ID: ${session.jobId})`);
  } else if (session.channel === "internal") {
    lines.push("This is a persistent internal session");
  } else if (session.channel === "tui") {
    lines.push("This is a TUI session with your person. SFW/NSFW depending on their preferences.");
  } else {
    throw new Error(`Unimplemented channel: ${session.channel}`);
  }

  lines.push(
    `- reactions supported: ${capabilities.supportsReactions}`,
    `- file attachments in respond supported: ${capabilities.supportsAttachments}`,
    `- attachment downloads supported: ${capabilities.supportsDownloadAttachments}`,
    "</metadata>",
  );

  return lines.join("\n");
}

export { NO_CAPABILITIES, buildSystemPrompt };
