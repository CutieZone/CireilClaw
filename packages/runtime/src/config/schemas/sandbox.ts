import { isAbsolute } from "node:path";

import * as vb from "valibot";

const MountSchema = vb.object({
  mode: vb.union([vb.literal("ro"), vb.literal("rw")]),
  source: vb.pipe(
    vb.string(),
    vb.minLength(1),
    vb.check(
      (it) => it.startsWith("~/") || isAbsolute(it),
      "source must be an absolute path or start with ~/",
    ),
  ),
  target: vb.pipe(
    vb.string(),
    vb.minLength(1),
    vb.check((it) => !it.startsWith("/"), "target must not start with /"),
    vb.check((it) => !it.includes(".."), "target must not contain .."),
  ),
});

const DevicesConfigSchema = vb.object({
  all: vb.optional(vb.boolean()),
  usb: vb.optional(vb.boolean()),
});

type Mount = vb.InferOutput<typeof MountSchema>;

const SandboxConfigSchema = vb.object({
  devices: vb.optional(DevicesConfigSchema),
  mounts: vb.array(MountSchema),
});

type SandboxConfig = vb.InferOutput<typeof SandboxConfigSchema>;

export { SandboxConfigSchema, MountSchema };
export type { SandboxConfig, Mount };
