import * as vb from "valibot";

const PluginEntrySchema = vb.strictObject({
  allowOverride: vb.pipe(
    vb.exactOptional(vb.boolean(), false),
    vb.description("Allow this plugin to override builtin tools"),
  ),
  path: vb.pipe(
    vb.string(),
    vb.nonEmpty(),
    vb.description("Path to the plugin module. Can be a file path or node_module name."),
  ),
});

type PluginEntry = vb.InferOutput<typeof PluginEntrySchema>;

const PluginsConfigSchema = vb.strictObject({
  plugins: vb.pipe(
    vb.exactOptional(vb.array(PluginEntrySchema), []),
    vb.description("List of plugins to load"),
  ),
});

type PluginsConfig = vb.InferOutput<typeof PluginsConfigSchema>;

export { PluginsConfigSchema };
export type { PluginsConfig, PluginEntry };
