class ToolError extends Error {
  public hint?: string;

  constructor(message: string, hint?: string) {
    super(message);
    this.name = "ToolError";
    this.hint = hint;
  }
}

export { ToolError };
