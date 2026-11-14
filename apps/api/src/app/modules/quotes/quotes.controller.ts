import type { QuoteRefreshResult } from '@core';
import { Body, Controller, Get, Param, Post } from '@nestjs/common';
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
  refresh(): Promise<QuoteRefreshResult> {
    return this.service.refreshAll();
  }

  /** Установить цену вручную для инструмента без автоматического источника */
  @Post(':instrumentId/manual')
  setManualPrice(@Param('instrumentId') instrumentId: string, @Body() body: unknown): QuoteRow {
    return this.service.setManualPrice(instrumentId, body);
  }

  /** Найти цену через провайдеры (MOEX/Binance) для инструмента без источника */
  @Post(':instrumentId/resolve')
  resolveViaApi(
    @Param('instrumentId') instrumentId: string,
  ): Promise<{ price: string; source: string }> {
    return this.service.resolveViaApi(instrumentId);
  }
}
