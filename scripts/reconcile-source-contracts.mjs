// Local source evidence only. Never loads environment files or contacts services.
import { readdirSync, readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, relative, join } from 'node:path';
import { createHash } from 'node:crypto';
import ts from 'typescript';

const root = process.cwd();
const norm = p => p.replaceAll('\\', '/');
const hash = text => createHash('sha256').update(text.replaceAll('\r\n', '\n')).digest('hex');
function files(dir, accept) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = join(dir, e.name);
    return e.isDirectory() ? (['node_modules', '.git', '__tests__'].includes(e.name) ? [] : files(p, accept)) : accept(p) ? [p] : [];
  });
}
const source = files(join(root, 'src'), p => /\.[cm]?tsx?$/.test(p));
const calls = [], routes = [], privileged = [], serverFunctions = [];
for (const path of source) {
  const text = readFileSync(path, 'utf8'), file = norm(relative(root, path));
  // Generated schema/types can be large and contain no executable calls.
  const inspectCalls = /\.rpc\s*\(|\bcreateServerFn\s*\(|requireCapability\s*\(|hasPermission\s*\(|requirePermission\s*\(/.test(text);
  const ast = ts.createSourceFile(file, inspectCalls ? text : '', ts.ScriptTarget.Latest, true);
  const rpc = [], permissions = [];
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.initializer && /\bcreateServerFn\s*\(/.test(node.initializer.getText(ast))) {
      const body = node.initializer.getText(ast);
      serverFunctions.push({ name: node.name.getText(ast), file, line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1,
        hasAuthMiddleware: /requireSupabaseAuth/.test(body), usesAdminClient: /supabaseAdmin/.test(body),
        hasCapabilityCall: /requireCapability|has_permission|requirePermission/.test(body),
        review: 'SOURCE_MARKERS_ONLY: absence is a review candidate, not proof of unauthorized access; helpers may enforce authority' });
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'rpc') {
      let arg = node.arguments[0];
      while (arg && (ts.isAsExpression(arg) || ts.isTypeAssertionExpression(arg) || ts.isParenthesizedExpression(arg) || ts.isSatisfiesExpression(arg))) arg = arg.expression;
      const literal = arg && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg));
      const entry = { file, line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1, name: literal ? arg.text : null, expression: literal ? null : arg?.getText(ast) ?? null };
      calls.push(entry); rpc.push(entry.name ?? '[dynamic]');
    }
    if (ts.isCallExpression(node) && /(?:requireCapability|hasPermission|has_permission|requirePermission)$/.test(node.expression.getText(ast)))
      permissions.push({ line: ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1, expression: node.getText(ast).slice(0, 350) });
    ts.forEachChild(node, visit);
  }
  visit(ast);
  if (file.startsWith('src/routes/')) routes.push({ file, hash: hash(text), rpc: [...new Set(rpc)], permissions, imports: [...text.matchAll(/from\s+["'](@\/[^"']+)["']/g)].map(m => m[1]), acceptance: 'SOURCE_ONLY' });
  if (/supabaseAdmin/.test(text)) privileged.push({ file, hash: hash(text), permissions, dependency: 'Requires usable server credential or reviewed managed route; source presence is not runtime readiness' });
}
const definitions = new Map();
for (const path of files(join(root, 'supabase/migrations'), p => p.endsWith('.sql')).sort()) {
  const text = readFileSync(path, 'utf8');
  for (const m of text.matchAll(/create\s+(?:or\s+replace\s+)?function\s+(?:"?public"?\s*\.\s*)?"?([a-zA-Z_][\w]*)"?\s*\(/gi)) {
    const name = m[1].toLowerCase();
    definitions.set(name, norm(relative(root, path)));
  }
}
const rpcNames = [...new Set(calls.map(c => c.name).filter(Boolean))].sort();
const missing = rpcNames.filter(n => !definitions.has(n)).map(name => ({ name, callers: calls.filter(c => c.name === name), status: 'NO_LOCAL_MIGRATION_DEFINITION: inspect live schema before declaring missing' }));
const candidates = [
  'C:/Users/Kelvin/Downloads/NEO_SOURCE',
  'C:/Users/Kelvin/Downloads/NEO_COMPLETE_SOURCE_2026-09-26',
  'C:/Users/Kelvin/Downloads/NEO_COMPLETE_SOURCE_2026-09-26/NEO_SOURCE',
  'C:/Users/Kelvin/Downloads/NEO_SOURCE_EXTRACT_ME_2026-09-25',
  'C:/Users/Kelvin/Downloads/NEO_SOURCE_EXTRACT_ME_2026-09-25/NEO_SOURCE',
  'C:/Users/Kelvin/Downloads/NEO',
  'C:/Users/Kelvin/Downloads',
];
const baselines = candidates.filter(p => resolve(p) !== resolve(root) && existsSync(join(p, 'src'))).map(base => {
  const other = files(join(base, 'src'), p => /\.[cm]?tsx?$/.test(p));
  const current = new Map(source.map(p => [norm(relative(join(root, 'src'), p)), hash(readFileSync(p, 'utf8'))]));
  const old = new Map(other.map(p => [norm(relative(join(base, 'src'), p)), hash(readFileSync(p, 'utf8'))]));
  return { path: base, authority: 'UNVERIFIED_BUNDLE: not assumed to be original or deployed', sourceFiles: old.size,
    same: [...old].filter(([p,h]) => current.get(p) === h).length,
    changed: [...old].filter(([p,h]) => current.has(p) && current.get(p) !== h).map(([p]) => p),
    onlyInBundle: [...old.keys()].filter(p => !current.has(p)),
    onlyInCurrent: [...current.keys()].filter(p => !old.has(p)) };
});
const report = { generatedAt: new Date().toISOString(), root, scope: 'Repeatable local contract inventory, not live function, role, UI or workflow acceptance. RPC definition matching is by name; overloads and dynamic calls require review.',
  summary: { sourceFiles: source.length, routeFiles: routes.length, literalRpcNames: rpcNames.length, dynamicRpcCalls: calls.filter(c => !c.name).length, namesWithoutLocalDefinition: missing.length, privilegedFiles: privileged.length, serverFunctions: serverFunctions.length },
  baselines, routes, serverFunctions, rpcCalls: calls, rpcWithoutLocalDefinition: missing, privileged };
mkdirSync(join(root, 'docs/repair'), { recursive: true });
writeFileSync(join(root, 'docs/repair/SOURCE-CONTRACT-RECONCILIATION.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ ...report.summary, baselines: baselines.map(({ path, sourceFiles, same, changed, onlyInBundle }) => ({ path, sourceFiles, same, changed: changed.length, onlyInBundle: onlyInBundle.length })) }));
