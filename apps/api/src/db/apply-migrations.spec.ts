import Database from 'better-sqlite3';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyMigrations } from './apply-migrations';

const FULL = join(__dirname, 'migrations');

/** Копия папки миграций, обрезанная ДО price_history (или ПОСЛЕ неё: `through`) — «БД пользователя до обновления» */
function oldMigrationsFolder(through = false): string {
  const dir = mkdtempSync(join(tmpdir(), 'migrations-'));
  cpSync(FULL, dir, { recursive: true });
  const journalPath = join(dir, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { tag: string }[] };
  const idx = journal.entries.findIndex((e) => e.tag.endsWith('_price_history'));
  journal.entries = journal.entries.slice(0, through ? idx + 1 : idx);
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

describe('обрыв между созданием price_history и переносом', () => {
  it('БД уже на 0017, снимки есть, 0018 не применена: перенос всё равно выполняется до удаления таблиц', () => {
    const sqlite = new Database(':memory:');
    applyMigrations(sqlite, oldMigrationsFolder(true)); // создана price_history, перенос «не успел»
    expect(sqlite.prepare(`SELECT name FROM sqlite_master WHERE name='price_history'`).get()).toBeDefined();
    sqlite.exec(`
      INSERT INTO instruments (id, ticker, type, currency, market_source) VALUES ('FUND','FUND','ETF','RUB','manual');
      INSERT INTO snapshot_positions (date, instrument_id, value_rub, quantity) VALUES ('2026-10-01','FUND','1000.00','4');
    `);

    applyMigrations(sqlite, FULL);

    expect(sqlite.prepare(`SELECT name FROM sqlite_master WHERE name='snapshot_positions'`).get()).toBeUndefined();
    expect(sqlite.prepare(`SELECT price, source FROM price_history`).all()).toEqual([{ price: '250', source: 'snapshot' }]);
  });
});

describe('заполнение instrument_identifiers из существующих инструментов', () => {
  it('тикер, ISIN и название; невалидный ISIN — код брокера; TMON@ уступает код TMON', () => {
    const sqlite = new Database(':memory:');
    applyMigrations(sqlite, FULL);
    sqlite.exec(`
      INSERT INTO instruments (id, ticker, type, currency, isin, name, market_source) VALUES
        ('TMON@','TMON@','ETF','RUB',NULL,'Денежный рынок','manual'),
        ('TMON','TMON','ETF','RUB',NULL,'паи БПИФ рфи Т-КапиталДенРынок','moex'),
        ('SBER','SBER','Stock','RUB','RU0009029540','Сбербанк','moex'),
        ('TCS00A10B4K3','TCS00A10B4K3','Bond','RUB','TCS00A10B4K3',NULL,'manual');
    `);
    applyMigrations(sqlite, FULL);
    const rows = sqlite
      .prepare(`SELECT scheme, value, instrument_id AS id FROM instrument_identifiers ORDER BY scheme, value`)
      .all();
    expect(rows).toEqual([
      { scheme: 'broker_code', value: 'TCS00A10B4K3', id: 'TCS00A10B4K3' },
      { scheme: 'isin', value: 'RU0009029540', id: 'SBER' },
      { scheme: 'name', value: 'денежный рынок', id: 'TMON@' },
      { scheme: 'name', value: 'паи бпиф рфи т-капиталденрынок', id: 'TMON' },
      { scheme: 'name', value: 'сбербанк', id: 'SBER' },
      { scheme: 'ticker', value: 'SBER', id: 'SBER' },
      { scheme: 'ticker', value: 'TCS00A10B4K3', id: 'TCS00A10B4K3' },
      { scheme: 'ticker', value: 'TMON', id: 'TMON' },
    ]);
    // повторный запуск ничего не дублирует
    applyMigrations(sqlite, FULL);
    expect(sqlite.prepare(`SELECT COUNT(*) AS n FROM instrument_identifiers`).get()).toEqual({ n: 8 });
  });

  it('идентификаторы удаляются вместе с инструментом (cascade)', () => {
    const sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    applyMigrations(sqlite, FULL);
    sqlite.exec(`INSERT INTO instruments (id, ticker, type, currency, market_source) VALUES ('X','X','Stock','RUB','manual')`);
    applyMigrations(sqlite, FULL);
    sqlite.exec(`DELETE FROM instruments WHERE id='X'`);
    expect(sqlite.prepare(`SELECT COUNT(*) AS n FROM instrument_identifiers`).get()).toEqual({ n: 0 });
  });
});
