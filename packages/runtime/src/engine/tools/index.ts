import { closeFile } from "$/engine/tools/close-file.js";
import { downloadAttachments } from "$/engine/tools/download-attachments.js";
import { exec } from "$/engine/tools/exec.js";
import { listDir } from "$/engine/tools/list-dir.js";
import { listSessions } from "$/engine/tools/list-sessions.js";
import { noResponse } from "$/engine/tools/no-response.js";
import { openFile } from "$/engine/tools/open-file.js";
import { querySessions } from "$/engine/tools/query-sessions.js";
import { react } from "$/engine/tools/react.js";
import { readHistory } from "$/engine/tools/read-history.js";
import { readSession } from "$/engine/tools/read-session.js";
import { skill as readSkill } from "$/engine/tools/read-skill.js";
import { read } from "$/engine/tools/read.js";
import { respond } from "$/engine/tools/respond.js";
import { schedule } from "$/engine/tools/schedule.js";
import { sessionInfo } from "$/engine/tools/session-info.js";
import { strReplace } from "$/engine/tools/str-replace.js";
import type { ToolDef } from "$/engine/tools/tool-def.js";
import { write } from "$/engine/tools/write.js";

const builtinToolRegistry: Record<string, ToolDef> = {
  "close-file": closeFile,
  "download-attachments": downloadAttachments,
  exec,
  "list-dir": listDir,
  "list-sessions": listSessions,
  "no-response": noResponse,
  "open-file": openFile,
  "query-sessions": querySessions,
  react,
  read,
  "read-history": readHistory,
  "read-session": readSession,
  "read-skill": readSkill,
  respond,
  schedule,
  "session-info": sessionInfo,
  "str-replace": strReplace,
  write,
};

let toolRegistry: Record<string, ToolDef> = builtinToolRegistry;

function setToolRegistry(registry: Record<string, ToolDef>): void {
  toolRegistry = registry;
}

function getToolRegistry(): Record<string, ToolDef> {
  return toolRegistry;
}

export { builtinToolRegistry, setToolRegistry, getToolRegistry };
