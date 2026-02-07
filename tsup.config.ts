import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['sources/main.ts'],
  format: ['esm'],
  target: 'node18',
  dts: false,  // Type checking handled by tsc --noEmit
  clean: true,
  treeshake: true,
  sourcemap: true,
  splitting: false,
  // Path alias resolution
  esbuildOptions(options) {
    options.alias = {
      '@/*': './sources/*',
    };
  },
});
