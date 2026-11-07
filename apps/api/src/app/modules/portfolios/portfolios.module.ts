import { Module } from '@nestjs/common';
import { OperationsModule } from '../operations/operations.module';
import { PortfoliosController } from './portfolios.controller';
import { PortfoliosService } from './portfolios.service';
import { SystemPerformanceService } from './system-performance.service';

@Module({
  imports: [OperationsModule],
  controllers: [PortfoliosController],
  providers: [PortfoliosService, SystemPerformanceService],
})
export class PortfoliosModule {}
