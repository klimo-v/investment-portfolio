CREATE TABLE `operation_annotations` (
	`operation_id` text PRIMARY KEY NOT NULL,
	`tag` text,
	`signal_price` text,
	`source` text NOT NULL,
	`imported_at` text NOT NULL,
	FOREIGN KEY (`operation_id`) REFERENCES `operations`(`id`) ON UPDATE no action ON DELETE cascade
);
