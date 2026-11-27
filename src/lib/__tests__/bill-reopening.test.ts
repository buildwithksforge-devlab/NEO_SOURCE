import { describe, expect, it } from "vitest";
import {
  reopeningRequestPayload,
  reopeningDecisionPayload,
  reopeningExecutionPayload,
  validateReopeningResponse,
} from "@/lib/bill-reopening";

const order="00000000-0000-4000-8000-000000000001";
const request="00000000-0000-4000-8000-000000000002";

describe("controlled bill reopening",()=>{

  it("preserves order and retry identity",()=>{

    expect(
      reopeningRequestPayload(
        order,
        "Correct original unpaid bill",
        "intent-1"
      )
    ).toEqual({
      _order:order,
      _reason:"Correct original unpaid bill",
      _intent_key:"intent-1",
    });
  });

  it("rejects insufficient reopening reasons",()=>{

    expect(()=>reopeningRequestPayload(
      order,"test","intent-1"
    )).toThrow();
  });

  it("rejects missing transaction identity",()=>{

    expect(()=>reopeningRequestPayload(
      order,"Correct original unpaid bill",""
    )).toThrow();
  });

  it("preserves independent approval command",()=>{

    expect(
      reopeningDecisionPayload(
        request,true,"Verified reopening reason"
      )
    ).toEqual({
      _request:request,
      _approve:true,
      _note:"Verified reopening reason",
    });
  });

  it("rejects an invalid request identity",()=>{

    expect(()=>reopeningExecutionPayload(
      "invalid"
    )).toThrow();
  });

  it("never sends payment status or order total overrides",()=>{

    expect(
      reopeningExecutionPayload(request)
    ).toEqual({
      _request:request,
    });
  });

  it("accepts matching executed reopening evidence",()=>{

    expect(
      validateReopeningResponse(
        {
          ok:true,
          order_id:order,
          request_id:request,
          status:"executed",
        },
        order,
        request,
        true
      ).status
    ).toBe("executed");
  });

  it("rejects mismatched order evidence",()=>{

    expect(()=>validateReopeningResponse(
      {
        ok:true,
        order_id:request,
        request_id:request,
        status:"executed",
      },
      order,
      request,
      true
    )).toThrow();
  });

  it("rejects approval as completed execution",()=>{

    expect(()=>validateReopeningResponse(
      {
        ok:true,
        order_id:order,
        request_id:request,
        status:"approved",
      },
      order,
      request,
      true
    )).toThrow();
  });
});