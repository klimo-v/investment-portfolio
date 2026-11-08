import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { PerformanceQuerySchema, type PerformanceDto } from '@core';
import { PerformanceService } from './performance.service';

@Controller('performance')
export class PerformanceController {
  constructor(private readonly service: PerformanceService) {}

  /** Доходность за период: ?scope=all|portfolio|system&id&portfolioId&from&till */
  @Get()
  get(@Query() rawQuery: unknown): Promise<PerformanceDto> {
    const query = PerformanceQuerySchema.safeParse(rawQuery);
    if (!query.success) throw new BadRequestException(query.error.issues);
    return this.service.performance(query.data);
  }
}
