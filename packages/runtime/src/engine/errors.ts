import type * as vb from "valibot";

/** Thrown when generation succeeds but produces no tool calls. Carries any plain text the model produced. */
class GenerationNoToolCallsError extends Error {
  readonly text: string | undefined;

  constructor(text: string | undefined, reason: string) {
    super(`Expected tool calls but got '${reason}' stop reason`);
    this.name = "GenerationNoToolCallsError";
    this.text = text;
  }
}

/** Base class for errors thrown by tools during execution. */
class ToolError extends Error {
  public hint?: string;

  constructor(message: string, hint?: string) {
    super(message);
    this.name = "ToolError";
    this.hint = hint;
  }
}

/** Thrown when tool input validation fails. */
class ParseError extends ToolError {
  public issues: [vb.BaseIssue<unknown>, ...vb.BaseIssue<unknown>[]];

  constructor(issues: [vb.BaseIssue<unknown>, ...vb.BaseIssue<unknown>[]]) {
    super("Invalid tool input");
    this.name = "ParseError";
    this.issues = issues;
  }
}

export { GenerationNoToolCallsError, ParseError, ToolError };
