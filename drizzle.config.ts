import { defineConfig } from "drizzle-kit";

const cfg = defineConfig({
  dialect: "sqlite",
  migrations: {
    prefix: "timestamp",
    schema: "./src/db/schema.ts",
    table: "__drizzle_migrations",
  },
  out: "./drizzle",
  schema: "./src/db/schema.ts",
});

// oxlint-disable-next-line import/no-default-export
export default cfg;
