import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConflictException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { portfolioSnapshots, portfolios, qsnapSnapshots, snapshotInvalidations, strategyConfigs, strategyDailyResults, systems, yv1AutomatTrades, yv1Settings } from '../../../db/schema';
import { StrategiesService } from './strategies.service';

const TRADES_HEADER =
  'date,time,contract,side,qty,price,reason,ref_price,slip_rub,slip_pct,broker_fee_quik,exchange_fee,clearing_fee,techcenter_fee,order_num,trade_num';

/** Стратегия ЮВ1 как в рабочей БД: система + конфиг quik-bridge с префиксом по умолчанию */
function seedYv1(db: BetterSQLite3Database): string {
  db.insert(systems).values({ id: 'yv1-sys', name: 'ЮВ1-2вх' }).run();
  db.insert(strategyConfigs).values({ systemId: 'yv1-sys', adapter: 'quik-bridge' }).run();
  return 'yv1-sys';
}

describe('StrategiesService', () => {
  let db: BetterSQLite3Database;
  let service: StrategiesService;
  let dir: string;
  const prevEnv = process.env['QUIK_BRIDGE_DIR'];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'strategies-'));
    process.env['QUIK_BRIDGE_DIR'] = dir;
    const sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    migrate(drizzle(sqlite), { migrationsFolder: 'src/db/migrations' });
    db = drizzle(sqlite);
    seedYv1(db);
    service = new StrategiesService(db);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (prevEnv === undefined) delete process.env['QUIK_BRIDGE_DIR'];
    else process.env['QUIK_BRIDGE_DIR'] = prevEnv;
  });

  it('список: ЮВ1, портфель пока не привязан', () => {
    expect(service.list()).toEqual([
      expect.objectContaining({ name: 'ЮВ1-2вх', adapter: 'quik-bridge', portfolioId: null, portfolioName: null }),
    ]);
  });

  it('неизвестная стратегия — 404 на любую операцию', () => {
    expect(() => service.overview('нет')).toThrow(NotFoundException);
    expect(() => service.refresh('нет')).toThrow(NotFoundException);
    expect(() => service.settings('нет')).toThrow(NotFoundException);
    expect(() => service.curveCsv('нет')).toThrow(NotFoundException);
  });

  it('refresh без файлов моста — понятная ошибка 422, а не 500', () => {
    const id = service.list()[0].systemId;
    expect(() => service.refresh(id)).toThrow(UnprocessableEntityException);
  });

  it('настройки: мусор отклоняется 422, нормальное значение сохраняется', () => {
    const id = service.list()[0].systemId;
    expect(() => service.updateSettings(id, { initialCapital: 'abc' })).toThrow(UnprocessableEntityException);
    expect(service.updateSettings(id, { initialCapital: '1000' }).initialCapital).toBe('1000');
  });

  it('привязка портфеля: подтягивается имя; несуществующий портфель — 404; мусор — 422', () => {
    const id = service.list()[0].systemId;
    db.insert(portfolios).values({ id: 'p1', name: 'Trader' }).run();
    expect(service.linkPortfolio(id, 'p1')).toMatchObject({ portfolioId: 'p1', portfolioName: 'Trader' });
    expect(() => service.linkPortfolio(id, 'нет')).toThrow(NotFoundException);
    expect(() => service.linkPortfolio(id, 42)).toThrow(UnprocessableEntityException);
  });

  it('вторая стратегия: свой список, свои данные, адаптер выбирается по systemId', () => {
    db.insert(systems).values({ id: 'sys-b', name: 'Вторая' }).run();
    db.insert(strategyConfigs)
      .values({ systemId: 'sys-b', adapter: 'quik-bridge', params: JSON.stringify({ journalPrefix: 'zz' }) })
      .run();
    writeFileSync(join(dir, 'zz_trades.csv'), `${TRADES_HEADER}\n2026-11-06,10:20:00,CRZ6,B,5,12.405,exit,,,,1,1,1,0.00,O1,222\n`);
    expect(service.list().map((s) => s.name)).toEqual(['Вторая', 'ЮВ1-2вх']);
    // мост без qsnap-файлов → 422 именно для второй; при этом настройки изолированы
    expect(() => service.refresh('sys-b')).toThrow(UnprocessableEntityException);
    service.updateSettings('sys-b', { initialCapital: '5' });
    const yv1Id = service.list().find((s) => s.name === 'ЮВ1-2вх')?.systemId ?? '';
    expect(service.settings(yv1Id).initialCapital).toBeNull();
  });

  it('некорректные params конфига — 422 с объяснением', () => {
    db.insert(systems).values({ id: 'sys-c', name: 'Битая' }).run();
    db.insert(strategyConfigs).values({ systemId: 'sys-c', adapter: 'quik-bridge', params: '{"journalPrefix":"Bad Prefix"}' }).run();
    expect(() => service.overview('sys-c')).toThrow(UnprocessableEntityException);
  });

  describe('create', () => {
    beforeEach(() => {
      db.insert(portfolios).values({ id: 'p1', name: 'Trader' }).run();
    });

    it('новая система + конфиг: появляется в списке с портфелем и префиксом', () => {
      const created = service.create({ name: 'Вторая ТС', portfolioId: 'p1', params: { journalPrefix: 'zz' } });
      expect(created).toMatchObject({ name: 'Вторая ТС', adapter: 'quik-bridge', portfolioId: 'p1', portfolioName: 'Trader' });
      expect(db.select().from(systems).all().filter((s) => s.name === 'Вторая ТС')).toHaveLength(1);
      expect(service.list().map((s) => s.name)).toContain('Вторая ТС');
    });

    it('существующая система без конфига становится стратегией, дубль системы не создаётся', () => {
      db.insert(systems).values({ id: 'old', name: 'Старая' }).run();
      const before = db.select().from(systems).all().length;
      service.create({ systemId: 'old', portfolioId: 'p1', params: { journalPrefix: 'old' } });
      expect(db.select().from(systems).all()).toHaveLength(before);
      expect(service.list().some((s) => s.systemId === 'old')).toBe(true);
    });

    it('занятый префикс — 409 и ничего не создаётся (в т.ч. новая система)', () => {
      const systemsBefore = db.select().from(systems).all().length;
      expect(() => service.create({ name: 'Дубль', portfolioId: 'p1', params: { journalPrefix: 'yv1' } })).toThrow(ConflictException);
      expect(db.select().from(systems).all()).toHaveLength(systemsBefore);
    });

    it('у системы уже есть стратегия — 409', () => {
      const id = service.list()[0].systemId;
      expect(() => service.create({ systemId: id, portfolioId: 'p1', params: { journalPrefix: 'new1' } })).toThrow(ConflictException);
    });

    it('валидация: нет префикса, плохой префикс, и name вместе с systemId, ни одного из них — 422', () => {
      const ok = { name: 'Х', portfolioId: 'p1', params: { journalPrefix: 'xx' } };
      expect(() => service.create({ ...ok, params: {} })).toThrow(UnprocessableEntityException);
      expect(() => service.create({ ...ok, params: { journalPrefix: 'Bad Prefix' } })).toThrow(UnprocessableEntityException);
      expect(() => service.create({ ...ok, systemId: 'old' })).toThrow(UnprocessableEntityException);
      expect(() => service.create({ portfolioId: 'p1', params: { journalPrefix: 'xx' } })).toThrow(UnprocessableEntityException);
      expect(() => service.create({ ...ok, name: '   ' })).toThrow(UnprocessableEntityException);
    });

    it('несуществующие портфель и система — 404', () => {
      expect(() => service.create({ name: 'Х', portfolioId: 'нет', params: { journalPrefix: 'xx' } })).toThrow(NotFoundException);
      expect(() => service.create({ systemId: 'нет', portfolioId: 'p1', params: { journalPrefix: 'xx' } })).toThrow(NotFoundException);
    });
  });

  describe('remove', () => {
    const seedData = (systemId: string, tradeNum: string): void => {
      db.insert(yv1AutomatTrades)
        .values({ tradeNum, systemId, date: '2026-11-06', time: '10:20:00', contract: 'CRZ6', side: 'B', qty: '1', price: '12', reason: 'exit', sourceFile: 'f' })
        .run();
      db.insert(strategyDailyResults).values({ systemId, date: '2026-11-06', pricePnlRub: '1', costsRub: '0', debtInterestRub: '0', netRub: '1', cycles: 1 }).run();
      db.insert(yv1Settings).values({ systemId, key: 'initialCapital', value: '100' }).run();
    };

    it('пустую стратегию удаляет без подтверждения; система остаётся', () => {
      db.insert(systems).values({ id: 'empty', name: 'Пустая' }).run();
      db.insert(strategyConfigs).values({ systemId: 'empty', adapter: 'quik-bridge', params: '{"journalPrefix":"em"}' }).run();
      expect(service.remove('empty', false)).toEqual({ deleted: true, trades: 0, resultDays: 0 });
      expect(service.list().some((s) => s.systemId === 'empty')).toBe(false);
      expect(db.select().from(systems).where(eq(systems.id, 'empty')).get()).toBeDefined();
    });

    it('с данными без force — 409 с цифрами, ничего не удалено', () => {
      const id = service.list()[0].systemId;
      seedData(id, 't1');
      expect(() => service.remove(id, false)).toThrow(ConflictException);
      expect(() => service.remove(id, false)).toThrow(/сделок в журнале — 1.*дней результата в портфеле — 1/);
      expect(db.select().from(yv1AutomatTrades).all()).toHaveLength(1);
      expect(service.list()).toHaveLength(1);
    });

    it('с force удаляет данные стратегии, но не соседней и не снимки моста', () => {
      const a = service.list()[0].systemId;
      db.insert(systems).values({ id: 'sys-b', name: 'Вторая' }).run();
      db.insert(strategyConfigs).values({ systemId: 'sys-b', adapter: 'quik-bridge', params: '{"journalPrefix":"zz"}' }).run();
      db.insert(qsnapSnapshots)
        .values({ snapId: 's1', localTime: 'x', serverTime: 'x', serverTimeEnd: 'x', tradeDate: 'x', connected: 1, quikVersion: 'x', scriptVersion: '3', status: 'ok', rawLines: 0, rawBytes: 0, floatIds: 0, counts: '', errors: '', complete: 1 })
        .run();
      seedData(a, 't1');
      seedData('sys-b', 't2');
      expect(service.remove(a, true)).toEqual({ deleted: true, trades: 1, resultDays: 1 });
      expect(db.select().from(yv1AutomatTrades).all().map((t) => t.tradeNum)).toEqual(['t2']);
      expect(db.select().from(strategyDailyResults).all().map((r) => r.systemId)).toEqual(['sys-b']);
      expect(db.select().from(yv1Settings).all().map((r) => r.systemId)).toEqual(['sys-b']);
      expect(db.select().from(qsnapSnapshots).all()).toHaveLength(1);
      expect(service.list().map((s) => s.systemId)).toEqual(['sys-b']);
    });

    it('неизвестная стратегия — 404', () => {
      expect(() => service.remove('нет', true)).toThrow(NotFoundException);
    });

    it('после удаления префикс освобождается для новой стратегии', () => {
      const id = service.list()[0].systemId;
      db.insert(portfolios).values({ id: 'p1', name: 'Trader' }).run();
      service.remove(id, true);
      expect(service.create({ name: 'Новая ЮВ1', portfolioId: 'p1', params: { journalPrefix: 'yv1' } }).name).toBe('Новая ЮВ1');
    });
  });

  it('неизвестный adapter в БД: список его пропускает (не падает), операции над ним — 422', () => {
    db.insert(systems).values({ id: 'future', name: 'Из будущего' }).run();
    db.insert(strategyConfigs).values({ systemId: 'future', adapter: 'spot-x', params: '{}' }).run();
    expect(service.list().map((s) => s.name)).toEqual(['ЮВ1-2вх']);
    expect(() => service.overview('future')).toThrow(UnprocessableEntityException);
    expect(() => service.overview('future')).toThrow(/Неизвестный адаптер/);
  });

  describe('инвалидация снимков', () => {
    const snapshot = (date: string): void => {
      db.insert(portfolioSnapshots).values({ date, investedRub: '0', currentValueRub: '0', pnlRub: '0', dividendsRub: '0' }).run();
    };
    const seedResult = (systemId: string, date: string): void => {
      db.insert(strategyDailyResults).values({ systemId, date, pricePnlRub: '1', costsRub: '0', debtInterestRub: '0', netRub: '1', cycles: 1 }).run();
    };

    it('удаление стратегии с результатом за дату, которую снимок уже видел, пишет strategy-sync с самой ранней датой', () => {
      const id = service.list()[0].systemId;
      seedResult(id, '2026-11-06');
      seedResult(id, '2026-11-09');
      snapshot('2026-11-10');
      service.remove(id, true);
      const rows = db.select().from(snapshotInvalidations).all();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ kind: 'strategy-sync', operationDate: '2026-11-06', affectedCount: 2 });
      expect(rows[0].description).toMatch(/ЮВ1-2вх/);
    });

    it('снимков нет или все старее результата — предупреждать не о чем', () => {
      const id = service.list()[0].systemId;
      seedResult(id, '2026-11-06');
      service.remove(id, true);
      expect(db.select().from(snapshotInvalidations).all()).toHaveLength(0);
    });
  });
});
