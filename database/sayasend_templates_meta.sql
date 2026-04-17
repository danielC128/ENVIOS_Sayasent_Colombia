-- Extensión de sayasend.templates para integración con Meta Business API.
-- Permite trackear el estado de aprobación de Meta, categoría, idioma,
-- y metadata completa de cada template (header, footer, botones).
-- Es aditivo (IF NOT EXISTS / columnas nullables) — no rompe el CRM ni el motor.

BEGIN;

ALTER TABLE sayasend.templates
  ADD COLUMN IF NOT EXISTS meta_id     VARCHAR(100),
  ADD COLUMN IF NOT EXISTS estado_meta VARCHAR(20),
  ADD COLUMN IF NOT EXISTS categoria   VARCHAR(30),
  ADD COLUMN IF NOT EXISTS idioma      VARCHAR(10),
  ADD COLUMN IF NOT EXISTS header      TEXT,
  ADD COLUMN IF NOT EXISTS footer      TEXT,
  ADD COLUMN IF NOT EXISTS botones     JSONB;

-- meta_id es único cuando está presente (una template por Meta ID)
CREATE UNIQUE INDEX IF NOT EXISTS uq_templates_meta_id
  ON sayasend.templates (meta_id)
  WHERE meta_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_templates_estado_meta
  ON sayasend.templates (estado_meta);

COMMIT;
