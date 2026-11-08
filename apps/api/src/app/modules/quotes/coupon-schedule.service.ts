import { Inject, Injectable, Logger } from '@nestjs/common';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { and, eq, inArray } from 'drizzle-orm';
import type { CouponScheduleRow } from '@core';
import { couponSchedule, couponScheduleLoads, instruments } from '../../../db/schema';
import { DB } from '../../db/drizzle.module';
import { COUPON_SCHEDULE_PROVIDER, type CouponScheduleProvider } from './coupon-schedule.provider';

/**
 * Через сколько дней график перезагружаем. Расписание почти не меняется (объявленные купоны),
 * но новые публикуются, а запрос к бирже на каждый заход на дашборд лишний — раз в неделю достаточно.
 */
export const SCHEDULE_TTL_DAYS = 7;
/** Не повторяем неудавшийся запрос чаще раза в час (как у истории цен) */
const FAILURE_TTL_MS = 60 * 60 * 1000;

const addDays = (iso: string, n: number): string => new Date(Date.parse(iso) + n * 86_400_000).toISOString().slice(0, 10);

/**
 * График купонов облигаций: загрузка с MOEX ISS через провайдер и кэш в БД (таблицы
 * coupon_schedule и coupon_schedule_loads). Грузим только облигации с биржевым источником.
 * Сбой сети не роняет проверку полноты: ошибка логируется, берётся то, что уже в кэше.
 */
@Injectable()
export class CouponScheduleService {
  private readonly log = new Logger(CouponScheduleService.name);
  private readonly failedAt = new Map<string, number>();
  private readonly inFlight = new Map<string, Promise<void>>();

  constructor(
    @Inject(DB) private readonly db: BetterSQLite3Database,
    @Inject(COUPON_SCHEDULE_PROVIDER) private readonly provider: CouponScheduleProvider,
  ) {}

  /**
   * Догрузить графики по бумагам. `firstOpDate` — дата первой операции по бумаге (с неё график
   * нужен); `till` — сегодня. Грузим, если графика нет, он устарел по TTL или не покрывает начало периода.
   */
  async ensure(firstOpDate: ReadonlyMap<string, string>, till: string, now: Date = new Date()): Promise<void> {
    if (firstOpDate.size === 0) return;
    const bonds = this.db
      .select()
      .from(instruments)
      .where(inArray(instruments.id, [...firstOpDate.keys()]))
      .all()
      .filter((i) => i.type === 'Bond' && i.marketSource === 'moex');
    const loads = new Map(this.db.select().from(couponScheduleLoads).all().map((l) => [l.instrumentId, l]));
    const staleBefore = addDays(now.toISOString().slice(0, 10), -SCHEDULE_TTL_DAYS);

    for (const bond of bonds) {
      const from = firstOpDate.get(bond.id) as string;
      const load = loads.get(bond.id);
      // Свежесть — только по сроку и началу охвата, НЕ по `till`: «сегодня» каждый день новое, и условие
      // coveredTill >= till перезагружало бы график ежедневно. Пропуска нет: TTL (7 дн.) меньше окна
      // ожидания выплаты (COMPLETENESS.PAYOUT_WINDOW_DAYS = 10), а проверяются только купоны, у которых окно
      // уже закрылось, — они старше загруженной границы.
      const fresh = load !== undefined && load.loadedAt.slice(0, 10) >= staleBefore && load.coveredFrom <= from;
      if (fresh) continue;
      const failed = this.failedAt.get(bond.id);
      if (failed !== undefined && now.getTime() - failed < FAILURE_TTL_MS) continue;
      // одновременные запросы по одной бумаге делят одну загрузку (дашборд шлёт несколько расчётов подряд)
      const running = this.inFlight.get(bond.id);
      if (running) {
        await running;
        continue;
      }
      // при перезагрузке берём полный охват: прежний и новый (запрос за прошлый период не сужает кэш)
      const rangeFrom = load && load.coveredFrom < from ? load.coveredFrom : from;
      const rangeTill = load && load.coveredTill > till ? load.coveredTill : till;
      const job = this.load(bond.id, bond.ticker, rangeFrom, rangeTill, now).finally(() => this.inFlight.delete(bond.id));
      this.inFlight.set(bond.id, job);
      await job;
    }
  }

  private async load(instrumentId: string, ticker: string, from: string, till: string, now: Date): Promise<void> {
    try {
      const coupons = await this.provider.getCoupons(ticker, from, till);
      this.db.transaction((tx) => {
        tx.delete(couponSchedule).where(eq(couponSchedule.instrumentId, instrumentId)).run();
        for (const c of coupons) {
          tx.insert(couponSchedule)
            .values({ instrumentId, couponDate: c.couponDate, recordDate: c.recordDate, amountRub: c.amountRub })
            .run();
        }
        tx.insert(couponScheduleLoads)
          .values({ instrumentId, loadedAt: now.toISOString(), coveredFrom: from, coveredTill: till })
          .onConflictDoUpdate({
            target: couponScheduleLoads.instrumentId,
            set: { loadedAt: now.toISOString(), coveredFrom: from, coveredTill: till },
          })
          .run();
      });
    } catch (err) {
      this.failedAt.set(instrumentId, now.getTime());
      this.log.warn(`График купонов ${ticker}: ${(err as Error).message}`);
    }
  }

  /** Купоны выбранных бумаг из кэша */
  list(instrumentIds: readonly string[]): CouponScheduleRow[] {
    if (instrumentIds.length === 0) return [];
    return this.db
      .select()
      .from(couponSchedule)
      .where(and(inArray(couponSchedule.instrumentId, [...instrumentIds])))
      .all()
      .map((r) => ({ instrumentId: r.instrumentId, couponDate: r.couponDate, recordDate: r.recordDate, amountRub: r.amountRub }))
      .sort((a, b) => a.couponDate.localeCompare(b.couponDate));
  }
}
