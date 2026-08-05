import { Injectable, ServiceUnavailableException } from '@nestjs/common';

/**
 * Токен T-Invest API (CLAUDE.md §8: секреты — только на бэке, никогда в бандле
 * фронта). Читается из переменной окружения по образцу `apps/api/src/db/db-path.ts`
 * — отдельный `@nestjs/config` ради одной переменной не вводим (YAGNI, CLAUDE.md §11).
 *
 * Токен обязан быть **только для чтения** (в приложении Т-Инвестиций выпускается
 * отдельным типом): им нельзя выставлять заявки. Со стороны приложения это
 * дополнительно закреплено списком доступных методов в `tbank-api.client.ts`.
 */
@Injectable()
export class TbankConfig {
  /** Настроен ли токен. Наружу (в API/фронт) отдаётся только этот флаг, не сам токен. */
  isConfigured(): boolean {
    return !!this.rawToken();
  }

  /** Токен для заголовка Authorization; 503 с понятным текстом, если не настроен */
  token(): string {
    const token = this.rawToken();
    if (!token) {
      throw new ServiceUnavailableException(
        'Токен T-Invest API не настроен: задайте TBANK_TOKEN в .env (см. .env.example) и перезапустите api',
      );
    }
    return token;
  }

  private rawToken(): string | null {
    return process.env['TBANK_TOKEN']?.trim() || null;
  }
}
