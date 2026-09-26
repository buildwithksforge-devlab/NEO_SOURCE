import { Fragment, useRef, useState } from "react";
import { Download, FileUp, History, Paperclip } from "lucide-react";
import { toast } from "sonner";
import { FormDialog } from "@/components/common/FormDialog";
import { FieldGrid } from "@/components/common/FormFields";
import { NeoDatePicker } from "@/components/common/DatePicker";
import { SectionCard, TableScroll } from "@/components/common/DataDisplay";
import { EmptyState, HrBadge, QueryState } from "@/components/hr/HrShared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useAuth } from "@/lib/auth";
import {
  HR_DOCUMENT_TYPES,
  buildDocumentChains,
  documentTypeLabel,
  openEmployeeDocument,
  useEmployeeDocuments,
  useUploadEmployeeDocument,
} from "@/lib/hr-documents";
import { HR_MODULES, shortDate, type Row } from "@/lib/hr";

/**
 * The employee's document file. Replacing a document never overwrites it: the
 * earlier version stays on the record underneath the current one.
 */
export function EmployeeDocumentsPanel({ employee }: { employee: Row }) {
  const { can } = useAuth();
  const documents = useEmployeeDocuments(String(employee["id"]));
  const [uploadFor, setUploadFor] = useState<{ open: boolean; supersedes: Row | null }>({
    open: false,
    supersedes: null,
  });
  const [expanded, setExpanded] = useState<string | null>(null);

  const manage = can(HR_MODULES.employees, "documents.manage");
  const chains = buildDocumentChains(documents.data ?? []);

  async function open(path: unknown) {
    try {
      await openEmployeeDocument(String(path));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not open the document");
    }
  }

  return (
    <SectionCard
      title="Documents"
      description="CVs, identity and statutory records, certificates, contracts and letters — each with its document date, expiry and earlier versions."
      actions={
        manage ? (
          <Button size="sm" onClick={() => setUploadFor({ open: true, supersedes: null })}>
            <FileUp className="mr-2 size-4" aria-hidden />
            Upload document
          </Button>
        ) : null
      }
    >
      <QueryState
        isLoading={documents.isLoading}
        error={documents.error}
        isEmpty={chains.length === 0}
        empty={
          <EmptyState
            title="No documents on file"
            description="Upload the CV, identity and statutory records, contract and certificates to build the employee file."
          />
        }
      >
        <TableScroll>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Document</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Document date</TableHead>
                <TableHead>Expires</TableHead>
                <TableHead>Filed</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {chains.map(({ current, previous }) => {
                const id = String(current["id"]);
                const expiry = current["expiry_date"] as string | null;
                const expired = Boolean(expiry && expiry < new Date().toISOString().slice(0, 10));
                return (
                  <Fragment key={id}>
                    <TableRow key={id}>
                      <TableCell className="font-medium">{String(current["title"] ?? "—")}</TableCell>
                      <TableCell>{documentTypeLabel(current["category"])}</TableCell>
                      <TableCell>
                        {shortDate(current["document_date"] ?? current["issue_date"])}
                      </TableCell>
                      <TableCell>
                        {expiry ? (
                          <HrBadge
                            value={shortDate(expiry)}
                            tone={expired ? "destructive" : "success"}
                          />
                        ) : (
                          "—"
                        )}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {shortDate(current["created_at"])}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-1.5">
                          {previous.length ? (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => setExpanded(expanded === id ? null : id)}
                            >
                              <History className="mr-1.5 size-4" aria-hidden />
                              {previous.length} earlier
                            </Button>
                          ) : null}
                          {current["storage_path"] ? (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => void open(current["storage_path"])}
                            >
                              <Download className="mr-1.5 size-4" aria-hidden />
                              Open
                            </Button>
                          ) : null}
                          {manage ? (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => setUploadFor({ open: true, supersedes: current })}
                            >
                              Replace
                            </Button>
                          ) : null}
                        </div>
                      </TableCell>
                    </TableRow>
                    {expanded === id
                      ? previous.map((p) => (
                          <TableRow key={String(p["id"])} className="bg-muted/40">
                            <TableCell className="pl-8 text-sm text-muted-foreground">
                              Previous version — {String(p["title"] ?? "")}
                            </TableCell>
                            <TableCell>{documentTypeLabel(p["category"])}</TableCell>
                            <TableCell>
                              {shortDate(p["document_date"] ?? p["issue_date"])}
                            </TableCell>
                            <TableCell>{shortDate(p["expiry_date"])}</TableCell>
                            <TableCell className="text-sm text-muted-foreground">
                              {shortDate(p["created_at"])}
                            </TableCell>
                            <TableCell className="text-right">
                              {p["storage_path"] ? (
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  onClick={() => void open(p["storage_path"])}
                                >
                                  Open
                                </Button>
                              ) : null}
                            </TableCell>
                          </TableRow>
                        ))
                      : null}
                  </Fragment>
                );
              })}
            </TableBody>
          </Table>
        </TableScroll>
      </QueryState>

      <UploadDocumentDialog
        open={uploadFor.open}
        supersedes={uploadFor.supersedes}
        employee={employee}
        onOpenChange={(v) => setUploadFor({ open: v, supersedes: v ? uploadFor.supersedes : null })}
      />
    </SectionCard>
  );
}

function UploadDocumentDialog({
  open,
  onOpenChange,
  employee,
  supersedes,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  employee: Row;
  supersedes: Row | null;
}) {
  const { organizationId } = useAuth();
  const upload = useUploadEmployeeDocument();
  const fileInput = useRef<HTMLInputElement>(null);

  const [category, setCategory] = useState(String(supersedes?.["category"] ?? "cv"));
  const [title, setTitle] = useState(String(supersedes?.["title"] ?? ""));
  const [documentDate, setDocumentDate] = useState("");
  const [expiryDate, setExpiryDate] = useState("");
  const [file, setFile] = useState<File | null>(null);

  function submit() {
    if (!file || !organizationId) return;
    upload.mutate(
      {
        organizationId,
        employeeId: String(employee["id"]),
        category,
        title,
        file,
        documentDate: documentDate || null,
        expiryDate: expiryDate || null,
        confidentiality: "hr_only",
        supersedesDocumentId: supersedes ? String(supersedes["id"]) : null,
      },
      {
        onSuccess: () => {
          setFile(null);
          setTitle("");
          setDocumentDate("");
          setExpiryDate("");
          onOpenChange(false);
        },
      },
    );
  }

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={supersedes ? `Replace ${String(supersedes["title"] ?? "document")}` : "Upload document"}
      description={
        supersedes
          ? "The current version is kept on the record as an earlier version."
          : "Files are stored privately and only opened through a short-lived link."
      }
      submitLabel="File document"
      canSubmit={Boolean(file)}
      busy={upload.isPending}
      busyLabel="Uploading…"
      onSubmit={submit}
    >
      <FieldGrid>
        <div className="space-y-1.5">
          <Label htmlFor="doc-category">Document type</Label>
          <Select value={category} onValueChange={setCategory}>
            <SelectTrigger id="doc-category">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {HR_DOCUMENT_TYPES.map((t) => (
                <SelectItem key={t.key} value={t.key}>
                  {t.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="doc-title">Title</Label>
          <Input
            id="doc-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={documentTypeLabel(category)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="doc-date">Document date</Label>
          <NeoDatePicker id="doc-date" value={documentDate} onChange={setDocumentDate} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="doc-expiry">Expiry date (where applicable)</Label>
          <NeoDatePicker id="doc-expiry" value={expiryDate} onChange={setExpiryDate} />
        </div>
      </FieldGrid>

      <div className="space-y-1.5">
        <Label htmlFor="doc-file">File</Label>
        <input
          ref={fileInput}
          id="doc-file"
          type="file"
          className="sr-only"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
        />
        <Button
          type="button"
          variant="outline"
          className="w-full justify-start font-normal"
          onClick={() => fileInput.current?.click()}
        >
          <Paperclip className="mr-2 size-4" aria-hidden />
          <span className="truncate">{file ? file.name : "Choose a file (max 25 MB)"}</span>
        </Button>
      </div>
    </FormDialog>
  );
}
