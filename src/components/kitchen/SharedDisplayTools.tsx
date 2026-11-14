import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
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
  onLogout,
  busy = false,
}: {
  stations: { id: string; name: string }[];
  station: string;
  onStationChange: (id: string) => void;
  compact: boolean;
  onCompactChange: (compact: boolean) => void;
  onLogout: () => void;
  busy?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        Supervisor tools
      </Button>
      <Button variant="outline" disabled={busy} onClick={onLogout}>
        Log out of display
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90dvh] overflow-hidden">
          <DialogHeader>
            <DialogTitle>Display tools</DialogTitle>
            <DialogDescription>
              Adjust this screen without leaving it. Production actions still require the employee’s
              PIN.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-5">
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
            <Button variant="outline" onClick={() => setOpen(false)}>
              Return to display
            </Button>
          </DialogBody>
        </DialogContent>
      </Dialog>
    </>
  );
}
