/**
 * Thin CLI entry for `pnpm dev` / `node dist/run.js`.
 * Logs immediately, then dynamically imports the heavy server graph so operators
 * see progress instead of a silent multi-minute tsx transpile.
 */
console.log('[api] process starting…');

const { start } = await import('./index.js');
await start();
