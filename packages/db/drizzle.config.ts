import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/schema.ts",
  out: "./migrations",
  dialect: "postgresql",
  schemaFilter: ["next_round"],
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgresql://next_round:next_round@localhost:5432/next_round",
  },
});
