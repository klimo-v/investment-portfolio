import { Module } from '@nestjs/common';
import { BenchmarkController } from './benchmark.controller';
import { BenchmarkService } from './benchmark.service';
import { QuotesController } from './quotes.controller';
import { QuotesService } from './quotes.service';
import { MoexProvider } from './moex.provider';
import { CbrProvider } from './cbr.provider';
import { BinanceProvider } from './binance.provider';
import { MoexHistoryProvider } from './moex-history.provider';
import { CbrHistoryProvider } from './cbr-history.provider';
import { BinanceHistoryProvider } from './binance-history.provider';
import { PRICE_HISTORY_PROVIDERS } from './price-history.provider';
import { COUPON_SCHEDULE_PROVIDER, MoexCouponProvider } from './coupon-schedule.provider';
import { CouponScheduleService } from './coupon-schedule.service';
import { PriceHistoryService } from './price-history.service';

@Module({
  controllers: [QuotesController, BenchmarkController],
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
    BenchmarkService,
    MoexCouponProvider,
    { provide: COUPON_SCHEDULE_PROVIDER, useExisting: MoexCouponProvider },
    CouponScheduleService,
  ],
  exports: [QuotesService, PriceHistoryService, CouponScheduleService],
})
export class QuotesModule {}
