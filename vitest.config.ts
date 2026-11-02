import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['packages/*', 'apps/*'],
    passWithNoTests: true,
    // Building the city's physics in a test's setup takes seconds, longer with every test file
    // running at once: room enough that it doesn't fail at random.
    hookTimeout: 60_000,
    testTimeout: 30_000,
  },
});
