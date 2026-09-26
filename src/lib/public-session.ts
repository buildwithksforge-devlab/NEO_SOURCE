/**
 * Customer-side session helpers for the public Guest and Delivery apps.
 *
 * These deliberately never touch `profiles`, `roles` or `user_roles`: a public
 * registration can only ever produce a customer record.
 */
import { guardedRpc } from "@/lib/rpc-guard";
import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import { guardPreview } from "@/lib/preview-mode";

export function useCustomerSession() {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      setSession(data.session);
      setLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next);
    });
    return () => {
      active = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  return { session, user: session?.user ?? null, loading };
}

/** Creates (or returns) the signed-in person's customer record for this hotel. */
export async function ensureCustomerRecord(input: {
  organizationId: string;
  branchId: string | null;
  fullName: string;
  phone: string;
}) {
  guardPreview();
  const { data, error } = await guardedRpc(supabase, "customer_register_self" as never, {
    _org: input.organizationId,
    _branch: input.branchId,
    _full_name: input.fullName,
    _phone: input.phone,
  } as never);
  if (error) throw new Error(error.message);
  return data as { customer_id: string; created: boolean };
}

/** The signed-in person's customer record inside one organisation. */
export async function fetchMyCustomer(organizationId: string) {
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) return null;
  const { data, error } = await supabase
    .from("customers")
    .select("id, organization_id, primary_branch_id, full_name, phone, email, customer_number")
    .eq("auth_user_id", auth.user.id)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

export const GENERIC_AUTH_ERROR =
  "We could not complete that. Check your details and try again.";
