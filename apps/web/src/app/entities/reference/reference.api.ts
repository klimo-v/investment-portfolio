import { Injectable } from '@angular/core';
import { httpResource } from '@angular/common/http';
import { z } from 'zod';
import { InstrumentSchema } from '@core';

/**
 * API-клиент справочников (FSD: entities): системы, портфели, инструменты.
 * Нужны форме ввода операции для выпадающих списков/автокомплита.
 */

export const SystemSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  color: z.string().nullable(),
});
export type System = z.infer<typeof SystemSchema>;

export const PortfolioSchema = z.object({
  id: z.string(),
  name: z.string(),
  broker: z.string(),
  baseCurrency: z.string(),
});
export type Portfolio = z.infer<typeof PortfolioSchema>;

export type Instrument = z.infer<typeof InstrumentSchema>;

@Injectable({ providedIn: 'root' })
export class ReferenceApi {
  readonly systems = httpResource(() => '/api/systems', {
    parse: z.array(SystemSchema).parse,
  });

  readonly portfolios = httpResource(() => '/api/portfolios', {
    parse: z.array(PortfolioSchema).parse,
  });

  readonly instruments = httpResource(() => '/api/instruments', {
    parse: z.array(InstrumentSchema).parse,
  });
}
