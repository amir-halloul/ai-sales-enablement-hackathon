import { configDefaults, defineConfig } from 'vitest/config';

// `vitest run --mode live` runs only the opt-in tests that call real providers.
export default defineConfig(({ mode }) => ({
  test: {
    include: mode === 'live' ? ['test/**/*.live.spec.ts'] : ['src/**/*.spec.ts', 'test/**/*.spec.ts'],
    exclude: mode === 'live' ? configDefaults.exclude : [...configDefaults.exclude, '**/*.live.spec.ts'],
    environment: 'node',
    coverage: {
      include: ['src/**/*.ts'],
      exclude: ['src/main.ts'],
      reporter: ['text', 'cobertura'],
    },
  },
}));
