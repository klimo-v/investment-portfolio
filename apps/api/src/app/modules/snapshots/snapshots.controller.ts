import { Controller, Get, Post } from '@nestjs/common';
import type { PositionSeries, Snapshot } from '@core';
import { SnapshotsService } from './snapshots.service';

@Controller('snapshots')
export class SnapshotsController {
  constructor(private readonly service: SnapshotsService) {}

  /** История снимков стоимости портфеля — для линии динамики на дашборде */
  @Get()
  list(): Snapshot[] {
    return this.service.list();
  }

  /**
   * Ряд «стоимость инструментов во времени» — линия на инструмент + итог + чистый
   * ввод средств. Читается из snapshot_positions (см. rebuild ниже).
   */
  @Get('positions')
  positions(): PositionSeries {
    return this.service.positionsSeries();
  }

  /** Снять снимок на сегодня (вызывается фронтом сразу после «Обновить цены») */
  @Post('capture')
  capture(): Promise<Snapshot> {
    return this.service.capture();
  }
}
