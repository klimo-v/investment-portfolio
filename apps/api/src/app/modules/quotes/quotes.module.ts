import { Module } from '@nestjs/common';
import { QuotesController } from './quotes.controller';
import { QuotesService } from './quotes.service';
import { MoexProvider } from './moex.provider';
import { CbrProvider } from './cbr.provider';
import { BinanceProvider } from './binance.provider';

@Module({
  controllers: [QuotesController],
  providers: [QuotesService, MoexProvider, CbrProvider, BinanceProvider],
  exports: [QuotesService],
})
export class QuotesModule {}
