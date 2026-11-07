-- Удаление моста QUIK и стратегий: записи журнала снимков про пересчёт стратегий больше не имеют смысла
DELETE FROM `snapshot_invalidations` WHERE `kind` = 'strategy-sync';--> statement-breakpoint
DROP TABLE `qsnap_raw`;--> statement-breakpoint
DROP TABLE `qsnap_snapshots`;--> statement-breakpoint
DROP TABLE `strategy_configs`;--> statement-breakpoint
DROP TABLE `strategy_daily_results`;--> statement-breakpoint
DROP TABLE `yv1_automat_days`;--> statement-breakpoint
DROP TABLE `yv1_automat_logs`;--> statement-breakpoint
DROP TABLE `yv1_automat_signals`;--> statement-breakpoint
DROP TABLE `yv1_automat_trades`;--> statement-breakpoint
DROP TABLE `yv1_settings`;