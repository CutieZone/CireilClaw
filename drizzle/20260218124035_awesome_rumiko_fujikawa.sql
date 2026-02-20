CREATE TABLE `cron_jobs` (
	`job_id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`config` text,
	`last_run` text,
	`next_run` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`retry_count` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL
);
