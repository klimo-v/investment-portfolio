// Публичный API общей библиотеки core (движок + схемы).
// Импорт из приложений — только через '@core' (Nx path alias).
export * from './lib/schemas';
export * from './lib/engine';
export * from './lib/cash';
export * from './lib/metrics';
export * from './lib/import';
export * from './lib/parsers/broker-html-report';
export * from './lib/parsers/tbank-invest-api';
// Срез «ЮВ1»: мост QUIK (qsnap), журнал автомата, циклы ТС, проверки точности.
export * from './lib/yv1/yv1-types';
export * from './lib/yv1/qsnap';
export * from './lib/yv1/qsnap-extract';
export * from './lib/yv1/yv1-automat';
export * from './lib/yv1/yv1-fills';
export * from './lib/yv1/yv1-cycles';
export * from './lib/yv1/yv1-checks';
export * from './lib/yv1/yv1-report';
// Манифест стратегии: связка «торговая система → адаптер источника + параметры».
export * from './lib/strategy/strategy-manifest';
export * from './lib/strategy/strategy-results';
