import { readdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, relative } from "node:path";

// Source inventory only: deliberately never imports app modules, credentials or
// business data. Visible roles/deployed build and rendered output need QA.
const root = process.cwd();
const surfaces = [];
async function scan(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await scan(path);
    else if (/\.tsx?$/.test(entry.name) && !path.includes("__tests__")) {
      const source = await readFile(path, "utf8");
      const controls = [
        ...source.matchAll(
          /<(DocumentPrintButton|SendToPrinterButton|FactExportButton|FactSection|DocumentPreview|ThermalReceipt|SalarySlipDialog|FolioStatementDialog)\b/g,
        ),
      ];
      if (!controls.length) continue;
      const file = relative(root, path).replaceAll("\\", "/");
      for (const match of controls) {
        const line = source.slice(0, match.index).split("\n").length;
        const rest = source.slice(match.index);
        const end = rest.indexOf("/>");
        // Bound the excerpt for components with children; preserve expressions
        // instead of guessing their runtime labels or transaction references.
        const excerpt = rest.slice(0, Math.min(end < 0 ? 700 : end + 2, 700));
        surfaces.push({
          key: `${file}:${line}`,
          file,
          line,
          component: match[1],
          sourceHash: createHash("sha256").update(source).digest("hex"),
          excerpt,
          acceptance: "OPEN: inspect deployed role-visible control and rendered output",
        });
      }
    }
  }
}
await scan(join(root, "src", "routes"));
await scan(join(root, "src", "components"));
surfaces.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
const output = {
  scope:
    "Local JSX document/print/export surfaces; not a live acceptance record or proof that every possible generator exists",
  regenerate: "node scripts/inventory-document-surfaces.mjs",
  components: Object.fromEntries(
    [...new Set(surfaces.map((row) => row.component))]
      .sort()
      .map((component) => [
        component,
        surfaces.filter((row) => row.component === component).length,
      ]),
  ),
  surfaces,
};
const target = join(root, "docs", "repair", "DOCUMENT-SURFACES-INVENTORY.json");
await writeFile(target, `${JSON.stringify(output, null, 2)}\n`);
console.log(`Recorded ${surfaces.length} document surfaces in ${relative(root, target)}.`);
