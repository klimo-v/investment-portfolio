import 'reflect-metadata';
import './load-env';
import { startHttp } from './http-server';

void startHttp(() => undefined);
