class ToolError extends Error {
  public hint?: string;

  public constructor(message: string, hint?: string) {
    super(message);
    this.name = "ToolError";
    this.hint = hint;
  }
}

export { ToolError };
