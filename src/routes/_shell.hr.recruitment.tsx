import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { PageHeader, SectionCard, StatCard, TableScroll } from "@/components/common/DataDisplay";
import { EmptyState, HrBadge, HrGuard, QueryState } from "@/components/hr/HrShared";
import {
  CandidateDialog,
  HireDialog,
  InterviewDialog,
  OfferDialog,
  RowAction,
  VacancyDialog,
} from "@/components/hr/RecruitmentDialogs";
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
import {
  useCandidates,
  useHrWrite,
  useInterviews,
  useOffers,
  useVacancies,
} from "@/lib/hr-data";
import {
  CANDIDATE_STAGES,
  HR_MODULES,
  VACANCY_STATUSES,
  labelFor,
  shortDate,
  shortDateTime,
  toneFor,
  type Row,
} from "@/lib/hr";

export const Route = createFileRoute("/_shell/hr/recruitment")({
  head: () => ({
    meta: [
      { title: "Recruitment — HOS Human Resources" },
      {
        name: "description",
        content: "Vacancies, candidate pipeline, interviews and employment offers.",
      },
      { property: "og:title", content: "Recruitment — HOS Human Resources" },
      {
        property: "og:description",
        content: "Vacancies, candidate pipeline, interviews and employment offers.",
      },
    ],
  }),
  component: () => (
    <HrGuard module={HR_MODULES.recruitment} action="vacancies.view">
      <RecruitmentScreen />
    </HrGuard>
  ),
});

function RecruitmentScreen() {
  const { can } = useAuth();
  const vacancies = useVacancies();
  const candidates = useCandidates();
  const interviews = useInterviews();
  const offers = useOffers();

  const mayManage =
    can(HR_MODULES.recruitment, "vacancies.manage") ||
    can(HR_MODULES.recruitment, "vacancies.create") ||
    can(HR_MODULES.recruitment, "edit");
  const mayHire =
    can(HR_MODULES.recruitment, "offers.manage") || can(HR_MODULES.employees, "create");

  const [openVacancy, setOpenVacancy] = useState(false);
  const [openCandidate, setOpenCandidate] = useState(false);
  const [openInterview, setOpenInterview] = useState(false);
  const [openOffer, setOpenOffer] = useState(false);
  const [hireOffer, setHireOffer] = useState<Row | null>(null);

  const vacancyStatus = useHrWrite("vacancies", { action: "hr.vacancy.status" });
  const offerWrite = useHrWrite("employment_offers", { action: "hr.offer.status" });

  const hireCandidate = hireOffer
    ? ((candidates.data ?? []).find(
        (c) => String(c["id"]) === String(hireOffer["candidate_id"]),
      ) ?? null)
    : null;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Human Resources"
        title="Recruitment"
        description="Candidates are kept separate from employees until an offer is accepted and the record is converted."
        actions={
          mayManage ? (
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={() => setOpenVacancy(true)}>
                Raise vacancy
              </Button>
              <Button variant="outline" onClick={() => setOpenCandidate(true)}>
                Capture candidate
              </Button>
              <Button variant="outline" onClick={() => setOpenInterview(true)}>
                Schedule interview
              </Button>
              <Button onClick={() => setOpenOffer(true)}>Issue offer</Button>
            </div>
          ) : null
        }
      />

      {mayManage ? (
        <>
          <VacancyDialog open={openVacancy} onOpenChange={setOpenVacancy} />
          <CandidateDialog open={openCandidate} onOpenChange={setOpenCandidate} />
          <InterviewDialog open={openInterview} onOpenChange={setOpenInterview} />
          <OfferDialog open={openOffer} onOpenChange={setOpenOffer} />
        </>
      ) : null}

      {hireOffer ? (
        <HireDialog
          offer={hireOffer}
          candidate={hireCandidate}
          open={Boolean(hireOffer)}
          onOpenChange={(v) => {
            if (!v) setHireOffer(null);
          }}
        />
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Vacancies" value={String((vacancies.data ?? []).length)} />
        <StatCard label="Candidates" value={String((candidates.data ?? []).length)} />
        <StatCard
          label="Interviews"
          value={String((interviews.data ?? []).length)}
          tone="warning"
        />
        <StatCard label="Offers" value={String((offers.data ?? []).length)} tone="success" />
      </div>

      <Tabs defaultValue="vacancies">
        <TabsList>
          <TabsTrigger value="vacancies">Vacancies</TabsTrigger>
          <TabsTrigger value="candidates">Candidates</TabsTrigger>
          <TabsTrigger value="interviews">Interviews</TabsTrigger>
          <TabsTrigger value="offers">Offers</TabsTrigger>
        </TabsList>

        <TabsContent value="vacancies" className="mt-4">
          <SectionCard
            title="Vacancies"
            description="Raised by a department, approved before publishing."
          >
            <QueryState
              isLoading={vacancies.isLoading}
              error={vacancies.error}
              isEmpty={(vacancies.data ?? []).length === 0}
              empty={
                <EmptyState
                  title="No vacancies"
                  description="Raise a vacancy to start a recruitment cycle."
                />
              }
            >
              <TableScroll>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Reference</TableHead>
                      <TableHead>Position</TableHead>
                      <TableHead>Department</TableHead>
                      <TableHead className="text-right">Positions</TableHead>
                      <TableHead>Status</TableHead>
                      {mayManage ? <TableHead className="text-right">Action</TableHead> : null}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(vacancies.data ?? []).map((v) => (
                      <TableRow key={String(v["id"])}>
                        <TableCell className="font-mono text-xs">
                          {String(v["vacancy_number"])}
                        </TableCell>
                        <TableCell className="font-medium">{String(v["job_title"])}</TableCell>
                        <TableCell>{(v["departments"] as Row | null)?.["name"] ?? "—"}</TableCell>
                        <TableCell className="text-right">{Number(v["positions"] ?? 1)}</TableCell>
                        <TableCell>
                          <HrBadge
                            value={labelFor(VACANCY_STATUSES, v["status"])}
                            tone={toneFor(VACANCY_STATUSES, v["status"])}
                          />
                        </TableCell>
                        {mayManage ? (
                          <TableCell className="text-right">
                            {v["status"] === "draft" || v["status"] === "approved" ? (
                              <RowAction
                                label="Open vacancy"
                                busy={vacancyStatus.isPending}
                                onClick={() =>
                                  vacancyStatus.mutate({
                                    id: String(v["id"]),
                                    values: { status: "open" },
                                  })
                                }
                              />
                            ) : v["status"] === "open" || v["status"] === "shortlisting" ? (
                              <RowAction
                                label="Close vacancy"
                                busy={vacancyStatus.isPending}
                                onClick={() =>
                                  vacancyStatus.mutate({
                                    id: String(v["id"]),
                                    values: { status: "closed" },
                                  })
                                }
                              />
                            ) : (
                              <span className="text-xs text-muted-foreground">—</span>
                            )}
                          </TableCell>
                        ) : null}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableScroll>
            </QueryState>
          </SectionCard>
        </TabsContent>

        <TabsContent value="candidates" className="mt-4">
          <SectionCard
            title="Candidate pipeline"
            description="Candidate personal data is restricted to recruiters and hiring managers."
          >
            <QueryState
              isLoading={candidates.isLoading}
              error={candidates.error}
              isEmpty={(candidates.data ?? []).length === 0}
              empty={
                <EmptyState
                  title="No candidates"
                  description="Applications appear here as they are captured."
                />
              }
            >
              <TableScroll>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Candidate</TableHead>
                      <TableHead>Applied for</TableHead>
                      <TableHead>Source</TableHead>
                      <TableHead>Stage</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(candidates.data ?? []).map((c) => (
                      <TableRow key={String(c["id"])}>
                        <TableCell className="font-medium">{String(c["full_name"])}</TableCell>
                        <TableCell>
                          {(c["vacancies"] as Row | null)?.["job_title"] ?? "—"}
                        </TableCell>
                        <TableCell>{String(c["source"])}</TableCell>
                        <TableCell>
                          <HrBadge
                            value={labelFor(CANDIDATE_STAGES, c["status"])}
                            tone={toneFor(CANDIDATE_STAGES, c["status"])}
                          />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableScroll>
            </QueryState>
          </SectionCard>
        </TabsContent>

        <TabsContent value="interviews" className="mt-4">
          <SectionCard title="Interviews">
            <QueryState
              isLoading={interviews.isLoading}
              error={interviews.error}
              isEmpty={(interviews.data ?? []).length === 0}
              empty={
                <EmptyState
                  title="No interviews scheduled"
                  description="Panel members see only the interviews they sit on."
                />
              }
            >
              <TableScroll>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Candidate</TableHead>
                      <TableHead>When</TableHead>
                      <TableHead>Type</TableHead>
                      <TableHead>Status</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(interviews.data ?? []).map((i) => (
                      <TableRow key={String(i["id"])}>
                        <TableCell className="font-medium">
                          {(i["candidates"] as Row | null)?.["full_name"] ?? "—"}
                        </TableCell>
                        <TableCell>{shortDateTime(i["scheduled_at"])}</TableCell>
                        <TableCell>{String(i["interview_type"])}</TableCell>
                        <TableCell>
                          <HrBadge value={i["status"]} tone="info" />
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableScroll>
            </QueryState>
          </SectionCard>
        </TabsContent>

        <TabsContent value="offers" className="mt-4">
          <SectionCard
            title="Employment offers"
            description="An accepted offer is converted into an employee record — it never creates a login by itself."
          >
            <QueryState
              isLoading={offers.isLoading}
              error={offers.error}
              isEmpty={(offers.data ?? []).length === 0}
              empty={
                <EmptyState
                  title="No offers issued"
                  description="Approved offers appear here with their acceptance status."
                />
              }
            >
              <TableScroll>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Candidate</TableHead>
                      <TableHead>Position</TableHead>
                      <TableHead>Start</TableHead>
                      <TableHead>Approval</TableHead>
                      <TableHead>Acceptance</TableHead>
                      {mayManage ? <TableHead className="text-right">Action</TableHead> : null}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(offers.data ?? []).map((o) => (
                      <TableRow key={String(o["id"])}>
                        <TableCell className="font-medium">
                          {(o["candidates"] as Row | null)?.["full_name"] ?? "—"}
                        </TableCell>
                        <TableCell>{String(o["job_title"])}</TableCell>
                        <TableCell>{shortDate(o["proposed_start_date"])}</TableCell>
                        <TableCell>
                          <HrBadge value={o["approval_status"]} tone="warning" />
                        </TableCell>
                        <TableCell>
                          <HrBadge
                            value={o["acceptance_status"]}
                            tone={o["acceptance_status"] === "accepted" ? "success" : "default"}
                          />
                        </TableCell>
                        {mayManage ? (
                          <TableCell className="text-right">
                            {o["approval_status"] !== "approved" ? (
                              <RowAction
                                label="Approve offer"
                                busy={offerWrite.isPending}
                                onClick={() =>
                                  offerWrite.mutate({
                                    id: String(o["id"]),
                                    values: { approval_status: "approved" },
                                  })
                                }
                              />
                            ) : o["acceptance_status"] !== "accepted" ? (
                              <RowAction
                                label="Record acceptance"
                                busy={offerWrite.isPending}
                                onClick={() =>
                                  offerWrite.mutate({
                                    id: String(o["id"]),
                                    values: { acceptance_status: "accepted" },
                                  })
                                }
                              />
                            ) : mayHire ? (
                              <RowAction label="Hire" onClick={() => setHireOffer(o)} />
                            ) : (
                              <span className="text-xs text-muted-foreground">—</span>
                            )}
                          </TableCell>
                        ) : null}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableScroll>
            </QueryState>
          </SectionCard>
        </TabsContent>
      </Tabs>
    </div>
  );
}
