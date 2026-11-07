CREATE TABLE `strategy_daily_results` (
	`system_id` text NOT NULL,
	`date` text NOT NULL,
	`price_pnl_rub` text NOT NULL,
	`costs_rub` text NOT NULL,
	`debt_interest_rub` text NOT NULL,
	`net_rub` text NOT NULL,
	`cycles` integer NOT NULL,
	PRIMARY KEY(`system_id`, `date`),
	FOREIGN KEY (`system_id`) REFERENCES `systems`(`id`) ON UPDATE no action ON DELETE no action
);
