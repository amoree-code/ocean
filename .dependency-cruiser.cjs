// Package boundaries for the kernel (T-222). Each package may import only the
// packages below it, and nothing may form a cycle.
const LAYERS = [
  "core",
  "market",
  "brain",
  "context",
  "loop",
  "services",
  "harness", // the CLI, composition root and providers: the top layer
].map((name) => [name, [`^packages/${name}/src/`]]);

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

module.exports = {
  forbidden: [
    {
      name: "no-circular",
      severity: "error",
      from: {},
      to: { circular: true },
    },
    {
      name: "not-to-unresolvable",
      comment:
        "an import that does not resolve — e.g. a package reaching one it does not declare — would hide from the layer rules",
      severity: "error",
      from: {},
      to: { couldNotResolve: true },
    },
    {
      name: "application-not-to-infrastructure",
      comment:
        "application code reaches infrastructure through domain ports; only the composition root and the interfaces wire concretes (T-218)",
      severity: "error",
      from: {
        path: "^packages/[^/]+/src/",
        pathNot:
          "^packages/[^/]+/src/(infrastructure|composition|interfaces)/|^packages/harness/src/(main|engine-root)\\.ts$",
      },
      to: { path: "^packages/[^/]+/src/infrastructure/" },
    },
    ...upward,
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    exclude: { path: "(^|/)(dist|node_modules)/" },
    tsPreCompilationDeps: true,
    combinedDependencies: true,
    // Each @ocean/* package exports a "source" condition pointing at src/*.ts, so
    // imports between packages resolve to source and the layer rules see them.
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["source", "import", "node", "default"],
    },
  },
};
