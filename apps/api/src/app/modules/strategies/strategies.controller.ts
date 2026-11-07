import { Body, Controller, Delete, Get, Header, Param, Post, Put, Query } from '@nestjs/common';
import type { StrategySummary, Yv1Overview } from '@core';
import type { StrategyRefreshReport, StrategySettings } from './strategy-adapter';
import { StrategiesService } from './strategies.service';

/**
 * Стратегии: список и операции над одной стратегией по `systemId`. Файлы источника
 * только читаются; БД получает записи при `POST /strategies/:systemId/refresh`.
 */
@Controller('strategies')
export class StrategiesController {
  constructor(private readonly service: StrategiesService) {}

  /** Настроенные стратегии (для бокового меню) */
  @Get()
  list(): StrategySummary[] {
    return this.service.list();
  }

  /**
   * Завести стратегию: `{ name | systemId, portfolioId, params: { journalPrefix } }`.
   * Создаёт систему (если дан `name`) и конфиг одной транзакцией.
   */
  @Post()
  create(@Body() body: unknown): StrategySummary {
    return this.service.create(body);
  }

  /**
   * Удалить стратегию вместе с её журналом, настройками и лентой результата. Система и снимки
   * моста остаются. Если данные есть, нужен `?force=true`, иначе 409 с перечнем потерь.
   */
  @Delete(':systemId')
  remove(
    @Param('systemId') systemId: string,
    @Query('force') force?: string,
  ): { deleted: true; trades: number; resultDays: number } {
    return this.service.remove(systemId, force === 'true');
  }

  /** Всё для страницы стратегии: циклы, издержки, расхождения, статус источника, кривая */
  @Get(':systemId/overview')
  overview(@Param('systemId') systemId: string): Yv1Overview {
    return this.service.overview(systemId);
  }

  /** Прочитать источник в БД (идемпотентно); для моста QUIK — та же операция, что `pnpm yv1:refresh` */
  @Post(':systemId/refresh')
  refresh(@Param('systemId') systemId: string): StrategyRefreshReport {
    return this.service.refresh(systemId);
  }

  @Get(':systemId/settings')
  settings(@Param('systemId') systemId: string): StrategySettings {
    return this.service.settings(systemId);
  }

  @Put(':systemId/settings')
  updateSettings(@Param('systemId') systemId: string, @Body() body: unknown): StrategySettings {
    return this.service.updateSettings(systemId, body);
  }

  /** Привязать счёт стратегии к портфелю: `{ "portfolioId": "..." }` */
  @Put(':systemId/portfolio')
  linkPortfolio(@Param('systemId') systemId: string, @Body() body: { portfolioId?: unknown }): StrategySummary {
    return this.service.linkPortfolio(systemId, body?.portfolioId);
  }

  /** Фактическая кривая `date,ret,equity` (net) в формате контракта */
  @Get(':systemId/curve.csv')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Content-Disposition', 'attachment; filename="strategy_live_curve.csv"')
  curve(@Param('systemId') systemId: string): string {
    return this.service.curveCsv(systemId);
  }
}
