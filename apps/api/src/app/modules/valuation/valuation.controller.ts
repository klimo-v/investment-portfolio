import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { ValuationQuerySchema, type ValuationSeriesDto } from '@core';
import { ValuationService } from './valuation.service';

@Controller('valuation')
export class ValuationController {
  constructor(private readonly service: ValuationService) {}

  /** Дневной ряд оценки: ?groupBy=system|portfolio|instrument&systemId&portfolioId&from&till */
  @Get('series')
  series(@Query() rawQuery: unknown): Promise<ValuationSeriesDto> {
    const query = ValuationQuerySchema.safeParse(rawQuery);
    if (!query.success) throw new BadRequestException(query.error.issues);
    return this.service.series(query.data);
  }
}
