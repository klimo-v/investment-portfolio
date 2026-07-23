import { Controller, Get, Post } from '@nestjs/common';
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
}
