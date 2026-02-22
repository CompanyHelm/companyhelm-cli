import { defineConfig } from "drizzle-kit";
import { homedir } from "node:os";
import { join } from "node:path";

const defaultDbPath = join(homedir(), ".local", "share", "companyhelm", "state.db");

export default defineConfig({
  schema: "./src/state/schema.ts",
  out: "./drizzle",
  dialect: "sqlite",
  dbCredentials: {
    url: process.env.DRIZZLE_DB_PATH ?? defaultDbPath,
  },
});
