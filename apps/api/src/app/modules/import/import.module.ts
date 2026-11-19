import { Module } from '@nestjs/common';
import { InstrumentsModule } from '../instruments/instruments.module';
import { AnnotationImportService } from './annotation-import.service';
import { ImportController } from './import.controller';
import { ImportService } from './import.service';
import { TbankApiClient } from './tbank/tbank-api.client';
import { TbankConfig } from './tbank/tbank.config';
import { TbankHistoryService } from './tbank/tbank-history.service';
import { TbankSyncService } from './tbank/tbank-sync.service';

@Module({
  imports: [InstrumentsModule],
  controllers: [ImportController],
  providers: [ImportService, AnnotationImportService, TbankConfig, TbankApiClient, TbankSyncService, TbankHistoryService],
})
export class ImportModule {}
