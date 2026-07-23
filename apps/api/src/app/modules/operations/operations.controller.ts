import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
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

  @Get('positions')
  positions(): Promise<Position[]> {
    return this.service.positions();
  }

  @Get('summary')
  summary(): Promise<DashboardSummary> {
    return this.service.summary();
  }

  @Get('trades')
  trades(): Promise<Trade[]> {
    return this.service.trades();
  }
}
