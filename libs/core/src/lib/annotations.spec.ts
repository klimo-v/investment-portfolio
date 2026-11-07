import { describe, expect, it } from 'vitest';
import Decimal from 'decimal.js';
import { calculateTrades } from './engine';
import { matchAnnotations, quikTradesParser, slippageRub, type MatchableOperation } from './annotations';
import { quikCodeToTicker } from './futures';
import { systemPerformance, type ExecutionFill } from './performance';
import { SystemPerformanceSchema } from './schemas';
import { CNY_FUTURE_ID, CNY_OPS } from './futures-report.fixture';

const HEADER =
  'date,time,contract,side,qty,price,reason,ref_price,slip_rub,slip_pct,broker_fee_quik,exchange_fee,clearing_fee,techcenter_fee,order_num,trade_num';
// сделка 1012 из эталона: Sell 64 @ 12 421, сигнал 12 422 → проскальзывание 64 ₽ (slip_rub файла — только для сверки)
const ROW_1012 = '2026-11-05,13:00:04,CRZ6,S,64,12.421,h1,12.422,64.00,0.0081,314.71,21.12,15.36,0.00,2022430710194950984,1012';
const csv = (...rows: string[]) => [HEADER, ...rows].join('\n');

describe('quikCodeToTicker', () => {
  it('код терминала → тикер отчёта брокера', () => {
    expect(quikCodeToTicker('CRZ6')).toBe('CNY-12.26');
    expect(quikCodeToTicker('CRH7')).toBe('CNY-03.27');
    expect(quikCodeToTicker(' crm6 ')).toBe('CNY-06.26');
  });
  it('неизвестная серия и мусор → null', () => {
    expect(quikCodeToTicker('SiZ6')).toBeNull();
    expect(quikCodeToTicker('CNY-12.26')).toBeNull();
    expect(quikCodeToTicker('')).toBeNull();
  });
});

describe('quikTradesParser', () => {
  it('разбирает строку: цены в ₽ за контракт строкой, тег, сторона, тикер', () => {
    const { rows, errors } = quikTradesParser.parse(csv(ROW_1012));
    expect(errors).toEqual([]);
    expect(rows).toEqual([
      {
        line: 1,
        brokerRef: '1012',
        date: '2026-11-05',
        time: '13:00:04',
        ticker: 'CNY-12.26',
        side: 'Sell',
        quantity: '64',
        price: '12421',
        tag: 'h1',
        signalPrice: '12422',
      },
    ]);
  });

  it('проскальзывание считается в ядре и совпадает с slip_rub файла (64 ₽)', () => {
    const [row] = quikTradesParser.parse(csv(ROW_1012)).rows;
    const slip = slippageRub(row.side, row.price, row.signalPrice as string, row.quantity);
    expect(slip.toString()).toBe('64');
    expect(slip.toNumber()).toBe(Number('64.00')); // slip_rub из файла — только сверка
  });

  it('знак проскальзывания: Buy дороже сигнала — потеря, Sell дороже сигнала — выигрыш', () => {
    expect(slippageRub('Buy', 12425, 12420, 2).toString()).toBe('10');
    expect(slippageRub('Buy', 12415, 12420, 2).toString()).toBe('-10');
    expect(slippageRub('Sell', 12425, 12420, 2).toString()).toBe('-10');
  });

  it('колонки комиссий терминала игнорируются: в результате их нет', () => {
    const [row] = quikTradesParser.parse(csv(ROW_1012)).rows;
    expect(JSON.stringify(row)).not.toContain('314.71');
    expect(Object.keys(row)).not.toContain('fee');
  });

  it('ошибочные строки возвращаются с причиной и номером строки, остальные разобраны', () => {
    const bad = [
      ROW_1012.replace('CRZ6', 'XXZ6'),
      ROW_1012.replace(',S,', ',Q,'),
      ROW_1012.replace('2026-11-05', '05.11.2026'),
      ROW_1012.replace(/,1012$/, ','),
      ROW_1012.replace(',64,12.421', ',abc,12.421'),
    ];
    const { rows, errors } = quikTradesParser.parse(csv(ROW_1012, ...bad));
    expect(rows).toHaveLength(1);
    expect(errors.map((e) => e.line)).toEqual([2, 3, 4, 5, 6]);
    expect(errors[0].reason).toContain('XXZ6');
    expect(errors[1].reason).toContain('сторона');
    expect(errors[2].reason).toContain('дату');
    expect(errors[3].reason).toContain('trade_num');
    expect(errors[4].reason).toContain('количество');
  });

  it('пустой ref_price допустим (тег есть, сигнала нет); BOM и пустые строки не мешают', () => {
    const { rows, errors } = quikTradesParser.parse('﻿' + csv(ROW_1012.replace('12.422', ''), '', ''));
    expect(errors).toEqual([]);
    expect(rows[0].signalPrice).toBeNull();
  });

  it('нет обязательных колонок → одна ошибка про колонки; пустой файл → пусто', () => {
    const r = quikTradesParser.parse('date,time\n2026-11-05,13:00:00');
    expect(r.rows).toEqual([]);
    expect(r.errors[0].reason).toContain('нет колонок');
    expect(quikTradesParser.parse('')).toEqual({ rows: [], errors: [] });
  });
});

describe('matchAnnotations', () => {
  const journal: MatchableOperation[] = CNY_OPS.map((operation) => ({ operation, ticker: CNY_FUTURE_ID }));
  const parse = (row: string) => quikTradesParser.parse(csv(row)).rows;

  it('точное сопоставление по номеру сделки', () => {
    const [m] = matchAnnotations(parse(ROW_1012), journal);
    expect(m).toMatchObject({ ok: true, operationId: 'op11' });
  });

  it('номера нет в журнале → причина, а не молчаливая потеря', () => {
    const [m] = matchAnnotations(parse(ROW_1012.replace(/,1012$/, ',9999')), journal);
    expect(m.ok).toBe(false);
    expect(!m.ok && m.reason).toContain('9999');
  });

  it('проверка согласованности: сторона, количество, цена, дата, инструмент', () => {
    const reason = (row: string, ops = journal) => {
      const [m] = matchAnnotations(parse(row), ops);
      return m.ok ? null : m.reason;
    };
    expect(reason(ROW_1012.replace(',S,', ',B,'))).toContain('Сторона');
    expect(reason(ROW_1012.replace(',64,12.421', ',63,12.421'))).toContain('Количество');
    expect(reason(ROW_1012.replace('12.421,h1', '12.420,h1'))).toContain('Цена');
    expect(reason(ROW_1012.replace('2026-11-05', '2026-11-06'))).toContain('Дата');
    const otherInstrument = journal.map((j) => ({ ...j, ticker: 'SBER' }));
    expect(reason(ROW_1012, otherInstrument)).toContain('другому инструменту');
  });
});

describe('systemPerformance: блок «Исполнение»', () => {
  const trades = calculateTrades(CNY_OPS, { futureIds: new Set([CNY_FUTURE_ID]) });
  const fill = (i: number, tag: string | null, signal: string | null): ExecutionFill => ({
    operationId: `op${i}`,
    tag,
    side: CNY_OPS[i].operationType as 'Buy' | 'Sell',
    quantity: new Decimal(CNY_OPS[i].quantity),
    price: new Decimal(CNY_OPS[i].price),
    signalPrice: signal ? new Decimal(signal) : null,
  });

  it('без аннотаций блока нет', () => {
    expect(systemPerformance(trades).execution).toBeNull();
    expect(systemPerformance(trades, { fills: [] }).execution).toBeNull();
  });

  it('проскальзывание: итог, среднее на контракт, разрез по тегам; пример h1 64 @ 12 421 при сигнале 12 422 = 64 ₽', () => {
    const p = systemPerformance(trades, {
      fills: [
        fill(0, 'h2', '12268'), // Buy 2 @ 12 270 при сигнале 12 268 → 4 ₽
        fill(3, 'h1', '12357'), // Sell 4 @ 12 357 при сигнале 12 357 → 0
        fill(11, 'h1', '12422'), // Sell 64 @ 12 421 при сигнале 12 422 → 64 ₽
        fill(12, 'h1', null), // сигнала нет — в среднее не входит
      ],
    });
    const e = p.execution!;
    expect(e.fills).toBe(4);
    expect(e.totalSlippageRub).toBe('68.00');
    expect(e.contractsWithSignal).toBe('70');
    expect(e.avgSlippagePerContractRub).toBe('0.97'); // 68 / 70
    expect(e.byTag).toEqual([
      { tag: 'h1', fills: 3, contracts: '68', slippageRub: '64.00' },
      { tag: 'h2', fills: 1, contracts: '2', slippageRub: '4.00' },
    ]);
  });

  it('статистика закрытых сделок по тегу входа', () => {
    const p = systemPerformance(trades, { fills: [fill(0, 'h2', '12268'), fill(3, 'h1', '12357')] });
    expect(p.execution!.byEntryTag).toEqual([
      { tag: 'h1', trades: 1, wins: 0, winRatePct: 0, netPnlRub: '-16037.16' },
      { tag: 'h2', trades: 1, wins: 1, winRatePct: 100, netPnlRub: '184.70' },
    ]);
  });

  it('аннотации чужих операций игнорируются; DTO проходит схему', () => {
    const foreign: ExecutionFill = { ...fill(0, 'h1', '12000'), operationId: 'не-из-этой-системы' };
    expect(systemPerformance(trades, { fills: [foreign] }).execution).toBeNull();
    const p = systemPerformance(trades, { fills: [fill(0, 'h2', '12268')] });
    expect(() => SystemPerformanceSchema.parse({ systemId: 's', systemName: 'S', ...p })).not.toThrow();
  });
});
