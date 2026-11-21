-- Migración 0002: registro de llamadas a Twelve Data para respetar el límite de
-- créditos por minuto entre el cron y las lecturas forzadas. Solo aditiva.
CREATE TABLE IF NOT EXISTS twelve_calls (
  ts INTEGER NOT NULL                  -- epoch UTC en segundos de cada intento
);

CREATE INDEX IF NOT EXISTS idx_twelve_calls_ts ON twelve_calls (ts);
