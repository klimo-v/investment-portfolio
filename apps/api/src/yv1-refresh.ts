import './load-env';
import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { QsnapFormatError } from '@core';
import { db, sqlite } from './db/client';
import { resolveDbPath } from './db/db-path';
import { runMigrations } from './db/run-migrations';
import { eq, or } from 'drizzle-orm';
import { portfolios, strategyConfigs, systems } from './db/schema';
import { StrategySourceError } from './app/modules/yv1/strategy-context';
import { Yv1Store } from './app/modules/yv1/yv1.store';

/**
 * Обновление среза «ЮВ1» одной командой: `pnpm yv1:refresh`.
 *
 *   pnpm yv1:refresh                      — мост и журнал автомата → БД, сводка в консоль
 *   pnpm yv1:refresh --curve out.csv      — плюс выгрузить кривую date,ret,equity
 *   pnpm yv1:refresh --portfolio Trader   — привязать счёт стратегии к портфелю (имя или id)
 *   pnpm yv1:refresh --system ЮВ1-2вх     — какая стратегия (имя или id); обязателен, если их несколько
 *
 * Файлы моста только читаются. Применяет миграции так же, как это делает API при старте.
 * Выгрузку в существующий файл не перезаписывает.
 */
/**
 * Стратегия по `--system` (имя или id среди настроенных). Без опции возвращает undefined:
 * хранилище само возьмёт единственную стратегию, а при нескольких откажет с подсказкой.
 */
function resolveSystemId(arg: string | undefined): string | undefined {
  const rows = db
    .select({ systemId: strategyConfigs.systemId, name: systems.name })
    .from(strategyConfigs)
    .innerJoin(systems, eq(systems.id, strategyConfigs.systemId))
    .all();
  if (!arg) {
    if (rows.length > 1) {
      throw new StrategySourceError(
        `Стратегий несколько — укажите --system (имя или id): ${rows.map((r) => `«${r.name}»`).join(', ')}`,
      );
    }
    return undefined;
  }
  const found = rows.filter((r) => r.systemId === arg || r.name === arg);
  if (found.length !== 1) {
    throw new StrategySourceError(
      found.length === 0
        ? `Стратегия не найдена: ${arg}. Доступные: ${rows.map((r) => `«${r.name}»`).join(', ') || 'нет'}`
        : `Стратегий с таким именем несколько — укажите id: ${arg}`,
    );
  }
  return found[0].systemId;
}

function main(): number {
  const args = process.argv.slice(2);
  const curveIdx = args.indexOf('--curve');
  const curvePath = curveIdx >= 0 ? args[curveIdx + 1] : undefined;
  if (curveIdx >= 0 && !curvePath) {
    console.error('--curve требует путь к файлу');
    return 2;
  }
  const pfIdx = args.indexOf('--portfolio');
  const portfolioArg = pfIdx >= 0 ? args[pfIdx + 1] : undefined;
  if (pfIdx >= 0 && !portfolioArg) {
    console.error('--portfolio требует имя или id портфеля');
    return 2;
  }
  const sysIdx = args.indexOf('--system');
  const systemArg = sysIdx >= 0 ? args[sysIdx + 1] : undefined;
  if (sysIdx >= 0 && !systemArg) {
    console.error('--system требует имя или id стратегии');
    return 2;
  }
  if (curvePath && existsSync(resolve(curvePath))) {
    console.error(`Файл ${resolve(curvePath)} уже есть — выберите другое имя, перезаписывать не буду.`);
    return 2;
  }

  try {
    runMigrations();
    // как и в Nest-провайдере DB, сервисы принимают дрозл без схемы — запросы типизированы таблицами
    const store = new Yv1Store(db as unknown as BetterSQLite3Database, undefined, resolveSystemId(systemArg));
    if (portfolioArg) {
      const found = db
        .select()
        .from(portfolios)
        .where(or(eq(portfolios.id, portfolioArg), eq(portfolios.name, portfolioArg)))
        .all();
      if (found.length !== 1) {
        console.error(
          found.length === 0 ? `Портфель не найден: ${portfolioArg}` : `Портфелей с таким именем несколько — укажите id: ${portfolioArg}`,
        );
        return 2;
      }
      store.linkPortfolio(found[0].id);
      console.log(`Счёт стратегии привязан к портфелю «${found[0].name}»`);
    }
    const r = store.refresh();
    console.log(`База: ${resolveDbPath()}`);
    console.log(
      `Снимки: всего ${r.snapshots.total}, новых ${r.snapshots.imported.length}, уже были ${r.snapshots.alreadyImported}` +
        `, не целых ${r.snapshots.incomplete.length}, незавершённых ${r.snapshots.unfinished.length}, конфликтов ${r.snapshots.conflicts.length}`,
    );
    for (const i of r.snapshots.incomplete) console.log(`  не целый ${i.snapId}: ${i.reasons.join('; ')}`);
    for (const u of r.snapshots.unfinished) console.log(`  без индекса ${u}`);
    for (const c of r.snapshots.conflicts) console.log(`  изменился в файле ${c} — не перезаписан`);
    console.log(
      `Автомат: сделок ${r.automat.trades}, дней ${r.automat.days}, сигналов ${r.automat.signals}, логов ${r.automat.logs}`,
    );
    console.log(`Лента результата для портфеля: ${r.resultDays} дн.`);
    for (const m of r.automat.missingFiles) console.log(`  нет файла ${m}`);
    for (const s of r.automat.skipped) console.log(`  пропущен ${s}`);

    const o = store.overview();
    console.log(
      `Циклов: ${o.cycles.length} (закрытых ${o.verdict.closedCycles}); ${o.verdict.note}`,
    );
    const errors = o.discrepancies.filter((d) => d.severity === 'error').length;
    const warns = o.discrepancies.filter((d) => d.severity === 'warn').length;
    console.log(`Расхождений: ${errors} ошибок, ${warns} предупреждений; дыр покрытия ${o.bridge.coverage.holes.length}`);

    if (curvePath) {
      writeFileSync(resolve(curvePath), store.curveCsv(), { flag: 'wx' });
      console.log(`Кривая записана: ${resolve(curvePath)}`);
    }
    return r.snapshots.conflicts.length > 0 ? 1 : 0;
  } catch (e) {
    if (e instanceof StrategySourceError || e instanceof QsnapFormatError) {
      console.error(`Ошибка: ${e.message}`);
      return 1;
    }
    throw e;
  } finally {
    sqlite.close();
  }
}

process.exitCode = main();
