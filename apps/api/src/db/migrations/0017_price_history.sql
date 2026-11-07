CREATE TABLE `price_history` (
	`instrument_id` text NOT NULL,
	`date` text NOT NULL,
	`price` text NOT NULL,
	`currency` text NOT NULL,
	`accrued_interest` text,
	`accrued_currency` text,
	`source` text NOT NULL,
	PRIMARY KEY(`instrument_id`, `date`)
);
