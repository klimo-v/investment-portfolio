import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { BenchmarkQuerySchema, type BenchmarkResponse } from '@core';
import { BenchmarkService } from './benchmark.service';

@Controller('benchmark')
export class BenchmarkController {
  constructor(private readonly service: BenchmarkService) {}

  /** Ориентир и денежный рынок на базе 100: ?secid=MCFTRR&from=YYYY-MM-DD&till=YYYY-MM-DD */
  @Get()
  get(@Query() rawQuery: unknown): Promise<BenchmarkResponse> {
    const query = BenchmarkQuerySchema.safeParse(rawQuery);
    if (!query.success) throw new BadRequestException(query.error.issues);
    return this.service.benchmark(query.data.secid, query.data.from, query.data.till);
  }
}
