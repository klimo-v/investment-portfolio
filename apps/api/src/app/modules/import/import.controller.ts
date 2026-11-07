import { BadRequestException, Body, Controller, Get, Post } from '@nestjs/common';
import { z } from 'zod';
import { AnnotationImportService } from './annotation-import.service';
import { ImportService, type ImportFormat, type PreviewResult } from './import.service';
import { TbankConfig } from './tbank/tbank.config';
import { TbankSyncService } from './tbank/tbank-sync.service';

/**
 * Тело запроса импорта: содержимое файла как строка (`content`, для обратной
 * совместимости — `csv`) — обязательно только в первом запросе на файл, формат
 * и батч-разметка (портфель/система). `uploadId` — id уже распарсенного файла
 * из ответа предыдущего preview(): последующие правки батч-разметки/тикер-выбора
 * шлют его вместо content, не пересылая и не парся заново весь файл (важно для
 * больших xlsx-отчётов — Т-Банк, тысячи строк). `tickerSystemOverrides` — выбор
 * системы по тикеру только для этого импорта (docs/04-roadmap.md §3.1), между
 * импортами не сохраняется.
 */
interface ImportBody {
  content?: string;
  csv?: string;
  uploadId?: string;
  format?: ImportFormat;
  systemId?: string;
  portfolioId?: string;
  tickerSystemOverrides?: Record<string, string>;
}

/**
 * Запрос синхронизации с T-Invest API. Валидируется Zod прямо в контроллере —
 * глобального ValidationPipe в проекте нет, схемы Zod и есть единый способ
 * проверки входных данных (CLAUDE.md §8: данным клиента не доверяем).
 */
const TbankFetchSchema = z.object({
  accountId: z.string().min(1, 'Не выбран счёт'),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Дата начала: ожидается YYYY-MM-DD'),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Дата конца: ожидается YYYY-MM-DD'),
});

const AnnotationBodySchema = z.object({
  content: z.string().min(1, 'Файл пуст'),
  format: z.string().optional(),
});

@Controller('import')
export class ImportController {
  constructor(
    private readonly service: ImportService,
    private readonly tbankConfig: TbankConfig,
    private readonly tbankSync: TbankSyncService,
    private readonly annotations: AnnotationImportService,
  ) {}

  /** Предпросмотр: распознать строки без записи */
  @Post('preview')
  preview(@Body() body: ImportBody): Promise<PreviewResult> {
    return this.service.preview({
      content: body.content ?? body.csv,
      uploadId: body.uploadId,
      format: body.format,
      systemId: body.systemId,
      portfolioId: body.portfolioId,
      tickerSystemOverrides: body.tickerSystemOverrides,
    });
  }

  /** Импортировать распознанные строки */
  @Post('commit')
  commit(@Body() body: ImportBody): Promise<{ batchId: string; imported: number; updated: number }> {
    return this.service.commit({
      content: body.content ?? body.csv,
      uploadId: body.uploadId,
      format: body.format,
      systemId: body.systemId,
      portfolioId: body.portfolioId,
      tickerSystemOverrides: body.tickerSystemOverrides,
    });
  }

  /**
   * Аннотации исполнения (тег, сигнальная цена) из CSV терминала: предпросмотр без записи.
   * Привязываются к уже импортированным операциям по номеру сделки.
   */
  @Post('annotations/preview')
  annotationsPreview(@Body() body: unknown) {
    return this.annotations.preview(this.parseAnnotationBody(body));
  }

  /** Сохранить аннотации сопоставленных строк; несопоставленные вернуть с причинами */
  @Post('annotations/commit')
  annotationsCommit(@Body() body: unknown) {
    return this.annotations.commit(this.parseAnnotationBody(body));
  }

  private parseAnnotationBody(body: unknown) {
    const parsed = AnnotationBodySchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues.map((i) => i.message).join('; '));
    }
    return parsed.data;
  }

  /** Откатить загрузку по batchId */
  @Post('rollback')
  rollback(@Body() body: { batchId: string }): { deleted: number } {
    return this.service.rollback(body.batchId);
  }

  /**
   * Доступна ли синхронизация с T-Invest API. Отдаём только флаг — сам токен
   * наружу не выходит никогда (CLAUDE.md §8). `lastOperationDate` фронт берёт
   * как начало периода по умолчанию, чтобы не тянуть повторно то, что уже
   * импортировано из файла.
   */
  @Get('tbank/status')
  tbankStatus(): { configured: boolean; lastOperationDate: string | null } {
    return {
      configured: this.tbankConfig.isConfigured(),
      lastOperationDate: this.service.lastOperationDate(),
    };
  }

  /** Счета клиента у брокера — для выбора, какой синхронизировать */
  @Get('tbank/accounts')
  tbankAccounts() {
    return this.tbankSync.accounts();
  }

  /**
   * Тянет историю операций за период и кладёт её в кэш загрузок. Ничего не
   * пишет в базу: дальше фронт вызывает обычные preview()/commit() с этим
   * `uploadId`, то есть API-источник проходит ровно тот же путь, что и файл.
   */
  @Post('tbank/fetch')
  async tbankFetch(@Body() body: unknown): Promise<{ uploadId: string; rows: number }> {
    const parsed = TbankFetchSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException(parsed.error.issues.map((i) => i.message).join('; '));
    }
    const { accountId, from, to } = parsed.data;
    if (from > to) throw new BadRequestException('Начало периода позже его конца');

    const rows = await this.tbankSync.fetchRawRows(accountId, from, to);
    return { uploadId: this.service.stashRawRows(rows), rows: rows.length };
  }
}
