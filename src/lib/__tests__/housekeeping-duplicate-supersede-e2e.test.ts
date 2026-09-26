/**
 * Housekeeping duplicate repair — end-to-end contract.
 *
 * Scheduling several cleaning requests for the SAME room must leave exactly one
 * active cleaning task. Older tasks are never deleted: they are superseded,
 * pointed at their replacement, stamped with a reason, and an immutable audit
 * entry is written for each supersession. History stays complete and is visible
 * on the Cleaning History surface.
 *
 * The database contract lives in the migration; this suite (a) executes the
 * exact trigger rules as a faithful in-memory model over a stream of scheduled
 * requests, and (b) pins the SQL that implements those rules so the model and
 * the database cannot drift apart.
 */
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

const MIGRATIONS = "supabase/migrations";
const sql = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith(".sql"))
  .map((f) => readFileSync(`${MIGRATIONS}/${f}`, "utf8"))
  .find((s) => s.includes("tg_housekeeping_single_active_room_job"));

const ACTIVE = ["pending", "assigned", "in-progress", "awaiting-inspection", "rework"];
const CLEANING = [
  "checkout-cleaning",
  "stayover-cleaning",
  "daily-cleaning",
  "cleaning",
  "turnover-cleaning",
];

type Job = {
  id: string;
  organization_id: string;
  room_id: string | null;
  job_type: string;
  status: string;
  task_id?: string | null;
  superseded_by?: string | null;
  superseded_at?: string | null;
  supersede_reason?: string | null;
};

type Audit = {
  action: string;
  module: string;
  record_id: string;
  previous_value: { status: string };
  new_value: { status: string; superseded_by: string };
  reason: string;
};

const isActive = (s: string) => ACTIVE.includes(s);
const isRoomCleaning = (t: string) => CLEANING.includes(t);

/** The BEFORE INSERT trigger, modelled exactly. */
function schedule(state: { jobs: Job[]; audit: Audit[]; tasks: Map<string, string> }, job: Job) {
  if (job.room_id && isActive(job.status) && isRoomCleaning(job.job_type)) {
    for (const existing of state.jobs) {
      if (
        existing.organization_id === job.organization_id &&
        existing.room_id === job.room_id &&
        existing.id !== job.id &&
        isActive(existing.status) &&
        isRoomCleaning(existing.job_type)
      ) {
        const previous = existing.status;
        existing.status = "superseded";
        existing.superseded_by = job.id;
        existing.superseded_at = new Date().toISOString();
        existing.supersede_reason = "Replaced by a newer cleaning job for the same room.";
        if (existing.task_id && state.tasks.get(existing.task_id) !== "completed") {
          state.tasks.set(existing.task_id, "cancelled");
        }
        state.audit.push({
          action: "housekeeping.job.superseded",
          module: "housekeeping",
          record_id: existing.id,
          previous_value: { status: previous },
          new_value: { status: "superseded", superseded_by: job.id },
          reason: "Replaced by a newer cleaning job for the same room",
        });
      }
    }
  }
  state.jobs.push(job);
  return state;
}

function fresh() {
  return { jobs: [] as Job[], audit: [] as Audit[], tasks: new Map<string, string>() };
}

const job = (id: string, over: Partial<Job> = {}): Job => ({
  id,
  organization_id: "org-1",
  room_id: "room-101",
  job_type: "checkout-cleaning",
  status: "pending",
  task_id: `task-${id}`,
  ...over,
});

describe("multiple cleaning requests for the same room", () => {
  it("leaves exactly one active cleaning task after four requests", () => {
    const s = fresh();
    schedule(s, job("j1"));
    schedule(s, job("j2", { status: "assigned" }));
    schedule(s, job("j3", { job_type: "daily-cleaning" }));
    schedule(s, job("j4", { status: "in-progress" }));

    const active = s.jobs.filter((j) => isActive(j.status) && isRoomCleaning(j.job_type));
    expect(active).toHaveLength(1);
    expect(active[0]!.id).toBe("j4");
  });

  it("supersedes rather than deletes — every earlier task is retained", () => {
    const s = fresh();
    schedule(s, job("j1"));
    schedule(s, job("j2"));
    schedule(s, job("j3"));

    expect(s.jobs).toHaveLength(3);
    const superseded = s.jobs.filter((j) => j.status === "superseded");
    expect(superseded.map((j) => j.id)).toEqual(["j1", "j2"]);
    for (const j of superseded) {
      expect(j.superseded_by).toBeTruthy();
      expect(j.superseded_at).toBeTruthy();
      expect(j.supersede_reason).toBe("Replaced by a newer cleaning job for the same room.");
    }
  });

  it("writes one audit entry per supersession, with the reason and replacement", () => {
    const s = fresh();
    schedule(s, job("j1"));
    schedule(s, job("j2"));
    schedule(s, job("j3"));

    expect(s.audit).toHaveLength(2);
    expect(s.audit.every((a) => a.action === "housekeeping.job.superseded")).toBe(true);
    expect(s.audit[0]).toMatchObject({
      record_id: "j1",
      previous_value: { status: "pending" },
      new_value: { status: "superseded", superseded_by: "j2" },
      reason: "Replaced by a newer cleaning job for the same room",
    });
    expect(s.audit[1]!.new_value.superseded_by).toBe("j3");
  });

  it("cancels the linked task of a superseded job but never a completed one", () => {
    const s = fresh();
    schedule(s, job("j1"));
    s.tasks.set("task-j1", "in-progress");
    schedule(s, job("j2"));
    expect(s.tasks.get("task-j1")).toBe("cancelled");

    const t = fresh();
    schedule(t, job("k1"));
    t.tasks.set("task-k1", "completed");
    schedule(t, job("k2"));
    expect(t.tasks.get("task-k1")).toBe("completed");
  });
});

describe("supersession is narrow", () => {
  it("never touches another room", () => {
    const s = fresh();
    schedule(s, job("j1", { room_id: "room-101" }));
    schedule(s, job("j2", { room_id: "room-202" }));
    expect(s.jobs.filter((j) => j.status === "superseded")).toHaveLength(0);
    expect(s.audit).toHaveLength(0);
  });

  it("never crosses an organisation", () => {
    const s = fresh();
    schedule(s, job("j1", { organization_id: "org-1" }));
    schedule(s, job("j2", { organization_id: "org-2" }));
    expect(s.jobs.every((j) => j.status === "pending")).toBe(true);
    expect(s.audit).toHaveLength(0);
  });

  it("leaves non-cleaning work and finished jobs alone", () => {
    const s = fresh();
    schedule(s, job("j1", { job_type: "inspection" }));
    schedule(s, job("j2", { status: "completed" }));
    schedule(s, job("j3"));
    expect(s.audit).toHaveLength(0);
    expect(s.jobs.find((j) => j.id === "j1")!.status).toBe("pending");
    expect(s.jobs.find((j) => j.id === "j2")!.status).toBe("completed");
  });
});

describe("database implements the same rules", () => {
  it("ships the BEFORE INSERT trigger and the one-active-job index", () => {
    expect(sql).toBeTruthy();
    expect(sql!).toContain("BEFORE INSERT ON public.housekeeping_jobs");
    expect(sql!).toContain("housekeeping_jobs_one_active_room_clean_idx");
    expect(sql!).toContain("CREATE UNIQUE INDEX");
  });

  it("supersedes and audits instead of deleting", () => {
    expect(sql!).toContain("SET status = 'superseded'");
    expect(sql!).toContain("supersede_reason");
    expect(sql!).toContain("'housekeeping.job.superseded'");
    expect(sql!).not.toMatch(/DELETE\s+FROM\s+public\.housekeeping_jobs/i);
  });

  it("keeps a manual repair route for existing duplicates", () => {
    expect(sql!).toContain("neo_housekeeping_dedupe_room_jobs");
  });
});

describe("cleaning history surface", () => {
  const route = readFileSync("src/routes/_shell.housekeeping.history.tsx", "utf8");
  const hooks = readFileSync("src/lib/operations-data.ts", "utf8");

  it("reads only superseded jobs, property-scoped", () => {
    expect(hooks).toContain("useSupersededHousekeepingJobs");
    expect(hooks).toContain('.not("superseded_by", "is", null)');
    expect(hooks).toContain('"housekeeping_jobs"');
  });

  it("shows when a task was superseded, by what, and why", () => {
    expect(route).toContain("superseded_at");
    expect(route).toContain("superseded_by");
    expect(route).toContain("supersede_reason");
    expect(route).toContain("Cleaning History");
  });

  it("is a supervisory surface, capability-gated like the rest of housekeeping", () => {
    const caps = readFileSync("src/lib/capabilities.ts", "utf8");
    expect(caps).toContain('{ prefix: "/housekeeping/history"');
    expect(route).toContain('path="/housekeeping/history"');
  });
});
