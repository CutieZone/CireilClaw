import * as vb from "valibot";

import { nonEmptyString } from "#config/schemas/shared.js";

const DefaultExecTimeout = 60_000;
const DefaultExecInlineThresholdBytes = 16_384;
const DefaultExecPreviewLines = 20;

const ExecToolConfigSchema = vb.strictObject({
  enabled: vb.pipe(
    vb.exactOptional(vb.boolean(), false),
    vb.description("Whether the exec tool is enabled"),
  ),
  hostEnvPassthrough: vb.pipe(
    vb.exactOptional(vb.pipe(vb.array(nonEmptyString)), []),
    vb.description("Which host environment variables to passthrough to the sandbox"),
  ),
  inline: vb.pipe(
    vb.exactOptional(vb.boolean(), true),
    vb.description(
      "Return stdout/stderr inline in the tool result instead of spilling to a workspace file. " +
        "Only effective when combined output is ≤ inlineThresholdBytes. On by default.",
    ),
  ),
  inlineThresholdBytes: vb.pipe(
    vb.exactOptional(
      vb.pipe(vb.number(), vb.integer(), vb.minValue(0)),
      DefaultExecInlineThresholdBytes,
    ),
    vb.description(
      "Combined stdout+stderr byte threshold below which output may be returned inline when " +
        "inline = true. Default: 16384.",
    ),
  ),
  outputDir: vb.pipe(
    vb.exactOptional(nonEmptyString, "/workspace/.exec-output"),
    vb.description(
      "Sandbox-relative directory where captured stdout/stderr files are written. " +
        "Default: /workspace/.exec-output",
    ),
  ),
  previewHead: vb.pipe(
    vb.exactOptional(vb.pipe(vb.number(), vb.integer(), vb.minValue(0)), DefaultExecPreviewLines),
    vb.description("Number of leading lines included in each preview. Default: 20."),
  ),
  previewTail: vb.pipe(
    vb.exactOptional(vb.pipe(vb.number(), vb.integer(), vb.minValue(0)), DefaultExecPreviewLines),
    vb.description("Number of trailing lines included in each preview. Default: 20."),
  ),
  timeout: vb.pipe(
    vb.exactOptional(vb.pipe(vb.number(), vb.integer(), vb.minValue(1000)), DefaultExecTimeout),
    vb.description("How long an exec tool is allowed to run before being killed"),
  ),
});
type ExecToolConfig = vb.InferOutput<typeof ExecToolConfigSchema>;

const ToolConfigSchema = vb.pipe(vb.boolean(), vb.description("Whether the tool is enabled"));

const ToolsConfigSchema = vb.objectWithRest(
  {
    exec: vb.union([ExecToolConfigSchema, vb.literal(false)]),
  },
  ToolConfigSchema,
);

type ToolsConfig = vb.InferOutput<typeof ToolsConfigSchema>;

export { ToolsConfigSchema };
export type { ToolsConfig, ExecToolConfig };
