import * as vb from "valibot";

const PluginEntrySchema = vb.pipe(
  vb.strictObject({
    allowOverride: vb.pipe(
      vb.exactOptional(vb.boolean(), false),
      vb.description("Allow this plugin to override builtin tools"),
    ),
    name: vb.pipe(
      vb.exactOptional(vb.pipe(vb.string(), vb.nonEmpty())),
      vb.description("Directory name under ~/.cireilclaw/plugins/"),
    ),
    package: vb.pipe(
      vb.exactOptional(vb.pipe(vb.string(), vb.nonEmpty())),
      vb.description("npm package name, resolved from ~/.cireilclaw/node_modules/"),
    ),
  }),
  vb.check(
    (entry) => (entry.name === undefined) !== (entry.package === undefined),
    "Plugin entry must set exactly one of 'name' or 'package'",
  ),
);

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
