import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { PageHeader, SectionCard, StatCard, TableScroll } from "@/components/common/DataDisplay";
import { EmptyState, HrBadge, HrGuard, QueryState, SensitiveBlock } from "@/components/hr/HrShared";
import {
  PerformanceCycleDialog,
  PerformanceOutcomeDialog,
  PerformanceReviewDialog,
} from "@/components/hr/PerformanceDialogs";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAuth } from "@/lib/auth";
import { useDisciplinaryCases, usePerformanceCycles, usePerformanceReviews } from "@/lib/hr-data";
import {
  HR_MODULES,
  REVIEW_STATUSES,
  labelFor,
  shortDate,
  titleCase,
  toneFor,
  type Row,
} from "@/lib/hr";

export const Route = createFileRoute("/_shell/hr/performance")({
  head: () => ({
    meta: [
      { title: "Performance & Conduct — HOS Human Resources" },
      {
        name: "description",
        content: "Review cycles, appraisals and confidential disciplinary case handling.",
      },
      { property: "og:title", content: "Performance & Conduct — HOS Human Resources" },
      {
        property: "og:description",
        content: "Review cycles, appraisals and confidential disciplinary case handling.",
      },
    ],
  }),
  component: () => (
    <HrGuard module={HR_MODULES.performance} action="self.view">
      <PerformanceScreen />
    </HrGuard>
  ),
});

function PerformanceScreen() {
  const cycles = usePerformanceCycles();
  const reviews = usePerformanceReviews();
  const cases = useDisciplinaryCases();
  const { can } = useAuth();
  const mayCreate = can(HR_MODULES.performance, "create");
  const mayEdit = can(HR_MODULES.performance, "edit");

  const [cycleOpen, setCycleOpen] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [outcome, setOutcome] = useState<Row | null>(null);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Human Resources"
        title="Performance & Conduct"
        description="Reviews are released to employees deliberately. Disciplinary records stay confidential and can never be deleted."
        actions={
          mayCreate ? (
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setCycleOpen(true)}>
                New cycle
              </Button>
              <Button onClick={() => setReviewOpen(true)}>Open appraisal</Button>
            </div>
          ) : null
        }
      />

      <PerformanceCycleDialog open={cycleOpen} onOpenChange={setCycleOpen} />
      <PerformanceReviewDialog open={reviewOpen} onOpenChange={setReviewOpen} />
      {outcome ? (
        <PerformanceOutcomeDialog
          open={Boolean(outcome)}
          onOpenChange={(v) => !v && setOutcome(null)}
          review={outcome}
        />
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Review cycles" value={String((cycles.data ?? []).length)} />
        <StatCard label="Reviews" value={String((reviews.data ?? []).length)} />
        <StatCard
          label="Completed"
          value={String((reviews.data ?? []).filter((r) => r["status"] === "completed").length)}
          tone="success"
        />
        <StatCard
          label="Open cases"
          value={String((cases.data ?? []).filter((c) => c["status"] !== "closed").length)}
          tone="warning"
        />
      </div>

      <Tabs defaultValue="reviews">
        <TabsList>
          <TabsTrigger value="reviews">Reviews</TabsTrigger>
          <TabsTrigger value="cycles">Cycles</TabsTrigger>
          <TabsTrigger value="conduct">Conduct</TabsTrigger>
        </TabsList>

        <TabsContent value="reviews" className="mt-4">
          <SectionCard title="Performance reviews">
            <QueryState
              isLoading={reviews.isLoading}
              error={reviews.error}
              isEmpty={(reviews.data ?? []).length === 0}
              empty={
                <EmptyState
                  title="No reviews"
                  description="Start a review cycle to generate appraisals."
                />
              }
            >
              <TableScroll>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Employee</TableHead>
                      <TableHead>Cycle</TableHead>
                      <TableHead>Due</TableHead>
                      <TableHead className="text-right">Rating</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Action</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(reviews.data ?? []).map((r) => (
                      <TableRow key={String(r["id"])}>
                        <TableCell className="font-medium">
                          {(r["employees"] as Row | null)?.["full_name"] ?? "—"}
                        </TableCell>
                        <TableCell>
                          {(r["performance_cycles"] as Row | null)?.["name"] ?? "—"}
                        </TableCell>
                        <TableCell>{shortDate(r["due_date"])}</TableCell>
                        <TableCell className="text-right">
                          {r["final_rating"] == null ? "—" : String(r["final_rating"])}
                        </TableCell>
                        <TableCell>
                          <HrBadge
                            value={labelFor(REVIEW_STATUSES, r["status"])}
                            tone={toneFor(REVIEW_STATUSES, r["status"])}
                          />
                        </TableCell>
                        <TableCell className="text-right">
                          {mayEdit ? (
                            <Button size="sm" variant="outline" onClick={() => setOutcome(r)}>
                              {r["status"] === "completed" ? "Amend outcome" : "Record outcome"}
                            </Button>
                          ) : null}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableScroll>
            </QueryState>
          </SectionCard>
        </TabsContent>

        <TabsContent value="cycles" className="mt-4">
          <SectionCard title="Review cycles">
            <QueryState
              isLoading={cycles.isLoading}
              error={cycles.error}
              isEmpty={(cycles.data ?? []).length === 0}
              empty={
                <EmptyState
                  title="No cycles defined"
                  description="Create probation, quarterly or annual cycles."
                />
              }
            >
              <TableScroll>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Cycle</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Period</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(cycles.data ?? []).map((c) => (
                      <TableRow key={String(c["id"])}>
                        <TableCell className="font-medium">{String(c["name"])}</TableCell>
                        <TableCell>{titleCase(c["cycle_type"])}</TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {shortDate(c["period_start"])} → {shortDate(c["period_end"])}
                        </TableCell>
                        <TableCell>
                          <HrBadge value={c["status"]} tone="info" />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableScroll>
            </QueryState>
          </SectionCard>
        </TabsContent>

        <TabsContent value="conduct" className="mt-4">
          <SectionCard
            title="Disciplinary cases"
            description="Confidential — restricted to authorized HR staff."
          >
            <SensitiveBlock
              module={HR_MODULES.performance}
              action="disciplinary.manage"
              label="Disciplinary case handling"
            >
              <QueryState
                isLoading={cases.isLoading}
                error={cases.error}
                isEmpty={(cases.data ?? []).length === 0}
                empty={
                  <EmptyState
                    title="No cases"
                    description="Cases follow report → investigate → hear → decide → close."
                  />
                }
              >
                <TableScroll>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Case</TableHead>
                        <TableHead>Employee</TableHead>
                        <TableHead>Incident</TableHead>
                        <TableHead>Status</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {(cases.data ?? []).map((c) => (
                        <TableRow key={String(c["id"])}>
                          <TableCell className="font-mono text-xs">
                            {String(c["case_number"])}
                          </TableCell>
                          <TableCell className="font-medium">
                            {(c["employees"] as Row | null)?.["full_name"] ?? "—"}
                          </TableCell>
                          <TableCell>{shortDate(c["incident_date"])}</TableCell>
                          <TableCell>
                            <HrBadge
                              value={c["status"]}
                              tone={c["status"] === "closed" ? "default" : "warning"}
                            />
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </TableScroll>
              </QueryState>
            </SensitiveBlock>
          </SectionCard>
        </TabsContent>
      </Tabs>
    </div>
  );
}
