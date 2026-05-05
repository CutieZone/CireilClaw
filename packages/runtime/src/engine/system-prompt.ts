import { readFile, stat } from "node:fs/promises";

import type { ConditionsConfig } from "#config/schemas/conditions.js";
import type { ChannelCapabilities } from "#harness/channel-handler.js";
import { InternalSession } from "#harness/session.js";
import type { Session } from "#harness/session.js";
import { loadBlocks, loadBaseInstructions, loadConditionalBlocks, loadSkills } from "#util/load.js";
import { sandboxToReal } from "#util/paths.js";

const NO_CAPABILITIES: ChannelCapabilities = {
  supportsAttachments: false,
  supportsDownloadAttachments: false,
  supportsReactions: false,
};

// Extracts the content of a named section from a file by finding the heading
// or XML element with a matching id and returning lines until the next
// same-or-higher-level boundary.
function extractSectionContent(content: string, sectionId: string): string {
  const lines = content.split("\n");

  // Try markdown heading match first (slugified id)
  const headingRegex = /^(#{1,6})\s+(.+)$/;
  let inSection = false;
  let currentLevel = 0;
  const result: string[] = [];

  for (const line of lines) {
    const headingMatch = headingRegex.exec(line);
    if (headingMatch !== null) {
      const level = headingMatch[1]?.length ?? 1;
      const text = headingMatch[2] ?? "";
      const id = text
        .toLowerCase()
        .replaceAll(/[^a-z0-9]+/g, "-")
        .replaceAll(/^-+|-+$/g, "");

      if (id === sectionId) {
        inSection = true;
        currentLevel = level;
        result.push(line);
        continue;
      }

      if (inSection && level <= currentLevel) {
        // Next heading at same or higher level — section ends
        break;
      }

      if (inSection) {
        result.push(line);
      }
      continue;
    }

    if (inSection) {
      result.push(line);
    }
  }

  if (result.length > 0) {
    return result.join("\n");
  }

  // Fallback: try XML element with matching id or name attribute
  const xmlRegex = new RegExp(
    `<\\w+[^>]*?(?:\\sid\\s*=\\s*"${sectionId.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)}"|\\sname\\s*=\\s*"${sectionId.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)}")[^>]*>`,
    "i",
  );
  const xmlMatch = xmlRegex.exec(content);
  if (xmlMatch !== null) {
    // Return the rest of the file from this point — XML is harder to boundary-detect without a parser
    const startIdx = content.indexOf(xmlMatch[0]);
    return content.slice(startIdx);
  }

  // If no section found, return a placeholder so the agent knows something is wrong
  return `[Section "${sectionId}" not found in file content — outline may be stale. Re-read the file to refresh.]`;
}

async function buildSystemPrompt(
  agentSlug: string,
  session: Session,
  capabilities: ChannelCapabilities,
  conditions?: ConditionsConfig,
  supportsVision?: boolean,
  supportsVideo?: boolean,
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

      const activeSections = session.activeFileSections.get(file);
      if (activeSections !== undefined && activeSections.size > 0) {
        // Render only the open sections with their IDs as labels
        lines.push(
          `<file path="${file}" size="${size}" sections="${[...activeSections].join(", ")}">`,
        );

        for (const sectionId of activeSections) {
          // Extract just the lines for this section by finding the heading/XML element
          const sectionContent = extractSectionContent(content, sectionId);
          lines.push(`<section id="${sectionId}">`, sectionContent, "</section>", "");
        }
      } else {
        // No section filter — render the entire file
        lines.push(`<file path="${file}" size="${size}">`, content, "</file>", "");
      }
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
  );

  if (supportsVision === false) {
    lines.push("- vision supported: false");
  }

  if (supportsVideo === false) {
    lines.push("- video supported: false");
  }

  lines.push("</metadata>");

  return lines.join("\n");
}

export { NO_CAPABILITIES, buildSystemPrompt };
