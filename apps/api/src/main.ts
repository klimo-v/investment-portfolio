import 'reflect-metadata';
import { runEntry, reportEntryError } from './profile/entry';

void runEntry().catch(reportEntryError);
