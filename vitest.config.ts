// oxlint-disable import/no-default-export
// oxlint-disable id-length
import { resolve } from "node:path";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // oxlint-disable-next-line unicorn/prefer-module
      $: resolve(__dirname, "src"),
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
  },
});
