import { describe, it, expect } from 'vitest';
import { filterOperations, type OperationFilter, type OperationRow } from './operations.page';

/**
 * Отбор строк журнала: тут решается, что пользователь увидит после ввода в поиск и
 * выбора системы/портфеля/типа. Ошибка здесь не падает — она молча прячет операции,
 * и человек считает, что их нет.
 */
function row(overrides: Partial<OperationRow> = {}): OperationRow {
  const base = {
    id: 'op-1',
    date: '2026-07-01',
    systemId: 'sys-1',
    portfolioId: 'pf-1',
    operationType: 'Buy',
    instrumentId: 'SBER',
    quantity: '10',
    price: '250.5',
    fee: '0',
    currency: 'RUB',
    fxRate: '1',
    systemName: 'Дивидендная',
    portfolioName: 'ИИС',
    ...overrides,
  } as OperationRow;
  return {
    ...base,
    haystack: [
      base.date,
      base.systemName,
      base.portfolioName,
      base.operationType,
      base.instrumentId ?? '',
    ]
      .join(' ')
      .toLowerCase(),
  };
}

const NO_FILTER: OperationFilter = {
  systemId: null,
  portfolioId: null,
  type: null,
  query: '',
};

describe('filterOperations', () => {
  const rows = [
    row({ id: '1', instrumentId: 'SBER', systemId: 'sys-1', portfolioId: 'pf-1' }),
    row({
      id: '2',
      instrumentId: 'GAZP',
      systemId: 'sys-2',
      portfolioId: 'pf-2',
      systemName: 'Спекулятивная',
      portfolioName: 'Брокерский',
      operationType: 'Sell',
    }),
    row({ id: '3', instrumentId: null, operationType: 'Deposit', systemId: 'sys-1' }),
  ];

  it('без фильтров отдаёт журнал как есть', () => {
    expect(filterOperations(rows, NO_FILTER)).toHaveLength(3);
  });

  it('сужает по системе и по портфелю', () => {
    expect(filterOperations(rows, { ...NO_FILTER, systemId: 'sys-2' }).map((r) => r.id)).toEqual([
      '2',
    ]);
    expect(filterOperations(rows, { ...NO_FILTER, portfolioId: 'pf-1' }).map((r) => r.id)).toEqual([
      '1',
      '3',
    ]);
  });

  it('сужает по типу операции', () => {
    expect(filterOperations(rows, { ...NO_FILTER, type: 'Deposit' }).map((r) => r.id)).toEqual([
      '3',
    ]);
  });

  it('ищет по тикеру без учёта регистра', () => {
    expect(filterOperations(rows, { ...NO_FILTER, query: 'sber' }).map((r) => r.id)).toEqual(['1']);
    expect(filterOperations(rows, { ...NO_FILTER, query: 'GaZp' }).map((r) => r.id)).toEqual(['2']);
  });

  it('ищет по НАЗВАНИЮ системы и портфеля, а не по их id', () => {
    // В таблице видны имена, и искать пользователь будет именно их
    expect(filterOperations(rows, { ...NO_FILTER, query: 'спекул' }).map((r) => r.id)).toEqual([
      '2',
    ]);
    expect(filterOperations(rows, { ...NO_FILTER, query: 'иис' }).map((r) => r.id)).toEqual([
      '1',
      '3',
    ]);
  });

  it('пробелы вокруг запроса не считаются частью поиска', () => {
    expect(filterOperations(rows, { ...NO_FILTER, query: '   ' })).toHaveLength(3);
    expect(filterOperations(rows, { ...NO_FILTER, query: '  sber ' }).map((r) => r.id)).toEqual([
      '1',
    ]);
  });

  it('условия складываются, а не заменяют друг друга', () => {
    expect(
      filterOperations(rows, { ...NO_FILTER, systemId: 'sys-1', query: 'sber' }).map((r) => r.id),
    ).toEqual(['1']);
    // Система из одной строки + тикер из другой не дают ничего — это И, а не ИЛИ
    expect(
      filterOperations(rows, { ...NO_FILTER, systemId: 'sys-2', query: 'sber' }),
    ).toHaveLength(0);
  });

  it('операция без тикера не теряется при пустом поиске', () => {
    // instrumentId: null у пополнений — раньше склейка haystack могла дать 'null'
    const deposits = filterOperations(rows, { ...NO_FILTER, type: 'Deposit' });
    expect(deposits[0].haystack).not.toContain('null');
  });
});
