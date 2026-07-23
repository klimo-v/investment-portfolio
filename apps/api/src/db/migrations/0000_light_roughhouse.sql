CREATE TABLE `instruments` (
	`id` text PRIMARY KEY NOT NULL,
	`ticker` text NOT NULL,
	`type` text NOT NULL,
	`currency` text NOT NULL,
	`isin` text,
	`name` text,
	`market_source` text DEFAULT 'manual' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `operations` (
	`id` text PRIMARY KEY NOT NULL,
	`date` text NOT NULL,
	`system_id` text NOT NULL,
	`portfolio_id` text NOT NULL,
	`instrument_id` text,
	`operation_type` text NOT NULL,
	`quantity` text NOT NULL,
	`price` text NOT NULL,
	`fee` text DEFAULT '0' NOT NULL,
	`fx_rate` text DEFAULT '1' NOT NULL,
	`currency` text NOT NULL,
	`transfer_group` text,
	`trade_id` text,
	`note` text,
	`broker_ref` text,
	`import_batch_id` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`system_id`) REFERENCES `systems`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`portfolio_id`) REFERENCES `portfolios`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`instrument_id`) REFERENCES `instruments`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `portfolios` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`broker` text NOT NULL,
	`base_currency` text DEFAULT 'RUB' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `systems` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`color` text
);
