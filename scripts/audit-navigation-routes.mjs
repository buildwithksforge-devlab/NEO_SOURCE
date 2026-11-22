#!/usr/bin/env node
/**
 * Source-only route inventory. A route existing in the generated tree does not
 * prove its access rules, actions, documents or downstream workflow work.
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const navigationSource = readFileSync(path.join(root, "src/lib/navigation.ts"), "utf8");
const generatedTree = readFileSync(path.join(root, "src/routeTree.gen.ts"), "utf8");
const sourceFile = ts.createSourceFile("navigation.ts", navigationSource, ts.ScriptTarget.Latest, true);
const normalise = (route) => route === "/" ? route : route.replace(/\/+$/, "");

function field(node, name) {
  if (!ts.isObjectLiteralExpression(node)) return undefined;
  return node.properties.find((property) =>
    ts.isPropertyAssignment(property) && property.name.getText(sourceFile) === name,
  )?.initializer;
}

function text(node) {
  return node && ts.isStringLiteralLike(node) ? node.text : undefined;
}

const declaration = sourceFile.statements
  .filter(ts.isVariableStatement)
  .flatMap((statement) => [...statement.declarationList.declarations])
  .find((variable) => variable.name.getText(sourceFile) === "navigation");
if (!declaration || !declaration.initializer || !ts.isArrayLiteralExpression(declaration.initializer)) {
  throw new Error("The sidebar navigation array cannot be inspected");
}

const sidebar = declaration.initializer.elements.flatMap((group) => {
  const section = text(field(group, "title"));
  const items = field(group, "items");
  if (!section || !items || !ts.isArrayLiteralExpression(items)) {
    throw new Error("A sidebar group has no static title or item list");
  }
  return items.elements.map((item) => {
    const label = text(field(item, "label"));
    const route = text(field(item, "to"));
    const rolesNode = field(item, "roles");
    if (!label || !route || !rolesNode) {
      throw new Error(`A sidebar item in ${section} has no static label, route or roles`);
    }
    const roles = ts.isArrayLiteralExpression(rolesNode)
      ? rolesNode.elements.map(text)
      : rolesNode.getText(sourceFile);
    return {
      section,
      label,
      route,
      roles,
      source: "src/lib/navigation.ts",
      status: "ROUTE_PRESENT_ONLY",
    };
  });
});

const generatedPaths = [...new Set(
  [...generatedTree.matchAll(/fullPath:\s*'([^']+)'/g)].map((match) => match[1]),
)];
if (!generatedPaths.length) throw new Error("The generated route tree has no paths");
const generatedByNormalised = new Set(generatedPaths.map(normalise));
const sidebarPaths = new Set(sidebar.map((item) => normalise(item.route)));
const missingSidebarRoutes = sidebar.filter((item) => !generatedByNormalised.has(normalise(item.route)));
const deepLinkOnly = generatedPaths
  .filter((route) => !sidebarPaths.has(normalise(route)))
  .map((route) => ({ route, status: "DISCOVERY_PENDING" }));

const report = {
  note: "Static route inventory only. Authorization, controls, business effects and live acceptance are unverified.",
  counts: {
    sidebarDestinations: sidebar.length,
    generatedRoutes: generatedPaths.length,
    directOrHiddenRoutes: deepLinkOnly.length,
    missingSidebarRoutes: missingSidebarRoutes.length,
  },
  missingSidebarRoutes,
  sidebar,
  directOrHidden: deepLinkOnly,
};

if (process.argv.includes("--write")) {
  writeFileSync(path.join(root, "docs/repair/SIDEBAR-ROUTE-BASELINE.json"),
    JSON.stringify(report, null, 2) + "\n");
}

if (process.argv.includes("--actions")) {
  const routesDirectory = path.join(root, "src/routes");
  const routePaths = new Map(
    [...generatedTree.matchAll(/'([^']+)': \{\s*id: '[^']+'\s*path: '[^']+'\s*fullPath: '([^']+)'/g)]
      .map(([, id, fullPath]) => [id, fullPath]),
  );
  const actionRoutes = readdirSync(routesDirectory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name))
    .flatMap((entry) => {
      const absolute = path.join(entry.parentPath, entry.name);
      const file = path.relative(root, absolute).split(path.sep).join("/");
      const source = ts.createSourceFile(file, readFileSync(absolute, "utf8"), ts.ScriptTarget.Latest, true);
      const controls = [];
      const commands = [];
      let routeId;
      function inspect(node) {
        const line = () => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
        if (ts.isCallExpression(node)) {
          const name = node.expression.getText(source);
          if (name === "createFileRoute") routeId = text(node.arguments[0]);
          if (/(^|\.)(guardedRpc|rpc|useMutation|useServerFn|mutate|mutateAsync)$/.test(name)) {
            const destination = node.arguments.find(ts.isStringLiteralLike)?.text;
            commands.push({ line: line(), command: name, ...(destination ? { destination } : {}) });
          }
        }
        if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
          const name = node.tagName.getText(source);
          const attributes = node.attributes.properties.filter(ts.isJsxAttribute);
          const action = attributes.find((attribute) => /^(onClick|onSubmit|onSelect|to|href|action)$/.test(attribute.name.getText(source)));
          if (action || /^(button|a|form|Link|[\w.]*Button)$/.test(name)) {
            const label = attributes.find((attribute) => /^(aria-label|label|title)$/.test(attribute.name.getText(source)));
            controls.push({
              line: line(),
              element: name,
              ...(label?.initializer ? { label: label.initializer.getText(source) } : {}),
              ...(action ? { action: action.getText(source) } : {}),
            });
          }
        }
        ts.forEachChild(node, inspect);
      }
      inspect(source);
      return routeId ? [{ route: routePaths.get(routeId) ?? routeId, file, controls, commands }] : [];
    });
  const output = path.join(root, ".output");
  mkdirSync(output, { recursive: true });
  writeFileSync(path.join(output, "route-action-inventory.json"), JSON.stringify({
    scope: "Static route-file scan. Follow controls into imported components and server handlers to verify expected effects.",
    routes: actionRoutes,
  }, null, 2) + "\n");
  console.log(JSON.stringify({
    routeFiles: actionRoutes.length,
    controls: actionRoutes.reduce((sum, route) => sum + route.controls.length, 0),
    commands: actionRoutes.reduce((sum, route) => sum + route.commands.length, 0),
  }));
}
console.log(JSON.stringify(report.counts));
if (missingSidebarRoutes.length) {
  console.error("Missing sidebar routes:", missingSidebarRoutes.map((item) => item.route).join(", "));
  process.exitCode = 1;
}
