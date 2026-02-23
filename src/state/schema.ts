import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// ── agent_sdks ──────────────────────────────────────────────────────────────

export const agentSdks = sqliteTable("agent_sdks", {
  name: text("name").primaryKey(),
  authentication: text("authentication", {
    enum: ["unauthenticated", "host", "dedicated", "api-key"],
  }).notNull(),
});

// ── llm_models ──────────────────────────────────────────────────────────────

export const llmModels = sqliteTable("llm_models", {
  name: text("name").primaryKey(),
  sdkName: text("sdk_name")
    .notNull()
    .references(() => agentSdks.name, { onDelete: "cascade" }),
  reasoningLevels: text("reasoning_levels", { mode: "json" })
    .$type<string[]>(),
});

// ── agents ──────────────────────────────────────────────────────────────────

export const agents = sqliteTable("agents", {
  id: text("id")
    .primaryKey(),
  name: text("name").notNull(),
  sdk: text("sdk", { enum: ["codex"] }).notNull(),
});

// -- threads ──────────────────────────────────────────────────────────────────

export const threads = sqliteTable("threads", {
  id: text("id").primaryKey(),
  agentId: text("agent_id")
    .notNull()
    .references(() => agents.id, { onDelete: "cascade" }),
  sdkThreadId: text("sdk_thread_id"),
  model: text("model").notNull(),
  reasoningLevel: text("reasoning_level").notNull(),
  status: text("status", { enum: ["creating", "ready", "deleting"] }).notNull(),
  current_sdk_turn_id: text("current_sdk_turn_id"),
  is_current_turn_running: integer("is_current_turn_running", { mode: "boolean" }).notNull(),
  workspace: text("workspace").notNull(),
  runtimeContainer: text("runtime_container").notNull(),
  dindContainer: text("dind_container").notNull(),
  // home directory within the container
  homeDirectory: text("home_directory").notNull(),
  // uid of the user within the container
  uid: integer("uid").notNull(),
  // gid of the user within the container
  gid: integer("gid").notNull(),
});
