-- Extensiones al schema sayasend para el motor de envíos (Sayasent Colombia).
-- Basado en las tablas equivalentes del schema `codigopago` para mantener la
-- misma robustez de tracking de Meta (message IDs, webhooks, historial).
-- Es aditivo (IF NOT EXISTS / DEFAULT) — no rompe al CRM ni a datos existentes.

BEGIN;

-- ========================================================================
-- 1. Extender campaign_contacts con tracking de Meta
-- ========================================================================
ALTER TABLE sayasend.campaign_contacts
  ADD COLUMN IF NOT EXISTS whatsapp_message_id VARCHAR(255),
  ADD COLUMN IF NOT EXISTS failure_code VARCHAR(50),
  ADD COLUMN IF NOT EXISTS retry_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS replied_at TIMESTAMP WITHOUT TIME ZONE;

CREATE INDEX IF NOT EXISTS idx_campaign_contacts_wa_msg_id
  ON sayasend.campaign_contacts (whatsapp_message_id);

-- ========================================================================
-- 2. webhook_logs: payloads crudos de Meta para audit/debug
-- ========================================================================
CREATE TABLE IF NOT EXISTS sayasend.webhook_logs (
  id          BIGSERIAL PRIMARY KEY,
  event_type  VARCHAR(100),
  payload     JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_webhook_logs_created_at
  ON sayasend.webhook_logs (created_at DESC);

-- ========================================================================
-- 3. mensaje_out: 1 fila por cada intento de envío a Meta
-- ========================================================================
CREATE TABLE IF NOT EXISTS sayasend.mensaje_out (
  id_msg              TEXT PRIMARY KEY,
  campaign_contact_id UUID REFERENCES sayasend.campaign_contacts(id) ON DELETE CASCADE,
  campaign_id         UUID REFERENCES sayasend.campaigns(id) ON DELETE CASCADE,
  phone_to            TEXT NOT NULL,
  template_name       TEXT NOT NULL,
  template_lang       TEXT NOT NULL,
  sent_at             TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mensaje_out_campaign
  ON sayasend.mensaje_out (campaign_id);
CREATE INDEX IF NOT EXISTS idx_mensaje_out_contact
  ON sayasend.mensaje_out (campaign_contact_id);

-- ========================================================================
-- 4. mensaje_status_event: historial de cambios de estado por mensaje
-- ========================================================================
CREATE TABLE IF NOT EXISTS sayasend.mensaje_status_event (
  id                BIGSERIAL PRIMARY KEY,
  id_msg            TEXT NOT NULL REFERENCES sayasend.mensaje_out(id_msg) ON DELETE CASCADE,
  estado            TEXT NOT NULL,
  ts_unix           BIGINT,
  recipient_id      TEXT,
  pricing_json      JSONB,
  conversation_json JSONB,
  errors_json       JSONB,
  created_at        TIMESTAMP WITHOUT TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_mensaje_status_event_id_msg
  ON sayasend.mensaje_status_event (id_msg);
CREATE INDEX IF NOT EXISTS idx_mensaje_status_event_created_at
  ON sayasend.mensaje_status_event (created_at DESC);

COMMIT;
