import { Controller, Get, Post } from '@nestjs/common';
import type { Snapshot } from '@core';
import { SnapshotsService } from './snapshots.service';

@Controller('snapshots')
export class SnapshotsController {
  constructor(private readonly service: SnapshotsService) {}

  /** История снимков стоимости портфеля — для линии динамики на дашборде */
  @Get()
  list(): Snapshot[] {
    return this.service.list();
  }

  /** Снять снимок на сегодня (вызывается фронтом сразу после «Обновить цены») */
  @Post('capture')
  capture(): Promise<Snapshot> {
    return this.service.capture();
  }
}
