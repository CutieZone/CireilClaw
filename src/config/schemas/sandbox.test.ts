import * as vb from "valibot";
import { describe, expect, it } from "vitest";

import { SandboxConfigSchema } from "./sandbox.js";

describe("SandboxConfigSchema", () => {
  describe("MountSchema", () => {
    it("accepts a valid mount with absolute source", () => {
      const input = {
        mounts: [{ mode: "rw", source: "/home/user/project", target: "project" }],
      };
      expect(vb.parse(SandboxConfigSchema, input)).toEqual(input);
    });

    it("accepts a valid mount with ~/ source", () => {
      const input = {
        mounts: [{ mode: "ro", source: "~/projects/my-app", target: "app" }],
      };
      expect(vb.parse(SandboxConfigSchema, input)).toEqual(input);
    });

    it("accepts nested target paths", () => {
      const input = {
        mounts: [{ mode: "rw", source: "/data/lib", target: "libs/data" }],
      };
      expect(vb.parse(SandboxConfigSchema, input)).toEqual(input);
    });

    it("rejects source that is neither absolute nor ~/ ", () => {
      const input = {
        mounts: [{ mode: "rw", source: "relative/path", target: "project" }],
      };
      expect(() => vb.parse(SandboxConfigSchema, input)).toThrow();
    });

    it("rejects empty source", () => {
      const input = {
        mounts: [{ mode: "rw", source: "", target: "project" }],
      };
      expect(() => vb.parse(SandboxConfigSchema, input)).toThrow();
    });

    it("rejects target starting with /", () => {
      const input = {
        mounts: [{ mode: "rw", source: "/home/user/project", target: "/project" }],
      };
      expect(() => vb.parse(SandboxConfigSchema, input)).toThrow();
    });

    it("rejects target containing ..", () => {
      const input = {
        mounts: [{ mode: "rw", source: "/home/user/project", target: "../escape" }],
      };
      expect(() => vb.parse(SandboxConfigSchema, input)).toThrow();
    });

    it("rejects empty target", () => {
      const input = {
        mounts: [{ mode: "rw", source: "/home/user/project", target: "" }],
      };
      expect(() => vb.parse(SandboxConfigSchema, input)).toThrow();
    });

    it("rejects invalid mode", () => {
      const input = {
        mounts: [{ mode: "rwx", source: "/home/user/project", target: "project" }],
      };
      expect(() => vb.parse(SandboxConfigSchema, input)).toThrow();
    });
  });

  describe("SandboxConfigSchema", () => {
    it("accepts empty mounts array", () => {
      expect(vb.parse(SandboxConfigSchema, { mounts: [] })).toEqual({ mounts: [] });
    });

    it("accepts multiple mounts", () => {
      const input = {
        mounts: [
          { mode: "rw" as const, source: "/home/user/a", target: "a" },
          { mode: "ro" as const, source: "/home/user/b", target: "b" },
        ],
      };
      expect(vb.parse(SandboxConfigSchema, input)).toEqual(input);
    });
  });
});
