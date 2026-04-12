interface PluginSession {
  readonly channel: "discord" | "matrix" | "tui" | "internal";
  readonly history: ReadonlyArray<unknown>;
  readonly openedFiles: ReadonlySet<string>;
  id(): string;
}

export type { PluginSession };
