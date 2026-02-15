CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_slug` text NOT NULL,
	`channel` text NOT NULL,
	`meta` text NOT NULL,
	`history` text NOT NULL,
	`opened_files` text NOT NULL
);
