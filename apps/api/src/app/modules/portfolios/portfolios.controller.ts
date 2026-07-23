import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
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

  @Post('portfolios')
  createPortfolio(@Body() body: unknown): PortfolioRow {
    return this.service.createPortfolio(body);
  }

  @Delete('portfolios/:id')
  deletePortfolio(@Param('id') id: string): { deleted: true } {
    this.service.deletePortfolio(id);
    return { deleted: true };
  }

  @Get('instruments')
  instruments(): InstrumentRow[] {
    return this.service.listInstruments();
  }
}
