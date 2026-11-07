import { Module } from '@nestjs/common';
import { InstrumentIdentityService } from './instrument-identity.service';

/** Идентичность инструментов: единая точка записи идентификаторов и слияния дублей */
@Module({
  providers: [InstrumentIdentityService],
  exports: [InstrumentIdentityService],
})
export class InstrumentsModule {}
