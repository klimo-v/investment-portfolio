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
];
