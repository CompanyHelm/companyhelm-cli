PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_threads` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`sdk_thread_id` text,
	`model` text NOT NULL,
	`reasoning_level` text NOT NULL,
	`status` text NOT NULL,
	`current_sdk_turn_id` text,
	`is_current_turn_running` integer NOT NULL,
	`workspace` text NOT NULL,
	`runtime_container` text NOT NULL,
	`dind_container` text,
	`home_directory` text NOT NULL,
	`uid` integer NOT NULL,
	`gid` integer NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_threads`("id", "agent_id", "sdk_thread_id", "model", "reasoning_level", "status", "current_sdk_turn_id", "is_current_turn_running", "workspace", "runtime_container", "dind_container", "home_directory", "uid", "gid") SELECT "id", "agent_id", "sdk_thread_id", "model", "reasoning_level", "status", "current_sdk_turn_id", "is_current_turn_running", "workspace", "runtime_container", "dind_container", "home_directory", "uid", "gid" FROM `threads`;--> statement-breakpoint
DROP TABLE `threads`;--> statement-breakpoint
ALTER TABLE `__new_threads` RENAME TO `threads`;--> statement-breakpoint
PRAGMA foreign_keys=ON;