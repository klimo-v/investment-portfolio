import { Body, Controller, Post } from '@nestjs/common';
import { ImportService, type PreviewResult } from './import.service';

/** Тело запроса: содержимое CSV как строка */
interface CsvBody {
  csv: string;
}

@Controller('import')
export class ImportController {
  constructor(private readonly service: ImportService) {}

  /** Предпросмотр: распознать строки без записи */
  @Post('preview')
  preview(@Body() body: CsvBody): PreviewResult {
    return this.service.preview(body.csv ?? '');
  }

  /** Импортировать распознанные строки */
  @Post('commit')
  commit(@Body() body: CsvBody): { batchId: string; imported: number } {
    return this.service.commit(body.csv ?? '');
  }

  /** Откатить загрузку по batchId */
  @Post('rollback')
  rollback(@Body() body: { batchId: string }): { deleted: number } {
    return this.service.rollback(body.batchId);
  }
}
