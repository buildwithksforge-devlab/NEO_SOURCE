/**
 * Partner messaging.
 *
 * A real two-way channel between a business partner and the hotel, held in the
 * database against the partner's own relationship record. A partner can only
 * ever see threads on their relationship; hotel staff only see threads for
 * their own organisation and property. No outside provider is involved, so
 * nothing here depends on an account the hotel has not set up.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { guardedRpc } from "@/lib/rpc-guard";

export type PartnerMessage = {
  id: string;
  side: "partner" | "hotel";
  sender_name: string | null;
  body: string;
  at: string;
};

export type PartnerThread = {
  id: string;
  subject: string;
  status: string;
  last_message_at: string;
  messages: PartnerMessage[];
};

export function usePartnerThreads(relationshipId: string | null) {
  return useQuery({
    queryKey: ["partner-threads", relationshipId],
    enabled: Boolean(relationshipId),
    queryFn: async (): Promise<PartnerThread[]> => {
      const { data, error } = await guardedRpc(supabase, "neo_partner_threads", {
        _relationship: relationshipId,
      });
      if (error) throw new Error(error.message);
      const result = (data ?? {}) as { allowed?: boolean; threads?: PartnerThread[] };
      if (!result.allowed) return [];
      return result.threads ?? [];
    },
  });
}

export function useSendPartnerMessage(relationshipId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      body: string;
      threadId?: string | null | undefined;
      subject?: string | undefined;
    }) => {
      const { data, error } = await guardedRpc(supabase, "neo_partner_message_send", {
        _relationship: relationshipId,
        _body: input.body,
        _thread: input.threadId ?? null,
        _subject: input.subject ?? null,
      });
      if (error) throw new Error(error.message);
      const result = (data ?? {}) as { ok?: boolean; reason?: string; thread_id?: string };
      if (!result.ok) throw new Error(sendFailure(result.reason));
      return result;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["partner-threads", relationshipId] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
}

export function sendFailure(reason?: string): string {
  switch (reason) {
    case "not_signed_in":
      return "Please sign in again to send this message.";
    case "empty_message":
      return "Write a message first.";
    case "unknown_relationship":
    case "not_permitted":
      return "This account is not authorised to message this hotel.";
    case "unknown_thread":
      return "That conversation is no longer available.";
    default:
      return "The message could not be sent.";
  }
}
