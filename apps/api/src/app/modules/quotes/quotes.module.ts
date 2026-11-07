import { Module } from '@nestjs/common';
import { QuotesController } from './quotes.controller';
import { QuotesService } from './quotes.service';
import { MoexProvider } from './moex.provider';
import { CbrProvider } from './cbr.provider';
import { BinanceProvider } from './binance.provider';
import { MoexHistoryProvider } from './moex-history.provider';
import { CbrHistoryProvider } from './cbr-history.provider';
import { BinanceHistoryProvider } from './binance-history.provider';
import { PRICE_HISTORY_PROVIDERS } from './price-history.provider';
import { PriceHistoryService } from './price-history.service';

@Module({
  controllers: [QuotesController],
  providers: [
    QuotesService,
    MoexProvider,
    CbrProvider,
    BinanceProvider,
    MoexHistoryProvider,
    CbrHistoryProvider,
    BinanceHistoryProvider,
    {
      provide: PRICE_HISTORY_PROVIDERS,
      useFactory: (...providers: unknown[]) => providers,
      inject: [MoexHistoryProvider, CbrHistoryProvider, BinanceHistoryProvider],
    },
    PriceHistoryService,
  ],
  exports: [QuotesService, PriceHistoryService],
})
export class QuotesModule {}
