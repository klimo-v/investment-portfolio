import '../load-env';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { sqlite } from './client';
import { resolveDbPath } from './db-path';
import { runMigrations } from './run-migrations';
import { collectInvariants, planDuplicateMerge, runDuplicateMerge } from './instrument-duplicates';

/**
 * Миграция уже существующих дублей справочника (TMON@ → TMON и т. п.):
 *   pnpm db:fix-duplicates            — dry-run: печатает план и инварианты, ничего не меняет
 *   pnpm db:fix-duplicates --apply    — резервная копия файла БД, затем всё в одной транзакции
 *                                       с проверкой инвариантов (расхождение → откат)
 */
const apply = process.argv.includes('--apply');
runMigrations();
const db = drizzle(sqlite);
const plan = planDuplicateMerge(db);

console.log(`БД: ${resolveDbPath()}\n`);
console.log('Слияния (детерминированные, тикер совпал после нормализации):');
if (plan.merges.length === 0) console.log('  — нет');
for (const m of plan.merges) console.log(`  ${m.sourceId} → ${m.targetId}  (операций: ${m.operations}; ${m.reason})`);
console.log('Исправление тикера одиночных инструментов (id не меняется):');
if (plan.renames.length === 0) console.log('  — нет');
for (const r of plan.renames) console.log(`  ${r.from} → ${r.to}: ${r.hint}`);
console.log('Возможные дубли — автоматически не трогаем, слить вручную в справочнике:');
if (plan.manual.length === 0) console.log('  — нет');
for (const m of plan.manual) console.log(`  ${m.a} ↔ ${m.b}: ${m.reason}`);

console.log('\nИнварианты ДО:');
for (const p of collectInvariants(db).portfolios) {
  console.log(
    `  ${p.name}: операций ${p.operations}, позиций ${p.openPositions}, вложено ${p.investedRub}, реализовано ${p.realizedPnlRub}, доходы ${p.incomeRub}, кэш ${p.cashRub}`,
  );
}

if (!apply) {
  console.log('\nDry-run: ничего не изменено. Применить: pnpm db:fix-duplicates --apply');
  sqlite.close();
} else if (plan.merges.length === 0 && plan.renames.length === 0) {
  console.log('\nПрименять нечего.');
  sqlite.close();
} else {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = join(dirname(resolveDbPath()), `portfolio.backup-${stamp}.sqlite`);
  if (existsSync(backup)) throw new Error(`Файл уже существует: ${backup}`);
  sqlite.exec(`VACUUM INTO '${backup.replace(/'/g, "''")}'`);
  console.log(`\nРезервная копия: ${backup}`);

  const res = runDuplicateMerge(sqlite, plan);
  if (!res.applied) {
    console.error('\nРАСХОЖДЕНИЕ ИНВАРИАНТОВ — изменения откачены:');
    for (const p of res.problems) console.error(`  ${p}`);
    process.exitCode = 1;
  } else {
    console.log('\nПрименено. Инварианты ПОСЛЕ совпали с инвариантами ДО.');
  }
  sqlite.close();
}
