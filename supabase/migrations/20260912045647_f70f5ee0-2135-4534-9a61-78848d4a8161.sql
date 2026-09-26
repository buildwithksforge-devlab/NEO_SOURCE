ALTER TABLE public.pos_payments DROP CONSTRAINT IF EXISTS pos_payments_method_chk;

ALTER TABLE public.pos_payments
  ADD CONSTRAINT pos_payments_method_chk CHECK (
    method = ANY (ARRAY[
      'cash',
      'mpesa',
      'card',
      'card-terminal',
      'debit-card',
      'credit-card',
      'qr',
      'bank-transfer',
      'corporate-credit',
      'voucher',
      'ota-prepaid',
      'room-charge',
      'complimentary',
      'other'
    ])
  );