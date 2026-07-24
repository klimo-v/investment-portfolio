ALTER TABLE `portfolios` ADD `account_ref` text;--> statement-breakpoint
CREATE UNIQUE INDEX `portfolios_account_ref_unique` ON `portfolios` (`account_ref`);