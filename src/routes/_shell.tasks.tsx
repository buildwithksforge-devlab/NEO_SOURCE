import { guardedRpc } from "@/lib/rpc-guard";
import { useState, type FormEvent } from "react";
import { useDataScope } from "@/lib/data-scope";
import { createFileRoute } from "@tanstack/react-router";
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { CalendarClock, Plus } from "lucide-react";
import { toast } from "sonner";

import {
  CalendarDayLegend,
  CalendarMonthGrid,
  CalendarMonthSkeleton,
  CalendarToolbar,
  monthCells,
} from "@/components/common/CalendarSurface";

import {
  PageHeader,
  SectionCard,
  StatusPill,
} from "@/components/common/DataDisplay";

import { DocumentPrintButton } from "@/components/common/DocumentPrintButton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Progress } from "@/components/ui/progress";

import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import {
  useScopedDepartments,
  useScopedWorkerOptions,
} from "@/lib/scoped-options";

import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/auth";

import {
  EmptyState,
  ErrorState,
  LoadingState,
} from "@/components/common/StateSystem";

/* ============================================================
   ROUTE
   ============================================================ */

export const Route = createFileRoute("/_shell/tasks")({
  head: () => ({
    meta: [
      {
        title: "Tasks — NEØ",
      },
      {
        name: "description",
        content:
          "Assign, track and escalate operational tasks across every department.",
      },
      {
        property: "og:title",
        content: "Tasks — NEØ",
      },
      {
        property: "og:description",
        content:
          "Assign, track and escalate operational tasks across every department.",
      },
    ],
  }),

  component: TasksPage,
});

/* ============================================================
   TYPES
   ============================================================ */

type Task = {
  id: string;
  reference: string;
  title: string;
  description: string;
  assignee_id: string | null;
  created_by: string | null;
  department_id: string | null;
  due_at: string | null;
  priority: string;
  status: string;
  progress: number;
};

type TaskWithDepartment = Task & {
  departments: {
    name: string;
  } | null;
};

type TaskPatch = Partial<Task> & {
  completed_at?: string | null;
};

type StaffOption = {
  id: string;
  full_name: string;
  department_id: string | null;
};

type DepartmentOption = {
  id: string;
  name: string;
};

type NewTaskPayload = {
  title: string;
  description: string;
  assignee_id: string | null;
  department_id: string | null;
  due_at: string | null;
  priority: string;
};

/* ============================================================
   CONSTANTS
   ============================================================ */

const STATUSES = [
  "new",
  "assigned",
  "in-progress",
  "waiting",
  "completed",
  "cancelled",
];

const PRIORITIES = [
  "low",
  "normal",
  "high",
  "urgent",
];

/**
 * Task statuses that represent actionable work.
 */
export const ACTIONABLE_TASK_STATUSES = [
  "new",
  "open",
  "assigned",
  "in-progress",
  "waiting",
];

/**
 * Terminal statuses.
 *
 * A cancelled, rejected, completed or superseded task must
 * not appear in an actionable task queue.
 */
export const CLOSED_TASK_STATUSES = [
  "completed",
  "cancelled",
  "rejected",
  "superseded",
];

export function isActionable(
  task: {
    status: string;
  },
) {
  return !CLOSED_TASK_STATUSES.includes(task.status);
}

const priorityTone = (priority: string) =>
  priority === "urgent"
    ? "destructive"
    : priority === "high"
      ? "warning"
      : priority === "low"
        ? "default"
        : "info";

function isOverdue(task: Task) {
  if (!task.due_at) return false;

  return (
    new Date(task.due_at).getTime() < Date.now() &&
    isActionable(task)
  );
}

/* ============================================================
   TASK PERSISTENCE HELPERS
   ============================================================ */

/**
 * Confirms an UPDATE affected one accessible task record.
 *
 * A Supabase UPDATE can produce no PostgREST error while
 * returning zero affected rows, particularly when RLS
 * filters the targeted record.
 *
 * The returned record is therefore mandatory.
 */
async function updateTaskAndConfirm(
  id: string,
  patch: TaskPatch,
) {
  const { data, error } = await supabase
    .from("tasks")
    .update(patch)
    .eq("id", id)
    .select(
      "id, assignee_id, department_id, status, progress",
    )
    .maybeSingle();

  if (error) {
    throw new Error(
      `Task update failed: ${error.message}`,
    );
  }

  if (!data) {
    throw new Error(
      "The task update could not be confirmed. " +
        "The task may be unavailable or your role may not " +
        "have permission to modify it.",
    );
  }

  if (
    patch.assignee_id !== undefined &&
    data.assignee_id !== patch.assignee_id
  ) {
    throw new Error(
      "The selected employee was not saved as the task assignee.",
    );
  }

  if (
    patch.department_id !== undefined &&
    data.department_id !== patch.department_id
  ) {
    throw new Error(
      "The task department was not saved correctly.",
    );
  }

  if (
    patch.status !== undefined &&
    data.status !== patch.status
  ) {
    throw new Error(
      "The requested task status was not saved.",
    );
  }

  if (
    patch.progress !== undefined &&
    data.progress !== patch.progress
  ) {
    throw new Error(
      "The requested task progress was not saved.",
    );
  }

  return data;
}

/**
 * Creates a task and verifies the persisted row.
 *
 * Never report successful creation for a zero-row insert.
 */
async function createTaskAndConfirm(
  organizationId: string,
  userId: string,
  payload: NewTaskPayload,
) {
  const { data: documentReference, error: referenceError } =
    await guardedRpc(
      supabase,
      "next_document_number",
      {
        _doc_type: "task",
      },
    );

  if (referenceError) {
    throw new Error(
      `Could not generate a task reference: ${referenceError.message}`,
    );
  }

  if (
    typeof documentReference !== "string" ||
    !documentReference.trim()
  ) {
    throw new Error(
      "The task reference generator returned no valid reference.",
    );
  }

  const expectedStatus = payload.assignee_id
    ? "assigned"
    : "new";

  const { data, error } = await supabase
    .from("tasks")
    .insert({
      organization_id: organizationId,
      created_by: userId,
      reference: documentReference,
      ...payload,
      status: expectedStatus,
    })
    .select(
      "id, reference, organization_id, assignee_id, department_id, status",
    )
    .single();

  if (error) {
    throw new Error(
      `Task creation failed: ${error.message}`,
    );
  }

  if (!data?.id) {
    throw new Error(
      "Task creation was not confirmed by the database.",
    );
  }

  if (data.organization_id !== organizationId) {
    throw new Error(
      "The created task was returned under an unexpected organisation.",
    );
  }

  if (
    data.department_id !== payload.department_id
  ) {
    throw new Error(
      "The task was created but its department does not match the selected department.",
    );
  }

  if (
    data.assignee_id !== payload.assignee_id
  ) {
    throw new Error(
      "The task was created but its assignee does not match the selected employee.",
    );
  }

  if (data.status !== expectedStatus) {
    throw new Error(
      "The task was created but its status does not match the requested status.",
    );
  }

  return data;
}

/* ============================================================
   MAIN TASK PAGE
   ============================================================ */

function TasksPage() {
  const { applyScope, scopeKey } = useDataScope();

  const {
    organizationId,
    user,
    profile,
  } = useAuth();

  const qc = useQueryClient();

  const [open, setOpen] = useState(false);

  /* ----------------------------------------------------------
     TASK QUERY
     ---------------------------------------------------------- */

  const tasksQuery = useQuery({
    queryKey: [
      "tasks",
      organizationId,
      scopeKey,
    ],

    enabled: Boolean(organizationId),

    queryFn: async () => {
      const { data, error } = await applyScope(
        supabase
          .from("tasks")
          .select("*, departments(name)"),
        "tasks",
      ).order("created_at", {
        ascending: false,
      });

      if (error) {
        throw error;
      }

      return data ?? [];
    },
  });

  /* ----------------------------------------------------------
     SCOPED STAFF AND DEPARTMENTS
     ---------------------------------------------------------- */

  const staff = useScopedWorkerOptions();

  const departments = useScopedDepartments();

  /* ----------------------------------------------------------
     UPDATE MUTATION
     ---------------------------------------------------------- */

  const update = useMutation({
    mutationFn: async ({
      id,
      patch,
    }: {
      id: string;
      patch: TaskPatch;
    }) => {
      return updateTaskAndConfirm(
        id,
        patch,
      );
    },

    onSuccess: async () => {
      await qc.invalidateQueries({
        queryKey: ["tasks"],
      });

      toast.success(
        "Task changes saved successfully.",
      );
    },

    onError: (error: Error) => {
      toast.error(
        error.message ||
          "The task could not be updated.",
      );
    },
  });

  /* ----------------------------------------------------------
     TASK CREATION MUTATION
     ---------------------------------------------------------- */

  const create = useMutation({
    mutationFn: async (
      payload: NewTaskPayload,
    ) => {
      if (!organizationId || !user?.id) {
        throw new Error(
          "Your workspace session is not ready. Please sign in again.",
        );
      }

      if (!payload.title.trim()) {
        throw new Error(
          "A task title is required.",
        );
      }

      if (!payload.department_id) {
        throw new Error(
          "Select a department before creating the task.",
        );
      }

      if (payload.assignee_id) {
        const selectedEmployee = (
          staff.data ?? []
        ).find(
          (employee) =>
            employee.id === payload.assignee_id &&
            employee.department_id === payload.department_id,
        );

        if (!selectedEmployee) {
          throw new Error(
            "The selected employee is not available in the selected department.",
          );
        }
      }

      const task = await createTaskAndConfirm(
        organizationId,
        user.id,
        payload,
      );

      return task;
    },

    onSuccess: async (task, payload) => {
      await qc.invalidateQueries({
        queryKey: ["tasks"],
      });

      toast.success(
        `Task ${task.reference} created successfully.`,
      );

      /*
       * Notification delivery is secondary to task persistence.
       *
       * A failure here must not cause the user to create
       * the same task again.
       */
      if (
        payload.assignee_id &&
        organizationId
      ) {
        void (async () => {
          try {
            const { error } = await supabase
              .from("notifications")
              .insert({
                organization_id: organizationId,
                user_id: payload.assignee_id,
                category: "task-assignment",
                title: "New task assigned",
                body: payload.title,
                link: "/tasks",
              });

            if (error) {
              console.error(
                "Task notification failed:",
                error,
              );

              toast.warning(
                "Task saved, but the assignment notification could not be sent.",
              );
            }
          } catch (error) {
            console.error(
              "Task notification failed:",
              error,
            );

            toast.warning(
              "Task saved, but the assignment notification could not be sent.",
            );
          }
        })();
      }
    },

    onError: (error: Error) => {
      toast.error(
        error.message ||
          "The task could not be created.",
      );
    },
  });

  /* ----------------------------------------------------------
     TASK COLLECTIONS
     ---------------------------------------------------------- */

  const all = (
    tasksQuery.data ?? []
  ) as unknown as TaskWithDepartment[];

  const mine = all.filter(
    (task) =>
      task.assignee_id === user?.id &&
      isActionable(task),
  );

  const dept = all.filter(
    (task) =>
      Boolean(task.department_id) &&
      task.department_id === profile?.department_id &&
      isActionable(task),
  );

  const overdue = all.filter(isOverdue);

  const completed = all.filter(
    (task) =>
      CLOSED_TASK_STATUSES.includes(
        task.status,
      ),
  );

  /* ----------------------------------------------------------
     STAFF DISPLAY HELPERS
     ---------------------------------------------------------- */

  /**
   * Do not label every unmatched ID "Unassigned".
   *
   * The scoped worker list may legitimately exclude an
   * existing assignee due to property or department scope.
   *
   * This fallback reveals no out-of-scope employee identity.
   */
  const nameOf = (
    id: string | null,
  ) => {
    if (!id) {
      return "Unassigned";
    }

    const employee = (
      staff.data ?? []
    ).find(
      (worker) => worker.id === id,
    );

    if (employee) {
      return (
        employee.full_name ||
        "Unnamed employee"
      );
    }

    if (staff.isLoading) {
      return "Loading assignee";
    }

    return "Assigned employee unavailable in current scope";
  };

  const workersForDepartment = (
    departmentId: string | null,
  ) => {
    if (!departmentId) {
      return [];
    }

    return (
      staff.data ?? []
    ).filter(
      (worker) =>
        worker.department_id === departmentId,
    );
  };

  /* ----------------------------------------------------------
     TASK LIST RENDERER
     ---------------------------------------------------------- */

  const renderList = (
    items: TaskWithDepartment[],
  ) => {
    if (tasksQuery.isLoading) {
      return (
        <LoadingState
          variant="rows"
          rows={3}
        />
      );
    }

    if (tasksQuery.error) {
      return (
        <ErrorState
          error={tasksQuery.error}
          onRetry={() => {
            void tasksQuery.refetch();
          }}
          inline
        />
      );
    }

    if (items.length === 0) {
      return (
        <EmptyState
          title="Nothing here yet"
          description="No tasks match this list. Create a task to get started."
        />
      );
    }

    return (
      <ul className="space-y-3">
        {items.map((task) => (
          <li
            key={task.id}
            className="surface-panel p-4"
          >
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                {/* TASK HEADER */}

                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-medium">
                    {task.title}
                  </p>

                  <StatusPill
                    tone={priorityTone(
                      task.priority,
                    )}
                  >
                    {task.priority}
                  </StatusPill>

                  {isOverdue(task) && (
                    <StatusPill tone="destructive">
                      Overdue · escalated
                    </StatusPill>
                  )}
                </div>

                {/* DESCRIPTION */}

                <p className="mt-1 text-sm text-muted-foreground">
                  {task.description ||
                    "No description"}
                </p>

                {/* TASK METADATA */}

                <p className="mt-2 text-xs text-muted-foreground">
                  {task.reference
                    ? `${task.reference} · `
                    : ""}

                  {task.departments?.name ??
                    "No department"}

                  {" · "}

                  {nameOf(
                    task.assignee_id,
                  )}

                  {task.due_at
                    ? ` · due ${new Date(
                        task.due_at,
                      ).toLocaleString()}`
                    : ""}
                </p>
              </div>

              {/* TASK CONTROLS */}

              <div className="flex items-center gap-2">
                {/* ASSIGNMENT */}

                <Select
                  value={
                    task.assignee_id ??
                    ""
                  }
                  disabled={
                    !task.department_id ||
                    update.isPending
                  }
                  onValueChange={(
                    employeeId,
                  ) => {
                    if (
                      employeeId ===
                      task.assignee_id
                    ) {
                      return;
                    }

                    update.mutate({
                      id: task.id,

                      patch: {
                        assignee_id:
                          employeeId,

                        status: "assigned",
                      },
                    });
                  }}
                >
                  <SelectTrigger
                    className="h-8 w-full sm:w-40"
                    aria-label="Reassign"
                  >
                    <SelectValue
                      placeholder={
                        task.department_id
                          ? "Assign"
                          : "Set department first"
                      }
                    />
                  </SelectTrigger>

                  <SelectContent>
                    {workersForDepartment(
                      task.department_id,
                    ).map((employee) => (
                      <SelectItem
                        key={employee.id}
                        value={employee.id}
                      >
                        {employee.full_name ||
                          "Unnamed"}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                {/* STATUS */}

                <Select
                  value={task.status}
                  disabled={update.isPending}
                  onValueChange={(
                    status,
                  ) => {
                    if (
                      status === task.status
                    ) {
                      return;
                    }

                    update.mutate({
                      id: task.id,

                      patch: {
                        status,

                        progress:
                          status ===
                          "completed"
                            ? 100
                            : task.progress,

                        completed_at:
                          status ===
                          "completed"
                            ? new Date().toISOString()
                            : null,
                      },
                    });
                  }}
                >
                  <SelectTrigger
                    className="h-8 w-full sm:w-36"
                    aria-label="Status"
                  >
                    <SelectValue />
                  </SelectTrigger>

                  <SelectContent>
                    {STATUSES.map(
                      (status) => (
                        <SelectItem
                          key={status}
                          value={status}
                        >
                          {status}
                        </SelectItem>
                      ),
                    )}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {/* PROGRESS */}

            <Progress
              value={
                task.status ===
                "completed"
                  ? 100
                  : task.progress
              }
              className="mt-3"
            />
          </li>
        ))}
      </ul>
    );
  };

  /* ==========================================================
     MAIN PAGE RENDER
     ========================================================== */

  return (
    <div>
      <PageHeader
        eyebrow="Operations"
        title="Tasks"
        description="Central task board: assignment, due dates, priorities, progress and overdue escalation."
        actions={
          <div className="flex items-center gap-2">
            <DocumentPrintButton
              type="task_sheet"
              id={
                profile?.department_id ??
                null
              }
              label="Task sheet"
            />

            <Button
              onClick={() =>
                setOpen(true)
              }
            >
              <Plus className="size-4" />

              New task
            </Button>
          </div>
        }
      />

      <SectionCard
        title="Task board"
        description={`${all.length} task(s)`}
      >
        <Tabs defaultValue="mine">
          <TabsList className="flex flex-wrap">
            <TabsTrigger value="mine">
              My tasks ({mine.length})
            </TabsTrigger>

            <TabsTrigger value="dept">
              Department ({dept.length})
            </TabsTrigger>

            <TabsTrigger value="overdue">
              Overdue ({overdue.length})
            </TabsTrigger>

            <TabsTrigger value="completed">
              Completed ({completed.length})
            </TabsTrigger>

            <TabsTrigger value="all">
              All ({all.length})
            </TabsTrigger>

            <TabsTrigger value="calendar">
              Calendar
            </TabsTrigger>
          </TabsList>

          <TabsContent
            value="mine"
            className="pt-4"
          >
            {renderList(mine)}
          </TabsContent>

          <TabsContent
            value="dept"
            className="pt-4"
          >
            {renderList(dept)}
          </TabsContent>

          <TabsContent
            value="overdue"
            className="pt-4"
          >
            {renderList(overdue)}
          </TabsContent>

          <TabsContent
            value="completed"
            className="pt-4"
          >
            {renderList(completed)}
          </TabsContent>

          <TabsContent
            value="all"
            className="pt-4"
          >
            {renderList(all)}
          </TabsContent>

          <TabsContent
            value="calendar"
            className="pt-4"
          >
            <TaskDueCalendar
              tasks={all}
              isLoading={
                tasksQuery.isLoading
              }
            />
          </TabsContent>
        </Tabs>
      </SectionCard>

      {/* CREATE TASK DIALOG */}

      <NewTaskDialog
        open={open}
        onOpenChange={setOpen}
        staff={staff.data ?? []}
        departments={
          departments.data ?? []
        }
        isSubmitting={
          create.isPending
        }
        onCreate={async (
          payload,
        ) => {
          await create.mutateAsync(
            payload,
          );
        }}
      />
    </div>
  );
}

/* ============================================================
   NEW TASK DIALOG
   ============================================================ */

function NewTaskDialog({
  open,
  onOpenChange,
  staff,
  departments,
  onCreate,
  isSubmitting,
}: {
  open: boolean;

  onOpenChange: (
    value: boolean,
  ) => void;

  staff: StaffOption[];

  departments: DepartmentOption[];

  onCreate: (
    payload: NewTaskPayload,
  ) => Promise<void>;

  isSubmitting: boolean;
}) {
  const [title, setTitle] =
    useState("");

  const [
    description,
    setDescription,
  ] = useState("");

  const [
    assignee,
    setAssignee,
  ] = useState("");

  const [
    department,
    setDepartment,
  ] = useState("");

  const [dueAt, setDueAt] =
    useState("");

  const [
    priority,
    setPriority,
  ] = useState("normal");

  /* ----------------------------------------------------------
     ELIGIBLE STAFF
     ---------------------------------------------------------- */

  const eligibleStaff =
    department
      ? staff.filter(
          (employee) =>
            employee.department_id ===
            department,
        )
      : [];

  /* ----------------------------------------------------------
     RESET FORM
     ---------------------------------------------------------- */

  function resetForm() {
    setTitle("");
    setDescription("");
    setAssignee("");
    setDepartment("");
    setDueAt("");
    setPriority("normal");
  }

  /* ----------------------------------------------------------
     DEPARTMENT SELECTION
     ---------------------------------------------------------- */

  function selectDepartment(
    departmentId: string,
  ) {
    setDepartment(
      departmentId,
    );

    /*
     * Preserve the assignee when they
     * belong to the newly selected
     * department.
     *
     * Otherwise clear the selection.
     */
    if (!assignee) {
      return;
    }

    const stillEligible =
      staff.some(
        (employee) =>
          employee.id === assignee &&
          employee.department_id ===
            departmentId,
      );

    if (!stillEligible) {
      setAssignee("");
    }
  }

  /* ----------------------------------------------------------
     SUBMIT
     ---------------------------------------------------------- */

  async function submit(
    event: FormEvent,
  ) {
    event.preventDefault();

    if (isSubmitting) {
      return;
    }

    if (!title.trim()) {
      toast.error(
        "Enter a task title.",
      );
      return;
    }

    if (!department) {
      toast.error(
        "Select a department.",
      );
      return;
    }

    const selectedEmployee =
      assignee
        ? eligibleStaff.find(
            (employee) =>
              employee.id ===
              assignee,
          )
        : null;

    if (
      assignee &&
      !selectedEmployee
    ) {
      toast.error(
        "The selected employee is not available in this department.",
      );
      return;
    }

    try {
      await onCreate({
        title: title.trim(),

        description:
          description.trim(),

        assignee_id:
          assignee || null,

        department_id:
          department,

        due_at: dueAt
          ? new Date(
              dueAt,
            ).toISOString()
          : null,

        priority,
      });

      resetForm();

      onOpenChange(false);
    } catch {
      /*
       * The mutation already reports
       * the actual database error.
       *
       * Keep the form open so the user
       * can correct the issue without
       * losing their input.
       */
    }
  }

  /* ==========================================================
     DIALOG RENDER
     ========================================================== */

  return (
    <Dialog
      open={open}
      onOpenChange={(
        nextOpen,
      ) => {
        if (
          isSubmitting &&
          !nextOpen
        ) {
          return;
        }

        onOpenChange(
          nextOpen,
        );
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            Create task
          </DialogTitle>

          <DialogDescription>
            Create and assign an
            operational task to an
            eligible employee.
          </DialogDescription>
        </DialogHeader>

        <form
          onSubmit={submit}
          className="space-y-4"
        >
          {/* TITLE */}

          <div className="space-y-2">
            <Label htmlFor="title">
              Title
            </Label>

            <Input
              id="title"
              required
              value={title}
              disabled={
                isSubmitting
              }
              onChange={(
                event,
              ) =>
                setTitle(
                  event.target.value,
                )
              }
            />
          </div>

          {/* DESCRIPTION */}

          <div className="space-y-2">
            <Label htmlFor="desc">
              Description
            </Label>

            <Textarea
              id="desc"
              value={description}
              disabled={
                isSubmitting
              }
              onChange={(
                event,
              ) =>
                setDescription(
                  event.target.value,
                )
              }
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            {/* ASSIGNEE */}

            <div className="space-y-2">
              <Label>
                Assign to
              </Label>

              <Select
                value={assignee}
                disabled={
                  !department ||
                  isSubmitting
                }
                onValueChange={
                  setAssignee
                }
              >
                <SelectTrigger>
                  <SelectValue
                    placeholder={
                      department
                        ? "Unassigned"
                        : "Select department first"
                    }
                  />
                </SelectTrigger>

                <SelectContent>
                  {eligibleStaff.map(
                    (employee) => (
                      <SelectItem
                        key={
                          employee.id
                        }
                        value={
                          employee.id
                        }
                      >
                        {employee.full_name ||
                          "Unnamed"}
                      </SelectItem>
                    ),
                  )}
                </SelectContent>
              </Select>
            </div>

            {/* DEPARTMENT */}

            <div className="space-y-2">
              <Label>
                Department
              </Label>

              <Select
                value={department}
                disabled={
                  isSubmitting
                }
                onValueChange={
                  selectDepartment
                }
              >
                <SelectTrigger>
                  <SelectValue
                    placeholder="Select department"
                  />
                </SelectTrigger>

                <SelectContent>
                  {departments.map(
                    (item) => (
                      <SelectItem
                        key={item.id}
                        value={item.id}
                      >
                        {item.name}
                      </SelectItem>
                    ),
                  )}
                </SelectContent>
              </Select>
            </div>

            {/* DUE DATE */}

            <div className="space-y-2">
              <Label htmlFor="due">
                Due
              </Label>

              <Input
                id="due"
                type="datetime-local"
                value={dueAt}
                disabled={
                  isSubmitting
                }
                onChange={(
                  event,
                ) =>
                  setDueAt(
                    event.target.value,
                  )
                }
              />
            </div>

            {/* PRIORITY */}

            <div className="space-y-2">
              <Label>
                Priority
              </Label>

              <Select
                value={priority}
                disabled={
                  isSubmitting
                }
                onValueChange={
                  setPriority
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>

                <SelectContent>
                  {PRIORITIES.map(
                    (item) => (
                      <SelectItem
                        key={item}
                        value={item}
                      >
                        {item}
                      </SelectItem>
                    ),
                  )}
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* ACTIONS */}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={
                isSubmitting
              }
              onClick={() =>
                onOpenChange(
                  false,
                )
              }
            >
              Cancel
            </Button>

            <Button
              type="submit"
              disabled={
                isSubmitting ||
                !title.trim() ||
                !department
              }
            >
              <CalendarClock className="size-4" />

              {isSubmitting
                ? "Creating..."
                : "Create task"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/* ============================================================
   TASK CALENDAR
   ============================================================ */

function TaskDueCalendar({
  tasks,
  isLoading = false,
}: {
  tasks: Task[];
  isLoading?: boolean;
}) {
  const [
    cursor,
    setCursor,
  ] = useState(() => {
    const now = new Date();

    return new Date(
      Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        1,
      ),
    );
  });

  const todayIso =
    new Date()
      .toISOString()
      .slice(0, 10);

  const byDay = new Map<
    string,
    Task[]
  >();

  for (const task of tasks) {
    if (!task.due_at) {
      continue;
    }

    const key = new Date(
      task.due_at,
    )
      .toISOString()
      .slice(0, 10);

    byDay.set(
      key,
      [
        ...(
          byDay.get(key) ?? []
        ),
        task,
      ],
    );
  }

  const cells = monthCells(
    cursor.getUTCFullYear(),
    cursor.getUTCMonth(),
    {
      today: todayIso,
    },
  ).map((cell) => {
    const items =
      byDay.get(cell.key) ??
      [];

    return {
      ...cell,

      count: items.length,

      content: items.map(
        (task) => (
          <div
            key={task.id}
            className="min-w-0 rounded bg-muted/70 px-1.5 py-1 text-[0.65rem] leading-tight"
            title={task.title}
          >
            <p className="truncate font-medium">
              {task.title}
            </p>

            <p className="truncate text-muted-foreground">
              {task.status}
            </p>
          </div>
        ),
      ),
    };
  });

  const monthLabel =
    cursor.toLocaleDateString(
      undefined,
      {
        month: "long",
        year: "numeric",
        timeZone: "UTC",
      },
    );

  const scheduled =
    tasks.filter(
      (task) =>
        Boolean(task.due_at),
    ).length;

  return (
    <div className="space-y-3">
      <CalendarToolbar
        label={monthLabel}
        prevLabel="Previous month"
        nextLabel="Next month"
        onPrev={() =>
          setCursor(
            new Date(
              Date.UTC(
                cursor.getUTCFullYear(),
                cursor.getUTCMonth() -
                  1,
                1,
              ),
            ),
          )
        }
        onNext={() =>
          setCursor(
            new Date(
              Date.UTC(
                cursor.getUTCFullYear(),
                cursor.getUTCMonth() +
                  1,
                1,
              ),
            ),
          )
        }
        onToday={() => {
          const now =
            new Date();

          setCursor(
            new Date(
              Date.UTC(
                now.getUTCFullYear(),
                now.getUTCMonth(),
                1,
              ),
            ),
          );
        }}
      >
        <span className="text-xs text-muted-foreground">
          {scheduled} of{" "}
          {tasks.length} task(s)
          carry a due date
        </span>
      </CalendarToolbar>

      <CalendarDayLegend
        states={[
          "today",
          "available",
          "limited",
          "unavailable",
        ]}
      />

      {isLoading ? (
        <CalendarMonthSkeleton />
      ) : (
        <CalendarMonthGrid
          ariaLabel={
            monthLabel
          }
          cells={cells}
        />
      )}
    </div>
  );
}