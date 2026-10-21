import { defineConfig } from 'wxt';
import { manifest } from './src/manifest.js';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  outDir: 'dist',
  manifestVersion: 3,
  manifest,
});
