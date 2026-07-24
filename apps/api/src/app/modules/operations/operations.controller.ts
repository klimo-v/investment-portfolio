import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import type { Operation, Position, DashboardSummary, Trade } from '@core';
import { OperationsService } from './operations.service';

/**
 * Контроллер операций (GRASP: Controller — точка входа сценария).
 * REST-контракт для Angular-фронта (httpResource).
 */
@Controller('operations')
export class OperationsController {
  constructor(private readonly service: OperationsService) {}

  @Get()
  list(): Operation[] {
    return this.service.list();
  }

  @Post()
  add(@Body() body: unknown): Operation {
    return this.service.add(body);
  }

  @Delete(':id')
  delete(@Param('id') id: string): { deleted: true } {
    this.service.delete(id);
    return { deleted: true };
  }

  @Patch(':id')
  reassign(@Param('id') id: string, @Body() body: unknown): { updated: true } {
    this.service.reassign(id, body);
    return { updated: true };
  }

  @Get('positions')
  positions(): Promise<Position[]> {
    return this.service.positions();
  }

  /** Глобальный фильтр дашборда (docs/05-review-usability.md §2): система/портфель/период */
  @Get('summary')
  summary(
    @Query('systemId') systemId?: string,
    @Query('portfolioId') portfolioId?: string,
    @Query('from') from?: string,
    @Query('till') till?: string,
  ): Promise<DashboardSummary> {
    return this.service.summary({ systemId, portfolioId, from, till });
  }

  @Get('trades')
  trades(): Promise<Trade[]> {
    return this.service.trades();
  }
}
