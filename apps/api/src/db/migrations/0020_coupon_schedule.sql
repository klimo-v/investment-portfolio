CREATE TABLE `coupon_schedule` (
	`instrument_id` text NOT NULL,
	`coupon_date` text NOT NULL,
	`record_date` text,
	`amount_rub` text,
	PRIMARY KEY(`instrument_id`, `coupon_date`),
	FOREIGN KEY (`instrument_id`) REFERENCES `instruments`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `coupon_schedule_loads` (
	`instrument_id` text PRIMARY KEY NOT NULL,
	`loaded_at` text NOT NULL,
	`covered_from` text NOT NULL,
	`covered_till` text NOT NULL,
	FOREIGN KEY (`instrument_id`) REFERENCES `instruments`(`id`) ON UPDATE no action ON DELETE cascade
);
