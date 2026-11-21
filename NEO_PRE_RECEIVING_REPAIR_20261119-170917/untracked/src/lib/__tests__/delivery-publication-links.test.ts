import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolvePublicWorkspace } from "@/lib/public-apps.functions";

const db = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn(), eq: vi.fn(), limit: vi.fn() }));
vi.mock("@/integrations/supabase/client.server", () => ({ supabaseAdmin: db }));
vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => ({
    inputValidator: (validate: (value: unknown) => unknown) => ({
      handler: (handler: (input: { data: unknown }) => unknown) =>
        ({ data }: { data: unknown }) => handler({ data: validate(data) }),
    }),
  }),
}));

const property = { branch_id: "branch", organization_id: "org", public_slug: "hotel", publicly_listed: true };
const workspace = { id: "delivery", app_key: "delivery", published: true, slug: "hotel-order", branch_id: "branch", organization_id: "org" };
const resolve = (slug: string) => resolvePublicWorkspace({ data: { appKey: "delivery", slug } });

beforeEach(() => {
  vi.resetAllMocks();
  const query = { select: vi.fn(), eq: db.eq, limit: db.limit, maybeSingle: vi.fn().mockResolvedValue({ data: { public_slug: "hotel" } }) };
  query.select.mockReturnValue(query);
  db.eq.mockReturnValue(query);
  db.from.mockReturnValue(query);
  db.limit.mockResolvedValue({ data: [workspace], error: null });
  db.rpc.mockImplementation(async (name, input) => ({
    data: name === "resolve_public_workspace" ? (input._slug === workspace.slug ? workspace : null)
      : input._slug === property.public_slug ? property : null,
    error: null,
  }));
});

describe("published Delivery links", () => {
  it("uses the canonical Delivery slug from a hotel alias, scoped to the same published property", async () => {
    expect(await resolve(" HOTEL ")).toMatchObject({ slug: "hotel-order", guest_slug: "hotel" });
    expect(db.eq.mock.calls).toEqual([["organization_id", "org"], ["branch_id", "branch"], ["app_key", "delivery"], ["published", true]]);
  });

  it("finds the Guest sign-in slug from the explicit Delivery link", async () => {
    expect(await resolve("hotel-order")).toMatchObject({ slug: "hotel-order", guest_slug: "hotel" });
    expect(db.from).toHaveBeenCalledWith("neo_public_experience");
  });

  it("refuses ambiguous or unpublished aliases", async () => {
    db.limit.mockResolvedValueOnce({ data: [workspace, { ...workspace, slug: "second-link" }], error: null });
    db.limit.mockResolvedValueOnce({ data: [], error: null });
    expect(await resolve("hotel")).toBeNull();
    expect(await resolve("hotel")).toBeNull();
  });

  it("distinguishes an unavailable publication check from an unknown link", async () => {
    db.rpc.mockResolvedValueOnce({ data: null, error: { message: "unavailable" } });
    await expect(resolve("hotel")).rejects.toThrow(/publication could not be checked/);
  });
});
