import { readFile } from "node:fs/promises";

import type { Section } from "@cireilclaw/sdk";

import { sandboxToReal } from "#util/paths.js";

// Sections carry no content — they identify a named span within a file that
// can be selectively loaded. The agent sees an outline and chooses which
// sections to open, trading precision for context budget.

interface FileOutline {
  path: string;
  lines: number;
  estTokens: number;
  sections: Section[];
}

// An extractor examines raw file content and returns an array of sections.
// Plugins register extractors by file extension glob with an optional priority.
interface Extractor {
  glob: string;
  priority: number;
  extract(filePath: string, content: string): Section[] | Promise<Section[]>;
}

// Token estimation heuristic — same as prune.ts CHARS_PER_TOKEN.
const CHARS_PER_TOKEN = 3;

const DEFAULT_OUTLINE_THRESHOLD_TOKENS = 2000;

// ---------------------------------------------------------------------------
// Built-in extractors
// ---------------------------------------------------------------------------

const HEADING_RE = /^(#{1,6})\s+(.+)$/gm;
const SETEXT_H1_RE = /^(.+)\n=+\s*$/gm;
const SETEXT_H2_RE = /^(.+)\n-+\s*$/gm;

function stripMarkdownLinks(text: string): string {
  return text.replaceAll(/\[([^\]]+)\]\([^)]+\)/g, "$1").trim();
}

function markdownExtractor(_filePath: string, content: string): Section[] {
  const sections: Section[] = [];
  const lines = content.split("\n");

  // oxlint-disable-next-line unicorn/no-null
  let match: RegExpExecArray | null = null;
  HEADING_RE.lastIndex = 0;
  while ((match = HEADING_RE.exec(content)) !== null) {
    const level = match[1]?.length ?? 1;
    const text = stripMarkdownLinks(match[2] ?? "");
    const lineNum = content.slice(0, match.index).split("\n").length;
    const id = text
      .toLowerCase()
      .replaceAll(/[^a-z0-9]+/g, "-")
      .replaceAll(/^-+|-+$/g, "");

    sections.push({
      id,
      label: text,
      line: lineNum,
      lines: 0,
      type: `h${level}`,
    });
  }

  const joined = content;
  SETEXT_H1_RE.lastIndex = 0;
  while ((match = SETEXT_H1_RE.exec(joined)) !== null) {
    const text = stripMarkdownLinks(match[1] ?? "");
    const lineNum = joined.slice(0, match.index).split("\n").length;
    sections.push({
      id: text
        .toLowerCase()
        .replaceAll(/[^a-z0-9]+/g, "-")
        .replaceAll(/^-+|-+$/g, ""),
      label: text,
      line: lineNum,
      lines: 0,
      type: "h1",
    });
  }

  SETEXT_H2_RE.lastIndex = 0;
  while ((match = SETEXT_H2_RE.exec(joined)) !== null) {
    const text = stripMarkdownLinks(match[1] ?? "");
    const lineNum = joined.slice(0, match.index).split("\n").length;
    sections.push({
      id: text
        .toLowerCase()
        .replaceAll(/[^a-z0-9]+/g, "-")
        .replaceAll(/^-+|-+$/g, ""),
      label: text,
      line: lineNum,
      lines: 0,
      type: "h2",
    });
  }

  sections.sort((lhs, rhs) => lhs.line - rhs.line);

  for (let idx = 0; idx < sections.length; idx++) {
    const section = sections[idx];
    if (section === undefined) {
      throw new TypeError("Unable to find section");
    }
    const nextLine = sections[idx + 1]?.line ?? lines.length + 1;
    section.lines = nextLine - section.line;
  }

  return sections;
}

const XML_TAG_RE = /<(\w+)[^>]*?(?:\sid\s*=\s*"([^"]+)"|\sname\s*=\s*"([^"]+)")[^>]*>/g;

function xmlExtractor(_filePath: string, content: string): Section[] {
  const sections: Section[] = [];
  const lines = content.split("\n");
  // oxlint-disable-next-line unicorn/no-null
  let match: RegExpExecArray | null = null;

  XML_TAG_RE.lastIndex = 0;
  while ((match = XML_TAG_RE.exec(content)) !== null) {
    const [, tagName, idAttr, nameAttr] = match;
    const id = idAttr ?? nameAttr ?? tagName ?? "element";
    const label = idAttr === undefined ? (tagName ?? "element") : `${tagName}#${idAttr}`;
    const lineNum = content.slice(0, match.index).split("\n").length;

    sections.push({
      id,
      label,
      line: lineNum,
      lines: 0,
      type: "xml-element",
    });
  }

  sections.sort((lhs, rhs) => lhs.line - rhs.line);

  for (let idx = 0; idx < sections.length; idx++) {
    const section = sections[idx];
    if (section === undefined) {
      throw new TypeError("Section was undefined");
    }
    const nextLine = sections[idx + 1]?.line ?? lines.length + 1;
    section.lines = nextLine - section.line;
  }

  return sections;
}

// ---------------------------------------------------------------------------
// Extractor registry
// ---------------------------------------------------------------------------

const extractors: Extractor[] = [
  { extract: markdownExtractor, glob: "*.md", priority: 0 },
  { extract: xmlExtractor, glob: "*.xml", priority: 0 },
  { extract: xmlExtractor, glob: "*.html", priority: 0 },
];

function registerExtractor(extractor: Extractor): void {
  const idx = extractors.findIndex((ext) => ext.priority < extractor.priority);
  if (idx === -1) {
    extractors.push(extractor);
  } else {
    extractors.splice(idx, 0, extractor);
  }
}

function getExtractors(): readonly Extractor[] {
  return extractors;
}

// ---------------------------------------------------------------------------
// Outline generation
// ---------------------------------------------------------------------------

const OUTLINE_TOKEN_THRESHOLD = DEFAULT_OUTLINE_THRESHOLD_TOKENS;

function matchesGlob(filename: string, glob: string): boolean {
  if (glob.startsWith("*.")) {
    const ext = glob.slice(1);
    return filename.endsWith(ext);
  }
  return filename === glob;
}

function estimateTokens(content: string): number {
  return Math.ceil(content.length / CHARS_PER_TOKEN);
}

// Generates an outline directly from content without touching the filesystem.
// Used for testing and when content is already in memory.
async function generateOutlineFromContent(
  sandboxPath: string,
  content: string,
): Promise<FileOutline | undefined> {
  const lines = content.split("\n").length;
  const estTokens = estimateTokens(content);

  if (estTokens <= OUTLINE_TOKEN_THRESHOLD) {
    return undefined;
  }

  const fileName = sandboxPath.split("/").pop() ?? sandboxPath;

  for (const extractor of extractors) {
    if (matchesGlob(fileName, extractor.glob)) {
      const sections = await extractor.extract(sandboxPath, content);
      if (sections.length > 0) {
        return { estTokens, lines, path: sandboxPath, sections };
      }
    }
  }

  return undefined;
}

async function generateOutline(
  sandboxPath: string,
  agentSlug: string,
  content?: string,
): Promise<FileOutline | undefined> {
  const realPath = sandboxToReal(sandboxPath, agentSlug);
  const text = content ?? (await readFile(realPath, "utf8"));
  return await generateOutlineFromContent(sandboxPath, text);
}

export type { Section, FileOutline, Extractor };
export {
  generateOutline,
  generateOutlineFromContent,
  registerExtractor,
  getExtractors,
  DEFAULT_OUTLINE_THRESHOLD_TOKENS as OUTLINE_TOKEN_THRESHOLD,
  CHARS_PER_TOKEN,
};
