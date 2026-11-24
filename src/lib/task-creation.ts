/** A task is owned by a real property and department before it enters a work queue. */
export type TaskCreation = {
  organization_id: string | null;
  branch_id: string | null;
  department_id: string | null;
  assignee_id: string | null;
  created_by: string | null;
  title: string;
  status: string;
  [key: string]: unknown;
};

export function validateTaskCreation(task: TaskCreation, requireAssignee = false) {
  if (!task.organization_id?.trim() || !task.created_by?.trim()) throw new Error("Your workspace session is not ready.");
  if (!task.branch_id?.trim()) throw new Error("Select a property before creating the task.");
  if (!task.department_id?.trim()) throw new Error("Select an active department before creating the task.");
  if (!task.title.trim()) throw new Error("Give the task a title.");
  if (requireAssignee && !task.assignee_id?.trim()) throw new Error("Select a worker before assigning the task.");
}

export function requireSavedTask(value: unknown, expected: TaskCreation) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Task creation was not confirmed by the database.");
  const row = value as Record<string, unknown>;
  if (typeof row["id"] !== "string" || !row["id"].trim()) throw new Error("Task creation was not confirmed by the database.");
  for (const key of ["organization_id", "branch_id", "department_id", "assignee_id", "status"] as const) {
    if (row[key] !== expected[key]) throw new Error(`The saved task ${key.replaceAll("_", " ")} differs from the requested task. Refresh before trying again.`);
  }
  return row;
}

type TaskClient = { from: (table: "tasks") => { insert: (task: TaskCreation) => {
  select: (columns: string) => { single: () => PromiseLike<{ data: unknown; error: { message: string } | null }> };
} } };

export async function createDepartmentTask(db: TaskClient, task: TaskCreation) {
  validateTaskCreation(task, true);
  const { data, error } = await db.from("tasks").insert(task)
    .select("id, organization_id, branch_id, department_id, assignee_id, status").single();
  if (error) throw new Error(error.message);
  return requireSavedTask(data, task);
}

