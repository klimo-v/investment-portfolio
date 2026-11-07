import { describe, it, expect } from 'vitest';
import type { RawRow } from './import';
import {
  InstrumentIdentityIndex,
  findPossibleDuplicates,
  identityKey,
  normalizeCode,
  normalizeRawRow,
  normalizeRawRows,
  planInstrumentIdentities,
  suggestInstruments,
  type IdentityEntry,
  type IdentityInstrument,
} from './instrument-identity';

const row = (p: Partial<RawRow> = {}): RawRow => ({ date: '2026-01-01', tradeType: 'Buy', ...p });

const inst = (id: string, over: Partial<IdentityInstrument> = {}): IdentityInstrument => ({
  id,
  ticker: id,
  type: 'Stock',
  currency: 'RUB',
  name: null,
  isin: null,
  ...over,
});
const entry = (scheme: IdentityEntry['scheme'], value: string, instrumentId: string): IdentityEntry => ({
  scheme,
  value,
  instrumentId,
  origin: 'import',
});

describe('нормализация кодов', () => {
  it('TMON@ → TMON, регистр и пробелы', () => {
    expect(normalizeCode('TMON@')).toBe('TMON');
    expect(normalizeCode(' tmon@@ ')).toBe('TMON');
    expect(normalizeCode('')).toBeUndefined();
    expect(normalizeCode('@')).toBeUndefined();
  });

  it('идемпотентна', () => {
    const once = normalizeRawRow(row({ ticker: 'tmon@', identifiers: { figi: ' bbg1 ', isin: 'ru0009029540' } }));
    expect(normalizeRawRow(once)).toEqual(once);
    expect(once.ticker).toBe('TMON');
    expect(once.identifiers).toEqual({ figi: 'BBG1', isin: 'RU0009029540' });
  });

  it('валидный ISIN в поле ticker переезжает в identifiers.isin', () => {
    const r = normalizeRawRow(row({ ticker: 'RU0009029540' }));
    expect(r.ticker).toBeUndefined();
    expect(r.identifiers?.isin).toBe('RU0009029540');
    expect(identityKey(r)).toBe('RU0009029540');
  });

  it('TCS00A10B4K3 — не ISIN: остаётся тикером; невалидный isin → brokerCode', () => {
    expect(normalizeRawRow(row({ ticker: 'TCS00A10B4K3' })).ticker).toBe('TCS00A10B4K3');
    const r = normalizeRawRow(row({ ticker: 'X', identifiers: { isin: 'TCS00A10B4K3' } }));
    expect(r.identifiers).toEqual({ brokerCode: 'TCS00A10B4K3' });
  });

  it('normalizeRawRows не меняет остальные поля и не портит строки без кодов', () => {
    const [a] = normalizeRawRows([row({ quantity: '5' })]);
    expect(a).toEqual(row({ quantity: '5' }));
  });
});

describe('planInstrumentIdentities', () => {
  const sber = inst('SBER', { name: 'Сбербанк', isin: 'RU0009029540' });
  const index = () =>
    InstrumentIdentityIndex.from(
      [sber, inst('TMON', { type: 'ETF', name: 'паи БПИФ рфи Т-КапиталДенРынок' })],
      [
        entry('ticker', 'SBER', 'SBER'),
        entry('isin', 'RU0009029540', 'SBER'),
        entry('name', 'сбербанк', 'SBER'),
        entry('ticker', 'TMON', 'TMON'),
      ],
    );

  it('TMON@ из API находится как TMON (нормализация + тикер), дубля нет', () => {
    const rows = normalizeRawRows([row({ ticker: 'TMON@', name: 'Денежный рынок', instrumentType: 'ETF' })]);
    const plan = planInstrumentIdentities(rows, index());
    expect(plan.rows[0]).toMatchObject({ instrumentId: 'TMON', via: 'ticker', isNew: false });
    expect(plan.created).toEqual([]);
    // новое название выучено на существующий инструмент
    expect(plan.links).toContainEqual(entry('name', 'денежный рынок', 'TMON'));
  });

  it('приоритет схем: figi/uid сильнее тикера', () => {
    const idx = index();
    idx.add(entry('figi', 'BBG004730N88', 'SBER'));
    const rows = normalizeRawRows([row({ ticker: 'SBER', identifiers: { figi: 'BBG004730N88' } })]);
    expect(planInstrumentIdentities(rows, idx).rows[0].via).toBe('figi');
  });

  it('новый идентификатор строки дописывается к найденному инструменту', () => {
    const rows = normalizeRawRows([row({ ticker: 'SBER', identifiers: { figi: 'BBG004730N88', tbankUid: 'UID-1' } })]);
    const plan = planInstrumentIdentities(rows, index());
    expect(plan.links.map((l) => `${l.scheme}:${l.value}`)).toEqual(['tbank_uid:uid-1', 'figi:BBG004730N88']);
  });

  it('ISIN-строка резолвится в инструмент по ISIN (внебиржевая выплата)', () => {
    const rows = normalizeRawRows([row({ ticker: 'RU0009029540', tradeType: 'Dividend' })]);
    expect(planInstrumentIdentities(rows, index()).rows[0]).toMatchObject({ instrumentId: 'SBER', via: 'isin' });
  });

  it('конфликт: тикер → A, ISIN → B — строка с ошибкой, ничего не склеивается', () => {
    const rows = normalizeRawRows([row({ ticker: 'TMON', identifiers: { isin: 'RU0009029540' } })]);
    const plan = planInstrumentIdentities(rows, index());
    expect(plan.rows[0].conflict).toMatch(/разные инструменты/);
    expect(plan.rows[0].instrumentId).toBeNull();
    expect(plan.links).toEqual([]);
    expect(plan.created).toEqual([]);
  });

  it('название связывает только при совместимых типе и валюте', () => {
    const ok = normalizeRawRows([row({ ticker: 'SBERP', name: 'Сбербанк', instrumentType: 'Stock', currency: 'RUB' })]);
    expect(planInstrumentIdentities(ok, index()).rows[0]).toMatchObject({ instrumentId: 'SBER', via: 'name' });
    const bad = normalizeRawRows([row({ ticker: 'SBERP', name: 'Сбербанк', instrumentType: 'Bond' })]);
    expect(planInstrumentIdentities(bad, index()).rows[0]).toMatchObject({ instrumentId: 'SBERP', isNew: true });
    const badCcy = normalizeRawRows([row({ ticker: 'SBERP', name: 'Сбербанк', currency: 'USD' })]);
    expect(planInstrumentIdentities(badCcy, index()).rows[0].isNew).toBe(true);
  });

  it('порядок строк не важен: ISIN-строка раньше тикерной резолвится через название (случай LKOH)', () => {
    const rows = normalizeRawRows([
      row({ identifiers: { isin: 'RU0009024277' }, name: 'ЛУКОЙЛ', tradeType: 'Dividend' }),
      row({ ticker: 'SBER', name: 'Сбербанк' }),
    ]);
    const idx = InstrumentIdentityIndex.from([inst('LKOH')], [entry('ticker', 'LKOH', 'LKOH')]);
    const plan = planInstrumentIdentities(
      [...rows, ...normalizeRawRows([row({ ticker: 'LKOH', name: 'ЛУКОЙЛ' })])],
      idx,
    );
    expect(plan.rows[0]).toMatchObject({ instrumentId: 'LKOH', via: 'name' });
    expect(plan.created.map((c) => c.id)).toEqual(['SBER']);
    expect(plan.links).toContainEqual(entry('isin', 'RU0009024277', 'LKOH'));
  });

  it('новый инструмент: id — нормализованный код, не TMON@; повтор в файле не плодит второй', () => {
    const rows = normalizeRawRows([row({ ticker: 'NEW@', name: 'Новый' }), row({ ticker: 'new', name: 'Новый' })]);
    const plan = planInstrumentIdentities(rows, new InstrumentIdentityIndex());
    expect(plan.created).toHaveLength(1);
    expect(plan.created[0]).toMatchObject({ id: 'NEW', ticker: 'NEW', type: 'Stock', currency: 'RUB' });
    expect(plan.rows[1]).toMatchObject({ instrumentId: 'NEW', isNew: false });
  });

  it('коллизия id — conflict, а не молчаливая привязка к чужому инструменту', () => {
    // инструмент с id «ABC» есть, но его кода «ABC» нет среди идентификаторов
    const idx = InstrumentIdentityIndex.from([inst('ABC', { ticker: 'OLD' })], [entry('ticker', 'OLD', 'ABC')]);
    const plan = planInstrumentIdentities(normalizeRawRows([row({ ticker: 'ABC' })]), idx);
    expect(plan.rows[0].conflict).toMatch(/уже занят/);
    expect(plan.created).toEqual([]);
  });

  it('TCS00A10B4K3 не склеивается с RU000A10B4K3 автоматически — создаётся новый + подсказка', () => {
    const bond = inst('RU000A10B4K3', { type: 'Bond', currency: 'USD', isin: 'RU000A10B4K3', name: 'НорНикБ1P8' });
    const idx = InstrumentIdentityIndex.from([bond], [entry('isin', 'RU000A10B4K3', 'RU000A10B4K3'), entry('ticker', 'RU000A10B4K3', 'RU000A10B4K3')]);
    const plan = planInstrumentIdentities(
      normalizeRawRows([row({ ticker: 'TCS00A10B4K3', instrumentType: 'Bond', name: 'ГМК Норникель БО-001Р-08' })]),
      idx,
    );
    expect(plan.rows[0]).toMatchObject({ instrumentId: 'TCS00A10B4K3', isNew: true });
    expect(plan.rows[0].suggestions[0]).toMatchObject({ instrumentId: 'RU000A10B4K3' });
    expect(plan.links).toEqual([]);
  });

  it('выбор пользователя «существующий» связывает с origin manual; «новый» — без подсказок', () => {
    const bond = inst('RU000A10B4K3', { type: 'Bond' });
    const idx = InstrumentIdentityIndex.from([bond], [entry('ticker', 'RU000A10B4K3', 'RU000A10B4K3')]);
    const rows = normalizeRawRows([row({ ticker: 'TCS00A10B4K3', instrumentType: 'Bond' })]);
    const linked = planInstrumentIdentities(rows, idx, { TCS00A10B4K3: { action: 'existing', instrumentId: 'RU000A10B4K3' } });
    expect(linked.rows[0]).toMatchObject({ instrumentId: 'RU000A10B4K3', via: 'choice' });
    expect(linked.links[0]).toMatchObject({ scheme: 'ticker', value: 'TCS00A10B4K3', origin: 'manual' });
    const fresh = planInstrumentIdentities(rows, idx, { TCS00A10B4K3: { action: 'new' } });
    expect(fresh.rows[0]).toMatchObject({ isNew: true, suggestions: [] });
  });

  it('строки без кодов инструмента (ввод/вывод) и skipReason не трогаются', () => {
    const plan = planInstrumentIdentities(
      [row({ tradeType: 'Deposit' }), row({ ticker: 'XYZ', skipReason: 'опцион' })],
      new InstrumentIdentityIndex(),
    );
    expect(plan.rows.map((r) => r.instrumentId)).toEqual([null, null]);
    expect(plan.created).toEqual([]);
  });

  it('план не меняет переданный индекс (preview — dry-run)', () => {
    const idx = index();
    planInstrumentIdentities(normalizeRawRows([row({ ticker: 'NEW' })]), idx);
    expect(idx.find('ticker', 'NEW')).toBeUndefined();
  });
});

describe('подсказки и возможные дубли', () => {
  it('suggestInstruments не предлагает инструменты другого типа', () => {
    const c = [inst('AAA', { type: 'ETF', name: 'Денежный рынок' })];
    expect(suggestInstruments({ codes: ['ZZZ'], name: 'Денежный рынок', type: 'Bond' }, c)).toEqual([]);
    expect(suggestInstruments({ codes: ['ZZZ'], name: 'Денежный рынок', type: 'ETF' }, c)).toHaveLength(1);
  });

  it('findPossibleDuplicates: TMON@/TMON детерминированно, TCS…/RU… — нет', () => {
    const list = [
      inst('TMON', { type: 'ETF' }),
      inst('TMON@', { type: 'ETF' }),
      inst('RU000A10B4K3', { type: 'Bond', currency: 'USD' }),
      inst('TCS00A10B4K3', { type: 'Bond' }),
      inst('SBER'),
    ];
    const dups = findPossibleDuplicates(list);
    expect(dups).toHaveLength(2);
    const tmon = dups.find((d) => d.a.id === 'TMON');
    expect(tmon?.deterministic).toBe(true);
    const bond = dups.find((d) => d.a.id === 'RU000A10B4K3');
    expect(bond?.deterministic).toBe(false);
  });
});

describe('донаучивание отображаемых полей', () => {
  it('пустые isin/name существующего инструмента заполняются, заполненные не трогаются', () => {
    const idx = InstrumentIdentityIndex.from(
      [inst('GAZP'), inst('SBER', { isin: 'RU0009029540', name: 'Сбербанк' })],
      [entry('ticker', 'GAZP', 'GAZP'), entry('ticker', 'SBER', 'SBER')],
    );
    const plan = planInstrumentIdentities(
      normalizeRawRows([
        row({ ticker: 'GAZP', name: 'ГАЗПРОМ ао', identifiers: { isin: 'RU0007661625' } }),
        row({ ticker: 'SBER', name: 'Другое имя', identifiers: { isin: 'RU000A10B4K3' } }),
      ]),
      idx,
    );
    expect(plan.patches).toEqual([{ instrumentId: 'GAZP', isin: 'RU0007661625', name: 'ГАЗПРОМ ао' }]);
  });
});
