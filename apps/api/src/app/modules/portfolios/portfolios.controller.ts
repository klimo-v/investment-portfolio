import { Controller, Get } from '@nestjs/common';
import type { SystemRow, PortfolioRow, InstrumentRow } from '../../../db/schema';
import { PortfoliosService } from './portfolios.service';

@Controller()
export class PortfoliosController {
  constructor(private readonly service: PortfoliosService) {}

  @Get('systems')
  systems(): SystemRow[] {
    return this.service.listSystems();
  }

  @Get('portfolios')
  portfolios(): PortfolioRow[] {
    return this.service.listPortfolios();
  }

  @Get('instruments')
  instruments(): InstrumentRow[] {
    return this.service.listInstruments();
  }
}
