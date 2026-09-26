/**
 * Guest documents — private, tenant-scoped document storage for a customer
 * profile (passport scans, signed registration cards, corporate letters).
 *
 * Files live in the private `guest-documents` bucket under
 * `<organization_id>/<customer_id>/<file>`; nothing is ever public. Every read
 * is served through a short-lived signed URL and recorded in
 * `customer_document_access_log` so access is accountable.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";
import { useActivePropertyFilter } from "@/lib/branch-filter";

export const BUCKET = "guest-documents";

export const GUEST_DOCUMENT_TYPES = [
  "identity",
  "passport",
  "visa",
  "registration-card",
  "contract",
  "corporate-authority",
  "invoice",
  "correspondence",
  "other",
] as const;

export type GuestDocument = {
  id: string;
  customer_id: string;
  branch_id: string | null;
  document_type: string;
  title: string;
  storage_path: string;
  mime_type: string | null;
  file_size: number | null;
  is_sensitive: boolean;
  retention_until: string | null;
  notes: string | null;
  created_at: string;
};

export function useCustomerDocuments(customerId: string | undefined) {
  const { organizationId } = useAuth();
  return useQuery({
    queryKey: ["guest-documents", organizationId, customerId],
    enabled: Boolean(organizationId && customerId),
    queryFn: async () => {
      const { data, error } = await supabase
        .from("customer_documents")
        .select(
          "id, customer_id, branch_id, document_type, title, storage_path, mime_type, file_size, is_sensitive, retention_until, notes, created_at",
        )
        .eq("customer_id", customerId as string)
        .is("archived_at", null)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as GuestDocument[];
    },
  });
}

export function useUploadCustomerDocument(customerId: string | undefined) {
  const { organizationId, user } = useAuth();
  const { branchId } = useActivePropertyFilter();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: {
      file: File;
      title: string;
      documentType: string;
      isSensitive: boolean;
      retentionUntil?: string | null;
      notes?: string | null;
    }) => {
      if (!organizationId || !customerId) throw new Error("No customer selected.");
      const safeName = input.file.name.replace(/[^\w.\-]+/g, "-");
      const path = `${organizationId}/${customerId}/${Date.now()}-${safeName}`;

      const upload = await supabase.storage
        .from(BUCKET)
        .upload(path, input.file, input.file.type ? { contentType: input.file.type, upsert: false } : { upsert: false });
      if (upload.error) throw upload.error;


      const { data, error } = await supabase
        .from("customer_documents")
        .insert({
          organization_id: organizationId,
          customer_id: customerId,
          branch_id: branchId ?? null,
          document_type: input.documentType,
          title: input.title,
          storage_path: path,
          mime_type: input.file.type || null,
          file_size: input.file.size,
          is_sensitive: input.isSensitive,
          retention_until: input.retentionUntil || null,
          notes: input.notes || null,
          created_by: user?.id ?? null,
        } as never)
        .select("id")
        .single();

      if (error) {
        // Never leave an orphan object behind when the record fails.
        await supabase.storage.from(BUCKET).remove([path]);
        throw error;
      }
      return data as unknown as { id: string };
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["guest-documents"] });
    },
  });
}

async function logAccess(doc: GuestDocument, organizationId: string, actorId: string | null, action: string) {
  await supabase.from("customer_document_access_log").insert({
    organization_id: organizationId,
    document_id: doc.id,
    customer_id: doc.customer_id,
    actor_id: actorId,
    action,
  } as never);
}

/** Returns a short-lived signed URL and records who opened the document. */
export function useOpenCustomerDocument() {
  const { organizationId, user } = useAuth();
  return useMutation({
    mutationFn: async (doc: GuestDocument) => {
      const { data, error } = await supabase.storage
        .from(BUCKET)
        .createSignedUrl(doc.storage_path, 60);
      if (error) throw error;
      if (organizationId) await logAccess(doc, organizationId, user?.id ?? null, "view");
      return data.signedUrl;
    },
  });
}

export function useDeleteCustomerDocument() {
  const { organizationId, user } = useAuth();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (doc: GuestDocument) => {
      if (organizationId) await logAccess(doc, organizationId, user?.id ?? null, "delete");
      const { error } = await supabase.from("customer_documents").delete().eq("id", doc.id);
      if (error) throw error;
      await supabase.storage.from(BUCKET).remove([doc.storage_path]);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["guest-documents"] });
    },
  });
}
