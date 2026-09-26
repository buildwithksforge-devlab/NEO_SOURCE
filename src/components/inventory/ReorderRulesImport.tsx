/**
 * Bulk loader for real reorder points and par levels.
 *
 * Stores keep their figures in a spreadsheet; typing them back row by row is
 * slow and error prone. This accepts a pasted or uploaded list of
 * `item, reorder point, par level`, matches each line against the catalogue by
 * SKU or name, shows exactly what will change and what could not be matched,
 * and only then writes. Nothing is guessed: an unmatched line is reported, not
 * invented, and a line whose figures are unchanged is skipped.
 */
import { useMemo, useRef, useState } from "react";
import { Download, Upload } from "lucide-react";
import { SectionCard, TableScroll } from "@/components/common/DataDisplay";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useSaveStockThresholdsBulk } from "@/lib/inventory-data";

export type ReorderTarget = {
  id: string;
  name: string;
  sku: string;
  unit: string;
  reorder: number;
  par: number;
};

type Matched = {
  target: ReorderTarget;
  reorderPoint: number;
  parLevel: number;
  changed: boolean;
};

type Parsed = {
  matched: Matched[];
  unmatched: Array<{ line: number; text: string; reason: string }>;
};

const norm = (value: string) => value.trim().toLowerCase().replace(/\s+/g, " ");

function splitLine(line: string): string[] {
  const raw = line.includes("\t") ? line.split("\t") : line.split(/[;,]/);
  return raw.map((cell) => cell.trim().replace(/^"|"$/g, ""));
}

export function parseReorderRules(text: string, targets: ReorderTarget[]): Parsed {
  const bySku = new Map<string, ReorderTarget>();
  const byName = new Map<string, ReorderTarget>();
  for (const target of targets) {
    if (target.sku) bySku.set(norm(target.sku), target);
    byName.set(norm(target.name), target);
  }

  const matched: Matched[] = [];
  const unmatched: Parsed["unmatched"] = [];
  const seen = new Set<string>();

  text.split(/\r?\n/).forEach((line, index) => {
    if (!line.trim()) return;
    const cells = splitLine(line);
    if (cells.length < 2) {
      unmatched.push({ line: index + 1, text: line.trim(), reason: "Needs item, reorder point and par level" });
      return;
    }
    const key = cells[0] ?? "";
    const reorderPoint = Number(cells[1]);
    const parLevel = cells.length > 2 ? Number(cells[2]) : Number(cells[1]);
    if (!Number.isFinite(reorderPoint) || !Number.isFinite(parLevel)) {
      // Almost always the header row, which is fine to ignore silently.
      if (index === 0) return;
      unmatched.push({ line: index + 1, text: line.trim(), reason: "Reorder point or par level is not a number" });
      return;
    }
    if (reorderPoint < 0 || parLevel < 0) {
      unmatched.push({ line: index + 1, text: line.trim(), reason: "Levels cannot be negative" });
      return;
    }
    if (parLevel > 0 && parLevel < reorderPoint) {
      unmatched.push({ line: index + 1, text: line.trim(), reason: "Par level is below the reorder point" });
      return;
    }
    const target = bySku.get(norm(key)) ?? byName.get(norm(key));
    if (!target) {
      unmatched.push({ line: index + 1, text: line.trim(), reason: "No stock item with this name or SKU" });
      return;
    }
    if (seen.has(target.id)) {
      unmatched.push({ line: index + 1, text: line.trim(), reason: "This item already appears above" });
      return;
    }
    seen.add(target.id);
    matched.push({
      target,
      reorderPoint,
      parLevel,
      changed: reorderPoint !== target.reorder || parLevel !== target.par,
    });
  });

  return { matched, unmatched };
}

export function ReorderRulesImport({
  targets,
  canEdit,
  scopeLabel,
}: {
  targets: ReorderTarget[];
  canEdit: boolean;
  scopeLabel: string;
}) {
  const [text, setText] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const save = useSaveStockThresholdsBulk();

  const parsed = useMemo(() => parseReorderRules(text, targets), [text, targets]);
  const changing = parsed.matched.filter((m) => m.changed);

  /**
   * Hands Stores the current figures in the exact shape the loader accepts, so
   * the real numbers can be written in beside what the catalogue holds today
   * and pasted straight back. Blank means nothing has been set for that item.
   */
  const downloadWorksheet = () => {
    const escape = (value: string) => (/[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);
    const lines = [
      "Item,Reorder point,Par level,Unit,Current reorder point,Current par level",
      ...[...targets]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((t) =>
          [
            escape(t.sku || t.name),
            t.reorder > 0 ? String(t.reorder) : "",
            t.par > 0 ? String(t.par) : "",
            escape(t.unit ?? ""),
            t.reorder > 0 ? String(t.reorder) : "",
            t.par > 0 ? String(t.par) : "",
          ].join(","),
        ),
    ];
    const url = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `reorder-rules-worksheet-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };


  return (
    <SectionCard
      title="Load your real reorder rules"
      description={`Paste or upload one line per item: item name or SKU, reorder point, par level. Figures are saved for ${scopeLabel}, and nothing is written until you review the match below.`}
    >
      <div className="space-y-4">
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={6}
          spellCheck={false}
          placeholder={"Beef fillet, 20, 60\nFB-RICE-001, 50, 150"}
          aria-label="Reorder rules to load"
          disabled={!canEdit}
        />

        <div className="flex flex-wrap items-center gap-3">
          <input
            ref={fileRef}
            type="file"
            accept=".csv,.tsv,.txt,text/csv,text/plain"
            className="sr-only"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              setText(await file.text());
              e.target.value = "";
            }}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!canEdit}
            onClick={() => fileRef.current?.click()}
          >
            <Upload className="mr-2 size-4" aria-hidden />
            Upload a file
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={downloadWorksheet}>
            <Download className="mr-2 size-4" aria-hidden />
            Download worksheet
          </Button>

          <p className="text-xs text-muted-foreground">
            {parsed.matched.length} matched · {changing.length} to change · {parsed.unmatched.length} not matched
          </p>
          <Button
            type="button"
            size="sm"
            className="ml-auto"
            disabled={!canEdit || changing.length === 0 || save.isPending}
            onClick={() =>
              save.mutate(
                changing.map((m) => ({
                  id: m.target.id,
                  reorderPoint: m.reorderPoint,
                  parLevel: m.parLevel,
                })),
                { onSuccess: () => setText("") },
              )
            }
          >
            {save.isPending ? "Loading…" : `Load ${changing.length} rules`}
          </Button>
        </div>

        {changing.length > 0 ? (
          <TableScroll>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Stock item</TableHead>
                  <TableHead className="text-right">Reorder point</TableHead>
                  <TableHead className="text-right">Par level</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {changing.map((m) => (
                  <TableRow key={m.target.id}>
                    <TableCell className="font-medium">
                      {m.target.name}
                      <span className="ml-1 text-xs text-muted-foreground">{m.target.unit}</span>
                    </TableCell>
                    <TableCell className="text-right text-sm">
                      <span className="text-muted-foreground line-through">{m.target.reorder}</span>{" "}
                      {m.reorderPoint}
                    </TableCell>
                    <TableCell className="text-right text-sm">
                      <span className="text-muted-foreground line-through">{m.target.par}</span> {m.parLevel}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableScroll>
        ) : null}

        {parsed.unmatched.length > 0 ? (
          <div className="rounded-lg border border-border bg-muted/30 p-3">
            <p className="mb-2 text-sm font-medium">Not loaded</p>
            <ul className="space-y-1 text-xs text-muted-foreground">
              {parsed.unmatched.slice(0, 25).map((row) => (
                <li key={row.line}>
                  Line {row.line}: {row.text} — {row.reason}
                </li>
              ))}
              {parsed.unmatched.length > 25 ? <li>…and {parsed.unmatched.length - 25} more.</li> : null}
            </ul>
          </div>
        ) : null}
      </div>
    </SectionCard>
  );
}
