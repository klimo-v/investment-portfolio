import Database from 'better-sqlite3';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyMigrations } from './apply-migrations';

const FULL = join(__dirname, 'migrations');

/** Копия папки миграций, обрезанная ДО price_history: это «БД пользователя до обновления» */
function oldMigrationsFolder(): string {
  const dir = mkdtempSync(join(tmpdir(), 'migrations-'));
  cpSync(FULL, dir, { recursive: true });
  const journalPath = join(dir, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { tag: string }[] };
  const idx = journal.entries.findIndex((e) => e.tag.endsWith('_price_history'));
  journal.entries = journal.entries.slice(0, idx);
  writeFileSync(journalPath, JSON.stringify(journal));
  return dir;
}

describe('перенос снимков в price_history при обновлении БД', () => {
  it('цена = value_rub / quantity, источник snapshot; фьючерсы и нулевой остаток пропущены', () => {
    const sqlite = new Database(':memory:');
    applyMigrations(sqlite, oldMigrationsFolder());
    expect(sqlite.prepare(`SELECT name FROM sqlite_master WHERE name='price_history'`).get()).toBeUndefined();

    sqlite.exec(`
      INSERT INTO instruments (id, ticker, type, currency, market_source) VALUES
        ('SBER','SBER','Stock','RUB','moex'),
        ('FUND','FUND','ETF','RUB','manual'),
        ('CNY-12.26','CNY-12.26','Future','RUB','manual');
      INSERT INTO snapshot_positions (date, instrument_id, value_rub, quantity) VALUES
        ('2026-10-01','SBER','2931.10','10'),
        ('2026-10-01','FUND','1000.00','3'),
        ('2026-10-01','CNY-12.26','4288.00','-1'),
        ('2026-10-02','SBER','0','0');
    `);

    applyMigrations(sqlite, FULL);

    const rows = sqlite.prepare(`SELECT * FROM price_history ORDER BY instrument_id, date`).all() as Record<string, unknown>[];
    expect(rows).toEqual([
      { instrument_id: 'FUND', date: '2026-10-01', price: '333.333333', currency: 'RUB', accrued_interest: null, accrued_currency: null, source: 'snapshot' },
      { instrument_id: 'SBER', date: '2026-10-01', price: '293.11', currency: 'RUB', accrued_interest: null, accrued_currency: null, source: 'snapshot' },
    ]);
  });

  it('повторный запуск ничего не дублирует и не затирает рыночную цену', () => {
    const sqlite = new Database(':memory:');
    applyMigrations(sqlite, FULL);
    sqlite.exec(`
      INSERT INTO instruments (id, ticker, type, currency, market_source) VALUES ('SBER','SBER','Stock','RUB','moex');
      INSERT INTO price_history VALUES ('SBER','2026-10-01','300','RUB',NULL,NULL,'moex');
    `);
    applyMigrations(sqlite, FULL);
    expect(sqlite.prepare(`SELECT COUNT(*) AS n FROM price_history`).get()).toEqual({ n: 1 });
  });
});
