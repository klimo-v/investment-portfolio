import { randomUUID } from 'node:crypto';
import {
  CallHandler,
  ConflictException,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { defer, finalize } from 'rxjs';
import type { FastifyRequest } from './fastify-types';

/** Поколение защищает от отправки старой формы/импорта из соседней вкладки. */
export const dataGate = {
  generation: randomUUID(),
  active: 0,
  changed(): void {
    this.generation = randomUUID();
  },
  assertIdle(): void {
    if (this.active)
      throw new Error('Сейчас выполняется запрос или импорт. Дождитесь завершения и повторите.');
  },
};

@Injectable()
export class DataGateInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler) {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    if (
      !['GET', 'HEAD', 'OPTIONS'].includes(request.method) &&
      request.headers['x-portfolio-generation'] !== dataGate.generation
    ) {
      throw new ConflictException('Данные изменились. Обновите страницу перед записью.');
    }
    return defer(() => {
      dataGate.active++;
      return next.handle().pipe(
        finalize(() => {
          dataGate.active--;
        }),
      );
    });
  }
}
