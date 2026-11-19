import type { GrossTradeAmountSource } from './schemas';

export interface TbankHistoryRequest {
  accountId: string;
  portfolioId: string;
  from: string;
  to: string;
}

export interface TbankHistoryRow {
  status: 'update' | 'matched' | 'unmatched' | 'conflict' | 'unknown';
  date: string;
  executionRef?: string;
  ticker?: string;
  operationId?: string;
  amount?: string;
  source?: GrossTradeAmountSource;
  previousAmount?: string | null;
  previousSource?: GrossTradeAmountSource | null;
  reason?: string;
}

export interface TbankHistoryPreview {
  previewId: string;
  rows: TbankHistoryRow[];
  summary: Record<TbankHistoryRow['status'], number>;
  bindingIssue?: string;
}

export interface TbankHistoryResult {
  imported: 0;
  updated: number;
  preview: TbankHistoryPreview;
}
