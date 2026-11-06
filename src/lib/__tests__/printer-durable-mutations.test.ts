import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  useSavePrinter,
  useRegisterPrintAgent,
  useRevokePrintAgent,
  useRequestPrinterDiscovery,
} from "@/lib/printing";
const mock = vi.hoisted(() => ({
  from: vi.fn(),
  rpc: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  invalidate: vi.fn(),
  select: vi.fn(),
  maybeSingle: vi.fn(),
}));
vi.mock("@/integrations/supabase/client", () => ({ supabase: { from: mock.from } }));
vi.mock("@/lib/rpc-guard", () => ({ guardedRpc: mock.rpc }));
vi.mock("@/lib/scoped-options", () => ({ useScopedStations: vi.fn() }));
vi.mock("@tanstack/react-query", () => ({
  useMutation: (options: unknown) => options,
  useQuery: vi.fn(),
  useQueryClient: () => ({ invalidateQueries: mock.invalidate }),
}));
vi.mock("sonner", () => ({ toast: { success: mock.success, error: mock.error } }));
type Mutation = { mutationFn: (value: unknown) => Promise<unknown> };
beforeEach(() => {
  vi.clearAllMocks();
  const query = {
    insert: vi.fn(),
    update: vi.fn(),
    eq: vi.fn(),
    select: mock.select,
    maybeSingle: mock.maybeSingle,
  };
  query.insert.mockReturnValue(query);
  query.update.mockReturnValue(query);
  query.eq.mockReturnValue(query);
  mock.select.mockReturnValue(query);
  mock.from.mockReturnValue(query);
});
describe("printer durable mutation results", () => {
  it("requires a returned saved profile rather than an empty successful transport reply", async () => {
    mock.maybeSingle.mockResolvedValue({ data: { id: "profile-1" }, error: null });
    expect(await (useSavePrinter() as unknown as Mutation).mutationFn({ name: "Thermal" })).toBe(
      "profile-1",
    );
    expect(mock.select).toHaveBeenCalledWith("id");
  });
  it.each([null, {}, { id: "" }])("rejects missing saved profile identity %j", async (data) => {
    mock.maybeSingle.mockResolvedValue({ data, error: null });
    await expect(
      (useSavePrinter() as unknown as Mutation).mutationFn({
        id: "profile-1",
        address: "192.168.1.3",
      }),
    ).rejects.toThrow("not saved");
    expect(mock.success).not.toHaveBeenCalled();
  });
  it("preserves database denial when saving", async () => {
    mock.maybeSingle.mockResolvedValue({ data: null, error: { message: "Wrong property" } });
    await expect(
      (useSavePrinter() as unknown as Mutation).mutationFn({ name: "Thermal" }),
    ).rejects.toThrow("Wrong property");
  });
  it("does not expose an agent secret as paired when registration has no saved identity", async () => {
    mock.rpc.mockResolvedValue({ data: null, error: null });
    await expect(
      (useRegisterPrintAgent() as unknown as Mutation).mutationFn({
        branch: "branch-1",
        name: "Computer",
        tokenHash: "hash",
      }),
    ).rejects.toThrow("agent was not saved");
  });
  it("does not report a different agent as revoked", async () => {
    mock.rpc.mockResolvedValue({ data: "other-agent", error: null });
    await expect(
      (useRevokePrintAgent() as unknown as Mutation).mutationFn("agent-1"),
    ).rejects.toThrow("revocation was not confirmed");
  });
  it.each([null, {}, { ok: false }, { ok: true }])(
    "requires a persisted discovery request %j",
    async (data) => {
      mock.rpc.mockResolvedValue({ data, error: null });
      await expect(
        (useRequestPrinterDiscovery() as unknown as Mutation).mutationFn({
          agent: "agent-1",
          kind: "usb",
        }),
      ).rejects.toThrow();
    },
  );
});
