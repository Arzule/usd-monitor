-- Migración 0001: tablas base. Solo aditiva.

-- Lecturas en vivo de Twelve Data (USD/PEN). Una fila por timestamp de cotización.
CREATE TABLE IF NOT EXISTS live_rates (
  ts INTEGER PRIMARY KEY,              -- epoch UTC en segundos
  price REAL NOT NULL,
  source TEXT NOT NULL,
  is_outlier INTEGER NOT NULL DEFAULT 0
);

-- Historial y mediana filtran por is_outlier y ordenan/acotan por ts.
CREATE INDEX IF NOT EXISTS idx_live_rates_valid_ts ON live_rates (is_outlier, ts);

-- Tipo de cambio interbancario oficial del BCRP (compra/venta), uno por día.
-- compra/venta pueden ser NULL cuando el BCRP publica "n.d." para uno de los dos.
CREATE TABLE IF NOT EXISTS bcrp_rates (
  date TEXT PRIMARY KEY,               -- YYYY-MM-DD (fecha de Lima)
  compra REAL,
  venta REAL,
  fetched_at INTEGER NOT NULL          -- epoch UTC en segundos
);
