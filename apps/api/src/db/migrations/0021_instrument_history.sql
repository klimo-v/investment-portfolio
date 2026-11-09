CREATE TABLE `instrument_history` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`source_id` text NOT NULL,
	`target_id` text NOT NULL,
	`at` text DEFAULT (datetime('now')) NOT NULL,
	`payload` text NOT NULL,
	`undone_at` text,
	`undone_by` text
);
