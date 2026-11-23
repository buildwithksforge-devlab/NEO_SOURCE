import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolvePublicWorkspace } from "@/lib/public-apps.functions";

const rpc = vi.hoisted(() => vi.fn());
vi.mock("@/integrations/supabase/client", () => ({ supabase: { rpc } }));
vi.mock("@/integrations/supabase/client.server", () => {
  throw new Error("Delivery publication must not load the service client");
});
vi.mock("@tanstack/react-start", () => ({
  createServerFn: () => ({
    inputValidator: (validate: (value: unknown) => unknown) => ({
      handler: (handler: (input: { data: unknown }) => unknown) =>
        ({ data }: { data: unknown }) => handler({ data: validate(data) }),
    }),
  }),
}));

const workspace = { id: "delivery", app_key: "delivery", published: true, slug: "hotel-order", branch_id: "branch", organization_id: "org", guest_slug: "hotel" };
const resolve = (slug: string) => resolvePublicWorkspace({ data: { appKey: "delivery", slug } });

beforeEach(() => rpc.mockReset());

describe("published Delivery links", () => {
  it("uses the publication's canonical slug and Guest handoff without a service credential", async () => {
    rpc.mockResolvedValueOnce({ data: workspace, error: null });
    rpc.mockResolvedValueOnce({ data: {
      branch_id: "branch", organization_id: "org", property_name: "Canonical hotel",
      media: { logo_url: "https://hotel.example/logo.webp" },
    }, error: null });
    expect(await resolve(" HOTEL ")).toEqual({
      ...workspace, hotel_name: "Canonical hotel", logo_url: "https://hotel.example/logo.webp",
      primary_color: undefined, secondary_color: undefined,
      background_color: undefined, experience_brand: null,
    });
    expect(rpc).toHaveBeenNthCalledWith(1, "neo_public_delivery_workspace", { _slug: "hotel" });
    expect(rpc).toHaveBeenNthCalledWith(2, "neo_public_property", { _slug: "hotel" });
  });

  it("distinguishes an unknown link from a failed database lookup", async () => {
    rpc.mockResolvedValueOnce({ data: null, error: null });
    rpc.mockResolvedValueOnce({ data: null, error: { message: "unavailable" } });
    expect(await resolve("hotel")).toBeNull();
    await expect(resolve("hotel")).rejects.toThrow("Delivery publication could not be checked");
  });
});
