CREATE TABLE IF NOT EXISTS `agent_sdks` (
	`name` text PRIMARY KEY NOT NULL,
	`authentication` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `agents` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`sdk` text NOT NULL,
	`model` text NOT NULL,
	`reasoning_level` text NOT NULL,
	`workspace` text NOT NULL,
	`runtime_container` text NOT NULL,
	`dind_container` text NOT NULL,
	`home_directory` text NOT NULL,
	`uid` integer NOT NULL,
	`gid` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `llm_models` (
	`name` text PRIMARY KEY NOT NULL,
	`sdk_name` text NOT NULL,
	`reasoning_levels` text,
	FOREIGN KEY (`sdk_name`) REFERENCES `agent_sdks`(`name`) ON UPDATE no action ON DELETE no action
);
