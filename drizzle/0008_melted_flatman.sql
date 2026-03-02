CREATE TABLE `thread_user_message_request_store` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`thread_id` text NOT NULL,
	`sdk_turn_id` text NOT NULL,
	`request_id` text NOT NULL,
	`sdk_item_id` text,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade
);
