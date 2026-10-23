-- NEØ F02: Preserve the reservation deposit calculation.
-- Additive schema migration. Existing reservation rows are not rewritten.

ALTER TABLE public.reservations
ADD COLUMN IF NOT EXISTS deposit_basis text;

ALTER TABLE public.reservations
ADD COLUMN IF NOT EXISTS deposit_value numeric;

COMMENT ON COLUMN public.reservations.deposit_basis
IS 'Reservation deposit basis: percentage or fixed.';

COMMENT ON COLUMN public.reservations.deposit_value
IS 'Original percentage or fixed deposit amount.';

DO $do$
BEGIN

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'reservations_deposit_basis_valid'
      AND conrelid = 'public.reservations'::regclass
  ) THEN
    ALTER TABLE public.reservations
    ADD CONSTRAINT reservations_deposit_basis_valid
    CHECK (
      deposit_basis IS NULL
      OR deposit_basis IN ('percentage','fixed')
    );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'reservations_deposit_value_valid'
      AND conrelid = 'public.reservations'::regclass
  ) THEN
    ALTER TABLE public.reservations
    ADD CONSTRAINT reservations_deposit_value_valid
    CHECK (
      deposit_value IS NULL
      OR (
        deposit_value >= 0
        AND (
          deposit_basis IS NULL
          OR deposit_basis <> 'percentage'
          OR deposit_value <= 100
        )
      )
    );
  END IF;

END;
$do$;