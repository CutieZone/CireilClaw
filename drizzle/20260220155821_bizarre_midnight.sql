PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_cron_jobs` (
	`job_id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`config` text,
	`last_run` text,
	`next_run` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`retry_count` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_cron_jobs`("job_id", "type", "config", "last_run", "next_run", "status", "retry_count", "created_at") SELECT "job_id", "type", "config", "last_run", "next_run", "status", "retry_count", "created_at" FROM `cron_jobs`;--> statement-breakpoint
DROP TABLE `cron_jobs`;--> statement-breakpoint
ALTER TABLE `__new_cron_jobs` RENAME TO `cron_jobs`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
ALTER TABLE `images` DROP COLUMN `agent_slug`;--> statement-breakpoint
ALTER TABLE `sessions` DROP COLUMN `agent_slug`;