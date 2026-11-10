import {readFileSync} from 'node:fs';
import {describe,it,expect} from 'vitest';
import {addGrant,canFromPermissions} from '@/lib/permissions';

const route=readFileSync('src/routes/_shell.pos.orders.$id.tsx','utf8');
const payment=route.slice(route.indexOf('function PaymentDialog('));
const canConfirm=(feature:string,action:string)=>{
 const grants=new Set<string>();addGrant(grants,'pos',feature,action);
 return canFromPermissions(grants)('pos','payments','manual-confirm');
};
describe('POS payment authority and property context',()=>{
 it('uses the payment authority enforced by the settlement backend',()=>{
  expect(payment).toContain('can("pos", "payments", "manual-confirm")');
  expect(payment).not.toContain('can("pos", "orders.approve")');
  expect(canConfirm('payments','manual-confirm')).toBe(true);
  expect(canConfirm('orders','approve')).toBe(false);
  expect(canConfirm('orders','view')).toBe(false);
 });
 it('loads the till for the actual order property',()=>{
  expect(route).toContain('branchId={data.branch_id}');
  expect(payment).toContain('useTillContext(branchId)');
  expect(payment).not.toContain('useTillContext()');
 });
 it('blocks cash while its property/till lookup is absent, loading or failed',()=>{
  expect(payment).toContain('isCash && (!branchId || till.isLoading || till.isError)');
  expect(payment).toContain('Cash routing is unavailable.');
 });
 it('does not submit a retained manual-confirm choice after permission changes',()=>{
  expect(payment).toContain('manualConfirm && (!canManualConfirm || !note.trim())');
 });
});
