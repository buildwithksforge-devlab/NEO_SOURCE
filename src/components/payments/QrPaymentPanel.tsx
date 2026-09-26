/**
 * Shows the code a QR provider handed back for the guest to scan.
 *
 * Showing a code is not being paid: the bill stays awaiting confirmation until
 * the provider's webhook says otherwise, and this panel says so plainly.
 */
import { useEffect, useState } from "react";
import QRCode from "qrcode";

export function QrPaymentPanel({ payload, imageUrl }: { payload?: string | null; imageUrl?: string | null }) {
  const [src, setSrc] = useState<string | null>(imageUrl ?? null);

  useEffect(() => {
    if (imageUrl) {
      setSrc(imageUrl);
      return;
    }
    if (!payload) {
      setSrc(null);
      return;
    }
    let live = true;
    void QRCode.toDataURL(payload, { margin: 1, width: 220 })
      .then((url) => {
        if (live) setSrc(url);
      })
      .catch(() => {
        if (live) setSrc(null);
      });
    return () => {
      live = false;
    };
  }, [payload, imageUrl]);

  if (!payload && !imageUrl) return null;

  return (
    <div className="grid justify-items-center gap-2 rounded-lg border border-border p-3">
      {src ? (
        <img src={src} alt="Payment QR code for the guest to scan" className="size-[180px]" />
      ) : (
        <p className="break-all text-center text-xs text-muted-foreground">{payload}</p>
      )}
      <p className="text-center text-xs text-muted-foreground">
        Ask the guest to scan this. The bill stays awaiting confirmation until the provider confirms
        the payment.
      </p>
    </div>
  );
}
