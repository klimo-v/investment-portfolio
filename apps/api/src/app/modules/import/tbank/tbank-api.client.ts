import { BadGatewayException, Injectable, UnauthorizedException } from '@nestjs/common';
import type { TbankInstrumentRef, TbankOperationItem } from '@core';
import { TbankConfig } from './tbank.config';

/**
 * HTTP-клиент T-Invest API (Adapter, CLAUDE.md §7). Нативный `fetch` — как в
 * провайдерах котировок (`quotes/moex.provider.ts`); отдельный HTTP-клиент в
 * проект не вводим (CLAUDE.md §11).
 *
 * ГРАНИЦА «ТОЛЬКО ЧТЕНИЕ». Список вызываемых методов замкнут типом `ReadMethod`:
 * обратиться к `OrdersService`/`StopOrdersService` (выставление и отмена заявок)
 * через этот клиент нельзя — это ошибка компиляции, а не проверка в рантайме.
 * Расширять union методами, которые что-либо меняют у брокера, нельзя:
 * приложение ведёт учёт и не торгует. Вторая линия защиты — сам токен, который
 * выпускается «только для чтения» (см. .env.example).
 */

const BASE_URL = 'https://invest-public-api.tbank.ru/rest/';
const SERVICE = 'tinkoff.public.invest.api.contract.v1';

type ReadMethod =
  | `${typeof SERVICE}.UsersService/GetAccounts`
  | `${typeof SERVICE}.OperationsService/GetOperationsByCursor`
  | `${typeof SERVICE}.InstrumentsService/GetInstrumentBy`;

/** Счёт клиента у брокера */
export interface TbankAccount {
  id: string;
  name?: string;
  type?: string;
  status?: string;
  openedDate?: string;
  closedDate?: string;
}

export interface OperationsPageRequest {
  accountId: string;
  /** RFC3339 UTC */
  from: string;
  /** RFC3339 UTC */
  to: string;
  cursor?: string;
  limit?: number;
}

export interface OperationsPage {
  items: TbankOperationItem[];
  hasNext: boolean;
  nextCursor?: string;
}

/**
 * Коды ошибок проверки сертификата. Сертификат `*.tbank.ru` выпущен корневым
 * центром Минцифры («Russian Trusted Root CA»), которого нет во встроенном
 * списке корней Node (там список Mozilla). Браузер на той же машине сайт
 * открывает — он берёт корни из системного хранилища, а Node в него не смотрит.
 */
const TLS_TRUST_ERRORS = new Set([
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_UNTRUSTED',
]);

/**
 * Человекочитаемая причина сбоя транспорта. Нативный fetch на любую сетевую
 * проблему бросает `TypeError: fetch failed`, пряча настоящую ошибку в `cause`
 * — без её разворачивания «сертификату не доверяют» и «нет интернета»
 * выглядят в UI одинаково, и понять, что чинить, невозможно.
 */
function describeTransportError(error: unknown): string {
  const cause = error instanceof Error ? (error.cause as NodeJS.ErrnoException | undefined) : undefined;
  const code = cause?.code;

  if (code && TLS_TRUST_ERRORS.has(code)) {
    return (
      'сертификат T-Bank не проходит проверку. Он выпущен корневым центром Минцифры, ' +
      'которого нет в списке доверенных корней Node. Скачайте корневой сертификат и ' +
      'запустите бэкенд с NODE_EXTRA_CA_CERTS=<путь к сертификату> (см. README)'
    );
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'адрес API не разрешается (DNS)';
  if (code === 'ECONNREFUSED') return 'соединение отклонено';
  if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') return 'таймаут соединения';

  const detail = cause?.message ?? (error instanceof Error ? error.message : '');
  return detail || 'сеть недоступна';
}

/** Сколько раз повторяем запрос, упёршийся в лимит частоты (429) */
const MAX_RATE_LIMIT_RETRIES = 3;
/** Потолок ожидания между повторами, чтобы запрос пользователя не висел бесконечно */
const MAX_RETRY_DELAY_MS = 30_000;

@Injectable()
export class TbankApiClient {
  constructor(private readonly config: TbankConfig) {}

  /** Счета клиента (только открытые) */
  async getAccounts(): Promise<TbankAccount[]> {
    const res = await this.call<{ accounts?: TbankAccount[] }>(
      `${SERVICE}.UsersService/GetAccounts`,
      {},
    );
    return (res.accounts ?? []).filter((a) => a.status !== 'ACCOUNT_STATUS_CLOSED');
  }

  /** Одна страница истории операций по курсору */
  async getOperationsPage(req: OperationsPageRequest): Promise<OperationsPage> {
    const res = await this.call<{
      items?: TbankOperationItem[];
      hasNext?: boolean;
      nextCursor?: string;
    }>(`${SERVICE}.OperationsService/GetOperationsByCursor`, {
      accountId: req.accountId,
      from: req.from,
      to: req.to,
      cursor: req.cursor,
      limit: req.limit ?? 1000,
      // отменённые и незавершённые операции в журнал учёта не попадают
      state: 'OPERATION_STATE_EXECUTED',
      // овернайты — техническое движение бумаг брокером, не сделка пользователя
      withoutOvernights: true,
    });

    return {
      items: res.items ?? [],
      hasNext: res.hasNext ?? false,
      nextCursor: res.nextCursor,
    };
  }

  /** Справочные поля инструмента по его uid; null, если брокер его не отдал */
  async getInstrumentByUid(uid: string): Promise<TbankInstrumentRef | null> {
    const res = await this.call<{ instrument?: TbankInstrumentRef }>(
      `${SERVICE}.InstrumentsService/GetInstrumentBy`,
      { idType: 'INSTRUMENT_ID_TYPE_UID', id: uid },
    );
    return res.instrument ?? null;
  }

  /**
   * Единственная точка выхода наружу. `method` ограничен типом `ReadMethod` —
   * см. комментарий к границе «только чтение» в шапке файла.
   */
  private async call<T>(method: ReadMethod, body: unknown, attempt = 0): Promise<T> {
    // токен получаем ДО try: ненастроенный токен — это 503 «настройте .env»,
    // а не «сеть недоступна», и заворачивать его в ошибку транспорта нельзя
    const token = this.config.token();

    let response: Response;
    try {
      response = await fetch(`${BASE_URL}${method}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          // брокер просит помечать обращения именем приложения
          'x-app-name': 'investment-portfolio',
        },
        body: JSON.stringify(body),
      });
    } catch (cause) {
      throw new BadGatewayException(
        `Не удалось связаться с T-Invest API: ${describeTransportError(cause)}`,
      );
    }

    if (response.ok) return (await response.json()) as T;

    if (response.status === 401 || response.status === 403) {
      throw new UnauthorizedException(
        'T-Invest API отклонил токен: он недействителен, отозван или не даёт доступа к этому методу. Проверьте TBANK_TOKEN в .env',
      );
    }

    // 429 — упёрлись в лимит частоты запросов; брокер сообщает, через сколько секунд он сбросится
    if (response.status === 429 && attempt < MAX_RATE_LIMIT_RETRIES) {
      const reset = Number(response.headers.get('x-ratelimit-reset') ?? '1');
      const delayMs = Math.min(
        Number.isFinite(reset) && reset > 0 ? reset * 1000 : 1000,
        MAX_RETRY_DELAY_MS,
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return this.call<T>(method, body, attempt + 1);
    }

    throw new BadGatewayException(
      `T-Invest API вернул ошибку ${response.status}: ${await this.readErrorMessage(response)}`,
    );
  }

  /**
   * Текст ошибки из тела ответа. Токен в него попасть не может (он только в
   * заголовке запроса), но само тело ограничиваем по длине, чтобы в лог и в UI
   * не уехала простыня (CLAUDE.md §8 — в логах нет ничего лишнего).
   */
  private async readErrorMessage(response: Response): Promise<string> {
    try {
      const text = (await response.text()).slice(0, 500);
      const parsed: unknown = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && 'message' in parsed) {
        return String((parsed as { message: unknown }).message);
      }
      return text;
    } catch {
      return response.statusText || 'нет деталей';
    }
  }
}
