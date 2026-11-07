import { Module } from '@nestjs/common';
import { OperationsModule } from '../operations/operations.module';
import { QuotesModule } from '../quotes/quotes.module';
import { ValuationController } from './valuation.controller';
import { ValuationService } from './valuation.service';

@Module({
  imports: [OperationsModule, QuotesModule],
  controllers: [ValuationController],
  providers: [ValuationService],
  exports: [ValuationService],
})
export class ValuationModule {}
