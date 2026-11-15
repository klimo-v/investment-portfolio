import { Injectable, computed } from '@angular/core';
import { httpResource } from '@angular/common/http';
import { toSignal } from '@angular/core/rxjs-interop';
import { interval } from 'rxjs';
import { calendarDate } from '@core';

/** Browser and server use the Mac's calendar, including clients in another timezone. */
@Injectable({ providedIn: 'root' })
export class PortfolioCalendar {
  readonly context = httpResource<{ today: string; timeZone: string }>(() => '/api/health');
  private readonly tick = toSignal(interval(30_000), { initialValue: 0 });
  readonly today = computed(() => {
    this.tick();
    return this.context.hasValue() ? calendarDate(new Date(), this.context.value().timeZone) : null;
  });
}
