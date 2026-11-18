// @vitest-environment jsdom
import {beforeEach,describe,expect,it,vi} from "vitest";
import {clearMinibarAttempt,getMinibarAttempt,minibarAttemptKey,requireMinibarAttemptResult} from "../minibar-attempt";
const id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
beforeEach(()=>localStorage.clear());
describe("durable minibar browser identity",()=>{
 it("retains the request across retries, reloads and changed drafts until explicitly reset",()=>{
  const key=minibarAttemptKey(id(1),id(2),id(3));
  const first=getMinibarAttempt(key);expect(getMinibarAttempt(key)).toBe(first);
  expect(localStorage.getItem(key)).toBe(first);
  clearMinibarAttempt(key);expect(getMinibarAttempt(key)).not.toBe(first);
 });
 it("separates organizations, employees and folios",()=>{
  const keys=[[1,2,3],[2,2,3],[1,3,3],[1,2,4]].map(ids=>minibarAttemptKey(...ids.map(id) as [string,string,string]));
  expect(new Set(keys.map(key=>getMinibarAttempt(key))).size).toBe(4);
 });
 it("refuses missing identity and unavailable or corrupt storage before posting",()=>{
  expect(()=>minibarAttemptKey("",id(2),id(3))).toThrow();
  const storage={getItem:vi.fn(()=>{throw new Error("denied");})} as unknown as Storage;
  expect(()=>getMinibarAttempt("key",storage)).toThrow(/browser could not retain/);
  localStorage.setItem("key","bad");expect(()=>getMinibarAttempt("key")).toThrow();
 });
 it("does not clear a newer request while resolving an older one",()=>{
  localStorage.setItem("key",id(1));clearMinibarAttempt("key",id(2));expect(localStorage.getItem("key")).toBe(id(1));
 });
 it("requires the exact saved request, folio, store and room response",()=>{
  const saved={attempt_id:id(1),folio_id:id(2),location_id:id(3),room_id:id(4),replayed:true};
  expect(requireMinibarAttemptResult(saved,id(1),id(2),id(3),id(4))).toBe(saved);
  for(const field of ["attempt_id","folio_id","location_id","room_id","replayed"])
   expect(()=>requireMinibarAttemptResult({...saved,[field]:null},id(1),id(2),id(3),id(4))).toThrow();
 });
});
