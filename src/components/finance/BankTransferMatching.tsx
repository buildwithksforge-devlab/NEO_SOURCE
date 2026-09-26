/**
 * Transfers awaiting the bank.
 *
 * Every bank transfer taken anywhere in NEØ appears here as unverified until a
 * line on the bank's own statement is matched to it. Nothing on this screen
 * creates money: it only decides whether the bank agrees that money already
 * recorded actually arrived.
 */
import { useState } from "react";
import { Banknote, CheckCircle2, Link2, Upload } from "lucide-react";
import { SectionCard } from "@/components/common/DataDisplay";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  parseStatementCsv,
  useAutoMatchTransfers,
  useBankTransferQueue,
  useImportStatement,
  useMatchTransfer,
  type AwaitingTransfer,
} from "@/lib/bank-reconciliation";
import { money, shortDate } from "@/lib/finance";

export function BankTransferMatching({
  accounts,
}: {
  accounts: { id: string; name: string }[];
}) {
  const queue = useBankTransferQueue();
  const match = useMatchTransfer();
  const auto = useAutoMatchTransfers();
  const [importOpen, setImportOpen] = useState(false);

  const awaiting = queue.data?.awaiting ?? [];
  const openLines = queue.data?.open_lines ?? [];

  return (
    <SectionCard
      title="Transfers awaiting the bank"
      description="A typed reference is a claim; a statement line is proof. Match one to the other to verify the money arrived."
      actions={
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => setImportOpen(true)}>
            <Upload className="mr-1.5 size-4" /> Import statement
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={auto.isPending || awaiting.length === 0}
            onClick={() => auto.mutate({ commit: true })}
          >
            <Link2 className="mr-1.5 size-4" /> Match exact references
          </Button>
        </div>
      }
    >
      {accounts.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Add a bank account above before importing a statement. Until then transfers stay
          recorded but unverified.
        </p>
      ) : queue.isLoading ? (
        <p className="text-sm text-muted-foreground">Reading the register…</p>
      ) : awaiting.length === 0 ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <CheckCircle2 className="size-4 text-emerald-600" />
          No transfer is waiting on the bank. {openLines.length} statement line
          {openLines.length === 1 ? "" : "s"} still unmatched.
        </p>
      ) : (
        <div className="space-y-3">
          {awaiting.map((t) => (
            <AwaitingRow
              key={t.attempt_id}
              transfer={t}
              busy={match.isPending}
              onMatch={(entryId) => match.mutate({ attemptId: t.attempt_id, entryId })}
            />
          ))}
        </div>
      )}

      <StatementImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        accounts={accounts}
      />
    </SectionCard>
  );
}

function AwaitingRow({
  transfer,
  busy,
  onMatch,
}: {
  transfer: AwaitingTransfer;
  busy: boolean;
  onMatch: (entryId: string) => void;
}) {
  const [entryId, setEntryId] = useState<string>("");
  const candidates = transfer.candidates ?? [];

  return (
    <div className="rounded-lg border border-border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-sm font-medium text-foreground">
            {money(transfer.amount)}{" "}
            <span className="font-normal text-muted-foreground">
              · {transfer.module ?? "payment"} · {shortDate(transfer.requested_at)}
            </span>
          </p>
          <p className="text-xs text-muted-foreground">
            Reference {transfer.reference ?? "none given"}
          </p>
        </div>
        <Badge variant="outline">Unverified</Badge>
      </div>

      {candidates.length === 0 ? (
        <p className="mt-2 text-xs text-muted-foreground">
          No statement line of this amount is on file for the days around it.
        </p>
      ) : (
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <div className="min-w-56 flex-1 space-y-1.5">
            <Label className="text-xs">Statement line</Label>
            <Select value={entryId} onValueChange={setEntryId}>
              <SelectTrigger>
                <SelectValue placeholder="Choose the line that settles this" />
              </SelectTrigger>
              <SelectContent>
                {candidates.map((c) => (
                  <SelectItem key={c.entry_id} value={c.entry_id}>
                    {shortDate(c.value_date)} · {money(c.amount)} ·{" "}
                    {c.reference ?? c.description ?? "no reference"}
                    {c.exact_reference ? " · exact reference" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button size="sm" disabled={!entryId || busy} onClick={() => onMatch(entryId)}>
            <Banknote className="mr-1.5 size-4" /> Verify
          </Button>
        </div>
      )}
    </div>
  );
}

function StatementImportDialog({
  open,
  onOpenChange,
  accounts,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  accounts: { id: string; name: string }[];
}) {
  const [accountId, setAccountId] = useState(accounts[0]?.id ?? "");
  const [text, setText] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [fileProblem, setFileProblem] = useState<string | null>(null);
  const importer = useImportStatement();
  const parsed = parseStatementCsv(text);

  async function readStatementFile(file: File) {
    setFileProblem(null);
    if (file.size > 5_000_000) {
      setFileProblem("That file is larger than 5 MB. Export a shorter date range.");
      return;
    }
    const contents = await file.text();
    if (contents.includes("\u0000") || /^PK\u0003\u0004/.test(contents)) {
      setFileProblem(
        "That file is not a text export. Save the statement as CSV from the bank and try again.",
      );
      return;
    }
    setFileName(file.name);
    setText(contents);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Import bank statement lines</DialogTitle>
          <DialogDescription>
            Paste the export from the bank: date, amount, reference, description — one line each.
            The same line pasted twice is only ever stored once.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label>Bank account</Label>
            <Select value={accountId} onValueChange={setAccountId}>
              <SelectTrigger>
                <SelectValue placeholder="Choose an account" />
              </SelectTrigger>
              <SelectContent>
                {accounts.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="statement-file">Statement file</Label>
            <Input
              id="statement-file"
              type="file"
              accept=".csv,.txt,.tsv,text/csv,text/plain"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void readStatementFile(file);
              }}
            />
            <p className="text-xs text-muted-foreground">
              {fileProblem
                ? fileProblem
                : fileName
                  ? `${fileName} loaded — check the lines below before importing.`
                  : "Choose the CSV the bank exports, or paste the lines below."}
            </p>
          </div>
          <div className="space-y-1.5">
            <Label>Statement lines</Label>
            <Textarea
              rows={8}
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                setFileName(null);
              }}
              placeholder={"2026-09-08, 8700, FT26A1B2C3, Transfer from J Mwangi"}
              className="font-mono text-xs"
            />
            <p className="text-xs text-muted-foreground">
              {parsed.rows.length} line{parsed.rows.length === 1 ? "" : "s"} read
              {parsed.problems.length ? ` · ${parsed.problems.length} could not be read` : ""}
            </p>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              disabled={!accountId || parsed.rows.length === 0 || importer.isPending}
              onClick={() =>
                importer.mutate(
                  { accountId, rows: parsed.rows },
                  {
                    onSuccess: () => {
                      setText("");
                      onOpenChange(false);
                    },
                  },
                )
              }
            >
              Import {parsed.rows.length || ""} lines
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
