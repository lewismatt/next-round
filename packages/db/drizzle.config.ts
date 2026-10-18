import { defineConfig } from "drizzle-kit";

const connectionString =
  process.env.DATABASE_DIRECT_URL ?? process.env.DATABASE_URL;

export default defineConfig({
  schema: "./src/schema.ts",
  out: "./migrations",
  dialect: "postgresql",
  schemaFilter: ["next_round"],
  // SQL generation needs no live database; database commands require an explicit URL.
  ...(connectionString ? { dbCredentials: { url: connectionString } } : {}),
});
