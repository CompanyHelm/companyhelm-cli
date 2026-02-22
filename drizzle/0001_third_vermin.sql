CREATE TABLE `threads` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`model` text NOT NULL,
	`reasoning_level` text NOT NULL,
	`workspace` text NOT NULL,
	`runtime_container` text NOT NULL,
	`dind_container` text NOT NULL,
	`home_directory` text NOT NULL,
	`uid` integer NOT NULL,
	`gid` integer NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `agents` DROP COLUMN `model`;--> statement-breakpoint
ALTER TABLE `agents` DROP COLUMN `reasoning_level`;--> statement-breakpoint
ALTER TABLE `agents` DROP COLUMN `workspace`;--> statement-breakpoint
ALTER TABLE `agents` DROP COLUMN `runtime_container`;--> statement-breakpoint
ALTER TABLE `agents` DROP COLUMN `dind_container`;--> statement-breakpoint
ALTER TABLE `agents` DROP COLUMN `home_directory`;--> statement-breakpoint
ALTER TABLE `agents` DROP COLUMN `uid`;--> statement-breakpoint
ALTER TABLE `agents` DROP COLUMN `gid`;