import { defineConfig } from 'vite';

// Relative base so the build works on GitHub Pages (served from /<repo>/) or any sub-path.
export default defineConfig({
  base: './',
});
