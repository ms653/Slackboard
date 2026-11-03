import { defineConfig } from 'vitest/config';
import path from 'node:path';
export default defineConfig({
  resolve: { alias: { '@': path.resolve(__dirname) } },
  test: { include: ['test/e2e/**/*.test.ts'], testTimeout: 120000, hookTimeout: 60000, pool: 'forks', fileParallelism: false },
});
