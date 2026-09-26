/**
 * Employee document file — upload, retention and version chain.
 *
 * Files live in the private `hr-documents` bucket under
 * `<organization_id>/<employee_id>/…`, and are only ever read through a
 * short-lived signed URL. Replacing a document never overwrites the old one:
 * the new record points at the one it supersedes, so the previous version
 * stays on the employee's file.
 */

import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { guardedRpc } from "@/lib/rpc-guard";
import { useHrInvalidate, useHrList } from "@/lib/hr-data";
import type { Row } from "@/lib/hr";

/* eslint-disable @typescript-eslint/no-explicit-any */
const db = supabase as any;

export const HR_DOCUMENT_BUCKET = "hr-documents";

export const HR_DOCUMENT_TYPES = [
  { key: "cv", label: "Curriculum vitae", expires: false },
  { key: "national_id", label: "National ID / passport", expires: true },
  { key: "kra_pin", label: "KRA PIN", expires: false },
  { key: "nssf", label: "NSSF", expires: false },
  { key: "sha", label: "SHA / SHIF", expires: false },
  { key: "academic", label: "Academic qualification", expires: false },
  { key: "professional", label: "Professional certification", expires: true },
  { key: "certificate", label: "Certificate", expires: true },
  { key: "contract", label: "Employment contract", expires: true },
  { key: "appointment", label: "Appointment letter", expires: false },
  { key: "promotion", label: "Promotion letter", expires: false },
  { key: "warning", label: "Warning / disciplinary letter", expires: false },
  { key: "appraisal", label: "Appraisal document", expires: false },
  { key: "medical", label: "Medical record", expires: true },
  { key: "other", label: "Other document", expires: false },
] as const;

export function documentTypeLabel(key: unknown): string {
  return HR_DOCUMENT_TYPES.find((t) => t.key === key)?.label ?? String(key ?? "Document");
}

export const MAX_HR_DOCUMENT_BYTES = 25 * 1024 * 1024;

/* --------------------------------- reads --------------------------------- */

export function useEmployeeDocuments(employeeId: string | undefined) {
  return useHrList(
    "employee_documents",
    "*",
    (q) => q.eq("employee_id", employeeId).order("created_at", { ascending: false }),
    [employeeId ?? ""],
    Boolean(employeeId),
  );
}

export type DocumentChain = { current: Row; previous: Row[] };

/** Groups a flat document list into current documents with their earlier versions. */
export function buildDocumentChains(rows: readonly Row[]): DocumentChain[] {
  const superseded = new Set(
    rows.map((r) => r["supersedes_document_id"]).filter(Boolean) as string[],
  );
  const byId = new Map(rows.map((r) => [String(r["id"]), r]));

  return rows
    .filter((r) => !superseded.has(String(r["id"])))
    .map((current) => {
      const previous: Row[] = [];
      let cursor = current["supersedes_document_id"] as string | null;
      while (cursor && byId.has(cursor)) {
        const prior = byId.get(cursor)!;
        previous.push(prior);
        cursor = prior["supersedes_document_id"] as string | null;
      }
      return { current, previous };
    });
}

/** Short-lived signed URL for one stored file. */
export function useSignedDocumentUrl(path: string | null | undefined) {
  return useQuery({
    queryKey: ["hr", "document-url", path ?? ""],
    enabled: Boolean(path),
    staleTime: 4 * 60 * 1000,
    queryFn: async () => {
      const { data, error } = await supabase.storage
        .from(HR_DOCUMENT_BUCKET)
        .createSignedUrl(String(path), 300);
      if (error) throw new Error(error.message);
      return data?.signedUrl ?? null;
    },
  });
}

export async function openEmployeeDocument(path: string) {
  const { data, error } = await supabase.storage
    .from(HR_DOCUMENT_BUCKET)
    .createSignedUrl(path, 300);
  if (error) throw new Error(error.message);
  if (data?.signedUrl) window.open(data.signedUrl, "_blank", "noopener,noreferrer");
}

/* -------------------------------- uploads -------------------------------- */

export type DocumentUpload = {
  organizationId: string;
  employeeId: string;
  category: string;
  title: string;
  file: File;
  documentDate: string | null;
  expiryDate: string | null;
  confidentiality: string;
  supersedesDocumentId: string | null;
};

export function useUploadEmployeeDocument() {
  const invalidate = useHrInvalidate();

  return useMutation({
    mutationFn: async (input: DocumentUpload) => {
      if (input.file.size > MAX_HR_DOCUMENT_BYTES) {
        throw new Error("That file is larger than 25 MB.");
      }
      const extension = (input.file.name.split(".").pop() ?? "pdf").toLowerCase().slice(0, 8);
      const path = `${input.organizationId}/${input.employeeId}/${input.category}-${Date.now()}.${extension}`;

      const upload = await supabase.storage
        .from(HR_DOCUMENT_BUCKET)
        .upload(path, input.file, { upsert: false, contentType: input.file.type });
      if (upload.error) throw new Error(upload.error.message);

      const { error } = await guardedRpc(db, "neo_hr_document_record", {
        _employee: input.employeeId,
        _category: input.category,
        _title: input.title.trim() || documentTypeLabel(input.category),
        _storage_path: path,
        _confidentiality: input.confidentiality,
        ...(input.documentDate ? { _issue_date: input.documentDate } : {}),
        ...(input.expiryDate ? { _expiry_date: input.expiryDate } : {}),
      });
      if (error) {
        await supabase.storage.from(HR_DOCUMENT_BUCKET).remove([path]);
        throw new Error(error.message);
      }

      // Attach the version chain to the record just created.
      const created = await db
        .from("employee_documents")
        .select("id")
        .eq("storage_path", path)
        .maybeSingle();

      const newId = created?.data?.id as string | undefined;
      if (newId) {
        const patch: Record<string, unknown> = {};
        if (input.documentDate) patch["document_date"] = input.documentDate;
        if (input.supersedesDocumentId) patch["supersedes_document_id"] = input.supersedesDocumentId;
        if (Object.keys(patch).length) {
          await db.from("employee_documents").update(patch).eq("id", newId);
        }
        if (input.supersedesDocumentId) {
          await db
            .from("employee_documents")
            .update({ status: "superseded" })
            .eq("id", input.supersedesDocumentId);
        }
      }

      return { path };
    },
    onSuccess: () => {
      invalidate();
      toast.success("Document filed on the employee record");
    },
    onError: (error: Error) => toast.error(error.message),
  });
}
