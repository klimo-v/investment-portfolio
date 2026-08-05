import { Module } from '@nestjs/common';
import { ImportController } from './import.controller';
import { ImportService } from './import.service';
import { TbankApiClient } from './tbank/tbank-api.client';
import { TbankConfig } from './tbank/tbank.config';
import { TbankSyncService } from './tbank/tbank-sync.service';

@Module({
  controllers: [ImportController],
  providers: [ImportService, TbankConfig, TbankApiClient, TbankSyncService],
})
export class ImportModule {}
