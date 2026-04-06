import { nonEmptyString } from "$/config/schemas/shared.js";
import * as vb from "valibot";

const DefaultExecTimeout = 60_000;

const ExecToolConfigSchema = vb.strictObject({
  binaries: vb.pipe(
    vb.array(nonEmptyString),
    vb.minLength(1),
    vb.description("Allowed binaries within the exec tool. This is a best-effort allowlist."),
  ),
  enabled: vb.pipe(
    vb.exactOptional(vb.boolean(), false),
    vb.description("Whether the exec tool is enabled"),
  ),
  hostEnvPassthrough: vb.pipe(
    vb.exactOptional(vb.pipe(vb.array(nonEmptyString), vb.minLength(1)), []),
    vb.description("Which host environment variables to passthrough to the sandbox"),
  ),
  timeout: vb.pipe(
    vb.exactOptional(vb.pipe(vb.number(), vb.integer(), vb.minValue(1000)), DefaultExecTimeout),
    vb.description("How long an exec tool is allowed to run before being killed"),
  ),
});
type ExecToolConfig = vb.InferOutput<typeof ExecToolConfigSchema>;

const ToolConfigSchema = vb.pipe(vb.boolean(), vb.description("Whether the tool is enabled"));

const SpecificToolConfigSchema = vb.strictObject({
  exec: ExecToolConfigSchema,
});

const ToolsConfigSchema = vb.intersect([
  vb.record(nonEmptyString, ToolConfigSchema),
  SpecificToolConfigSchema,
]);

type ToolsConfig = vb.InferOutput<typeof ToolsConfigSchema>;

export { ToolsConfigSchema };
export type { ToolsConfig, ExecToolConfig };
