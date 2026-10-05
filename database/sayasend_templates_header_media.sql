-- Extensión de sayasend.templates para soportar templates con header de media
-- (imagen, video, documento). Para el caso típico de templates de WhatsApp con
-- imagen en el encabezado: el admin sube la imagen al bucket GCS, guarda la
-- URL pública aquí, y el motor al enviar inyecta el componente header en el
-- payload de Meta.
-- Es aditivo (IF NOT EXISTS / columnas nullables) — no rompe al CRM ni al motor.

BEGIN;

ALTER TABLE sayasend.templates
  ADD COLUMN IF NOT EXISTS header_type      VARCHAR(20),
  ADD COLUMN IF NOT EXISTS header_media_url TEXT;

COMMENT ON COLUMN sayasend.templates.header_type IS 'Tipo de header: TEXT, IMAGE, DOCUMENT, VIDEO. NULL si la template no tiene header.';
COMMENT ON COLUMN sayasend.templates.header_media_url IS 'URL publica del media (ej. GCS bucket) usada cuando header_type es IMAGE, DOCUMENT o VIDEO. Incluida en cada send como parametro del componente header.';

COMMIT;
