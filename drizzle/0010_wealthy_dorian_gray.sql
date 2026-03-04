DROP TABLE `agents`;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_threads` (
	`id` text PRIMARY KEY NOT NULL,
	`sdk_thread_id` text,
	`cli_secret` text,
	`model` text NOT NULL,
	`reasoning_level` text NOT NULL,
	`additional_model_instructions` text,
	`status` text NOT NULL,
	`current_sdk_turn_id` text,
	`is_current_turn_running` integer NOT NULL,
	`workspace` text NOT NULL,
	`runtime_container` text NOT NULL,
	`dind_container` text,
	`home_directory` text NOT NULL,
	`uid` integer NOT NULL,
	`gid` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_threads`("id", "sdk_thread_id", "cli_secret", "model", "reasoning_level", "additional_model_instructions", "status", "current_sdk_turn_id", "is_current_turn_running", "workspace", "runtime_container", "dind_container", "home_directory", "uid", "gid") SELECT "id", "sdk_thread_id", "cli_secret", "model", "reasoning_level", "additional_model_instructions", "status", "current_sdk_turn_id", "is_current_turn_running", "workspace", "runtime_container", "dind_container", "home_directory", "uid", "gid" FROM `threads`;--> statement-breakpoint
DROP TABLE `threads`;--> statement-breakpoint
ALTER TABLE `__new_threads` RENAME TO `threads`;--> statement-breakpoint
PRAGMA foreign_keys=ON;