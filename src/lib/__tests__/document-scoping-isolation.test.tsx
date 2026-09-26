// @vitest-environment jsdom
/**
 * Cross-property leak protection for documents and previews.
 *
 * A document may only ever show the ACTIVE property's mark, trading name and
 * contact details. Stale client context (an active id that no longer resolves,
 * a cached sibling branch, a "All properties" workspace) must degrade to
 * organisation identity — never borrow a neighbouring property's brand.
 *
 * Switching the active property must also re-render branding immediately, with
 * no reload, for both the on-screen preview and the payload the PDF renders.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { resolveDocumentIdentity } from "@/lib/document-identity";
import type { Branch } from "@/lib/tenant-types";

const branches = [
  {
    id: "prop-1",
    name: "Coastline Diani",
    logo: "diani.png",
    address: "Diani Beach Road",
    phone: "+254711111111",
    email: "diani@example.com",
  },
  {
    id: "prop-2",
    name: "Coastline Westlands",
    logo: "westlands.png",
    address: "Westlands Road",
    phone: "+254722222222",
    email: "westlands@example.com",
  },
] as unknown as Branch[];

const tenant = {
  organization: { name: "Coastline Collection", legalName: "Coastline Collection Limited" },
  contact: {
    address: "Head office, Nairobi",
    phonePrimary: "+254700000000",
    email: "hq@example.com",
    website: "coastline.example",
  },
  regional: { taxIdLabel: "PIN", taxId: "P051", registrationNumber: "C-99", currency: "KES" },
  branches,
};

/** Mutable so a test can switch the active property between renders. */
const active = { branchId: null as string | null };

vi.mock("@/lib/branding", () => ({
  useBranding: () => ({
    branding: { logo: "org-mark.png" },
    brand: { primary: "#18C4C8", accent: "#D5AF63", logoText: "NEØ" },
  }),
}));

vi.mock("@/lib/tenant", () => ({ useTenant: () => ({ tenant }) }));

vi.mock("@/lib/branch-filter", () => ({
  useActivePropertyFilter: () => ({ branchId: active.branchId }),
}));

const { DocumentPreview } = await import("@/components/documents/DocumentPreview");

afterEach(cleanup);

const preview = () =>
  render(
    <DocumentPreview
      documentType="Invoice"
      documentNumber="INV-1"
      columns={[{ key: "description", label: "Description" }]}
      rows={[{ description: "Accommodation" }]}
    />,
  );

const shownLogo = (container: HTMLElement) =>
  container.querySelector("[data-document-logo]")?.getAttribute("src") ?? null;

const shownName = (container: HTMLElement) =>
  container.querySelector("[data-document-trading-name]")?.textContent ?? "";

describe("documents never render a non-active property", () => {
  it("shows only the active property's mark, never a sibling's", () => {
    active.branchId = "prop-1";
    const { container } = preview();
    expect(shownLogo(container)).toBe("diani.png");
    expect(shownName(container)).toBe("Coastline Diani");
    expect(container.innerHTML).not.toContain("westlands.png");
    expect(container.textContent).not.toContain("Coastline Westlands");
    expect(container.textContent).not.toContain("Westlands Road");
  });

  it("degrades to organisation identity when the cached active id no longer resolves", () => {
    active.branchId = "prop-deleted";
    const { container } = preview();
    expect(shownLogo(container)).toBe("org-mark.png");
    expect(shownName(container)).toBe("Coastline Collection");
    expect(container.innerHTML).not.toContain("diani.png");
    expect(container.innerHTML).not.toContain("westlands.png");
  });

  it("uses organisation identity on the all-properties workspace", () => {
    active.branchId = null;
    const { container } = preview();
    expect(shownLogo(container)).toBe("org-mark.png");
    expect(container.textContent).toContain("Head office, Nairobi");
    expect(container.textContent).not.toContain("Diani Beach Road");
  });

  it("never falls back to the first branch in the list", () => {
    // The classic leak: an unresolved property silently picking branches[0].
    const identity = resolveDocumentIdentity({
      organization: tenant.organization,
      contact: tenant.contact,
      regional: tenant.regional,
      brand: { primary: "#18C4C8", accent: "#D5AF63", logoText: "NEØ" },
      organisationLogo: "org-mark.png",
      property: null,
    });
    expect(identity.logo).toBe("org-mark.png");
    expect(identity.logoSource).toBe("organisation");
    expect(identity.propertyName).toBe("");
    expect(identity.propertyId).toBeNull();
  });
});

describe("switching the active property updates branding immediately", () => {
  it("re-renders the preview masthead and footer without a reload", () => {
    active.branchId = "prop-1";
    const { container, rerender } = preview();
    expect(shownLogo(container)).toBe("diani.png");
    expect(container.textContent).toContain("Diani Beach Road");

    active.branchId = "prop-2";
    rerender(
      <DocumentPreview
        documentType="Invoice"
        documentNumber="INV-1"
        columns={[{ key: "description", label: "Description" }]}
        rows={[{ description: "Accommodation" }]}
      />,
    );

    expect(shownLogo(container)).toBe("westlands.png");
    expect(shownName(container)).toBe("Coastline Westlands");
    expect(container.textContent).toContain("Westlands Road");
    expect(container.textContent).not.toContain("Diani Beach Road");
  });

  it("keeps the legal entity stable while the trading identity follows the property", () => {
    for (const [id, name] of [
      ["prop-1", "Coastline Diani"],
      ["prop-2", "Coastline Westlands"],
    ] as const) {
      active.branchId = id;
      const { container, unmount } = preview();
      expect(shownName(container)).toBe(name);
      expect(container.textContent).toContain("Coastline Collection Limited");
      unmount();
    }
  });
});

describe("the PDF renderer resolves the same active property, server-side", () => {
  const source = readSource("src/lib/document-pdf.server.ts");

  it("looks the property up by the payload's branch id, not by list position", () => {
    expect(source).toContain("branch_id");
    expect(source).toMatch(/from\("branches"\)/);
    expect(source).toMatch(/\.eq\("id",/);
    expect(source).not.toMatch(/branches\[0\]|\.limit\(1\)\s*\)\s*;\s*$/m);
  });
});

function readSource(path: string) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("node:fs").readFileSync(path, "utf8") as string;
}
