import path from "node:path";

import * as vb from "valibot";

const MountSchema = vb.object({
  mode: vb.picklist(["ro", "rw"]),
  source: vb.pipe(
    vb.string(),
    vb.minLength(1),
    vb.check(
      (it) => it.startsWith("~/") || path.isAbsolute(it),
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

const BwrapConfigSchema = vb.strictObject({
  binaries: vb.array(vb.pipe(vb.string(), vb.minLength(1))),
});

const IncusConfigSchema = vb.strictObject({
  image: vb.pipe(vb.string(), vb.minLength(1)),
  profiles: vb.pipe(vb.exactOptional(vb.array(vb.pipe(vb.string(), vb.minLength(1))), [])),
  project: vb.optional(vb.pipe(vb.string(), vb.minLength(1))),
});

type Mount = vb.InferOutput<typeof MountSchema>;

const SandboxConfigSchema = vb.object({
  backend: vb.pipe(vb.exactOptional(vb.picklist(["bwrap", "incus"]), "bwrap")),
  bwrap: vb.optional(BwrapConfigSchema),
  devices: vb.optional(DevicesConfigSchema),
  incus: vb.optional(IncusConfigSchema),
  mounts: vb.array(MountSchema),
});

type SandboxConfig = vb.InferOutput<typeof SandboxConfigSchema>;
type IncusConfig = vb.InferOutput<typeof IncusConfigSchema>;

export { BwrapConfigSchema, IncusConfigSchema, SandboxConfigSchema, MountSchema };
export type { IncusConfig, SandboxConfig, Mount };
