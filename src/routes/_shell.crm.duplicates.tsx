/**
 * Duplicate people review.
 *
 * The scan matches on email, normalised phone and recorded identity documents
 * and writes what it finds to a register. Nothing merges on its own: a person
 * confirms or rejects each pair in writing, and only then can the two records
 * be merged — choosing which one survives.
 */
import { useMemo, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { RefreshCcw } from "lucide-react";
import { LoadingState } from "@/components/common/StateSystem";
import { OpsGuard } from "@/components/operations/OpsShared";
import { PageHeader, SectionCard, StatusPill } from "@/components/common/DataDisplay";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAuth } from "@/lib/auth";
import {
  MATCH_REASON_LABEL,
  useDuplicatePeople,
  useDuplicateRegister,
  useMergeDuplicate,
  useReviewDuplicate,
  useScanDuplicates,
  type DuplicateEntity,
} from "@/lib/duplicate-resolver";

export const Route = createFileRoute("/_shell/crm/duplicates")({
  head: () => ({
    meta: [
      { title: "Duplicate Review — Guest & Staff Records" },
      {
        name: "description",
        content:
          "Review possible duplicate guest and staff records matched on email, phone and identity documents, record a written decision, and merge only what a person has confirmed.",
      },
      { property: "og:title", content: "Duplicate Review — Guest & Staff Records" },
      {
        property: "og:description",
        content: "Matched on email, phone and identity documents — confirmed by a person before anything merges.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: GuardedPage,
});

const STATUS_TONE: Record<string, "warning" | "success" | "default"> = {
  pending: "warning",
  confirmed: "success",
  rejected: "default",
  merged: "success",
};

function Page() {
  const { organizationId, can } = useAuth();
  const [entity, setEntity] = useState<DuplicateEntity>("customer");
  const [notes, setNotes] = useState<Record<string, string>>({});

  const register = useDuplicateRegister(entity, organizationId);
  const scan = useScanDuplicates();
  const review = useReviewDuplicate();
  const merge = useMergeDuplicate();

  const ids = useMemo(
    () => (register.data ?? []).flatMap((c) => [c.primary_id, c.duplicate_id]),
    [register.data],
  );
  const people = useDuplicatePeople(entity, ids);

  const canDecide =
    entity === "customer" ? can("marketing", "edit") : can("hr", "edit");

  function describe(id: string) {
    const row = people.data?.[id];
    if (!row) return { title: id.slice(0, 8), detail: "Record not visible" };
    return {
      title: (row["full_name"] as string) ?? "Unnamed",
      detail: [
        row["customer_number"] ?? row["employee_number"],
        row["email"] ?? row["work_email"] ?? row["personal_email"] ?? "no email",
        row["phone"] ?? "no phone",
      ]
        .filter(Boolean)
        .join(" · "),
    };
  }

  return (
    <div className="p-6">
      <PageHeader
        title="Duplicate review"
        description="Nothing is merged automatically. Each pair is matched on hard evidence and waits for a written decision."
        actions={
          <Button disabled={!canDecide || scan.isPending} onClick={() => scan.mutate(entity)}>
            <RefreshCcw className="mr-2 h-4 w-4" /> Run scan
          </Button>
        }
      />

      <Tabs value={entity} onValueChange={(v) => setEntity(v as DuplicateEntity)} className="mb-6">
        <TabsList>
          <TabsTrigger value="customer">Guests</TabsTrigger>
          <TabsTrigger value="employee">Staff</TabsTrigger>
        </TabsList>
      </Tabs>

      {register.isLoading ? (
        <LoadingState variant="cards" rows={3} />
      ) : !register.data?.length ? (
        <SectionCard title="No possible duplicates recorded">
          <p className="py-6 text-center text-sm text-muted-foreground">
            Run the scan to check email addresses, phone numbers and identity documents for records that look like the
            same person.
          </p>
        </SectionCard>
      ) : (
        <div className="space-y-4">
          {register.data.map((candidate) => {
            const a = describe(candidate.primary_id);
            const b = describe(candidate.duplicate_id);
            const note = notes[candidate.id] ?? "";
            return (
              <SectionCard
                key={candidate.id}
                title={`${a.title} ↔ ${b.title}`}
                description={candidate.match_reasons
                  .map((r) => MATCH_REASON_LABEL[r] ?? r)
                  .join(" · ")}
              >
                <div className="mb-3 flex flex-wrap items-center gap-2">
                  <StatusPill tone={STATUS_TONE[candidate.status] ?? "default"}>
                    {candidate.status === "pending" ? "Awaiting decision" : candidate.status}
                  </StatusPill>
                  <span className="text-xs text-muted-foreground">
                    Confidence {Math.round(Number(candidate.match_score) * 100)}%
                  </span>
                  {candidate.decision_note ? (
                    <span className="text-xs text-muted-foreground">· {candidate.decision_note}</span>
                  ) : null}
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  {[
                    { id: candidate.primary_id, info: a },
                    { id: candidate.duplicate_id, info: b },
                  ].map(({ id, info }) => (
                    <div key={id} className="rounded-md border border-border p-3">
                      <p className="font-medium">{info.title}</p>
                      <p className="text-xs text-muted-foreground">{info.detail}</p>
                      {candidate.status === "confirmed" ? (
                        <Button
                          className="mt-3"
                          size="sm"
                          variant="outline"
                          disabled={!canDecide || merge.isPending || !note.trim()}
                          onClick={() =>
                            merge.mutate({ candidate: candidate.id, survivor: id, reason: note.trim() })
                          }
                        >
                          Keep this one, merge the other
                        </Button>
                      ) : null}
                    </div>
                  ))}
                </div>

                {candidate.status === "pending" || candidate.status === "confirmed" ? (
                  <div className="mt-4 space-y-2">
                    <Input
                      value={note}
                      onChange={(e) => setNotes((prev) => ({ ...prev, [candidate.id]: e.target.value }))}
                      placeholder={
                        candidate.status === "confirmed"
                          ? "Why these are being merged (recorded)"
                          : "What you checked before deciding (recorded)"
                      }
                    />
                    {candidate.status === "pending" ? (
                      <div className="flex flex-wrap gap-2">
                        <Button
                          size="sm"
                          disabled={!canDecide || !note.trim() || review.isPending}
                          onClick={() =>
                            review.mutate({ candidate: candidate.id, decision: "confirmed", note: note.trim() })
                          }
                        >
                          Same person
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={!canDecide || !note.trim() || review.isPending}
                          onClick={() =>
                            review.mutate({ candidate: candidate.id, decision: "rejected", note: note.trim() })
                          }
                        >
                          Different people
                        </Button>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </SectionCard>
            );
          })}
        </div>
      )}
    </div>
  );
}

// Money and customer records: the screen asks for the capability its route
// declares, so the menu and the page can never disagree.
function GuardedPage() {
  return (
    <OpsGuard path="/crm/duplicates">
      <Page />
    </OpsGuard>
  );
}
