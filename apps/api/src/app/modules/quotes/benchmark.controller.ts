import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { DEFAULT_BENCHMARK, isBenchmarkSecid, type BenchmarkResponse } from '@core';
import { BenchmarkService } from './benchmark.service';

@Controller('benchmark')
export class BenchmarkController {
  constructor(private readonly service: BenchmarkService) {}

  /** Ориентир и денежный рынок на базе 100: ?secid=MCFTRR&from=YYYY-MM-DD&till=YYYY-MM-DD */
  @Get()
  get(
    @Query('from') from: string,
    @Query('till') till: string,
    @Query('secid') secid: string = DEFAULT_BENCHMARK,
  ): Promise<BenchmarkResponse> {
    const date = /^\d{4}-\d{2}-\d{2}$/;
    if (!date.test(from ?? '') || !date.test(till ?? '') || from > till) {
      throw new BadRequestException('Нужны `from` и `till` в формате YYYY-MM-DD, from ≤ till');
    }
    if (!isBenchmarkSecid(secid) || secid === 'RUSFAR') {
      throw new BadRequestException('Неизвестный ориентир: допустимы MCFTRR, RGBITR, RUCBTRNS, IMOEX');
    }
    return this.service.benchmark(secid, from, till);
  }
}
