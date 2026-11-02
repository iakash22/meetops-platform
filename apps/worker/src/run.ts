/**
 * Thin CLI entry for `pnpm dev` / `node dist/run.js`.
 * Logs immediately before pulling the worker dependency graph.
 */
console.log('[worker] process starting…');

const { boot } = await import('./index.js');
await boot();
