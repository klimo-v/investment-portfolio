import { randomUUID } from 'node:crypto';
import { ConflictException, Inject, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { asc, count, eq } from 'drizzle-orm';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { z } from 'zod';
import {
  QsnapFormatError,
  StrategyAdapterIdSchema,
  parseQuikBridgeParams,
  type StrategySummary,
} from '@core';
import { recordSnapshotInvalidation } from '../../../db/snapshot-invalidations';
import {
  portfolios,
  strategyConfigs,
  strategyDailyResults,
  systems,
  yv1AutomatDays,
  yv1AutomatLogs,
  yv1AutomatSignals,
  yv1AutomatTrades,
  yv1Settings,
} from '../../../db/schema';
import { DB } from '../../db/drizzle.module';
import { StrategySourceError } from '../yv1/strategy-context';
import { Yv1SettingsPatchSchema } from '../yv1/yv1.store';
import type { StrategyAdapter, StrategyOverview, StrategyRefreshReport, StrategySettings } from './strategy-adapter';
import { createStrategyAdapter } from './strategy-registry';

/**
 * Тело создания стратегии. Либо `systemId` существующей системы (без конфига), либо `name`
 * новой. Префикс журнала обязателен и задаётся явно: значение по умолчанию (`yv1`) принадлежит
 * ЮВ1, и молчаливое совпадение двух стратегий на одном журнале смешало бы их сделки.
 */
const CreateStrategySchema = z
  .object({
    systemId: z.string().min(1).optional(),
    name: z.string().trim().min(1).optional(),
    portfolioId: z.string().min(1, 'Выберите портфель'),
    adapter: StrategyAdapterIdSchema.default('quik-bridge'),
    params: z.object({ journalPrefix: z.string({ error: 'Укажите префикс журнала' }) }),
  })
  .refine((v) => Boolean(v.systemId) !== Boolean(v.name), {
    message: 'Укажите либо существующую систему, либо название новой',
  });

/** Префикс журнала из `params` конфига; null — у конфига битые params (он чужого префикса не занимает) */
function journalPrefixOf(params: string): string | null {
  try {
    return parseQuikBridgeParams(params).journalPrefix;
  } catch {
    return null;
  }
}

/**
 * Фасад стратегий для контроллера: список, выбор адаптера по `systemId` и перевод ошибок
 * источника/формата в понятные ответы 422. Вся логика источника — в адаптере.
 */
@Injectable()
export class StrategiesService {
  constructor(@Inject(DB) private readonly db: BetterSQLite3Database) {}

  /**
   * Все настроенные стратегии — для бокового меню. Строка с неизвестным адаптером (откат на
   * старую версию, ручная правка БД) пропускается, а не роняет весь список: иначе одна битая
   * запись убирала бы из меню все стратегии.
   */
  list(): StrategySummary[] {
    return this.db
      .select({
        systemId: strategyConfigs.systemId,
        name: systems.name,
        adapter: strategyConfigs.adapter,
        portfolioId: strategyConfigs.portfolioId,
        portfolioName: portfolios.name,
      })
      .from(strategyConfigs)
      .innerJoin(systems, eq(systems.id, strategyConfigs.systemId))
      .leftJoin(portfolios, eq(portfolios.id, strategyConfigs.portfolioId))
      .orderBy(systems.name)
      .all()
      .flatMap((r) => {
        const adapter = StrategyAdapterIdSchema.safeParse(r.adapter);
        return adapter.success ? [{ ...r, adapter: adapter.data }] : [];
      });
  }

  /**
   * Завести стратегию: система (новая или существующая без конфига) + конфиг, в одной
   * транзакции. Проверяем портфель, формат параметров и уникальность префикса журнала —
   * два конфига на одном журнале делили бы одни и те же сделки.
   */
  create(raw: unknown): StrategySummary {
    const parsed = CreateStrategySchema.safeParse(raw);
    if (!parsed.success) {
      throw new UnprocessableEntityException(parsed.error.issues.map((i) => i.message).join('; '));
    }
    const body = parsed.data;

    let params: string;
    let prefix: string;
    try {
      prefix = parseQuikBridgeParams(JSON.stringify(body.params)).journalPrefix;
      params = JSON.stringify({ journalPrefix: prefix });
    } catch (e) {
      throw new UnprocessableEntityException(`Параметры стратегии некорректны: ${(e as Error).message}`);
    }

    if (!this.db.select().from(portfolios).where(eq(portfolios.id, body.portfolioId)).get()) {
      throw new NotFoundException(`Портфель не найден: ${body.portfolioId}`);
    }
    if (body.systemId) {
      if (!this.db.select().from(systems).where(eq(systems.id, body.systemId)).get()) {
        throw new NotFoundException(`Система не найдена: ${body.systemId}`);
      }
      if (this.db.select().from(strategyConfigs).where(eq(strategyConfigs.systemId, body.systemId)).get()) {
        throw new ConflictException('У этой системы уже есть стратегия');
      }
    }
    const configs = this.db
      .select({ name: systems.name, params: strategyConfigs.params })
      .from(strategyConfigs)
      .innerJoin(systems, eq(systems.id, strategyConfigs.systemId))
      .all();
    const owner = configs.find((c) => journalPrefixOf(c.params) === prefix);
    if (owner) throw new ConflictException(`Префикс журнала «${prefix}» уже занят стратегией «${owner.name}»`);

    const systemId = body.systemId ?? randomUUID();
    this.db.transaction((tx) => {
      if (!body.systemId) tx.insert(systems).values({ id: systemId, name: body.name as string }).run();
      tx.insert(strategyConfigs).values({ systemId, portfolioId: body.portfolioId, adapter: body.adapter, params }).run();
    });
    return this.list().find((s) => s.systemId === systemId) as StrategySummary;
  }

  /**
   * Удалить стратегию: конфиг, журнал автомата (сделки, дни, сигналы, логи), настройки и
   * ленту результата для портфеля — одной транзакцией. Не трогаем: систему (на неё могут
   * ссылаться операции — её удаляют отдельно), снимки моста (данные счёта, общие со
   * стратегиями) и файлы источника. Если у стратегии есть данные, без `force` отказываем и
   * называем, что пропадёт, — удаление необратимо.
   */
  remove(systemId: string, force: boolean): { deleted: true; trades: number; resultDays: number } {
    if (!this.db.select().from(strategyConfigs).where(eq(strategyConfigs.systemId, systemId)).get()) {
      throw new NotFoundException(`Стратегия не найдена: ${systemId}`);
    }
    const countOf = (table: typeof yv1AutomatTrades | typeof strategyDailyResults): number =>
      this.db.select({ n: count() }).from(table).where(eq(table.systemId, systemId)).get()?.n ?? 0;
    const trades = countOf(yv1AutomatTrades);
    const resultDays = countOf(strategyDailyResults);
    if (!force && (trades > 0 || resultDays > 0)) {
      throw new ConflictException(
        `У стратегии есть данные: сделок в журнале — ${trades}, дней результата в портфеле — ${resultDays}. ` +
          'Удаление необратимо; подтвердите его (force=true).',
      );
    }
    // даты результата читаем ДО удаления: по ним определяем, какие снимки история потеряет
    const resultDates = this.db
      .select({ date: strategyDailyResults.date })
      .from(strategyDailyResults)
      .where(eq(strategyDailyResults.systemId, systemId))
      .orderBy(asc(strategyDailyResults.date))
      .all();
    const name = this.db.select({ name: systems.name }).from(systems).where(eq(systems.id, systemId)).get()?.name;
    this.db.transaction((tx) => {
      for (const t of [yv1AutomatTrades, yv1AutomatDays, yv1AutomatSignals, yv1AutomatLogs, yv1Settings, strategyDailyResults]) {
        tx.delete(t).where(eq(t.systemId, systemId)).run();
      }
      tx.delete(strategyConfigs).where(eq(strategyConfigs.systemId, systemId)).run();
    });
    if (resultDates.length > 0) {
      recordSnapshotInvalidation(this.db, {
        kind: 'strategy-sync',
        operationDate: resultDates[0].date,
        description: `Удалена стратегия «${name ?? systemId}»: дней результата — ${resultDays}`,
        affectedCount: resultDays,
      });
    }
    return { deleted: true, trades, resultDays };
  }

  private adapter(systemId: string): StrategyAdapter {
    const row = this.db.select().from(strategyConfigs).where(eq(strategyConfigs.systemId, systemId)).get();
    if (!row) throw new NotFoundException(`Стратегия не найдена: ${systemId}`);
    const adapterId = StrategyAdapterIdSchema.safeParse(row.adapter);
    if (!adapterId.success) {
      throw new UnprocessableEntityException(`Неизвестный адаптер стратегии «${row.adapter}» — обновите приложение`);
    }
    return this.guard(() => createStrategyAdapter(adapterId.data, this.db, systemId));
  }

  private guard<T>(fn: () => T): T {
    try {
      return fn();
    } catch (e) {
      if (e instanceof StrategySourceError || e instanceof QsnapFormatError) {
        throw new UnprocessableEntityException(e.message);
      }
      throw e;
    }
  }

  refresh(systemId: string): StrategyRefreshReport {
    const a = this.adapter(systemId);
    return this.guard(() => a.refresh());
  }

  overview(systemId: string): StrategyOverview {
    const a = this.adapter(systemId);
    return this.guard(() => a.overview());
  }

  curveCsv(systemId: string): string {
    const a = this.adapter(systemId);
    return this.guard(() => a.curveCsv());
  }

  settings(systemId: string): StrategySettings {
    return this.adapter(systemId).getSettings();
  }

  updateSettings(systemId: string, body: unknown): StrategySettings {
    const parsed = Yv1SettingsPatchSchema.safeParse(body);
    if (!parsed.success) {
      throw new UnprocessableEntityException(parsed.error.issues.map((i) => i.message).join('; '));
    }
    return this.adapter(systemId).updateSettings(parsed.data);
  }

  /** Привязать счёт стратегии к существующему портфелю */
  linkPortfolio(systemId: string, portfolioId: unknown): StrategySummary {
    if (typeof portfolioId !== 'string' || portfolioId === '') {
      throw new UnprocessableEntityException('Нужен portfolioId (строка)');
    }
    if (!this.db.select().from(portfolios).where(eq(portfolios.id, portfolioId)).get()) {
      throw new NotFoundException(`Портфель не найден: ${portfolioId}`);
    }
    this.adapter(systemId).linkPortfolio(portfolioId);
    return this.list().find((s) => s.systemId === systemId) as StrategySummary;
  }
}
