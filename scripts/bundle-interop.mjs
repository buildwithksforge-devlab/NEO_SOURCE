const typescriptHelpers = [
  "__extends", "__assign", "__awaiter", "__generator", "__decorate", "__spreadArray", "__importDefault",
];

/** Finds CommonJS-to-ESM destructures that can throw while the bundle loads. */
export function findBrokenInteropDestructures(source) {
  const hits = [];
  const pattern = /(?:var|const|let)\s*\{([^}]{0,4000}?)\}\s*=\s*[^;{}]{0,80}?__toESM\(/g;
  for (const [, names] of source.matchAll(pattern)) {
    const helper = typescriptHelpers.find((name) => new RegExp(`\\b${name}\\b`).test(names));
    if (helper) hits.push(helper);
  }
  return hits;
}
