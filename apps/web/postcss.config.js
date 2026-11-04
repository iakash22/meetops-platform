import autoprefixer from 'autoprefixer';
import tailwindcss from 'tailwindcss';
import pruneBootstrap from './scripts/postcss-prune-bootstrap.mjs';

export default {
  // pruneBootstrap drops Bootstrap rules the app never uses (keeps the CSS budget near its pre-Bootstrap size).
  plugins: [tailwindcss(), autoprefixer(), pruneBootstrap()],
};
