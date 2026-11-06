import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSaveWorkOrder, useSetRoomBlock } from "@/lib/operations-data";
import { useAdvanceMaintenanceJob } from "@/lib/maintenance-department";
const mock = vi.hoisted(() => ({
  rpc: vi.fn(),
  from: vi.fn(),
  success: vi.fn(),
  warning: vi.fn(),
  invalidate: vi.fn(),
}));
vi.mock("@/integrations/supabase/client", () => ({ supabase: { from: mock.from } }));
vi.mock("@/lib/rpc-guard", () => ({ guardedRpc: mock.rpc }));
vi.mock("@tanstack/react-query", () => ({
  useMutation: (options: unknown) => options,
  useQuery: vi.fn(),
  useQueryClient: () => ({ invalidateQueries: mock.invalidate }),
}));
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    organizationId: "org-1",
    user: { id: "manager-1" },
    profile: { department_id: "maintenance" },
  }),
}));
vi.mock("@/lib/branch-filter", () => ({
  useWriteBranchId: () => "branch-1",
  useActivePropertyFilter: () => ({ branchId: "branch-1" }),
}));
vi.mock("@/lib/scoped-options", () => ({
  useScopedDepartments: vi.fn(),
  useScopedWorkers: vi.fn(),
}));
vi.mock("@/lib/realtime-scope", () => ({ useScopedRealtime: vi.fn() }));
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }));
vi.mock("sonner", () => ({
  toast: { success: mock.success, warning: mock.warning, error: vi.fn() },
}));
type Mutation = {
  mutationFn: (input: unknown) => Promise<unknown>;
  onSuccess: (data: unknown) => void;
};
beforeEach(() => {
  vi.clearAllMocks();
  mock.from.mockImplementation(() => {
    throw Error("Lifecycle changes must not use direct table writes");
  });
});
describe("maintenance durable lifecycle mutations", () => {
  it("sends board closure through the canonical lifecycle with the independent verification note", async () => {
    mock.rpc.mockResolvedValue({ data: { id: "wo-1", status: "closed" }, error: null });
    const mutation = useSaveWorkOrder() as unknown as Mutation;
    expect(
      await mutation.mutationFn({ id: "wo-1", status: "closed", note: "Tested independently" }),
    ).toEqual({ id: "wo-1", status: "closed" });
    expect(mock.rpc).toHaveBeenCalledWith(expect.anything(), "neo_maint_job_advance", {
      _work_order: "wo-1",
      _status: "closed",
      _note: "Tested independently",
      _diagnosis: "",
    });
    expect(mock.from).not.toHaveBeenCalled();
  });
  it.each([
    null,
    {},
    { id: "wo-1" },
    { id: "other", status: "completed" },
    { id: "wo-1", status: "assigned" },
    { ok: false, id: "wo-1", status: "completed" },
  ])("rejects incomplete or different board status %j", async (data) => {
    mock.rpc.mockResolvedValue({ data, error: null });
    await expect(
      (useSaveWorkOrder() as unknown as Mutation).mutationFn({ id: "wo-1", status: "completed" }),
    ).rejects.toThrow();
  });
  it.each([null, {}, { id: "wo-1", status: "assigned" }])(
    "does not announce an unsaved technician transition %j",
    async (data) => {
      mock.rpc.mockResolvedValue({ data, error: null });
      await expect(
        (useAdvanceMaintenanceJob() as unknown as Mutation).mutationFn({
          workOrderId: "wo-1",
          status: "completed",
        }),
      ).rejects.toThrow();
      expect(mock.success).not.toHaveBeenCalled();
    },
  );
  it("retains a legitimate assignment update and requires its saved row", async () => {
    const query: {
      update: ReturnType<typeof vi.fn>;
      eq: ReturnType<typeof vi.fn>;
      select: ReturnType<typeof vi.fn>;
      maybeSingle: ReturnType<typeof vi.fn>;
    } = { update: vi.fn(), eq: vi.fn(), select: vi.fn(), maybeSingle: vi.fn() };
    query.update.mockReturnValue(query);
    query.eq.mockReturnValue(query);
    query.select.mockReturnValue(query);
    query.maybeSingle.mockResolvedValue({
      data: { id: "wo-1", work_order_number: "WO-1" },
      error: null,
    });
    mock.from.mockReturnValue(query);
    expect(
      await (useSaveWorkOrder() as unknown as Mutation).mutationFn({
        id: "wo-1",
        assigned_to: "tech-1",
        status: "assigned",
      }),
    ).toEqual({ id: "wo-1", work_order_number: "WO-1" });
    expect(query.update).toHaveBeenCalledWith({ assigned_to: "tech-1", status: "assigned" });
  });
});
describe("maintenance room-hold result boundary", () => {
  const saved = {
    ok: true,
    work_order_id: "wo-1",
    room_id: "room-1",
    blocked: false,
    room_released: true,
  };
  it.each([
    null,
    {},
    { ...saved, ok: false },
    { ...saved, work_order_id: "other" },
    { ...saved, blocked: true },
    { ...saved, room_released: undefined },
  ])("rejects an unconfirmed or different release %j", async (data) => {
    mock.rpc.mockResolvedValue({ data, error: null });
    await expect(
      (useSetRoomBlock() as unknown as Mutation).mutationFn({ workOrder: "wo-1", block: false }),
    ).rejects.toThrow();
    expect(mock.success).not.toHaveBeenCalled();
  });
  it("warns when only this job hold was removed and another repair still blocks the room", async () => {
    mock.rpc.mockResolvedValue({
      data: { ...saved, room_released: false, remaining_holds: 1 },
      error: null,
    });
    const mutation = useSetRoomBlock() as unknown as Mutation;
    mutation.onSuccess(await mutation.mutationFn({ workOrder: "wo-1", block: false }));
    expect(mock.warning).toHaveBeenCalledWith(expect.stringContaining("another maintenance hold"));
    expect(mock.success).not.toHaveBeenCalled();
  });
  it("refreshes PMS, operations and technician views after a confirmed handback", async () => {
    mock.rpc.mockResolvedValue({ data: saved, error: null });
    const mutation = useSetRoomBlock() as unknown as Mutation;
    mutation.onSuccess(await mutation.mutationFn({ workOrder: "wo-1", block: false }));
    expect(mock.success).toHaveBeenCalledWith("Room released to housekeeping");
    for (const key of ["pms", "ops", "maintenance-dept"])
      expect(mock.invalidate).toHaveBeenCalledWith({ queryKey: [key] });
  });
});
