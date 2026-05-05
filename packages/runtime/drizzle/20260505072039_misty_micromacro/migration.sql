CREATE TABLE `summaries` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`session_id` text NOT NULL,
	`slug` text NOT NULL,
	`display_name` text NOT NULL,
	`start_message_id` text NOT NULL,
	`end_message_id` text NOT NULL,
	`preserve` text DEFAULT '[]' NOT NULL,
	`summary` text NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT `fk_summaries_session_id_sessions_id_fk` FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
ALTER TABLE `sessions` ADD `active_file_sections` text DEFAULT '{}' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `summaries_session_slug_idx` ON `summaries` (`session_id`,`slug`);