PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_llm_models` (
	`name` text PRIMARY KEY NOT NULL,
	`sdk_name` text NOT NULL,
	`reasoning_levels` text,
	FOREIGN KEY (`sdk_name`) REFERENCES `agent_sdks`(`name`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_llm_models`("name", "sdk_name", "reasoning_levels") SELECT "name", "sdk_name", "reasoning_levels" FROM `llm_models`;--> statement-breakpoint
DROP TABLE `llm_models`;--> statement-breakpoint
ALTER TABLE `__new_llm_models` RENAME TO `llm_models`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE TABLE `__new_threads` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`sdk_id` text,
	`model` text NOT NULL,
	`reasoning_level` text NOT NULL,
	`status` text NOT NULL,
	`current_sdk_turn_id` text,
	`is_current_turn_running` boolean NOT NULL,
	`workspace` text NOT NULL,
	`runtime_container` text NOT NULL,
	`dind_container` text NOT NULL,
	`home_directory` text NOT NULL,
	`uid` integer NOT NULL,
	`gid` integer NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_threads`("id", "agent_id", "sdk_id", "model", "reasoning_level", "status", "current_sdk_turn_id", "is_current_turn_running", "workspace", "runtime_container", "dind_container", "home_directory", "uid", "gid") SELECT "id", "agent_id", "sdk_id", "model", "reasoning_level", "status", "current_sdk_turn_id", "is_current_turn_running", "workspace", "runtime_container", "dind_container", "home_directory", "uid", "gid" FROM `threads`;--> statement-breakpoint
DROP TABLE `threads`;--> statement-breakpoint
ALTER TABLE `__new_threads` RENAME TO `threads`;