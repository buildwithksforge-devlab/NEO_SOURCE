/**
 * Guest documents section of a customer profile. Files are private: they are
 * uploaded into a non-public store, opened only through short-lived links and
 * every open is recorded.
 */
import { useRef, useState } from "react";
import { toast } from "sonner";
import { FileText, Trash2, Upload } from "lucide-react";
import { SectionCard, StatusPill } from "@/components/common/DataDisplay";
import { NeoDatePicker } from "@/components/common/DatePicker";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAuth } from "@/lib/auth";
import {
  GUEST_DOCUMENT_TYPES,
  useCustomerDocuments,
  useDeleteCustomerDocument,
  useOpenCustomerDocument,
  useUploadCustomerDocument,
  type GuestDocument,
} from "@/lib/guest-documents";

function titleCase(value: string) {
  return value.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatSize(bytes: number | null) {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function GuestDocuments({ customerId }: { customerId: string }) {
  const { can } = useAuth();
  const canView = can("crm", "documents", "view") || can("administration", "workspace", "edit");
  const canCreate = can("crm", "documents", "create") || can("administration", "workspace", "edit");
  const canDelete = can("crm", "documents", "delete") || can("administration", "workspace", "edit");

  const documents = useCustomerDocuments(canView ? customerId : undefined);
  const upload = useUploadCustomerDocument(customerId);
  const open = useOpenCustomerDocument();
  const remove = useDeleteCustomerDocument();

  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [documentType, setDocumentType] = useState<string>("identity");
  const [isSensitive, setIsSensitive] = useState(true);
  const [retentionUntil, setRetentionUntil] = useState("");
  const [notes, setNotes] = useState("");

  if (!canView) {
    return (
      <SectionCard title="Guest documents">
        <div className="rounded-lg border border-dashed border-border bg-muted/30 p-6 text-center text-sm text-muted-foreground">
          You do not have permission to view documents for this guest.
        </div>
      </SectionCard>
    );
  }

  async function submit() {
    if (!file) {
      toast.error("Choose a file first.");
      return;
    }
    try {
      await upload.mutateAsync({
        file,
        title: title.trim() || file.name,
        documentType,
        isSensitive,
        retentionUntil: retentionUntil || null,
        notes: notes.trim() || null,
      });
      setFile(null);
      setTitle("");
      setNotes("");
      setRetentionUntil("");
      if (fileRef.current) fileRef.current.value = "";
      toast.success("Document stored privately against this guest.");
    } catch (error) {
      toast.error((error as { message?: string }).message ?? "The document could not be stored.");
    }
  }

  async function view(doc: GuestDocument) {
    try {
      const url = await open.mutateAsync(doc);
      window.open(url, "_blank", "noopener,noreferrer");
    } catch (error) {
      toast.error((error as { message?: string }).message ?? "The document could not be opened.");
    }
  }

  async function destroy(doc: GuestDocument) {
    try {
      await remove.mutateAsync(doc);
      toast.success("Document removed.");
    } catch (error) {
      toast.error((error as { message?: string }).message ?? "The document could not be removed.");
    }
  }

  return (
    <div className="space-y-6">
      {canCreate ? (
        <SectionCard
          title="Add a document"
          description="Stored privately for this guest. Nothing here is publicly reachable."
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="guest-doc-file">File</Label>
              <Input
                id="guest-doc-file"
                ref={fileRef}
                type="file"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="guest-doc-title">Title</Label>
              <Input
                id="guest-doc-title"
                value={title}
                placeholder="Passport — scanned copy"
                onChange={(e) => setTitle(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label>Document type</Label>
              <Select value={documentType} onValueChange={setDocumentType}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {GUEST_DOCUMENT_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>
                      {titleCase(t)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="guest-doc-retention">Keep until</Label>
              <NeoDatePicker
                id="guest-doc-retention"
                value={retentionUntil}
                onChange={setRetentionUntil}
              />
            </div>

            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="guest-doc-notes">Notes</Label>
              <Textarea
                id="guest-doc-notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={2}
              />
            </div>
            <div className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2 sm:col-span-2">
              <div>
                <p className="text-sm font-medium">Sensitive document</p>
                <p className="text-xs text-muted-foreground">
                  Marks the record as containing personal identity information.
                </p>
              </div>
              <Switch checked={isSensitive} onCheckedChange={setIsSensitive} />
            </div>
          </div>
          <div className="mt-4">
            <Button size="sm" onClick={submit} disabled={upload.isPending}>
              <Upload className="mr-2 size-4" />
              {upload.isPending ? "Storing…" : "Store document"}
            </Button>
          </div>
        </SectionCard>
      ) : null}

      <SectionCard title="Documents on file">
        {documents.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading documents…</p>
        ) : !documents.data?.length ? (
          <div className="rounded-lg border border-dashed border-border bg-muted/30 p-6 text-center text-sm text-muted-foreground">
            No documents stored for this guest yet.
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {documents.data.map((doc) => (
              <li key={doc.id} className="flex flex-wrap items-center gap-3 py-3">
                <FileText className="size-4 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{doc.title}</p>
                  <p className="text-xs text-muted-foreground">
                    {titleCase(doc.document_type)}
                    {formatSize(doc.file_size) ? ` · ${formatSize(doc.file_size)}` : ""} ·{" "}
                    {new Date(doc.created_at).toLocaleDateString()}
                    {doc.retention_until ? ` · keep until ${doc.retention_until}` : ""}
                  </p>
                </div>
                {doc.is_sensitive ? <StatusPill tone="warning">Sensitive</StatusPill> : null}
                <Button size="sm" variant="outline" onClick={() => view(doc)}>
                  Open
                </Button>
                {canDelete ? (
                  <Button size="sm" variant="ghost" onClick={() => destroy(doc)}>
                    <Trash2 className="size-4" />
                    <span className="sr-only">Remove {doc.title}</span>
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}
