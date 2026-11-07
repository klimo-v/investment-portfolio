CREATE TABLE `qsnap_raw` (
	`snap_id` text NOT NULL,
	`table_name` text NOT NULL,
	`row_no` integer NOT NULL,
	`field` text NOT NULL,
	`value` text NOT NULL,
	PRIMARY KEY(`snap_id`, `table_name`, `row_no`, `field`),
	FOREIGN KEY (`snap_id`) REFERENCES `qsnap_snapshots`(`snap_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `qsnap_snapshots` (
	`snap_id` text PRIMARY KEY NOT NULL,
	`local_time` text NOT NULL,
	`server_time` text NOT NULL,
	`server_time_end` text NOT NULL,
	`trade_date` text NOT NULL,
	`connected` integer NOT NULL,
	`quik_version` text NOT NULL,
	`script_version` text NOT NULL,
	`status` text NOT NULL,
	`raw_lines` integer NOT NULL,
	`raw_bytes` integer NOT NULL,
	`float_ids` integer NOT NULL,
	`counts` text NOT NULL,
	`errors` text NOT NULL,
	`clock_skew_sec` integer,
	`complete` integer NOT NULL,
	`reasons` text DEFAULT '' NOT NULL,
	`imported_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `yv1_automat_days` (
	`date` text PRIMARY KEY NOT NULL,
	`payload` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `yv1_automat_logs` (
	`date` text PRIMARY KEY NOT NULL,
	`payload` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `yv1_automat_signals` (
	`date` text PRIMARY KEY NOT NULL,
	`payload` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `yv1_automat_trades` (
	`trade_num` text PRIMARY KEY NOT NULL,
	`order_num` text,
	`date` text NOT NULL,
	`time` text NOT NULL,
	`contract` text NOT NULL,
	`side` text NOT NULL,
	`qty` text NOT NULL,
	`price` text NOT NULL,
	`reason` text NOT NULL,
	`ref_price` text,
	`slip_rub` text,
	`broker_fee_quik` text,
	`exchange_fee` text,
	`clearing_fee` text,
	`tech_center_fee` text,
	`source_file` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `yv1_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
