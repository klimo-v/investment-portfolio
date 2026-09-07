import { Controller, Delete, Get, Post } from '@nestjs/common';
import type { PositionSeries, Snapshot, SnapshotStaleness } from '@core';
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
   * ввод средств. Читается из snapshot_positions, которые пишет capture().
   */
  @Get('positions')
  positions(): PositionSeries {
    return this.service.positionsSeries();
  }

  /**
   * Достоверность накопленной истории: с какой даты снимкам нельзя доверять и что
   * именно изменилось в журнале операций после того, как они были сняты.
   */
  @Get('staleness')
  staleness(): SnapshotStaleness {
    return this.service.staleness();
  }

  /** Снять снимок на сегодня (кнопка «Сделать снимок» на дашборде) */
  @Post('capture')
  capture(): Promise<Snapshot> {
    return this.service.capture();
  }

  /** «Понятно, скрыть» — пометить предупреждение просмотренным, историю оставить */
  @Post('acknowledge')
  acknowledge(): { acknowledged: number } {
    return this.service.acknowledge();
  }

  /** «Очистить историю снимков» — явное разрушительное действие пользователя */
  @Delete()
  clear(): { deleted: true } {
    return this.service.clearHistory();
  }
}
