import { ToolError } from "@cireilclaw/sdk";
import type * as vb from "valibot";

class GenerationNoToolCallsError extends Error {
  readonly text: string | undefined;

  constructor(text: string | undefined, reason: string) {
    super(`Expected tool calls but got '${reason}' stop reason`);
    this.name = "GenerationNoToolCallsError";
    this.text = text;
  }
}

class ParseError extends ToolError {
  public issues: [vb.BaseIssue<unknown>, ...vb.BaseIssue<unknown>[]];

  constructor(issues: [vb.BaseIssue<unknown>, ...vb.BaseIssue<unknown>[]]) {
    super("Invalid tool input");
    this.name = "ParseError";
    this.issues = issues;
  }
}

export { GenerationNoToolCallsError, ParseError, ToolError };
