import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { beforeEach, describe, expect, it } from 'vitest';
import { couponSchedule, couponScheduleLoads, instruments } from '../../../db/schema';
import { CouponScheduleService, SCHEDULE_TTL_DAYS } from './coupon-schedule.service';
import { parseBondizationCoupons, type CouponScheduleProvider, type IssCouponsResponse, type ParsedCoupon } from './coupon-schedule.provider';

/** Ответ ISS bondization по SU29015RMFS3, снятый с живого эндпоинта (07.11.2026) */
const fixture = JSON.parse(readFileSync(join(__dirname, '__fixtures__', 'iss-bondization-ofz.json'), 'utf8')) as IssCouponsResponse;

describe('parseBondizationCoupons', () => {
  it('дата выплаты, дата фиксации и купон на бумагу в ₽ по возрастанию даты', () => {
    const rows = parseBondizationCoupons(fixture);
    expect(rows).toHaveLength(6);
    expect(rows[0]).toEqual({ couponDate: '2025-07-23', recordDate: '2025-07-22', amountRub: '50.71' });
    expect(rows[5]).toEqual({ couponDate: '2026-10-21', recordDate: '2026-10-20', amountRub: '34.81' });
  });

  it('нет блока coupons / нет рублёвой суммы — пусто / null, без падения', () => {
    expect(parseBondizationCoupons({})).toEqual([]);
    const usd = parseBondizationCoupons({ coupons: { columns: ['coupondate', 'recorddate', 'value_rub'], data: [['2026-05-01', null, null]] } });
    expect(usd).toEqual([{ couponDate: '2026-05-01', recordDate: null, amountRub: null }]);
  });
});

let db: BetterSQLite3Database;
const calls: string[] = [];
let failing = false;

const provider: CouponScheduleProvider = {
  async getCoupons(secid: string, from: string, till: string): Promise<ParsedCoupon[]> {
    calls.push(`${secid}|${from}|${till}`);
    if (failing) throw new Error('сеть недоступна');
    return parseBondizationCoupons(fixture).filter((c) => c.couponDate >= from && c.couponDate <= till);
  },
};

beforeEach(() => {
  calls.length = 0;
  failing = false;
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  migrate(drizzle(sqlite), { migrationsFolder: 'src/db/migrations' });
  db = drizzle(sqlite);
  db.insert(instruments)
    .values([
      { id: 'SU29015RMFS3', ticker: 'SU29015RMFS3', type: 'Bond', currency: 'RUB', marketSource: 'moex' },
      { id: 'SBER', ticker: 'SBER', type: 'Stock', currency: 'RUB', marketSource: 'moex' },
    ])
    .run();
});

const NOW = new Date('2026-11-07T12:00:00Z');
const first = (entries: [string, string][]) => new Map(entries);

describe('CouponScheduleService', () => {
  it('грузит только облигации с биржевым источником и кладёт график в БД', async () => {
    const svc = new CouponScheduleService(db, provider);
    await svc.ensure(first([['SU29015RMFS3', '2025-07-01'], ['SBER', '2025-07-01']]), '2026-11-07', NOW);
    expect(calls).toEqual(['SU29015RMFS3|2025-07-01|2026-11-07']);
    expect(db.select().from(couponSchedule).all()).toHaveLength(6);
    expect(db.select().from(couponScheduleLoads).get()).toMatchObject({ coveredFrom: '2025-07-01', coveredTill: '2026-11-07' });
    expect(svc.list(['SU29015RMFS3'])[0]).toMatchObject({ couponDate: '2025-07-23', amountRub: '50.71' });
  });

  it('свежий график (в пределах TTL и покрывает период) повторно не грузится', async () => {
    const svc = new CouponScheduleService(db, provider);
    const args = [first([['SU29015RMFS3', '2025-07-01']]), '2026-11-07'] as const;
    await svc.ensure(...args, NOW);
    await svc.ensure(...args, new Date(NOW.getTime() + (SCHEDULE_TTL_DAYS - 1) * 86_400_000));
    expect(calls).toHaveLength(1);
  });

  it('график старше TTL или не покрывающий начало периода перезагружается', async () => {
    const svc = new CouponScheduleService(db, provider);
    await svc.ensure(first([['SU29015RMFS3', '2025-10-01']]), '2026-11-07', NOW);
    await svc.ensure(first([['SU29015RMFS3', '2025-10-01']]), '2026-11-20', new Date(NOW.getTime() + (SCHEDULE_TTL_DAYS + 1) * 86_400_000));
    expect(calls).toHaveLength(2);
    // бумагу «купили раньше», чем грузили: берём полный охват, а не только новую дату
    await svc.ensure(first([['SU29015RMFS3', '2025-07-01']]), '2026-11-20', new Date(NOW.getTime() + (SCHEDULE_TTL_DAYS + 1) * 86_400_000));
    expect(calls[2]).toBe('SU29015RMFS3|2025-07-01|2026-11-20');
  });

  it('сбой источника не роняет расчёт: кэш остаётся, повтор не чаще раза в час', async () => {
    const svc = new CouponScheduleService(db, provider);
    await svc.ensure(first([['SU29015RMFS3', '2025-07-01']]), '2026-11-07', NOW);
    failing = true;
    const later = new Date(NOW.getTime() + (SCHEDULE_TTL_DAYS + 1) * 86_400_000);
    await svc.ensure(first([['SU29015RMFS3', '2025-07-01']]), '2026-11-20', later);
    await svc.ensure(first([['SU29015RMFS3', '2025-07-01']]), '2026-11-20', new Date(later.getTime() + 60_000));
    expect(calls).toHaveLength(2); // успех + одна неудача; вторая попытка отложена
    expect(svc.list(['SU29015RMFS3'])).toHaveLength(6); // старый график на месте
  });
});
