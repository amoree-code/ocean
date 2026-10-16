// Package boundaries for the kernel (T-222). Each layer may import only layers
// below it, and nothing may form a cycle. Layers are matched by path so the rules
// hold while modules still live inside packages/harness and after they move into
// their own packages.
const H = "^packages/harness/src/";

const LAYERS = [
  ["core", ["^packages/core/src/", `${H}(paths|fs-utils)\\.ts$`]],
  ["market", ["^packages/market/src/", `${H}application/(skills|mcp)/`]],
  [
    "brain",
    [
      "^packages/brain/src/",
      `${H}application/(brain|memory|evidence|capture)/`,
      `${H}infrastructure/brain/`,
    ],
  ],
  ["context", ["^packages/context/src/", `${H}application/context/`]],
  [
    "loop",
    [
      "^packages/loop/src/",
      `${H}application/(tasks|handoff|runs|loops|sessions|operations|hooks)/`,
      `${H}infrastructure/persistence/`,
    ],
  ],
  [
    "services",
    [
      "^packages/services/src/",
      `${H}application/(browser|obsidian|doctor)/`,
      `${H}infrastructure/mcp/`,
    ],
  ],
  // harness is everything else in packages/harness — the top layer, unrestricted.
];

const upward = LAYERS.map(([name, paths], rank) => {
  const above = LAYERS.slice(rank + 1).flatMap(([, p]) => p);
  return {
    name: `${name}-imports-upward`,
    comment: `${name} may only import layers below it (core ← market ← brain ← context ← loop ← services ← harness)`,
    severity: "error",
    from: { path: paths },
    to: {
      path: above.length ? above : ["$^"],
      pathNot: paths,
    },
  };
});

const harnessOnly = LAYERS.flatMap(([, p]) => p).filter((p) => p.startsWith(H));

module.exports = {
  forbidden: [
    {
      name: "no-circular",
      severity: "error",
      from: {},
      to: { circular: true },
    },
    ...upward,
    {
      name: "nothing-imports-harness",
      comment:
        "the harness (CLI, composition, providers) is the top layer; no lower layer may reach it",
      severity: "error",
      from: { path: harnessOnly },
      to: { path: H, pathNot: harnessOnly },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    exclude: { path: "(^|/)(dist|node_modules)/" },
    tsPreCompilationDeps: true,
    combinedDependencies: true,
  },
};
