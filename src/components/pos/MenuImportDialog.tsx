import { guardedRpc } from "@/lib/rpc-guard";
import { useMemo, useState } from "react";
import Papa from "papaparse";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { useActivePropertyFilter } from "@/lib/branch-filter";
import { useMenus, useStations } from "@/lib/pos-data";
import { useQueryClient } from "@tanstack/react-query";
import { logAudit } from "@/lib/audit";
import {
  diagnoseImportError,
  type ImportDiagnosis,
} from "@/lib/import-diagnostics";

/** The capability the database actually tests before a menu write is allowed. */
const IMPORT_CAPABILITY = "restaurant.menu.create";

type ImportFailure = ImportDiagnosis & { correlationId: string; stage: string };

/**
 * Structured menu import.
 *
 * Flow: upload -> column mapping (auto-suggested, admin correctable) -> row
 * validation -> draft import. Rows are never validated before the required
 * columns have been mapped, so an unmapped header can never be reported as
 * "missing item name".
 */

type CanonicalField =
  | "item_name"
  | "category"
  | "selling_price"
  | "currency"
  | "menu_or_outlet"
  | "availability_status"
  | "description"
  | "tax_rate"
  | "preparation_minutes"
  | "sku"
  | "station";

const FIELD_LABELS: Record<CanonicalField, string> = {
  item_name: "Item Name",
  category: "Category",
  selling_price: "Selling Price",
  currency: "Currency",
  menu_or_outlet: "Menu / Outlet",
  availability_status: "Availability Status",
  description: "Description",
  tax_rate: "Tax Rate",
  preparation_minutes: "Preparation Minutes",
  sku: "SKU / Item Code",
  station: "Production Station",
};

const CANONICAL_FIELDS = Object.keys(FIELD_LABELS) as CanonicalField[];

/** Required to reach a Draft import (may be satisfied by a batch default). */
const REQUIRED_FIELDS: CanonicalField[] = [
  "item_name",
  "category",
  "selling_price",
  "currency",
  "menu_or_outlet",
  "availability_status",
];
/** Must come from the file itself — no batch default is possible. */
const MUST_MAP_FIELDS: CanonicalField[] = ["item_name", "category", "selling_price"];
/** Can be applied to the whole batch during preview when absent from the file. */
const BATCH_DEFAULT_FIELDS: CanonicalField[] = ["currency", "menu_or_outlet", "availability_status"];

const HEADER_ALIASES: Record<string, CanonicalField> = {};
const registerAliases = (field: CanonicalField, aliases: string[]) => {
  for (const alias of aliases) HEADER_ALIASES[normaliseKey(alias)] = field;
};

/** Trim, strip BOM, lowercase, collapse spaces/hyphens/underscores/slashes. */
function normaliseKey(value: string) {
  return value
    .replace(/^\uFEFF/, "")
    .trim()
    .toLowerCase()
    .replace(/[\s\-_/]+/g, " ")
    .trim();
}

registerAliases("item_name", [
  "name",
  "item",
  "item_name",
  "item name",
  "menu_item",
  "menu item",
  "product",
  "product name",
  "dish",
]);
registerAliases("category", [
  "category",
  "category_name",
  "category name",
  "menu_category",
  "menu category",
  "group",
  "section",
]);
registerAliases("selling_price", [
  "price",
  "selling_price",
  "selling price",
  "menu_price",
  "menu price",
  "unit price",
  "amount",
]);
registerAliases("currency", ["currency", "currency_code", "currency code"]);
registerAliases("menu_or_outlet", [
  "menu",
  "menu_name",
  "menu name",
  "outlet",
  "outlet_name",
  "outlet name",
  "menu/outlet",
  "menu or outlet",
]);
registerAliases("availability_status", [
  "status",
  "available",
  "availability",
  "availability_status",
  "availability status",
]);
registerAliases("description", [
  "description",
  "item_description",
  "item description",
  "details",
]);
registerAliases("tax_rate", ["tax", "tax_rate", "tax rate", "tax_category", "vat"]);
registerAliases("sku", ["sku", "item_code", "item code", "code", "plu", "barcode"]);
registerAliases("station", [
  "station",
  "station_name",
  "station name",
  "production station",
  "kitchen station",
  "prep station",
]);
registerAliases("preparation_minutes", [
  "prep",
  "prep_minutes",
  "prep minutes",
  "preparation_minutes",
  "preparation minutes",
  "estimated_preparation_minutes",
  "estimated preparation minutes",
]);

const TEMPLATE_HEADERS = CANONICAL_FIELDS.join(",");
const TEMPLATE_EXAMPLE =
  '"Full American Breakfast","Signature Breakfasts",1500,KES,"Restaurant",Available,"Two eggs any style; beef sausage; bacon; grilled tomato. Served with tea or coffee.",16,20,"FB-BRK-014","Main Kitchen"';

type Matrix = { headers: string[]; rows: string[][] };

async function readMatrix(file: File): Promise<Matrix> {
  const lower = file.name.toLowerCase();
  if (lower.endsWith(".xlsx") || lower.endsWith(".xls")) {
    // Loaded on demand: only spreadsheet uploads need the parser.
    const XLSX = await import("xlsx");
    const buffer = await file.arrayBuffer();
    const wb = XLSX.read(buffer, { type: "array" });
    const sheetName = wb.SheetNames[0];
    if (!sheetName) return { headers: [], rows: [] };
    const sheet = wb.Sheets[sheetName];
    if (!sheet) return { headers: [], rows: [] };
    const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, blankrows: false });
    const [head = [], ...rest] = matrix;
    return {
      headers: head.map((h) => String(h ?? "")),
      rows: rest.map((r) => (r ?? []).map((c) => String(c ?? ""))),
    };
  }

  // Real CSV/TSV parsing: quoted fields, embedded commas, escaped quotes,
  // CRLF/LF, BOM, and auto delimiter detection are handled by the parser.
  const text = await file.text();
  const result = Papa.parse<string[]>(text, {
    header: false,
    skipEmptyLines: "greedy",
    delimitersToGuess: [",", ";", "\t", "|"],
  });
  const matrix = (result.data ?? []).filter((r) => Array.isArray(r));
  const [head = [], ...rest] = matrix;
  return {
    headers: head.map((h) => String(h ?? "").replace(/^\uFEFF/, "")),
    rows: rest.map((r) => r.map((c) => String(c ?? ""))),
  };
}

function parsePrice(raw: string): number | null {
  const cleaned = raw
    .replace(/[^\d.,\-]/g, "")
    .replace(/,(?=\d{3}\b)/g, "")
    .replace(/,/g, ".")
    .trim();
  if (!cleaned) return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

const AVAILABLE_WORDS = new Set([
  "available",
  "active",
  "true",
  "yes",
  "y",
  "1",
  "in stock",
  "on",
  "enabled",
]);
const SOLD_OUT_WORDS = new Set(["sold out", "soldout", "out of stock", "86"]);
const TEMP_WORDS = new Set(["temporarily unavailable", "temp unavailable", "paused", "unavailable"]);

function parseAvailability(raw: string): string | null {
  const key = normaliseKey(raw);
  if (!key) return null;
  if (AVAILABLE_WORDS.has(key)) return "available";
  if (SOLD_OUT_WORDS.has(key)) return "sold-out";
  if (TEMP_WORDS.has(key)) return "temporarily-unavailable";
  if (["false", "no", "n", "0", "disabled", "inactive"].includes(key)) return "disabled";
  return null;
}

type ValidatedRow = {
  line: number;
  itemName: string;
  category: string;
  price: number | null;
  priceSource: string;
  currency: string;
  menuOrOutlet: string;
  availability: string;
  description: string;
  taxRate: number | null;
  prepMinutes: number | null;
  sku: string;
  stationName: string;
  stationId: string | null;
  errors: { field: string; value: string; error: string; fix: string }[];
};

export function MenuImportDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { organizationId } = useAuth();
  const { branchId } = useActivePropertyFilter();
  const menus = useMenus();
  const stations = useStations();
  const stationOptions = useMemo(
    () => (stations.data ?? []).filter((s) => !branchId || !s.branch_id || s.branch_id === branchId),
    [stations.data, branchId],
  );
  const qc = useQueryClient();
  const [fileName, setFileName] = useState("");
  const [fileType, setFileType] = useState("");
  const [matrix, setMatrix] = useState<Matrix | null>(null);
  const [mapping, setMapping] = useState<Record<CanonicalField, number | null>>(
    () => emptyMapping(),
  );
  const [step, setStep] = useState<"upload" | "mapping" | "preview">("upload");
  const [defaults, setDefaults] = useState({
    currency: "KES",
    menu_or_outlet: "",
    availability_status: "Available",
  });
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ImportFailure | null>(null);
  const [menuId, setMenuId] = useState("");

  function emptyMapping(): Record<CanonicalField, number | null> {
    return CANONICAL_FIELDS.reduce(
      (acc, f) => ({ ...acc, [f]: null }),
      {} as Record<CanonicalField, number | null>,
    );
  }

  const reset = () => {
    setMatrix(null);
    setMapping(emptyMapping());
    setFileName("");
    setFileType("");
    setStep("upload");
    setBusy(false);
    setFailure(null);
    setMenuId("");
  };

  const handleFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      const parsed = await readMatrix(file);
      if (!parsed.headers.length || !parsed.rows.length) {
        toast.error("No data rows found. The first row must contain column headers.");
        return;
      }
      const suggested = emptyMapping();
      parsed.headers.forEach((header, index) => {
        const field = HEADER_ALIASES[normaliseKey(header)];
        if (field && suggested[field] === null) suggested[field] = index;
      });
      setFileName(file.name);
      setFileType(file.name.split(".").pop()?.toLowerCase() ?? "");
      setMatrix(parsed);
      setMapping(suggested);
      setStep("mapping");
    } catch {
      toast.error("That file could not be read. Use CSV, TXT or XLSX.");
    }
  };

  const unmappedRequired = MUST_MAP_FIELDS.filter((f) => mapping[f] === null);
  const missingDefaults = BATCH_DEFAULT_FIELDS.filter(
    (f) => mapping[f] === null && !defaults[f as keyof typeof defaults]?.trim(),
  );

  const validated: ValidatedRow[] = useMemo(() => {
    if (!matrix || step !== "preview") return [];
    const cell = (row: string[], field: CanonicalField) => {
      const idx = mapping[field];
      return idx === null ? "" : String(row[idx] ?? "").trim();
    };

    return matrix.rows.map((row, i) => {
      const errors: ValidatedRow["errors"] = [];
      const itemName = cell(row, "item_name");
      const category = cell(row, "category");
      const priceSource = cell(row, "selling_price");
      const price = parsePrice(priceSource);
      const currency = (cell(row, "currency") || defaults.currency).trim().toUpperCase();
      const menuOrOutlet = cell(row, "menu_or_outlet") || defaults.menu_or_outlet.trim();
      const availabilityRaw = cell(row, "availability_status") || defaults.availability_status;
      const availability = parseAvailability(availabilityRaw) ?? "available";
      const taxRaw = cell(row, "tax_rate");
      const prepRaw = cell(row, "preparation_minutes");
      const sku = cell(row, "sku");
      const stationName = cell(row, "station");
      // A station named in the file only counts when it maps to a canonical
      // station of the active property; unmatched names stay unresolved and
      // the row is imported awaiting mapping rather than inventing a station.
      const stationId = stationName
        ? (stationOptions.find((s) => normaliseKey(s.name) === normaliseKey(stationName))?.id ?? null)
        : null;

      if (!itemName)
        errors.push({
          field: FIELD_LABELS.item_name,
          value: priceSource ? "(blank)" : "(blank)",
          error: "Item name is empty in this row",
          fix: "Add the item name to this row in the source file",
        });
      if (!category)
        errors.push({
          field: FIELD_LABELS.category,
          value: "(blank)",
          error: "Category is empty in this row",
          fix: "Add a category to this row in the source file",
        });
      if (price === null)
        errors.push({
          field: FIELD_LABELS.selling_price,
          value: priceSource || "(blank)",
          error: "Selling price could not be read as a number",
          fix: "Use a value such as 1500, 1,500 or KSh 1,500",
        });
      else if (price < 0)
        errors.push({
          field: FIELD_LABELS.selling_price,
          value: priceSource,
          error: "Selling price is negative",
          fix: "Enter a price of zero or more",
        });

      const taxRate = taxRaw ? parsePrice(taxRaw) : null;
      const prepMinutes = prepRaw ? parsePrice(prepRaw) : null;

      return {
        line: i + 2,
        itemName,
        category,
        price,
        priceSource,
        currency,
        menuOrOutlet,
        availability,
        description: cell(row, "description"),
        taxRate,
        prepMinutes: prepMinutes === null ? null : Math.round(prepMinutes),
        sku,
        stationName,
        stationId,
        errors,
      };
    });
  }, [matrix, mapping, defaults, step, stationOptions]);

  const valid = validated.filter((r) => r.errors.length === 0);
  const rejected = validated.filter((r) => r.errors.length > 0);

  const downloadTemplate = () => {
    const csv = `${TEMPLATE_HEADERS}\n${TEMPLATE_EXAMPLE}\n`;
    const blob = new Blob([`\uFEFF${csv}`], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "neo-menu-import-template.csv";
    a.click();
    URL.revokeObjectURL(url);
  };

  const importDrafts = async () => {
    if (!organizationId || !branchId || !menuId || !valid.length) return;
    setBusy(true);
    setFailure(null);
    // One correlation ID follows the whole attempt: the client log line, every
    // database step and the audit record all carry it, so a refusal can be
    // traced end to end from the message the operator was shown.
    const correlationId = crypto.randomUUID();
    let stage = "batch";
    console.info("[menu-import] started", { correlationId, rows: valid.length, fileName });
    try {
      stage = "transaction";
      const rows = valid.map((r) => ({
        name: r.itemName,
        category: r.category,
        description: r.description || null,
        base_price: r.price ?? 0,
        currency: r.currency || "KES",
        availability: r.availability,
        tax_rate: r.taxRate,
        prep_minutes: r.prepMinutes,
        sku: r.sku || null,
        station_id: r.stationId,
      }));
      const checksumInput = JSON.stringify({ fileName, menuId, rows });
      const checksumBuffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(checksumInput));
      const checksum = Array.from(new Uint8Array(checksumBuffer)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
      const { data, error } = await guardedRpc(supabase, "pos_import_menu_drafts", {
        _menu: menuId,
        _branch: branchId,
        _file_name: fileName,
        _file_type: fileType,
        _checksum: checksum,
        _rows: rows,
        _idempotency_key: checksum,
        _correlation: correlationId,
      } as never);
      if (error) throw error;
      const result = data as Record<string, unknown>;
      const committed = Number(result["committed_rows"] ?? 0);
      if (!result["ok"] || !result["batch_id"] || committed < 1 || !result["workflow_event_id"] || !result["audit_event_id"]) {
        throw new Error("The backend did not confirm persisted menu items. No success was reported.");
      }
      const { count, error: verifyError } = await supabase.from("menu_items").select("id", { count: "exact", head: true }).eq("import_batch_id", String(result["batch_id"]));
      if (verifyError || count !== committed) throw verifyError ?? new Error("Committed item verification did not match the transaction result.");
      console.info("[menu-import] completed", { correlationId, batchId: result["batch_id"], committed });
      toast.success(`${committed} item${committed === 1 ? "" : "s"} imported as drafts${Number(result["mapping_rows"] ?? 0) ? ` · ${result["mapping_rows"]} awaiting station mapping` : ""}`);
      await qc.invalidateQueries({ queryKey: ["menu_items"] });
      await qc.invalidateQueries({ queryKey: ["menu_categories"] });
      reset();
      onOpenChange(false);
    } catch (e) {
      // Classify once: a capability refusal and a bad spreadsheet need
      // completely different next actions, and the operator gets told which.
      const diagnosis = diagnoseImportError(e, {
        subject: "menu",
        capability: IMPORT_CAPABILITY,
      });
      console.error("[menu-import] failed", { correlationId, stage, diagnosis });
      setFailure({ ...diagnosis, correlationId, stage });
      await logAudit({
        organizationId,
        action: "menu.import.denied",
        module: "restaurant",
        correlationId,
        permissionUsed: IMPORT_CAPABILITY,
        reason: `${diagnosis.category}: ${diagnosis.detail}`,
        newValue: { stage, code: diagnosis.code, category: diagnosis.category },
      }).catch(() => undefined);
      toast.error(`${diagnosis.title} · ${correlationId}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-4xl">
        <DialogHeader>
          <DialogTitle>Import menu file</DialogTitle>
          <DialogDescription>
            Upload a CSV, TXT or XLSX file, confirm how its columns map to NEØ fields, then review
            the rows. Imported items are created as drafts and are not sold until published.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {step === "upload" && (
            <div className="space-y-3">
              <input
                type="file"
                accept=".xlsx,.xls,.csv,.txt"
                className="block w-full text-sm file:mr-3 file:rounded-md file:border file:border-border file:bg-muted file:px-3 file:py-2 file:text-sm"
                onChange={(e) => void handleFile(e.target.files?.[0])}
              />
              <Button variant="outline" size="sm" onClick={downloadTemplate}>
                Download CSV template
              </Button>
            </div>
          )}

          {step === "mapping" && matrix && (
            <div className="space-y-4">
              <p className="text-sm text-muted-foreground">
                {fileName} · {matrix.rows.length} data row(s) · {matrix.headers.length} column(s)
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                {CANONICAL_FIELDS.map((field) => (
                  <div key={field} className="space-y-1">
                    <Label className="text-xs">
                      {FIELD_LABELS[field]}
                      {REQUIRED_FIELDS.includes(field) ? " *" : ""}
                    </Label>
                    <Select
                      value={mapping[field] === null ? "none" : String(mapping[field])}
                      onValueChange={(v) =>
                        setMapping((prev) => ({
                          ...prev,
                          [field]: v === "none" ? null : Number(v),
                        }))
                      }
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="Not mapped" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="none">Not mapped</SelectItem>
                        {matrix.headers.map((h, i) => (
                          <SelectItem key={`${h}-${i}`} value={String(i)}>
                            {h || `Column ${i + 1}`}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                ))}
              </div>

              {BATCH_DEFAULT_FIELDS.some((f) => mapping[f] === null) && (
                <div className="grid gap-3 rounded-md border border-border p-3 sm:grid-cols-3">
                  <p className="sm:col-span-3 text-xs text-muted-foreground">
                    These fields are not in the file. Apply one value to the whole batch.
                  </p>
                  {BATCH_DEFAULT_FIELDS.filter((f) => mapping[f] === null).map((f) => (
                    <div key={f} className="space-y-1">
                      <Label className="text-xs">{FIELD_LABELS[f]} for all rows</Label>
                      <Input
                        value={defaults[f as keyof typeof defaults]}
                        onChange={(e) =>
                          setDefaults((prev) => ({ ...prev, [f]: e.target.value }))
                        }
                      />
                    </div>
                  ))}
                </div>
              )}

              {unmappedRequired.length > 0 && (
                <p className="text-sm text-destructive">
                  {unmappedRequired
                    .map(
                      (f) =>
                        `${FIELD_LABELS[f]} has not been mapped. Select the CSV column containing the ${FIELD_LABELS[f].toLowerCase()}.`,
                    )
                    .join(" ")}
                </p>
              )}
              {missingDefaults.length > 0 && (
                <p className="text-sm text-destructive">
                  Provide a batch value for {missingDefaults.map((f) => FIELD_LABELS[f]).join(", ")}.
                </p>
              )}
            </div>
          )}

          {step === "preview" && (
            <div className="space-y-2">
              <div className="space-y-1.5">
                <Label>Destination menu</Label>
                <Select value={menuId} onValueChange={setMenuId}>
                  <SelectTrigger><SelectValue placeholder="Select the menu that owns these items" /></SelectTrigger>
                  <SelectContent>
                    {(menus.data ?? []).filter((menu) => menu.branch_id === branchId).map((menu) => (
                      <SelectItem key={menu.id} value={menu.id}>{menu.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {!branchId ? <p className="text-sm text-destructive">Select one property before importing.</p> : null}
                {branchId && (menus.data ?? []).filter((menu) => menu.branch_id === branchId).length === 0 ? <p className="text-sm text-destructive">Create a menu for this property before importing items.</p> : null}
              </div>
              <p className="text-sm text-muted-foreground">
                {fileName} · {valid.length} ready · {rejected.length} rejected
              </p>
              <div className="max-h-80 overflow-auto rounded-md border border-border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Row</TableHead>
                      <TableHead>Item</TableHead>
                      <TableHead>Category</TableHead>
                      <TableHead className="text-right">Price</TableHead>
                      <TableHead>Availability</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {validated.map((r) => (
                      <TableRow key={r.line}>
                        <TableCell>{r.line}</TableCell>
                        <TableCell>{r.itemName || "—"}</TableCell>
                        <TableCell>{r.category || "—"}</TableCell>
                        <TableCell className="text-right">
                          {r.price === null ? "—" : `${r.currency} ${r.price.toFixed(2)}`}
                        </TableCell>
                        <TableCell>{r.availability}</TableCell>
                        <TableCell
                          className={r.errors.length ? "text-destructive" : "text-muted-foreground"}
                        >
                          {r.errors.length
                            ? r.errors
                                .map((e) => `${e.field}: ${e.error} (value: ${e.value}) — ${e.fix}`)
                                .join("; ")
                            : "Ready (draft)"}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>
          )}
        </div>

        {failure && (
          <div
            role="alert"
            className="rounded-xl border border-destructive/40 bg-destructive/5 p-4 text-sm"
          >
            <p className="font-semibold text-destructive">{failure.title}</p>
            <p className="mt-1 text-muted-foreground">
              {failure.category === "permission"
                ? "Access refusal"
                : failure.category === "validation"
                  ? "Data problem"
                  : "System problem"}
              {failure.code ? ` · ${failure.code}` : ""} · failed at the {failure.stage} step
            </p>
            <p className="mt-2 text-foreground">{failure.detail}</p>
            <p className="mt-2 text-muted-foreground">{failure.nextAction}</p>
            <div className="mt-3 flex items-center gap-2">
              <code className="rounded bg-muted px-2 py-1 text-xs">{failure.correlationId}</code>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => {
                  void navigator.clipboard?.writeText(failure.correlationId);
                  toast.success("Correlation ID copied");
                }}
              >
                Copy correlation ID
              </Button>
            </div>
          </div>
        )}



        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          {step === "mapping" && (
            <Button
              onClick={() => setStep("preview")}
              disabled={unmappedRequired.length > 0 || missingDefaults.length > 0}
            >
              Validate rows
            </Button>
          )}
          {step === "preview" && (
            <>
              <Button variant="outline" onClick={() => setStep("mapping")} disabled={busy}>
                Back to mapping
              </Button>
              <Button onClick={() => void importDrafts()} disabled={busy || !valid.length || !branchId || !menuId}>
                {busy ? "Importing…" : `Import ${valid.length} as draft`}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
