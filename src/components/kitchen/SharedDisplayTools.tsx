import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

/** Local view settings do not widen the paired station scope or skip per-action PIN checks. */
export function SharedDisplayTools({
  stations,
  station,
  onStationChange,
  compact,
  onCompactChange,
  onApprove,
  onLogout,
  busy = false,
}: {
  stations: { id: string; name: string }[];
  station: string;
  onStationChange: (id: string) => void;
  compact: boolean;
  onCompactChange: (compact: boolean) => void;
  onApprove: (pin: string, mode: "tools" | "logout") => Promise<void>;
  onLogout: () => void;
  busy?: boolean;
}) {
  const [mode, setMode] = useState<"tools" | "logout" | null>(null);
  const [approved, setApproved] = useState(false);
  const [pin, setPin] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const close = () => {
    setMode(null);
    setApproved(false);
    setPin("");
    setMessage("");
  };
  return (
    <>
      <Button variant="outline" disabled={busy || pending} onClick={() => setMode("tools")}>
        Supervisor tools
      </Button>
      <Button variant="outline" disabled={busy || pending} onClick={() => setMode("logout")}>
        Log out of display
      </Button>
      <Dialog open={mode !== null} onOpenChange={(open) => { if (!open && !pending) close(); }}>
        <DialogContent className="max-h-[90dvh] overflow-hidden">
          <DialogHeader>
            <DialogTitle>{approved ? "Display tools" : mode === "logout" ? "Log out of display" : "Supervisor approval"}</DialogTitle>
            <DialogDescription>
              {approved ? "Adjust this screen without leaving it." : "Enter the personal PIN of a supervisor assigned to this screen."}
            </DialogDescription>
          </DialogHeader>
          {approved ? <DialogBody className="space-y-5">
            <div className="space-y-2">
              <Label htmlFor="display-station-filter">Stations shown</Label>
              <select
                id="display-station-filter"
                className="min-h-11 w-full rounded-md border bg-background p-2"
                value={station}
                onChange={(event) => onStationChange(event.target.value)}
              >
                <option value="all">All paired stations</option>
                {stations.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">
                Only stations already authorised for this display are available.
              </p>
            </div>
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="display-compact">Compact spacing</Label>
              <Switch id="display-compact" checked={compact} onCheckedChange={onCompactChange} />
            </div>
            <div className="space-y-2 border-t pt-4">
              <p className="text-sm">
                Changing the paired property, department or access needs a supervisor sign-in. The
                current pairing stays available until you explicitly replace or revoke it.
              </p>
              <Button asChild variant="outline">
                <Link to="/auth" search={{ redirect: "/production-displays" }}>
                  Change paired display / access
                </Link>
              </Button>
            </div>
            <Button variant="outline" onClick={close}>
              Return to display
            </Button>
          </DialogBody> : <DialogBody>
            <form className="space-y-3" onSubmit={async (event) => {
              event.preventDefault();
              if (!mode || pin.length !== 6 || pending) return;
              setPending(true);
              setMessage("");
              try {
                await onApprove(pin, mode);
                if (mode === "logout") { close(); onLogout(); }
                else setApproved(true);
              } catch (error) {
                setMessage(error instanceof Error ? error.message : "Supervisor approval failed.");
              } finally {
                setPending(false);
                setPin("");
              }
            }}>
              <Label htmlFor="display-supervisor-pin">Personal PIN</Label>
              <Input id="display-supervisor-pin" type="password" inputMode="numeric" autoComplete="off"
                value={pin} maxLength={6} disabled={pending} onChange={(event) => setPin(event.target.value.replace(/\D/g, ""))} />
              {message ? <p role="alert">{message}</p> : null}
              <Button type="submit" disabled={pending || pin.length !== 6}>{pending ? "Checking…" : "Approve"}</Button>
            </form>
          </DialogBody>}
        </DialogContent>
      </Dialog>
    </>
  );
}
