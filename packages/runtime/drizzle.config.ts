import { defineConfig } from "drizzle-kit";
import type { Config } from "drizzle-kit";

const cfg = defineConfig({
  dialect: "sqlite",
  migrations: {
    schema: "./src/db/schema.ts",
    table: "__drizzle_migrations",
  },
  out: "./drizzle",
  schema: "./src/db/schema.ts",
} as Config);

// oxlint-disable-next-line import/no-default-export
export default cfg;
