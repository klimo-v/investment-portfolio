CREATE TABLE `quotes` (
	`instrument_id` text PRIMARY KEY NOT NULL,
	`price` text NOT NULL,
	`currency` text NOT NULL,
	`source` text NOT NULL,
	`as_of` text NOT NULL,
	FOREIGN KEY (`instrument_id`) REFERENCES `instruments`(`id`) ON UPDATE no action ON DELETE no action
);
