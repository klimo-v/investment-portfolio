import nx from '@nx/eslint-plugin';

export default [
  ...nx.configs['flat/base'],
  ...nx.configs['flat/typescript'],
  ...nx.configs['flat/javascript'],
  {
    ignores: ['**/dist', '**/vite.config.*.timestamp*', '**/vitest.config.*.timestamp*'],
  },
  {
    files: ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx'],
    rules: {
      // FSD + Nx module boundaries: слой может импортировать только нижележащие.
      '@nx/enforce-module-boundaries': [
        'error',
        {
          enforceBuildableLibDependency: true,
          allow: ['^.*/eslint(\\.base)?\\.config\\.[cm]?[jt]s$'],
          depConstraints: [
            // тип библиотеки
            { sourceTag: 'type:app', onlyDependOnLibsWithTags: ['type:feature', 'type:ui', 'type:util', 'type:core'] },
            { sourceTag: 'type:feature', onlyDependOnLibsWithTags: ['type:feature', 'type:ui', 'type:util', 'type:core'] },
            { sourceTag: 'type:ui', onlyDependOnLibsWithTags: ['type:ui', 'type:util', 'type:core'] },
            { sourceTag: 'type:core', onlyDependOnLibsWithTags: ['type:util', 'type:core'] },
            { sourceTag: 'type:util', onlyDependOnLibsWithTags: ['type:util'] },
            // scope: фронт не зависит от бэка и наоборот; shared доступен обоим
            { sourceTag: 'scope:web', onlyDependOnLibsWithTags: ['scope:web', 'scope:shared'] },
            { sourceTag: 'scope:api', onlyDependOnLibsWithTags: ['scope:api', 'scope:shared'] },
            { sourceTag: 'scope:shared', onlyDependOnLibsWithTags: ['scope:shared'] },
          ],
        },
      ],
    },
  },
  /*
   * FSD-слои ВНУТРИ apps/web. @nx/enforce-module-boundaries выше работает по тегам
   * ПРОЕКТОВ и границу между каталогами одного проекта не видит — а именно она
   * описана в CLAUDE.md §2: pages → widgets → features → entities → shared,
   * зависимости только вниз. Без этих правил слой оставался бы декларацией:
   * нарушение ловилось бы на ревью, а не линтером.
   */
  ...[
    { layer: 'shared', forbidden: ['entities', 'features', 'widgets', 'pages'] },
    { layer: 'entities', forbidden: ['features', 'widgets', 'pages'] },
    { layer: 'features', forbidden: ['widgets', 'pages'] },
    { layer: 'widgets', forbidden: ['pages'] },
  ].map(({ layer, forbidden }) => ({
    files: [`apps/web/src/app/${layer}/**/*.ts`],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: forbidden.map((upper) => ({
            group: [`**/${upper}/**`],
            message: `FSD: слой «${layer}» не может зависеть от «${upper}» — зависимости только вниз (CLAUDE.md §2). Поднимите общий код в нижележащий слой или передайте данные входом компонента.`,
          })),
        },
      ],
    },
  })),
];
