import { useCallback, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { getWorkerPushConfiguration } from "@/lib/worker-push.functions";
import { guardedRpc } from "@/lib/rpc-guard";

function vapidBytes(key: string): Uint8Array<ArrayBuffer> {
  const padded = key.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(key.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function WorkerPushSettings({ userId, organizationId }: { userId: string; organizationId: string }) {
  const loadConfiguration = useServerFn(getWorkerPushConfiguration);
  const configuration = useQuery({ queryKey: ["worker-push-configuration"], queryFn: () => loadConfiguration() });
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState("");
  const [registered, setRegistered] = useState(false);
  const canUse = typeof window !== "undefined" && window.isSecureContext &&
    "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

  // Registration survives reloads. Check ownership in the database before
  // offering a test alert or a disable action for this signed-in worker.
  useEffect(() => {
    let active = true;
    setRegistered(false);
    if (!canUse || !configuration.data?.available) return;
    void (async () => {
      try {
        const registration = await navigator.serviceWorker.getRegistration("/");
        const subscription = await registration?.pushManager.getSubscription();
        if (!subscription) return;
        const { data, error } = await supabase.from("worker_push_subscriptions" as never)
          .select("id").eq("endpoint", subscription.endpoint)
          .eq("organization_id", organizationId).eq("user_id", userId).maybeSingle();
        if (error) throw error;
        if (active) setRegistered(Boolean(data));
      } catch {
        if (active) setMessage("Could not check this device's alert registration. Try again shortly.");
      }
    })();
    return () => { active = false; };
  }, [canUse, configuration.data?.available, organizationId, userId]);

  const subscribe = useCallback(async () => {
    if (!configuration.data?.available || !canUse) return;
    setWorking(true);
    setMessage("");
    try {
      // Browsers require the permission prompt to follow an explicit tap.
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setMessage("Phone alerts were not enabled. Allow notifications in your device settings to try again.");
        return;
      }
      const registration = await navigator.serviceWorker.register("/worker-push-sw.js", { scope: "/" });
      let existing = await registration.pushManager.getSubscription();
      if (existing) {
        const { data: owned, error: ownerError } = await supabase
          .from("worker_push_subscriptions" as never)
          .select("id").eq("endpoint", existing.endpoint)
          .eq("organization_id", organizationId).eq("user_id", userId).maybeSingle();
        if (ownerError) throw ownerError;
        // The browser can retain a different worker's old subscription after
        // sign-out. Never transfer its endpoint to this account.
        const expectedKey = vapidBytes(configuration.data.publicKey);
        const currentKey = existing.options.applicationServerKey;
        const keyMatches = currentKey && new Uint8Array(currentKey).length === expectedKey.length &&
          new Uint8Array(currentKey).every((byte, index) => byte === expectedKey[index]);
        if (!owned || !keyMatches) {
          if (owned) {
            const { error: removeError } = await supabase.from("worker_push_subscriptions" as never)
              .delete().eq("endpoint", existing.endpoint).eq("user_id", userId);
            if (removeError) throw removeError;
          }
          await existing.unsubscribe();
          existing = null;
        }
      }
      const subscription = existing ?? await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: vapidBytes(configuration.data.publicKey),
      });
      const serialised = subscription.toJSON();
      if (!serialised.endpoint || !serialised.keys?.["p256dh"] || !serialised.keys?.["auth"]) {
        throw new Error("The browser did not provide a complete device subscription.");
      }
      const { error: deviceError } = await supabase.from("worker_push_subscriptions" as never).upsert({
        organization_id: organizationId,
        user_id: userId,
        endpoint: serialised.endpoint,
        p256dh: serialised.keys["p256dh"],
        auth_key: serialised.keys["auth"],
        updated_at: new Date().toISOString(),
      } as never, { onConflict: "endpoint" });
      if (deviceError) throw deviceError;
      const { error: prefError } = await supabase.from("notification_preferences").upsert({
        organization_id: organizationId, user_id: userId, push: true,
      }, { onConflict: "user_id" });
      if (prefError) throw prefError;
      setRegistered(true);
      setMessage("This device is registered for personal work alerts. Send a test alert and verify it on your phone before relying on it.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not register this device for alerts.");
    } finally {
      setWorking(false);
    }
  }, [canUse, configuration.data, organizationId, userId]);

  const unsubscribe = useCallback(async () => {
    setWorking(true);
    try {
      const registration = await navigator.serviceWorker.getRegistration("/");
      const subscription = await registration?.pushManager.getSubscription();
      if (subscription) {
        const { error } = await supabase.from("worker_push_subscriptions" as never)
          .delete().eq("endpoint", subscription.endpoint)
          .eq("organization_id", organizationId).eq("user_id", userId);
        if (error) throw error;
        await subscription.unsubscribe();
      }
      const { count, error: remainingError } = await supabase
        .from("worker_push_subscriptions" as never).select("id", { count: "exact", head: true })
        .eq("organization_id", organizationId).eq("user_id", userId);
      if (remainingError) throw remainingError;
      if (!count) {
        const { error } = await supabase.from("notification_preferences")
          .update({ push: false }).eq("organization_id", organizationId).eq("user_id", userId);
        if (error) throw error;
      }
      setRegistered(false);
      setMessage("Phone alerts disabled on this device.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not remove this device.");
    } finally {
      setWorking(false);
    }
  }, [organizationId, userId]);

  const testAlert = useCallback(async () => {
    setWorking(true);
    try {
      const { error } = await guardedRpc(supabase, "neo_worker_push_test");
      if (error) throw error;
      setMessage("Test alert queued. Lock your phone and confirm that it arrives; a queued alert alone is not proof of delivery.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not queue a test alert.");
    } finally {
      setWorking(false);
    }
  }, []);

  if (configuration.isLoading) return <p className="text-sm text-muted-foreground">Checking phone alerts…</p>;
  if (configuration.isError) return <div role="alert" className="space-y-2 rounded-2xl border border-border bg-card p-4 text-sm">
    <p>Could not check phone alert availability.</p>
    <Button type="button" variant="outline" onClick={() => void configuration.refetch()}>Try again</Button>
  </div>;
  if (!configuration.data?.available) return <p className="text-sm text-muted-foreground">Phone alerts are awaiting server setup. Your in-app inbox remains available.</p>;
  if (!canUse) return <p className="text-sm text-muted-foreground">This browser cannot register phone alerts. Use a supported browser on HTTPS; on iPhone, install NEØ to the Home Screen.</p>;

  return <div className="space-y-3 rounded-2xl border border-border bg-card p-4 sm:p-5">
    <div><h3 className="text-sm font-semibold text-foreground">Phone alerts</h3>
      <p className="mt-1 text-sm text-muted-foreground">Register this device, then send a test alert before relying on it for work.</p></div>
    <Button type="button" variant="outline" disabled={working} onClick={() => void subscribe()}>
      {working ? "Updating…" : registered ? "Refresh this device" : "Enable alerts on this device"}
    </Button>
    {registered ? <Button type="button" variant="outline" disabled={working} onClick={() => void testAlert()}>
      Send a test alert
    </Button> : null}
    {registered ? <Button type="button" variant="ghost" disabled={working} onClick={() => void unsubscribe()}>
      Disable on this device
    </Button> : null}
    <p className="text-xs text-muted-foreground">Personal alerts only. Department and property broadcasts are not yet delivered to devices. Browser permission and an active device subscription are required.</p>
    {message && <p role="status" aria-live="polite" className="text-sm text-foreground">{message}</p>}
  </div>;
}
