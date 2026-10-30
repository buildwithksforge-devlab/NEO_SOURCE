import { useEffect, useRef, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { TicketCard } from "@/components/kitchen/TicketCard";
import {
  ensureSharedScreenSignedOut,
  DISPLAY_TOKEN_STORAGE_KEY,
  readSharedDisplay,
  actOnSharedDisplay,
  productionActions,
  type SharedDisplayAction,
} from "@/lib/shared-production-display";
import { titleCase } from "@/lib/kitchen";

export const Route = createFileRoute("/station-screen")({
  beforeLoad: ensureSharedScreenSignedOut,
  ssr: false,
  component: SharedScreen,
});
function SharedScreen() {
  const qc = useQueryClient();
  const [token] = useState(() => sessionStorage.getItem(DISPLAY_TOKEN_STORAGE_KEY) ?? "");
  const [online, setOnline] = useState(() => navigator.onLine);
  const [selected, setSelected] = useState<SharedDisplayAction | null>(null);

  const [pin, setPin] = useState("");
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState("");
  const [station, setStation] = useState("all");
  const panel = useRef<HTMLDivElement>(null);
  const snapshot = useQuery({
    queryKey: ["shared-production-display"],
    queryFn: () => readSharedDisplay(token),
    enabled: Boolean(token),
    retry: false,
    gcTime: 0,
    // Keep retrying after transient network/server failures. Stopping polling on
    // the first error stranded an otherwise active station until manual refresh.
    refetchInterval: 5000,
    refetchOnWindowFocus: true,
  });
  useEffect(() => {
    const update = () => {
      setOnline(navigator.onLine);
      if (navigator.onLine) void snapshot.refetch();
    };
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, [snapshot.refetch]);
  const close = () => {
    setSelected(null);
    setPin("");
    setReason("");
    setMessage("");
  };
  const action = useMutation({
    retry: false,
    mutationFn: async () => {
      if (!online || !selected) throw new Error("Reconnect before submitting an action.");
      return actOnSharedDisplay(token, pin, { ...selected, reason });
    },
    onSettled: () => {
      setPin("");
    },
    onSuccess: (result) => {
      void qc.invalidateQueries({ queryKey: ["shared-production-display"] });
      if (!result.ok) {
        setMessage(result.message ?? "Action refused. Refresh and review the ticket.");
        return;
      }
      toast.success(
        `${result.idempotent ? "Already recorded" : "Recorded"} · ${result.actor_name ?? "Staff member"}`,
      );
      close();
    },
    onError: (error: Error) => {
      setMessage(
        `${error.message} Your PIN has been cleared. Enter it again to retry this action.`,
      );
    },
  });
  const data = snapshot.data;
  const disabled =
    !online ||
    Boolean(snapshot.error) ||
    action.isPending ||
    !data ||
    Date.parse(data.expires_at) <= Date.now();
  if (!token)
    return (
      <main className="mx-auto max-w-lg p-8">
        <h1 className="text-2xl font-semibold">Screen not paired</h1>
        <p className="my-4">
          A production supervisor must sign in, choose a property and station display, then pair
          this screen.
        </p>
        <Link to="/auth" search={{ redirect: "/production-displays" }}>
          Supervisor sign in
        </Link>
      </main>
    );
  return (
    <main
      ref={panel}
      className="min-h-screen space-y-5 bg-background p-4 text-foreground fullscreen:overflow-auto"
    >
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-sm text-muted-foreground">{data?.property ?? "Production"}</p>
          <h1 className="text-2xl font-semibold">{data?.label ?? "Shared production display"}</h1>
          <p className="text-sm">
            {data?.read_only
              ? "View only"
              : "Enter your personal PIN for every production action."}
          </p>
          {data ? (
            <p className="text-xs text-muted-foreground">
              Screen access expires {new Date(data.expires_at).toLocaleString()}
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            onClick={() => void snapshot.refetch()}
            disabled={snapshot.isFetching}
          >
            Refresh
          </Button>
          <Button
            variant="outline"
            onClick={async () => {
              try {
                if (document.fullscreenElement) await document.exitFullscreen();
                else await panel.current?.requestFullscreen();
              } catch {
                toast.error("Fullscreen is unavailable. Continue using this display here.");
              }
            }}
          >
            Toggle fullscreen
          </Button>
          <Link
            to="/auth"
            search={{ redirect: "/production-displays" }}
            className="rounded-md border px-4 py-2 text-sm"
          >
            Supervisor controls
          </Link>
        </div>
      </header>
      {!online ? (
        <p role="alert" className="rounded-lg border p-3">
          Offline — tickets may be out of date. Actions are disabled until reconnected.
        </p>
      ) : null}
      {snapshot.error ? (
        <p role="alert" className="rounded-lg border border-destructive p-3">
          {snapshot.error.message}
        </p>
      ) : null}
      {snapshot.isLoading ? <p role="status">Loading station tickets…</p> : null}
      {data ? (
        <>
          <nav aria-label="Shared display stations" className="flex flex-wrap gap-2">
            <Button
              variant={station === "all" ? "default" : "outline"}
              onClick={() => setStation("all")}
            >
              All paired stations
            </Button>
            {data.stations.map((s) => (
              <Button
                key={s.id}
                variant={station === s.id ? "default" : "outline"}
                onClick={() => setStation(s.id)}
              >
                {s.name}
              </Button>
            ))}
          </nav>
          {!data.tickets.length && !snapshot.error ? (
            <p className="rounded-lg border p-6">
              No live tickets. New orders appear here automatically.
            </p>
          ) : null}
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {data.tickets
              .filter((t) => station === "all" || t.station_id === station)
              .map((t) => (
                <TicketCard
                  key={t.ticket_id}
                  ticket={t}
                  readOnly={data.read_only}
                  allowedActions={productionActions(t.status)}
                  stationAuthority={!data.read_only}
                  busy={disabled}
                  onTransition={(to) => {
                    setSelected({
                      ticketId: t.ticket_id,
                      to,
                      expected: t.status,
                      requestId: crypto.randomUUID(),
                      reason: "",
                    });
                    setMessage("");
                  }}
                  onDelay={() => {
                    setSelected({
                      ticketId: t.ticket_id,
                      to: "delay",
                      expected: t.status,
                      requestId: crypto.randomUUID(),
                      reason: "",
                    });
                    setMessage("");
                  }}
                  footer={
                    <p className="w-full text-xs text-muted-foreground">
                      {t.claimed_by ? `Claimed by ${t.claimed_by}` : "Not yet claimed"}
                      {t.accepted_at
                        ? ` · accepted ${new Date(t.accepted_at).toLocaleTimeString()}`
                        : ""}
                    </p>
                  }
                />
              ))}
          </div>
        </>
      ) : null}
      <Dialog
        open={Boolean(selected)}
        onOpenChange={(open) => {
          if (!open && !action.isPending) close();
        }}
      >
        <DialogContent
          onEscapeKeyDown={(e) => {
            if (action.isPending) e.preventDefault();
          }}
          onPointerDownOutside={(e) => {
            if (action.isPending) e.preventDefault();
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {selected?.to === "delay"
                ? "Report delay"
                : titleCase(selected?.to ?? "Staff action")}
            </DialogTitle>
            <DialogDescription>
              Enter your unique six-digit PIN. NEØ identifies you and checks your station permissions.
            </DialogDescription>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              action.mutate();
            }}
          >
            <div>
              <Label htmlFor="display-pin">Personal PIN</Label>
              <Input
                id="display-pin"
                type="password"
                inputMode="numeric"
                autoComplete="off"
                value={pin}
                maxLength={6}
                pattern="[0-9]{6}"
                onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
                disabled={action.isPending}
                required
              />
            </div>
            <div className="mx-auto max-w-xs space-y-3">
              <p className="text-center text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Enter your personal PIN
              </p>
              <div className="grid grid-cols-3 gap-3">
                {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map((digit) => (
                  <Button
                    key={digit}
                    type="button"
                    variant="outline"
                    className="h-14 text-xl font-semibold"
                    disabled={action.isPending}
                    onClick={() => setPin((value) => (value + digit).slice(0, 6))}
                  >
                    {digit}
                  </Button>
                ))}
                <Button
                  type="button"
                  variant="outline"
                  className="h-14"
                  disabled={action.isPending}
                  onClick={() => setPin((value) => value.slice(0, -1))}
                >
                  Delete
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className="h-14 text-xl font-semibold"
                  disabled={action.isPending}
                  onClick={() => setPin((value) => (value + "0").slice(0, 6))}
                >
                  0
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  className="h-14"
                  disabled={action.isPending}
                  onClick={() => setPin("")}
                >
                  Clear
                </Button>
              </div>
            </div>
            {selected?.to === "delay" ? (
              <div>
                <Label htmlFor="display-reason">Reason for delay</Label>
                <Input
                  id="display-reason"
                  value={reason}
                  minLength={3}
                  maxLength={500}
                  required
                  onChange={(e) => setReason(e.target.value)}
                  disabled={action.isPending}
                />
              </div>
            ) : null}
            {message ? (
              <p role="alert" className="text-sm text-destructive">
                {message}
              </p>
            ) : null}
            <Button type="submit" disabled={disabled || pin.length !== 6}>
              {action.isPending ? "Recording…" : "Confirm staff action"}
            </Button>
          </form>
        </DialogContent>
      </Dialog>
    </main>
  );
}
