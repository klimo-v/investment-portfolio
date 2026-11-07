import { Module } from '@nestjs/common';
import { InstrumentsModule } from '../instruments/instruments.module';
import { OperationsModule } from '../operations/operations.module';
import { ValuationModule } from '../valuation/valuation.module';
import { PortfoliosController } from './portfolios.controller';
import { PortfoliosService } from './portfolios.service';
import { SystemPerformanceService } from './system-performance.service';

@Module({
  imports: [InstrumentsModule, OperationsModule, ValuationModule],
  controllers: [PortfoliosController],
  providers: [PortfoliosService, SystemPerformanceService],
})
export class PortfoliosModule {}
