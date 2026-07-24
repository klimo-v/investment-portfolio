CREATE TABLE `portfolio_snapshots` (
	`date` text PRIMARY KEY NOT NULL,
	`invested_rub` text NOT NULL,
	`current_value_rub` text NOT NULL,
	`pnl_rub` text NOT NULL,
	`dividends_rub` text NOT NULL
);
