-- Fallback al número alterno (pedido en la reunión del 11/08/2026).
--
-- El motor ahora intenta enviar al teléfono principal (clientes.telefono) y, si
-- ese intento queda en 'failed', reintenta con el alterno (clientes.telefono_3).
-- Estas columnas guardan qué pasó con CADA número, para que el CRM pueda mostrar
-- los errores separados por teléfono 1 / teléfono 2 en el detalle de la campaña.
--
-- `failure_code` / `failure_reason` (las de siempre) se mantienen con el ÚLTIMO
-- error, para no romper lo que ya lee el CRM.

ALTER TABLE sayasend.campaign_contacts
  ADD COLUMN IF NOT EXISTS phone_1           VARCHAR(20),   -- número principal intentado
  ADD COLUMN IF NOT EXISTS failure_code_1    VARCHAR(50),
  ADD COLUMN IF NOT EXISTS failure_reason_1  TEXT,
  ADD COLUMN IF NOT EXISTS phone_2           VARCHAR(20),   -- número alterno (telefono_3)
  ADD COLUMN IF NOT EXISTS failure_code_2    VARCHAR(50),
  ADD COLUMN IF NOT EXISTS failure_reason_2  TEXT,
  ADD COLUMN IF NOT EXISTS phone_used        VARCHAR(20);   -- con cuál se logró enviar
