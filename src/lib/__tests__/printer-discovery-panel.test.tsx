// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { PrinterDiscoveryPanel } from "@/components/settings/PrinterDiscoveryPanel";
const mock = vi.hoisted(() => ({
  mutate: vi.fn(),
  refetch: vi.fn(),
  status: { data: undefined as unknown, isError: false, error: null as unknown },
  pending: false,
}));
vi.mock("@/lib/printing", () => ({
  usePrinterDiscovery: () => ({ ...mock.status, refetch: mock.refetch }),
  useRequestPrinterDiscovery: () => ({ mutate: mock.mutate, isPending: mock.pending }),
}));
// Native select adapter keeps tests focused on search and saved-result behavior.
vi.mock("@/components/ui/select", () => ({
  Select: ({
    value,
    onValueChange,
    children,
  }: {
    value: string;
    onValueChange: (value: string) => void;
    children: ReactNode;
  }) => (
    <select value={value} onChange={(event) => onValueChange(event.target.value)}>
      {children}
    </select>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children: ReactNode }) => (
    <option value={value}>{children}</option>
  ),
}));
const agent = {
  id: "agent-1",
  organization_id: "org-1",
  branch_id: "branch-1",
  name: "Property PC",
  active: true,
  last_seen_at: null,
  created_at: "2026-11-06",
};
function chooseAgent() {
  fireEvent.change(screen.getAllByRole("combobox")[0]!, { target: { value: agent.id } });
}
function state(extra: Record<string, unknown> = {}) {
  return {
    agent_id: agent.id,
    branch_id: agent.branch_id,
    last_seen_at: new Date().toISOString(),
    request_id: null,
    reported_request_id: null,
    requested_at: null,
    reported_at: null,
    kind: null,
    result: null,
    ...extra,
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  mock.status = { data: undefined, isError: false, error: null };
  mock.pending = false;
});
afterEach(cleanup);
describe("printer discovery interaction", () => {
  it("requires a selected active property computer before dispatch", () => {
    render(<PrinterDiscoveryPanel agents={[agent]} onChoose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Search printers" }));
    expect(mock.mutate).not.toHaveBeenCalled();
  });
  it("requests a real Bluetooth queue search from the chosen agent", () => {
    render(<PrinterDiscoveryPanel agents={[agent]} onChoose={vi.fn()} />);
    chooseAgent();
    fireEvent.change(screen.getAllByRole("combobox")[1]!, { target: { value: "bluetooth" } });
    fireEvent.click(screen.getByRole("button", { name: "Search printers" }));
    expect(mock.mutate).toHaveBeenCalledWith({ agent: agent.id, kind: "bluetooth" });
    expect(screen.getByText(/Bluetooth pairing is completed in Windows Settings/)).toBeTruthy();
  });
  it("keeps waiting distinct from a completed or connected printer", () => {
    mock.status.data = state({ request_id: "req-1", requested_at: new Date().toISOString() });
    render(<PrinterDiscoveryPanel agents={[agent]} onChoose={vi.fn()} />);
    chooseAgent();
    expect(screen.getByText(/waiting for the local computer/)).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Search printers" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.queryByRole("button", { name: "Use this printer" })).toBeNull();
  });
  it("allows a fresh search after timeout without inventing a result", () => {
    mock.status.data = state({
      request_id: "req-1",
      requested_at: new Date(Date.now() - 121000).toISOString(),
    });
    render(<PrinterDiscoveryPanel agents={[agent]} onChoose={vi.fn()} />);
    chooseAgent();
    expect(screen.getByText(/Search timed out/)).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Search printers" }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });
  it("fills the profile with the actual detected queue and its property", () => {
    const printer = {
      name: "Detected thermal",
      address: "Installed thermal queue",
      connection_type: "windows",
      source: "Windows installed queue",
      note: "Detected only",
    };
    mock.status.data = state({
      result: { printers: [printer], notes: [] },
      reported_at: new Date().toISOString(),
    });
    const onChoose = vi.fn();
    render(<PrinterDiscoveryPanel agents={[agent]} onChoose={onChoose} />);
    chooseAgent();
    fireEvent.click(screen.getByRole("button", { name: "Use this printer" }));
    expect(onChoose).toHaveBeenCalledWith(printer, agent.branch_id);
  });
  it("does not enable an advertised IPP endpoint as an unsupported RAW printer", () => {
    mock.status.data = state({
      result: {
        printers: [
          {
            name: "Office IPP",
            address: "192.168.1.3:631",
            connection_type: "unsupported",
            note: "Install Windows queue",
          },
        ],
        notes: [],
      },
      reported_at: new Date().toISOString(),
    });
    const onChoose = vi.fn();
    render(<PrinterDiscoveryPanel agents={[agent]} onChoose={onChoose} />);
    chooseAgent();
    fireEvent.click(screen.getByRole("button", { name: "Use this printer" }));
    expect(onChoose).not.toHaveBeenCalled();
  });
  it("shows an empty real search without a connected badge", () => {
    mock.status.data = state({
      result: { printers: [], notes: ["No local advertisements"] },
      reported_at: new Date().toISOString(),
    });
    render(<PrinterDiscoveryPanel agents={[agent]} onChoose={vi.fn()} />);
    chooseAgent();
    expect(screen.getByText(/No matching printers were detected/)).toBeTruthy();
    expect(screen.getByText("No local advertisements")).toBeTruthy();
  });
  it("keeps backend failures visible and blocks requests until resolved", () => {
    mock.status.isError = true;
    mock.status.error = new Error("Discovery permission denied");
    render(<PrinterDiscoveryPanel agents={[agent]} onChoose={vi.fn()} />);
    chooseAgent();
    expect(screen.getByText(/Discovery permission denied/)).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Search printers" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});
