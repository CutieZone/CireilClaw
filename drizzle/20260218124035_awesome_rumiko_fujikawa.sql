CREATE TABLE `cron_jobs` (
	`agent_slug` text NOT NULL,
	`job_id` text NOT NULL,
	`type` text NOT NULL,
	`config` text,
	`last_run` text,
	`next_run` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`retry_count` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`agent_slug`, `job_id`)
);
