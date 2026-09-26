import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { PageHeader, SectionCard } from "@/components/common/DataDisplay";
import { EmptyState, QueryState, SecurityGuard } from "@/components/security/SecurityShared";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { StatusPill } from "@/components/common/DataDisplay";
import {
  securityStr,
  useCheckOutVisitor,
  useRecordVisitor,
  useSecurityPosts,
  useVisitorLogs,
  type SecurityRow,
} from "@/lib/security-department";

export const Route = createFileRoute("/_shell/security/visitors")({
  head: () => ({
    meta: [
      { title: "Visitor & Contractor Access — NEØ Security" },
      {
        name: "description",
        content:
          "Sign visitors and contractors in and out at the gate, record who they are visiting and see everyone currently on the property.",
      },
      { property: "og:title", content: "Visitor & Contractor Access — NEØ Security" },
      {
        property: "og:description",
        content: "A complete record of who entered the property, when and why.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: () => (
    <SecurityGuard feature="visitors">
      <VisitorsPage />
    </SecurityGuard>
  ),
});

function VisitorsPage() {
  const [onSiteOnly, setOnSiteOnly] = useState(true);
  const logs = useVisitorLogs(onSiteOnly);
  const posts = useSecurityPosts();
  const record = useRecordVisitor();
  const checkOut = useCheckOutVisitor();

  const [open, setOpen] = useState(false);
  const [visitorName, setVisitorName] = useState("");
  const [company, setCompany] = useState("");
  const [visitingPerson, setVisitingPerson] = useState("");
  const [visitingDepartment, setVisitingDepartment] = useState("");
  const [purpose, setPurpose] = useState("");
  const [vehicle, setVehicle] = useState("");
  const [postId, setPostId] = useState("none");
  const [notes, setNotes] = useState("");

  const rows = (logs.data ?? []) as SecurityRow[];

  function submit() {
    if (!visitorName.trim()) return;
    record.mutate(
      {
        visitorName,
        postId: postId === "none" ? null : postId,
        ...(company ? { company } : {}),
        ...(visitingPerson ? { visitingPerson } : {}),
        ...(visitingDepartment ? { visitingDepartment } : {}),
        ...(purpose ? { purpose } : {}),
        ...(vehicle ? { vehicle } : {}),
        ...(notes ? { notes } : {}),
      },
      {
        onSuccess: () => {
          setOpen(false);
          setVisitorName("");
          setCompany("");
          setVisitingPerson("");
          setVisitingDepartment("");
          setPurpose("");
          setVehicle("");
          setNotes("");
        },
      },
    );
  }

  return (
    <div>
      <PageHeader
        eyebrow="Security"
        title="Visitor and contractor access"
        description="Everyone who comes through the gate is recorded and signed out again. The log is permanent."
        actions={<Button onClick={() => setOpen(true)}>Sign in a visitor</Button>}
      />

      <SectionCard
        title={onSiteOnly ? "Currently on site" : "Full access log"}
        description="Newest entries first."
        actions={
          <Select
            value={onSiteOnly ? "on-site" : "all"}
            onValueChange={(v) => setOnSiteOnly(v === "on-site")}
          >
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="on-site">On site now</SelectItem>
              <SelectItem value="all">All records</SelectItem>
            </SelectContent>
          </Select>
        }
      >
        <QueryState
          isLoading={logs.isLoading}
          error={logs.error}
          isEmpty={rows.length === 0}
          empty={
            <EmptyState title="No visitor records" description="Nothing has been signed in yet." />
          }
        >
          <div className="space-y-2">
            {rows.map((r) => {
              const out = r["time_out"];
              return (
                <div
                  key={String(r["id"])}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/70 p-3"
                >
                  <div>
                    <p className="text-sm font-medium">
                      {securityStr(r["visitor_name"])}
                      {r["company"] ? ` · ${securityStr(r["company"])}` : ""}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Visiting {securityStr(r["visiting_person"], "—")}
                      {r["visiting_department"]
                        ? ` (${securityStr(r["visiting_department"])})`
                        : ""}{" "}
                      · {securityStr(r["purpose"], "Purpose not recorded")}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      In {new Date(String(r["time_in"])).toLocaleString()}
                      {out ? ` · Out ${new Date(String(out)).toLocaleString()}` : ""}
                      {r["vehicle_registration"]
                        ? ` · ${securityStr(r["vehicle_registration"])}`
                        : ""}
                    </p>
                  </div>
                  {out ? (
                    <StatusPill tone="default">Signed out</StatusPill>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={checkOut.isPending}
                      onClick={() => checkOut.mutate(String(r["id"]))}
                    >
                      Sign out
                    </Button>
                  )}
                </div>
              );
            })}
          </div>
        </QueryState>
      </SectionCard>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Sign in a visitor</DialogTitle>
            <DialogDescription>
              Record who is entering and who they are here to see.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            <div className="grid gap-2">
              <Label htmlFor="visitor-name">Visitor name</Label>
              <Input
                id="visitor-name"
                value={visitorName}
                onChange={(e) => setVisitorName(e.target.value)}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="visitor-company">Company</Label>
              <Input
                id="visitor-company"
                value={company}
                onChange={(e) => setCompany(e.target.value)}
              />
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-2">
                <Label htmlFor="visitor-person">Visiting</Label>
                <Input
                  id="visitor-person"
                  value={visitingPerson}
                  onChange={(e) => setVisitingPerson(e.target.value)}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="visitor-dept">Department</Label>
                <Input
                  id="visitor-dept"
                  value={visitingDepartment}
                  onChange={(e) => setVisitingDepartment(e.target.value)}
                />
              </div>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="visitor-purpose">Purpose</Label>
              <Input
                id="visitor-purpose"
                value={purpose}
                onChange={(e) => setPurpose(e.target.value)}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="visitor-vehicle">Vehicle registration</Label>
              <Input
                id="visitor-vehicle"
                value={vehicle}
                onChange={(e) => setVehicle(e.target.value)}
              />
            </div>
            <div className="grid gap-2">
              <Label>Post</Label>
              <Select value={postId} onValueChange={setPostId}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">No specific post</SelectItem>
                  {((posts.data ?? []) as SecurityRow[]).map((p) => (
                    <SelectItem key={String(p["id"])} value={String(p["id"])}>
                      {securityStr(p["name"])}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="visitor-notes">Notes</Label>
              <Textarea
                id="visitor-notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={2}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={submit} disabled={record.isPending || !visitorName.trim()}>
              Sign in
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
