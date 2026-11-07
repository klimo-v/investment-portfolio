CREATE TABLE `instrument_identifiers` (
	`scheme` text NOT NULL,
	`value` text NOT NULL,
	`instrument_id` text NOT NULL,
	`origin` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	PRIMARY KEY(`scheme`, `value`),
	FOREIGN KEY (`instrument_id`) REFERENCES `instruments`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `instrument_identifiers_instrument_idx` ON `instrument_identifiers` (`instrument_id`);