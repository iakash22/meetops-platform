/* global module */
module.exports = function (api) {
  api.cache(true);
  // Inline Babel helpers instead of importing @babel/runtime: it is not a direct dependency of
  // this app, so pnpm's isolated layout leaves it unresolvable for Metro. Revisit if
  // @babel/runtime is added as a dependency (lockfile change, separate PR).
  return { presets: [['babel-preset-expo', { enableBabelRuntime: false }]] };
};
