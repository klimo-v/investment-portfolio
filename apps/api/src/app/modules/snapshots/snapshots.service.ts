import { Inject, Injectable } from '@nestjs/common';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { PositionSeries, Snapshot } from '@core';
import { instruments, portfolioSnapshots, snapshotPositions } from '../../../db/schema';
import { DB } from '../../db/drizzle.module';
import { OperationsService } from '../operations/operations.service';

/**
 * Снимки стоимости портфеля во времени (docs/04-roadmap.md, Фаза 5).
 * Кроме агрегатного снимка (portfolio_snapshots) ведёт разбивку по инструментам
 * (snapshot_positions) для графика «Стоимость инструментов во времени». Оба снимка
 * пишет capture() на текущую дату (по нажатию «Обновить цены»); история копится
 * день за днём. Исторических цен не реконструируем — снимок фиксирует стоимость
 * всех оценённых инструментов «как есть» на дату, ровно как её видит дашборд.
 */
@Injectable()
export class SnapshotsService {
  constructor(
    @Inject(DB) private readonly db: BetterSQLite3Database,
    private readonly operations: OperationsService,
  ) {}

  /** Все агрегатные снимки по датам, по возрастанию — для линии динамики на дашборде */
  list(): Snapshot[] {
    return this.db
      .select()
      .from(portfolioSnapshots)
      .orderBy(portfolioSnapshots.date)
      .all()
      .map(rowToSnapshot);
  }

  /** Снять снимок на сегодня (вызывается вместе с обновлением котировок) */
  async capture(): Promise<Snapshot> {
    const { totals } = await this.operations.summary();
    const date = new Date().toISOString().slice(0, 10);

    this.db
      .insert(portfolioSnapshots)
      .values({
        date,
        investedRub: totals.investedRub.toString(),
        currentValueRub: totals.currentValueRub.toString(),
        pnlRub: totals.pnlRub.toString(),
        dividendsRub: totals.dividendsRub.toString(),
      })
      .onConflictDoUpdate({
        target: portfolioSnapshots.date,
        set: {
          investedRub: totals.investedRub.toString(),
          currentValueRub: totals.currentValueRub.toString(),
          pnlRub: totals.pnlRub.toString(),
          dividendsRub: totals.dividendsRub.toString(),
        },
      })
      .run();

    // разбивка по инструментам на сегодня — той же оценкой, что на дашборде.
    // Пишем ВСЕ оценённые инструменты (у кого есть текущая стоимость в RUB), без
    // фильтра по валюте — тогда сумма линий = «Текущая стоимость» портфеля.
    const positions = await this.operations.positions();
    const byInst = new Map<string, { value: number; qty: number }>();
    for (const p of positions) {
      if (p.currentValueRub === null) continue;
      const cur = byInst.get(p.instrumentId) ?? { value: 0, qty: 0 };
      cur.value += Number(p.currentValueRub);
      cur.qty += Number(p.quantity);
      byInst.set(p.instrumentId, cur);
    }
    for (const [instrumentId, v] of byInst) {
      if (v.qty <= 1e-9) continue;
      this.db
        .insert(snapshotPositions)
        .values({
          date,
          instrumentId,
          valueRub: v.value.toFixed(2),
          quantity: v.qty.toString(),
        })
        .onConflictDoUpdate({
          target: [snapshotPositions.date, snapshotPositions.instrumentId],
          set: { valueRub: v.value.toFixed(2), quantity: v.qty.toString() },
        })
        .run();
    }

    return {
      date,
      investedRub: totals.investedRub,
      currentValueRub: totals.currentValueRub,
      pnlRub: totals.pnlRub,
      dividendsRub: totals.dividendsRub,
    };
  }

  /**
   * Ряд «стоимость инструментов во времени» из snapshot_positions: общая ось дат,
   * по линии на инструмент (null там, где инструмент в эту дату не удерживался),
   * итог как сумма стоимостей и накопленный чистый ввод средств (депозиты − выводы)
   * из операций — чтобы отделить рост от довнесения капитала.
   */
  positionsSeries(): PositionSeries {
    const snapRows = this.db
      .select()
      .from(snapshotPositions)
      .orderBy(snapshotPositions.date)
      .all();

    const dates = [...new Set(snapRows.map((r) => r.date))].sort((a, b) => a.localeCompare(b));
    const dateIdx = new Map(dates.map((d, i) => [d, i]));

    const instrumentRows = this.db.select().from(instruments).all();
    const tickerById = new Map(instrumentRows.map((i) => [i.id, i.ticker]));

    const byInst = new Map<string, (number | null)[]>();
    for (const r of snapRows) {
      let arr = byInst.get(r.instrumentId);
      if (!arr) {
        arr = new Array<number | null>(dates.length).fill(null);
        byInst.set(r.instrumentId, arr);
      }
      arr[dateIdx.get(r.date) ?? 0] = Number(r.valueRub);
    }

    const instrumentsOut = [...byInst.entries()]
      .map(([instrumentId, values]) => ({
        instrumentId,
        ticker: tickerById.get(instrumentId) ?? instrumentId,
        values,
      }))
      // крупные позиции сверху — стабильный порядок легенды/цветов
      .sort((a, b) => lastValue(b.values) - lastValue(a.values));

    const total = dates.map((_, i) =>
      instrumentsOut.reduce((s, ins) => s + (ins.values[i] ?? 0), 0),
    );

    const ops = this.operations.list();
    const netContributions = dates.map((d) => {
      let net = 0;
      for (const o of ops) {
        if (o.date > d) continue;
        const amount = Number(o.quantity) * Number(o.price) * Number(o.fxRate);
        if (o.operationType === 'Deposit') net += amount;
        else if (o.operationType === 'Withdraw') net -= amount;
      }
      return net;
    });

    return { dates, instruments: instrumentsOut, total, netContributions };
  }
}

/** Последнее ненулевое значение ряда (для сортировки инструментов по величине) */
function lastValue(values: (number | null)[]): number {
  for (let i = values.length - 1; i >= 0; i--) {
    if (values[i] !== null) return values[i] as number;
  }
  return 0;
}

function rowToSnapshot(row: typeof portfolioSnapshots.$inferSelect): Snapshot {
  return {
    date: row.date,
    investedRub: Number(row.investedRub),
    currentValueRub: Number(row.currentValueRub),
    pnlRub: Number(row.pnlRub),
    dividendsRub: Number(row.dividendsRub),
  };
}
