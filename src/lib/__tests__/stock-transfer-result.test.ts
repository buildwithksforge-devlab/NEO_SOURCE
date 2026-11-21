import { describe, expect, it } from "vitest";
import { requireTransferResult } from "@/lib/stock-transfer-result";
const transfer = "00000000-0000-4000-8000-000000000001";
describe("durable transfer response", () => {
  it.each([null,{},[],{ ok: false },{ok:true,status:"completed"}])("rejects incomplete success %j", (value) => {
    expect(() => requireTransferResult(value,"receive",transfer)).toThrow();
  });
  it("requires the requested transfer identity and action state", () => {
    const result = {ok:true,transfer_id:transfer,status:"completed"};
    expect(requireTransferResult(result,"receive",transfer)).toEqual(result);
    expect(() => requireTransferResult(result,"cancel",transfer)).toThrow();
    expect(() => requireTransferResult(result,"receive","other")).toThrow();
  });
  it.each(["in-transit","completed","cancelled"])("retains saved %s state on dispatch replay", (status) => {
    expect(requireTransferResult({ok:true,transfer_id:transfer,transfer_number:"TR-1",replayed:true,status},"create")["status"]).toBe(status);
  });
  it("requires a saved number for dispatch and refuses an unknown replay state", () => {
    expect(() => requireTransferResult({ok:true,transfer_id:transfer,status:"in-transit"},"create")).toThrow();
    expect(() => requireTransferResult({ok:true,transfer_id:transfer,transfer_number:"TR-1",replayed:true,status:"draft"},"create")).toThrow();
  });
});
