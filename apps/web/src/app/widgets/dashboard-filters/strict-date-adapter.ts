import { Injectable } from '@angular/core';
import { NativeDateAdapter } from '@angular/material/core';
import { parseIsoDate } from '../../shared/iso-date';

@Injectable()
export class StrictDateAdapter extends NativeDateAdapter {
  override parse(value: unknown): Date | null {
    if (typeof value !== 'string' || !value.trim()) return null;
    const raw = value.trim();
    const match = /^(\d{1,2})[.](\d{1,2})[.](\d{4})$/.exec(raw);
    const iso = match
      ? `${match[3]}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}`
      : raw;
    return parseIsoDate(iso) ?? this.invalid();
  }
}
