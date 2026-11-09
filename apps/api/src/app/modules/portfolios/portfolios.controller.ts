import { BadRequestException, Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';
import { SystemPerformanceQuerySchema, type InstrumentIdentifiersDto, type SystemPerformance } from '@core';
import type { SystemRow, PortfolioRow, InstrumentRow } from '../../../db/schema';
import type { PossibleDuplicateDto } from '../instruments/instrument-identity.service';
import { PortfoliosService } from './portfolios.service';
import { SystemPerformanceService } from './system-performance.service';

@Controller()
export class PortfoliosController {
  constructor(
    private readonly service: PortfoliosService,
    private readonly performanceService: SystemPerformanceService,
  ) {}

  @Get('systems')
  systems(): SystemRow[] {
    return this.service.listSystems();
  }

  @Post('systems')
  addSystem(@Body() body: unknown): SystemRow {
    return this.service.createSystem(body);
  }

  /** Статистика результатов системы. Фильтры — query: portfolioId, from, till */
  @Get('systems/:systemId/performance')
  systemPerformance(
    @Param('systemId') systemId: string,
    @Query() rawQuery: unknown,
  ): Promise<SystemPerformance> {
    const query = SystemPerformanceQuerySchema.safeParse(rawQuery);
    if (!query.success) throw new BadRequestException(query.error.issues);
    return this.performanceService.performance(systemId, query.data);
  }

  @Delete('systems/:id')
  removeSystem(@Param('id') id: string): { deleted: true } {
    this.service.deleteSystem(id);
    return { deleted: true };
  }

  @Get('portfolios')
  portfolios(): PortfolioRow[] {
    return this.service.listPortfolios();
  }

  @Post('portfolios')
  createPortfolio(@Body() body: unknown): PortfolioRow {
    return this.service.createPortfolio(body);
  }

  @Delete('portfolios/:id')
  deletePortfolio(@Param('id') id: string): { deleted: true } {
    this.service.deletePortfolio(id);
    return { deleted: true };
  }

  @Get('instruments')
  instruments(): InstrumentRow[] {
    return this.service.listInstruments();
  }

  /** Пары похожих инструментов, которые, возможно, дубли (подсказка, не решение) */
  @Get('instruments/possible-duplicates')
  possibleDuplicates(): PossibleDuplicateDto[] {
    return this.service.possibleDuplicates();
  }

  /** Инструменты со слитыми кодами или подозрительным набором кодов (только чтение) */
  @Get('instruments/merged-identifiers')
  mergedIdentifiers(): InstrumentIdentifiersDto[] {
    return this.service.mergedIdentifiers();
  }

  /** «Привязанные коды» инструмента: схема, значение, origin, дата добавления (только чтение) */
  @Get('instruments/:id/identifiers')
  instrumentIdentifiers(@Param('id') id: string): InstrumentIdentifiersDto {
    return this.service.instrumentIdentifiers(id);
  }

  @Post('instruments/:sourceId/merge-into/:targetId')
  mergeInstruments(
    @Param('sourceId') sourceId: string,
    @Param('targetId') targetId: string,
  ): { merged: true; movedOperations: number } {
    return this.service.mergeInstruments(sourceId, targetId);
  }
}
