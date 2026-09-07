CREATE TABLE `snapshot_invalidations` (
	`id` text PRIMARY KEY NOT NULL,
	`at` text DEFAULT (datetime('now')) NOT NULL,
	`kind` text NOT NULL,
	`operation_date` text NOT NULL,
	`description` text NOT NULL,
	`ticker` text,
	`affected_count` integer DEFAULT 1 NOT NULL,
	`acknowledged_at` text
);
