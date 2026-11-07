CREATE TABLE `futures_settlements` (
	`portfolio_id` text NOT NULL,
	`instrument_id` text NOT NULL,
	`date` text NOT NULL,
	`period_from` text,
	`vm_period` text NOT NULL,
	`vm_planned` text NOT NULL,
	`qty_start` text DEFAULT '0' NOT NULL,
	`mark_start` text,
	`mark_end` text,
	`source` text DEFAULT 'broker-report' NOT NULL,
	PRIMARY KEY(`portfolio_id`, `instrument_id`, `date`),
	FOREIGN KEY (`portfolio_id`) REFERENCES `portfolios`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`instrument_id`) REFERENCES `instruments`(`id`) ON UPDATE no action ON DELETE cascade
);
