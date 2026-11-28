import assert from "node:assert/strict";
import test from "node:test";
import { assessReadiness } from "../platform-readiness.mjs";

const now = new Date("2026-11-19T12:00:00Z");
const scope = { property: "hotel-a", release: "commit-a" };
const assess = (evidence) => assessReadiness({ ...scope, evidence }, now);
const pass = (check) => ({
  ...scope, check, result: "pass", checkedAt: "2026-11-19T11:00:00Z",
  expected: "Records reconcile", observed: "Records reconciled", reference: "test report",
});
const complete = assess([]).checks.map(({ id }) => pass(id));

test("all required evidence is needed for a Ready verdict", () => {
  assert.equal(assess(complete).status, "Ready");
  assert.equal(assess(complete.slice(1)).status, "Unverified");
});

test("another release or property's pass cannot verify a check", () => {
  for (const change of [{ property: "hotel-b" }, { release: "commit-b" }]) {
    assert.equal(assess([{ ...complete[0], ...change }, ...complete.slice(1)]).status, "Unverified");
  }
});

test("a verified blocker outweighs missing evidence and persists until retest", () => {
  const failure = { ...complete[0], result: "fail", checkedAt: "2026-11-01T11:00:00Z" };
  assert.equal(assess([failure]).status, "Blocked");
  assert.equal(assess([failure, { ...complete[0], result: "unverified" }]).status, "Blocked");
  assert.equal(assess([failure, ...complete]).status, "Ready");
});

test("old, skipped, duplicate and future evidence cannot certify readiness", () => {
  for (const evidence of [
    [{ ...complete[0], checkedAt: "2026-11-01T11:00:00Z" }],
    [{ ...complete[0], result: "unverified" }],
    [complete[0], complete[0]],
    [{ ...complete[0], checkedAt: "2026-11-20T11:00:00Z" }],
  ]) {
    assert.equal(assess([...evidence, ...complete.slice(1)]).status, "Unverified");
  }
});

test("only optional disabled capabilities can be marked Not applicable", () => {
  const waive = (row, enabled) => ({
    ...row, result: "not-applicable", enabled, applicabilityReason: "Property has no guest laundry",
  });
  const withWaiver = (id, enabled) => complete.map((row) => row.check === id ? waive(row, enabled) : row);
  assert.equal(assess(withWaiver("workflow/laundry", false)).status, "Ready");
  assert.equal(assess(withWaiver("workflow/laundry", true)).status, "Unverified");
  assert.equal(assess(withWaiver("workflow/documents", false)).status, "Unverified");
});
