import type { Stats } from "node:fs";
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

function extractSectionContent(content: string, sectionId: string): string {
  const lines = content.split("\n");

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

async function buildOpenedFilesBlock(agentSlug: string, session: Session): Promise<string> {
  const missingFiles: string[] = [];
  const lines: string[] = [];

  if (session.openedFiles.size > 0) {
    lines.push("<opened_files>", "These are your currently open files:", "");

    for (const file of session.openedFiles) {
      const realPath = sandboxToReal(file, agentSlug);

      let stats: Stats | undefined = undefined;
      try {
        stats = await stat(realPath);
      } catch {
        missingFiles.push(file);
        session.openedFiles.delete(file);
        session.activeFileSections.delete(file);
        continue;
      }

      if (!stats.isFile()) {
        missingFiles.push(file);
        session.openedFiles.delete(file);
        session.activeFileSections.delete(file);
        continue;
      }

      // oxlint-disable-next-line init-declarations
      let content: string;
      try {
        content = await readFile(realPath, "utf8");
      } catch (error) {
        // stat() succeeded but the file was removed before readFile —
        // clean up the stale handle and skip without crashing the turn.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          missingFiles.push(file);
          session.openedFiles.delete(file);
          session.activeFileSections.delete(file);
          continue;
        }
        throw error;
      }

      const activeSections = session.activeFileSections.get(file);
      if (activeSections !== undefined && activeSections.size > 0) {
        // Render only the actively-viewed sections to limit token budget
        // and keep the engine focused on the relevant context.
        lines.push(
          `<file path="${file}" size="${stats.size}" sections="${[...activeSections].join(", ")}">`,
        );

        for (const sectionId of activeSections) {
          // extractSectionContent reduces prompt noise by returning only
          // the matching heading/XML element and its body, omitting the
          // rest of the file.
          const sectionContent = extractSectionContent(content, sectionId);
          lines.push(`<section id="${sectionId}">`, sectionContent, "</section>", "");
        }

        lines.push("</file>", "");
      } else {
        // No active section filter — the whole file is relevant, so render
        // it in full. Larger files will be caught by context pruning.
        lines.push(`<file path="${file}" size="${stats.size}">`, content, "</file>", "");
      }
    }

    lines.push("</opened_files>");
  }

  if (missingFiles.length > 0) {
    session.pendingToolMessages.push({
      content: {
        content: missingFiles
          .map(
            (filePath) => `File ${filePath} moved/deleted while still open. Automatically closed.`,
          )
          .join("\n"),
        type: "text",
      },
      role: "user",
    });
  }

  return lines.join("\n");
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

export { NO_CAPABILITIES, buildOpenedFilesBlock, buildSystemPrompt };
