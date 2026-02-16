import type { ToolDef } from "$/engine/tools/tool-def.js";

import { braveSearch } from "$/engine/tools/brave-search.js";
import { closeFile } from "$/engine/tools/close-file.js";
import { exec } from "$/engine/tools/exec.js";
import { listDir } from "$/engine/tools/list-dir.js";
import { openFile } from "$/engine/tools/open-file.js";
import { skill as readSkill } from "$/engine/tools/read-skill.js";
import { read } from "$/engine/tools/read.js";
import { respond } from "$/engine/tools/respond.js";
import { strReplace } from "$/engine/tools/str-replace.js";
import { write } from "$/engine/tools/write.js";

export const toolRegistry: Record<string, ToolDef> = {
  "brave-search": braveSearch,
  "close-file": closeFile,
  exec,
  "list-dir": listDir,
  "open-file": openFile,
  read,
  "read-skill": readSkill,
  respond,
  "str-replace": strReplace,
  write,
};
