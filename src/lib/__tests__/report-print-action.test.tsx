// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const state = vi.hoisted(() => ({
  allowed: true,
  ready: true,
  export: vi.fn(),
  open: vi.fn(),
  show: vi.fn(),
  close: vi.fn(),
  download: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({ useAuth: () => ({ isAdmin: false, can: () => state.allowed }) }));
vi.mock("@tanstack/react-start", () => ({ useServerFn: () => state.export }));
vi.mock("@/lib/report-pdf.functions", () => ({ exportManagementReportPdf: {} }));
vi.mock("@/lib/browser-document", () => ({
  openDocumentPrintWindow: () => {
    state.open();
    return { show: state.show, close: state.close };
  },
  downloadDocumentPdf: state.download,
}));
vi.mock("@/lib/facts", () => ({
  useFacts: () => ({ isSuccess: state.ready, data: {} }),
  factsAuthorised: () => true,
  useFactReconciliation: () => ({ isLoading: false, data: [] }),
}));
vi.mock("@/lib/fact-export", () => ({
  useReconciliationMeta: () => ({ data: {} }),
  downloadTextFile: vi.fn(),
  factExportCsv: vi.fn(),
  factExportFilename: vi.fn(),
}));
const { FactExportButton } = await import("@/components/common/FactExportButton");
const scope = { branchId: "property-1", from: "2026-11-01", to: "2026-11-16" };
beforeEach(() => {
  vi.clearAllMocks();
  state.allowed = true;
  state.ready = true;
  state.export.mockResolvedValue({ base64: btoa("%PDF"), filename: "report.pdf" });
});
afterEach(cleanup);
describe("management report printing", () => {
  it("opens print preview before exporting the selected property/period", async () => {
    render(
      <FactExportButton scope={scope} scopeLabel="Property 1" paths={["rooms.occupancy_rate"]} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Print report" }));
    await waitFor(() => expect(state.show).toHaveBeenCalledWith(expect.any(Blob), "report.pdf"));
    expect(state.export).toHaveBeenCalledWith({
      data: {
        title: "Management report",
        branchId: scope.branchId,
        from: scope.from,
        to: scope.to,
        paths: ["rooms.occupancy_rate"],
      },
    });
    expect(state.open.mock.invocationCallOrder[0]!).toBeLessThan(
      state.export.mock.invocationCallOrder[0]!,
    );
    expect(state.download).not.toHaveBeenCalled();
  });
  it("exports PDF without opening a print window", async () => {
    render(<FactExportButton scope={scope} scopeLabel="Property 1" />);
    fireEvent.click(screen.getByRole("button", { name: "Export PDF" }));
    await waitFor(() =>
      expect(state.download).toHaveBeenCalledWith(expect.any(Blob), "report.pdf"),
    );
    expect(state.open).not.toHaveBeenCalled();
  });
  it("closes preview on export failure", async () => {
    state.export.mockRejectedValue(new Error("Access denied"));
    render(<FactExportButton scope={scope} scopeLabel="Property 1" />);
    fireEvent.click(screen.getByRole("button", { name: "Print report" }));
    await waitFor(() => expect(state.close).toHaveBeenCalled());
    expect(state.show).not.toHaveBeenCalled();
  });
  it("does not expose exports without permission", () => {
    state.allowed = false;
    render(<FactExportButton scope={scope} scopeLabel="Property 1" />);
    expect(screen.queryByRole("button")).toBeNull();
  });
  it("disables printing until facts load", () => {
    state.ready = false;
    render(<FactExportButton scope={scope} scopeLabel="Property 1" />);
    expect(
      (screen.getByRole("button", { name: "Print report" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(state.export).not.toHaveBeenCalled();
  });
});
