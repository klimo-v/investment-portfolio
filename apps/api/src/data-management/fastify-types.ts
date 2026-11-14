import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { HttpServer } from '@nestjs/common';

// Используем типы установленного адаптера без новой runtime-зависимости.
type Adapter = ReturnType<NestFastifyApplication['getHttpAdapter']>;
export type FastifyInstance = ReturnType<Adapter['getInstance']>;
export type FastifyRequest = Adapter extends HttpServer<infer Request> ? Request : never;
