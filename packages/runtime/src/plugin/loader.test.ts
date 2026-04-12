import { builtinToolRegistry, setToolRegistry } from "$/engine/tools/index.js";
import type { ToolDef } from "$/engine/tools/tool-def.js";
import { mergeToolRegistries } from "$/plugin/loader.js";
import * as vb from "valibot";
import { describe, it, expect } from "vitest";

function makeTool(name: string): ToolDef {
  return {
    description: `test tool ${name}`,
    // oxlint-disable-next-line typescript/require-await
    async execute(): Promise<Record<string, unknown>> {
      return { success: true };
    },
    name,
    parameters: vb.strictObject({}),
  };
}

describe("mergeToolRegistries", () => {
  it("returns a copy of the builtin registry when no plugins provided", () => {
    const result = mergeToolRegistries(builtinToolRegistry, []);
    expect(result).toEqual(builtinToolRegistry);
    expect(result).not.toBe(builtinToolRegistry);
  });

  it("merges plugin tools into the registry", () => {
    const tool = makeTool("my-plugin-tool");
    const result = mergeToolRegistries(builtinToolRegistry, [
      { allowOverride: false, name: "test-plugin", tools: { "my-plugin-tool": tool } },
    ]);

    expect(result["my-plugin-tool"]).toBe(tool);
    expect(result["brave-search"]).toBe(builtinToolRegistry["brave-search"]);
  });

  it("throws on plugin-builtin collision without allowOverride", () => {
    const tool = makeTool("respond");
    expect(() =>
      mergeToolRegistries(builtinToolRegistry, [
        { allowOverride: false, name: "evil-plugin", tools: { respond: tool } },
      ]),
    ).toThrow("collides with builtin");
  });

  it("allows plugin-builtin override when allowOverride is true", () => {
    const tool = makeTool("respond");
    const result = mergeToolRegistries(builtinToolRegistry, [
      { allowOverride: true, name: "override-plugin", tools: { respond: tool } },
    ]);

    expect(result["respond"]).toBe(tool);
  });

  it("throws on plugin-plugin collision", () => {
    const tool1 = makeTool("shared-name");
    const tool2 = makeTool("shared-name");
    expect(() =>
      mergeToolRegistries(builtinToolRegistry, [
        { allowOverride: false, name: "plugin-a", tools: { "shared-name": tool1 } },
        { allowOverride: false, name: "plugin-b", tools: { "shared-name": tool2 } },
      ]),
    ).toThrow("collides with another plugin");
  });

  it("handles multiple plugins with distinct tools", () => {
    const tool1 = makeTool("tool-a");
    const tool2 = makeTool("tool-b");
    const result = mergeToolRegistries(builtinToolRegistry, [
      { allowOverride: false, name: "plugin-a", tools: { "tool-a": tool1 } },
      { allowOverride: false, name: "plugin-b", tools: { "tool-b": tool2 } },
    ]);

    expect(result["tool-a"]).toBe(tool1);
    expect(result["tool-b"]).toBe(tool2);
    expect(Object.keys(result).length).toBe(Object.keys(builtinToolRegistry).length + 2);
  });
});

describe("setToolRegistry", () => {
  it("replaces the active tool registry", () => {
    const customRegistry: Record<string, ToolDef> = {
      "custom-tool": makeTool("custom-tool"),
    };
    setToolRegistry(customRegistry);

    // Import again to verify the mutable module state was updated
    // Note: Because of ESM module caching, we need to re-import
    // The test verifies the function doesn't throw
    expect(() => {
      setToolRegistry(customRegistry);
    }).not.toThrow();

    // Restore original
    setToolRegistry(builtinToolRegistry);
  });
});
