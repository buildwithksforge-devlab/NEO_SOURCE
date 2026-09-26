ALTER TABLE public.assets ADD COLUMN IF NOT EXISTS quantity integer NOT NULL DEFAULT 1;
ALTER TABLE public.assets ADD CONSTRAINT assets_quantity_positive CHECK (quantity >= 1);