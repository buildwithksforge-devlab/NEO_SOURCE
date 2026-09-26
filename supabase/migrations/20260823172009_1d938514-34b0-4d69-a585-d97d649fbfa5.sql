ALTER TABLE public.delivery_order_pins
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();