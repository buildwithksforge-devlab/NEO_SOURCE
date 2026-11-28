import { describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client",()=>({
  supabase:{rpc:vi.fn()},
}));

import { supabase } from "@/integrations/supabase/client";

import {
  complimentaryExecutionPayload,
  executeApprovedComplimentary,
} from "@/lib/complimentary-pos-execution";

const order="00000000-0000-4000-8000-000000000001";
const item="00000000-0000-4000-8000-000000000002";
const approval="00000000-0000-4000-8000-000000000003";

const rpc = supabase.rpc as unknown as ReturnType<typeof vi.fn>;

describe("complimentary execution identity",()=>{

  it("uses the exact canonical three-argument contract",()=>{

    expect(
      complimentaryExecutionPayload(order,item,approval)
    ).toEqual({
      _order:order,
      _item:item,
      _approval:approval,
    });
  });

  it("rejects invalid order identity",()=>{

    expect(()=>complimentaryExecutionPayload(
      "",item,approval
    )).toThrow();
  });

  it("rejects invalid item identity",()=>{

    expect(()=>complimentaryExecutionPayload(
      order,"invalid",approval
    )).toThrow();
  });

  it("rejects invalid approval identity",()=>{

    expect(()=>complimentaryExecutionPayload(
      order,item,""
    )).toThrow();
  });

  it("never supplies client pricing overrides",()=>{

    expect(
      Object.keys(
        complimentaryExecutionPayload(order,item,approval)
      ).sort()
    ).toEqual([
      "_order","_item","_approval"
    ].sort());
  });

  it("accepts matching execution evidence",async()=>{

    rpc.mockResolvedValueOnce({
      data:{
        ok:true,
        order_id:order,
        order_item_id:item,
        approval_id:approval,
      },
      error:null,
    } as any);

    await expect(
      executeApprovedComplimentary(order,item,approval)
    ).resolves.toMatchObject({
      ok:true,
    });
  });

  it("rejects mismatched execution evidence",async()=>{

    rpc.mockResolvedValueOnce({
      data:{
        ok:true,
        order_id:order,
        order_item_id:approval,
        approval_id:approval,
      },
      error:null,
    } as any);

    await expect(
      executeApprovedComplimentary(order,item,approval)
    ).rejects.toThrow();
  });
});