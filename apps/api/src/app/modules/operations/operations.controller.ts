import { Body, Controller, Get, Post } from '@nestjs/common';
import type { Operation, Position } from '@core';
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

  @Get('positions')
  positions(): Position[] {
    return this.service.positions();
  }
}
