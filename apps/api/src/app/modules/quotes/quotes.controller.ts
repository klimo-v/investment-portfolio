import { Controller, Get, Post, Query } from '@nestjs/common';
import type { BenchmarkPoint } from '@core';
import type { QuoteRow } from '../../../db/schema';
import { QuotesService } from './quotes.service';

@Controller('quotes')
export class QuotesController {
  constructor(private readonly service: QuotesService) {}

  /** Текущие кэшированные котировки */
  @Get()
  list(): QuoteRow[] {
    return this.service.list();
  }

  /** Обновить цены по всем инструментам (кнопка «Обновить цены» на фронте) */
  @Post('refresh')
  refresh(): Promise<{ updated: number; total: number }> {
    return this.service.refreshAll();
  }

  /**
   * История индекса-бенчмарка (по умолчанию IMOEX) за период — для линии
   * «Портфель vs рынок» на дашборде. Даты в формате YYYY-MM-DD.
   */
  @Get('benchmark')
  benchmark(
    @Query('from') from: string,
    @Query('till') till: string,
    @Query('secid') secid?: string,
  ): Promise<BenchmarkPoint[]> {
    return this.service.benchmark(from, till, secid);
  }
}
