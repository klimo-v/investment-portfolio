import { Injectable, signal } from '@angular/core';

/**
 * Счётчик «данные на сервере изменились». Читается URL-функциями всех httpResource
 * приложения, увеличивается любой мутацией — так один POST/DELETE перезапрашивает
 * и журнал, и позиции, и сделки, и сводку.
 *
 * Зачем отдельный сервис: раньше все четыре ресурса жили в одном `OperationApi` и
 * делили приватный `reloadTrigger`. Из-за этого любая страница, инжектившая сервис
 * ради одного списка, поднимала все четыре запроса — «Портфель» тянул сделки,
 * «Сделки» тянули позиции. Ресурсы разъехались по своим сервисам (SRP), а общей
 * осталась ровно инвалидация — она тут и живёт.
 */
@Injectable({ providedIn: 'root' })
export class DataRevision {
  private readonly state = signal(0);

  /** Читать в URL-функции httpResource, чтобы ресурс перезапрашивался по bump() */
  readonly value = this.state.asReadonly();

  bump(): void {
    this.state.update((n) => n + 1);
  }
}
