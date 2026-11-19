import { Link } from '@tanstack/react-router';
import { SectionCard } from '@/components/common/DataDisplay';
import { DocumentPrintButton } from '@/components/common/DocumentPrintButton';
import { Button } from '@/components/ui/button';
import { useRecentGoodsReceipts } from '@/lib/procurement-data';
import { useState } from 'react';
import { Input } from '@/components/ui/input';

/** Saved receipts remain discoverable after leaving receiving or changing status. */
export function ReceivingDocumentHistory() {
  const [search, setSearch] = useState('');
  const receipts = useRecentGoodsReceipts(100, search);
  return <SectionCard title="Saved GRNs & purchase history" description="Recent saved receipts for the selected property, including receipts that have moved to matching or been reversed.">
    <Button variant="outline" disabled={receipts.isFetching} onClick={() => void receipts.refetch()}>{receipts.isFetching ? 'Refreshing…' : 'Refresh saved GRNs'}</Button>
    <Input className="mt-3" aria-label="Find saved GRN by number" placeholder="Find a saved GRN by number, including older receipts" value={search} onChange={event => setSearch(event.target.value)} />
    {receipts.isError ? <p role="alert" className="mt-3 text-destructive">Saved GRNs could not be loaded. {receipts.error instanceof Error ? receipts.error.message : 'Refresh to retry.'}</p>
      : receipts.isPending ? <p className="mt-3">Loading saved GRNs…</p>
      : !receipts.data?.length ? <p className="mt-3 text-muted-foreground">No saved GRNs found for this property.</p>
      : <ul className="mt-3 space-y-3">{receipts.data.map(receipt => <li key={String(receipt.id)} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3">
        <div><p className="font-medium">{String(receipt.grn_number || receipt.id)}</p><p className="text-sm text-muted-foreground">{String(receipt.status ?? 'Unknown status')} · {String(receipt.received_at ?? '')}</p></div>
        <div className="flex flex-wrap items-center gap-3"><DocumentPrintButton type="goods_receipt" id={String(receipt.id)} label="Open / reprint GRN" />
          {receipt.order_id ? <Link to="/lpos/$id" params={{ id: String(receipt.order_id) }} className="text-sm underline">Purchase, reconciliation & invoices</Link> : <span className="text-sm text-destructive">Purchase link needs review</span>}
        </div>
      </li>)}</ul>}
  </SectionCard>;
}
