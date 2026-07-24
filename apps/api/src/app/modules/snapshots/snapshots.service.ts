import { Inject, Injectable } from '@nestjs/common';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { Snapshot } from '@core';
import { portfolioSnapshots } from '../../../db/schema';
import { DB } from '../../db/drizzle.module';
import { OperationsService } from '../operations/operations.service';

/**
 * Снимки стоимости портфеля во времени (docs/04-roadmap.md, Фаза 5).
 * Переиспользует уже посчитанные тоталы из OperationsService.summary()
 * (DRY — та же логика позиций/курсов, что и на дашборде), просто пишет их
 * в отдельную таблицу с датой. Один снимок в день — upsert по дате.
 */
@Injectable()
export class SnapshotsService {
  constructor(
    @Inject(DB) private readonly db: BetterSQLite3Database,
    private readonly operations: OperationsService,
  ) {}

  /** Все снимки по датам, по возрастанию — для линии динамики на дашборде */
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

    return {
      date,
      investedRub: totals.investedRub,
      currentValueRub: totals.currentValueRub,
      pnlRub: totals.pnlRub,
      dividendsRub: totals.dividendsRub,
    };
  }
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
