import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { guardedRpc } from "@/lib/rpc-guard";
import { PageHeader } from "@/components/common/DataDisplay";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export const Route = createFileRoute("/_shell/staff-display-code")({ component: StaffDisplayCode });
type PinState = { ok: boolean; staff_code: string | null; pin_set: boolean };
function StaffDisplayCode() {
  const [pin, setPin] = useState("");
  const [confirm, setConfirm] = useState("");
  const state = useQuery({
    queryKey: ["my-production-pin"],
    retry: false,
    queryFn: async () => {
      const { data, error } = await guardedRpc<PinState>(supabase, "neo_production_staff_pin");
      if (error) throw new Error(error.message);
      return data;
    },
  });
  const save = useMutation({
    retry: false,
    mutationFn: async (disable: boolean) => {
      const { data, error } = await guardedRpc<PinState>(supabase, "neo_production_staff_pin", {
        _pin: disable ? null : pin,
        _disable: disable,
      });
      if (error) throw new Error(error.message);
      return data;
    },
    onSuccess: () => {
      toast.success("Display PIN updated.");
      void state.refetch();
    },
    onError: (e: Error) => toast.error(e.message),
    onSettled: () => {
      setPin("");
      setConfirm("");
    },
  });
  return (
    <div className="mx-auto max-w-xl space-y-5">
      <PageHeader
        eyebrow="My staff account"
        title="My personal staff PIN"
        description="Set your unique six-digit PIN. On a paired station screen, enter only this PIN to authorize work. NEØ identifies you and checks your assigned station permissions."
      />
      {state.isLoading ? <p>Loading your personal PIN status…</p> : null}
      {state.error ? (
        <p role="alert" className="text-destructive">
          {state.error.message}
        </p>
      ) : null}
      {state.data ? (
        <>
          <div className="rounded-lg border p-4">
            <p className="text-sm">
              {state.data.pin_set
                ? "Your personal PIN is active."
                : "You have no active personal PIN."}
            </p>
          </div>
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              save.mutate(false);
            }}
          >
            <div>
              <Label htmlFor="new-display-pin">New six-digit PIN</Label>
              <Input
                id="new-display-pin"
                type="password"
                inputMode="numeric"
                autoComplete="new-password"
                value={pin}
                maxLength={6}
                pattern="[0-9]{6}"
                required
                onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
              />
            </div>
            <div>
              <Label htmlFor="confirm-display-pin">Confirm PIN</Label>
              <Input
                id="confirm-display-pin"
                type="password"
                inputMode="numeric"
                autoComplete="new-password"
                value={confirm}
                maxLength={6}
                pattern="[0-9]{6}"
                required
                onChange={(e) => setConfirm(e.target.value.replace(/\D/g, ""))}
              />
            </div>
            <Button disabled={save.isPending || pin.length !== 6 || pin !== confirm} type="submit">
              {save.isPending ? "Saving…" : "Save personal PIN"}
            </Button>
          </form>
          {state.data.pin_set ? (
            <Button variant="outline" disabled={save.isPending} onClick={() => save.mutate(true)}>
              Disable my personal PIN
            </Button>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
