CREATE TABLE `strategy_configs` (
	`system_id` text PRIMARY KEY NOT NULL,
	`portfolio_id` text,
	`adapter` text NOT NULL,
	`params` text DEFAULT '{}' NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`system_id`) REFERENCES `systems`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`portfolio_id`) REFERENCES `portfolios`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
-- Данные ЮВ1 до этой миграции принадлежат одной системе: берём существующую по имени или заводим.
-- Только если такие данные есть: на чистой базе фантомной системы и стратегии быть не должно.
INSERT INTO `systems` (`id`, `name`)
SELECT lower(hex(randomblob(16))), 'ЮВ1-2вх'
WHERE NOT EXISTS (SELECT 1 FROM `systems` WHERE `name` = 'ЮВ1-2вх')
  AND (
  EXISTS (SELECT 1 FROM `yv1_automat_trades`) OR EXISTS (SELECT 1 FROM `yv1_automat_days`)
  OR EXISTS (SELECT 1 FROM `yv1_automat_signals`) OR EXISTS (SELECT 1 FROM `yv1_automat_logs`)
  OR EXISTS (SELECT 1 FROM `yv1_settings`)
);
--> statement-breakpoint
INSERT INTO `strategy_configs` (`system_id`, `adapter`)
SELECT `id`, 'quik-bridge' FROM `systems`
WHERE `name` = 'ЮВ1-2вх' AND (
  EXISTS (SELECT 1 FROM `yv1_automat_trades`) OR EXISTS (SELECT 1 FROM `yv1_automat_days`)
  OR EXISTS (SELECT 1 FROM `yv1_automat_signals`) OR EXISTS (SELECT 1 FROM `yv1_automat_logs`)
  OR EXISTS (SELECT 1 FROM `yv1_settings`)
)
ORDER BY rowid LIMIT 1;
--> statement-breakpoint
CREATE TABLE `__new_yv1_automat_days` (
	`system_id` text NOT NULL,
	`date` text NOT NULL,
	`payload` text NOT NULL,
	PRIMARY KEY(`system_id`, `date`),
	FOREIGN KEY (`system_id`) REFERENCES `systems`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_yv1_automat_days` (`system_id`, `date`, `payload`)
SELECT (SELECT `system_id` FROM `strategy_configs` LIMIT 1), `date`, `payload` FROM `yv1_automat_days`;
--> statement-breakpoint
DROP TABLE `yv1_automat_days`;
--> statement-breakpoint
ALTER TABLE `__new_yv1_automat_days` RENAME TO `yv1_automat_days`;
--> statement-breakpoint
CREATE TABLE `__new_yv1_automat_signals` (
	`system_id` text NOT NULL,
	`date` text NOT NULL,
	`payload` text NOT NULL,
	PRIMARY KEY(`system_id`, `date`),
	FOREIGN KEY (`system_id`) REFERENCES `systems`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_yv1_automat_signals` (`system_id`, `date`, `payload`)
SELECT (SELECT `system_id` FROM `strategy_configs` LIMIT 1), `date`, `payload` FROM `yv1_automat_signals`;
--> statement-breakpoint
DROP TABLE `yv1_automat_signals`;
--> statement-breakpoint
ALTER TABLE `__new_yv1_automat_signals` RENAME TO `yv1_automat_signals`;
--> statement-breakpoint
CREATE TABLE `__new_yv1_automat_logs` (
	`system_id` text NOT NULL,
	`date` text NOT NULL,
	`payload` text NOT NULL,
	PRIMARY KEY(`system_id`, `date`),
	FOREIGN KEY (`system_id`) REFERENCES `systems`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_yv1_automat_logs` (`system_id`, `date`, `payload`)
SELECT (SELECT `system_id` FROM `strategy_configs` LIMIT 1), `date`, `payload` FROM `yv1_automat_logs`;
--> statement-breakpoint
DROP TABLE `yv1_automat_logs`;
--> statement-breakpoint
ALTER TABLE `__new_yv1_automat_logs` RENAME TO `yv1_automat_logs`;
--> statement-breakpoint
CREATE TABLE `__new_yv1_settings` (
	`system_id` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	PRIMARY KEY(`system_id`, `key`),
	FOREIGN KEY (`system_id`) REFERENCES `systems`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_yv1_settings` (`system_id`, `key`, `value`)
SELECT (SELECT `system_id` FROM `strategy_configs` LIMIT 1), `key`, `value` FROM `yv1_settings`;
--> statement-breakpoint
DROP TABLE `yv1_settings`;
--> statement-breakpoint
ALTER TABLE `__new_yv1_settings` RENAME TO `yv1_settings`;
--> statement-breakpoint
CREATE TABLE `__new_yv1_automat_trades` (
	`trade_num` text PRIMARY KEY NOT NULL,
	`system_id` text NOT NULL,
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
	`source_file` text NOT NULL,
	FOREIGN KEY (`system_id`) REFERENCES `systems`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_yv1_automat_trades` (`system_id`, `trade_num`, `order_num`, `date`, `time`, `contract`, `side`, `qty`, `price`, `reason`, `ref_price`, `slip_rub`, `broker_fee_quik`, `exchange_fee`, `clearing_fee`, `tech_center_fee`, `source_file`)
SELECT (SELECT `system_id` FROM `strategy_configs` LIMIT 1), `trade_num`, `order_num`, `date`, `time`, `contract`, `side`, `qty`, `price`, `reason`, `ref_price`, `slip_rub`, `broker_fee_quik`, `exchange_fee`, `clearing_fee`, `tech_center_fee`, `source_file` FROM `yv1_automat_trades`;
--> statement-breakpoint
DROP TABLE `yv1_automat_trades`;
--> statement-breakpoint
ALTER TABLE `__new_yv1_automat_trades` RENAME TO `yv1_automat_trades`;
--> statement-breakpoint
ALTER TABLE `qsnap_snapshots` ADD `portfolio_id` text REFERENCES portfolios(id);
