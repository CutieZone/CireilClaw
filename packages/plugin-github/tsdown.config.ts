import { defineConfig } from "tsdown";

// oxlint-disable-next-line eslint-plugin-import/no-default-export -- tsdown requires default export
export default defineConfig({
  clean: true,
  deps: { neverBundle: ["@cireilclaw/sdk"] },
  dts: true,
  entry: ["src/index.ts"],
  format: "esm",
  sourcemap: true,
  target: "node22",
});
