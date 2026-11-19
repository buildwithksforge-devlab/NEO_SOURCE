import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const m = vi.hoisted(() => ({ result: {} as any, hook: vi.fn() }));
vi.mock('@/lib/procurement-data', () => ({ useRecentGoodsReceipts: (...args: any[]) => { m.hook(...args); return m.result; } }));
vi.mock('@tanstack/react-router', () => ({ Link: ({ children, params }: any) => <a href={`/lpos/${params.id}`}>{children}</a> }));
vi.mock('@/components/common/DataDisplay', () => ({ SectionCard: ({ children, title }: any) => <section><h2>{title}</h2>{children}</section> }));
vi.mock('@/components/common/DocumentPrintButton', () => ({ DocumentPrintButton: ({ id, label }: any) => <button data-receipt={id}>{label}</button> }));
import { ReceivingDocumentHistory } from '@/components/inventory/ReceivingDocumentHistory';
describe('durable receiving document history', () => {
 beforeEach(() => { m.hook.mockClear(); m.result = { data: [{id:'saved-grn',grn_number:'GRN-42',order_id:'approved-lpo',status:'posted',received_at:'2026-11-19'}], isPending:false,isError:false,isFetching:false,refetch:vi.fn() }; });
 it('retrieves saved history again after remount and keeps the original document/purchase IDs', () => {
  for (let i=0;i<2;i++) { const html=renderToStaticMarkup(<ReceivingDocumentHistory />); expect(html).toContain('GRN-42');expect(html).toContain('data-receipt="saved-grn"');expect(html).toContain('/lpos/approved-lpo'); }
  expect(m.hook).toHaveBeenCalledTimes(2);
 });
 it('retains reversed/status-changed receipts for history and reprint', () => {
  m.result.data[0].status='reversed'; expect(renderToStaticMarkup(<ReceivingDocumentHistory />)).toContain('reversed');
 });
 it('does not disguise a retrieval error as an empty GRN register', () => {
  m.result={...m.result,isError:true,error:new Error('Access denied'),data:undefined}; const html=renderToStaticMarkup(<ReceivingDocumentHistory />);
  expect(html).toContain('Access denied');expect(html).not.toContain('No saved GRNs found');
 });
 it('flags a missing purchase link without inventing one', () => {
  m.result.data[0].order_id=null;const html=renderToStaticMarkup(<ReceivingDocumentHistory />);expect(html).toContain('Purchase link needs review');expect(html).not.toContain('/lpos/');
 });
});
