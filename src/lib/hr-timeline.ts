/**
 * Employee timeline.
 *
 * The timeline is never stored: it is assembled from the records themselves —
 * employment history, leave, documents, training, performance, conduct,
 * assets and exit — so it can never disagree with them.
 */

import type { Row } from "@/lib/hr";
import { titleCase } from "@/lib/hr";

export type TimelineTone = "default" | "success" | "warning" | "info" | "destructive";

export type TimelineEvent = {
  id: string;
  date: string;
  title: string;
  detail: string;
  group: string;
  tone: TimelineTone;
};

export type TimelineSources = {
  employee?: Row | null;
  history?: readonly Row[];
  leave?: readonly Row[];
  documents?: readonly Row[];
  training?: readonly Row[];
  reviews?: readonly Row[];
  cases?: readonly Row[];
  assets?: readonly Row[];
  clearances?: readonly Row[];
  attendance?: readonly Row[];
  shifts?: readonly Row[];
  candidate?: Row | null;
};

function iso(value: unknown): string | null {
  if (!value) return null;
  const d = new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function push(out: TimelineEvent[], event: Omit<TimelineEvent, "date"> & { date: unknown }) {
  const date = iso(event.date);
  if (!date) return;
  out.push({ ...event, date });
}

const HISTORY_TONE: Record<string, TimelineTone> = {
  promotion: "success",
  transfer: "info",
  separation: "destructive",
  salary_change: "info",
  confirmation: "success",
};

/** Builds one dated stream of the employee's working life, newest first. */
export function buildEmployeeTimeline(sources: TimelineSources): TimelineEvent[] {
  const out: TimelineEvent[] = [];
  const emp = sources.employee ?? null;

  if (emp) {
    push(out, {
      id: `joined-${emp["id"]}`,
      date: emp["employment_date"],
      title: "Joined the company",
      detail: [emp["job_title"], emp["employment_type"] ? titleCase(emp["employment_type"]) : null]
        .filter(Boolean)
        .join(" · "),
      group: "Employment",
      tone: "success",
    });
    push(out, {
      id: `probation-start-${emp["id"]}`,
      date: emp["probation_start_date"],
      title: "Probation started",
      detail: "Probation period opened.",
      group: "Employment",
      tone: "info",
    });
    push(out, {
      id: `probation-end-${emp["id"]}`,
      date: emp["probation_end_date"],
      title: "Probation end date",
      detail: "Confirm, extend or end probation on this date.",
      group: "Employment",
      tone: "warning",
    });
    push(out, {
      id: `contract-start-${emp["id"]}`,
      date: emp["contract_start"],
      title: "Contract issued",
      detail: "Employment contract start date.",
      group: "Employment",
      tone: "info",
    });
    push(out, {
      id: `contract-end-${emp["id"]}`,
      date: emp["contract_end"],
      title: "Contract end date",
      detail: "Renewal or exit planning falls due here.",
      group: "Employment",
      tone: "warning",
    });
  }

  if (sources.candidate) {
    const c = sources.candidate;
    push(out, {
      id: `applied-${c["id"]}`,
      date: c["application_date"] ?? c["created_at"],
      title: "Applied for a position",
      detail: String(c["position_applied"] ?? c["source"] ?? "Recruitment application"),
      group: "Recruitment",
      tone: "default",
    });
  }

  for (const h of sources.history ?? []) {
    push(out, {
      id: `history-${h["id"]}`,
      date: h["effective_date"] ?? h["created_at"],
      title: titleCase(h["change_type"]),
      detail: String(h["reason"] ?? "Recorded employment change."),
      group: "Employment",
      tone: HISTORY_TONE[String(h["change_type"])] ?? "info",
    });
  }

  for (const l of sources.leave ?? []) {
    const type = String(l["leave_types"]?.["name"] ?? "Leave");
    push(out, {
      id: `leave-req-${l["id"]}`,
      date: l["created_at"],
      title: `${type} requested`,
      detail: `${l["days"] ?? 0} day(s) from ${String(l["start_date"] ?? "")}.`,
      group: "Leave",
      tone: "default",
    });
    if (l["status"] === "approved" || l["status"] === "taken") {
      push(out, {
        id: `leave-app-${l["id"]}`,
        date: l["approved_at"] ?? l["updated_at"],
        title: `${type} approved`,
        detail: `${l["days"] ?? 0} day(s) to ${String(l["end_date"] ?? "")}.`,
        group: "Leave",
        tone: "success",
      });
    }
    if (l["status"] === "taken") {
      push(out, {
        id: `leave-taken-${l["id"]}`,
        date: l["end_date"],
        title: `${type} taken`,
        detail: "Leave completed and deducted from the balance.",
        group: "Leave",
        tone: "info",
      });
    }
    if (l["status"] === "rejected") {
      push(out, {
        id: `leave-rej-${l["id"]}`,
        date: l["decided_at"] ?? l["updated_at"],
        title: `${type} rejected`,
        detail: String(l["decision_notes"] ?? "Request declined."),
        group: "Leave",
        tone: "destructive",
      });
    }
  }

  for (const d of sources.documents ?? []) {
    push(out, {
      id: `doc-${d["id"]}`,
      date: d["created_at"],
      title: `Document filed — ${String(d["title"] ?? "")}`,
      detail: titleCase(d["category"]),
      group: "Documents",
      tone: "default",
    });
  }

  for (const t of sources.training ?? []) {
    push(out, {
      id: `training-${t["id"]}`,
      date: t["completed_at"] ?? t["completion_date"] ?? t["created_at"],
      title: "Training completed",
      detail: String(t["training_sessions"]?.["title"] ?? t["title"] ?? "Training record"),
      group: "Training",
      tone: "success",
    });
  }

  for (const r of sources.reviews ?? []) {
    push(out, {
      id: `review-${r["id"]}`,
      date: r["review_date"] ?? r["period_end"] ?? r["created_at"],
      title: "Performance appraisal",
      detail: String(r["overall_rating"] ? `Rating ${r["overall_rating"]}` : titleCase(r["status"])),
      group: "Performance",
      tone: "info",
    });
  }

  for (const c of sources.cases ?? []) {
    push(out, {
      id: `case-${c["id"]}`,
      date: c["incident_date"] ?? c["created_at"],
      title: titleCase(c["case_type"] ?? "Conduct case"),
      detail: String(c["outcome"] ?? titleCase(c["status"])),
      group: "Conduct",
      tone: "destructive",
    });
  }

  for (const a of sources.assets ?? []) {
    push(out, {
      id: `asset-${a["id"]}`,
      date: a["issued_date"] ?? a["created_at"],
      title: "Asset issued",
      detail: String(a["assets"]?.["name"] ?? a["item_name"] ?? "Company asset"),
      group: "Assets",
      tone: "default",
    });
  }

  for (const c of sources.clearances ?? []) {
    push(out, {
      id: `exit-${c["id"]}`,
      date: c["last_working_day"] ?? c["notice_date"] ?? c["created_at"],
      title: "Exit recorded",
      detail: titleCase(c["separation_type"] ?? "Separation"),
      group: "Exit",
      tone: "destructive",
    });
  }

  for (const a of sources.attendance ?? []) {
    const status = String(a["status"] ?? "");
    const late = Number(a["late_minutes"] ?? 0);
    if (status !== "absent" && status !== "incomplete" && late <= 0) continue;
    const worked = Number(a["worked_minutes"] ?? 0);
    push(out, {
      id: `attendance-${a["id"]}`,
      date: a["work_date"],
      title:
        status === "absent"
          ? "Absent"
          : status === "incomplete"
            ? "Incomplete attendance"
            : `Late by ${late} minutes`,
      detail:
        status === "absent"
          ? String(a["notes"] ?? "Recorded as absent.")
          : `${Math.floor(worked / 60)}h ${worked % 60}m recorded.`,
      group: "Attendance",
      tone: status === "absent" ? "destructive" : "warning",
    });
  }

  for (const s of sources.shifts ?? []) {
    const template = s["shift_templates"] as Row | null;
    push(out, {
      id: `shift-${s["id"]}`,
      date: s["shift_date"],
      title: `Shift — ${String(template?.["name"] ?? "Assigned shift")}`,
      detail: [
        template?.["start_time"] && template?.["end_time"]
          ? `${String(template["start_time"])} – ${String(template["end_time"])}`
          : null,
        titleCase(s["status"] ?? "scheduled"),
      ]
        .filter(Boolean)
        .join(" · "),
      group: "Scheduling",
      tone: s["status"] === "cancelled" ? "destructive" : "info",
    });
  }

  return out.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}
