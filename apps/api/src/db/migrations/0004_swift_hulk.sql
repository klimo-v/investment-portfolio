CREATE TABLE `snapshot_positions` (
	`date` text NOT NULL,
	`instrument_id` text NOT NULL,
	`value_rub` text NOT NULL,
	`quantity` text NOT NULL,
	PRIMARY KEY(`date`, `instrument_id`),
	FOREIGN KEY (`instrument_id`) REFERENCES `instruments`(`id`) ON UPDATE no action ON DELETE no action
);
