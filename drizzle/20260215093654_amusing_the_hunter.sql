CREATE TABLE `images` (
	`id` text NOT NULL,
	`session_id` text NOT NULL,
	`agent_slug` text NOT NULL,
	`media_type` text NOT NULL,
	PRIMARY KEY(`id`, `session_id`),
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action
);
