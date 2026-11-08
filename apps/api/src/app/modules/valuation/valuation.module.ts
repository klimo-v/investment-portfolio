import { Module } from '@nestjs/common';
import { OperationsModule } from '../operations/operations.module';
import { QuotesModule } from '../quotes/quotes.module';
import { ValuationController } from './valuation.controller';
import { PerformanceController } from './performance.controller';
import { PerformanceService } from './performance.service';
import { ValuationService } from './valuation.service';

@Module({
  imports: [OperationsModule, QuotesModule],
  controllers: [ValuationController, PerformanceController],
  providers: [ValuationService, PerformanceService],
  exports: [ValuationService],
})
export class ValuationModule {}
