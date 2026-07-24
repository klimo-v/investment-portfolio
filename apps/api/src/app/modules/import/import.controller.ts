import { Body, Controller, Post } from '@nestjs/common';
import { ImportService, type ImportFormat, type PreviewResult } from './import.service';

/**
 * Тело запроса импорта: содержимое файла как строка (`content`, для обратной
 * совместимости — `csv`), формат и батч-разметка (портфель/система).
 * `tickerSystemOverrides` — выбор системы по тикеру только для этого импорта
 * (docs/04-roadmap.md §3.1), между импортами не сохраняется.
 */
interface ImportBody {
  content?: string;
  csv?: string;
  format?: ImportFormat;
  systemId?: string;
  portfolioId?: string;
  tickerSystemOverrides?: Record<string, string>;
}

@Controller('import')
export class ImportController {
  constructor(private readonly service: ImportService) {}

  /** Предпросмотр: распознать строки без записи */
  @Post('preview')
  preview(@Body() body: ImportBody): Promise<PreviewResult> {
    return this.service.preview(body.content ?? body.csv ?? '', {
      format: body.format,
      systemId: body.systemId,
      portfolioId: body.portfolioId,
      tickerSystemOverrides: body.tickerSystemOverrides,
    });
  }

  /** Импортировать распознанные строки */
  @Post('commit')
  commit(@Body() body: ImportBody): Promise<{ batchId: string; imported: number }> {
    return this.service.commit(body.content ?? body.csv ?? '', {
      format: body.format,
      systemId: body.systemId,
      portfolioId: body.portfolioId,
      tickerSystemOverrides: body.tickerSystemOverrides,
    });
  }

  /** Откатить загрузку по batchId */
  @Post('rollback')
  rollback(@Body() body: { batchId: string }): { deleted: number } {
    return this.service.rollback(body.batchId);
  }
}
