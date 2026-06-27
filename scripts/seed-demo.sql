-- Demo retail warehouse for intelligence-ops-mcp Phase 1.
-- Mirrors the EurekaMS Intelligence Ops demo: sucursales, productos, inventario, ventas.
-- Enough data to answer the 4 success-criteria questions (§9 of the plan).
-- Idempotent: drops and recreates.

DROP TABLE IF EXISTS ventas CASCADE;
DROP TABLE IF EXISTS inventario CASCADE;
DROP TABLE IF EXISTS productos CASCADE;
DROP TABLE IF EXISTS sucursales CASCADE;

CREATE TABLE sucursales (
  id      SERIAL PRIMARY KEY,
  nombre  TEXT NOT NULL,
  ciudad  TEXT NOT NULL
);
COMMENT ON TABLE sucursales IS 'Tiendas físicas del retailer';

CREATE TABLE productos (
  id        SERIAL PRIMARY KEY,
  sku       TEXT NOT NULL UNIQUE,
  nombre    TEXT NOT NULL,
  categoria TEXT NOT NULL,
  precio    NUMERIC(10,2) NOT NULL
);

CREATE TABLE inventario (
  sucursal_id INTEGER NOT NULL REFERENCES sucursales(id),
  producto_id INTEGER NOT NULL REFERENCES productos(id),
  stock       INTEGER NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (sucursal_id, producto_id)
);

CREATE TABLE ventas (
  id          SERIAL PRIMARY KEY,
  sucursal_id INTEGER NOT NULL REFERENCES sucursales(id),
  producto_id INTEGER NOT NULL REFERENCES productos(id),
  cantidad    INTEGER NOT NULL,
  vendido_en  TIMESTAMPTZ NOT NULL
);
CREATE INDEX idx_ventas_fecha ON ventas (vendido_en);

INSERT INTO sucursales (nombre, ciudad) VALUES
  ('Narvarte',   'CDMX'),
  ('Roma Norte', 'CDMX'),
  ('Polanco',    'CDMX');

INSERT INTO productos (sku, nombre, categoria, precio) VALUES
  ('CH-001', 'Chamarra Invierno',  'Ropa',    899.00),
  ('PL-002', 'Playera Básica',     'Ropa',    199.00),
  ('TN-003', 'Tenis Running',      'Calzado', 1299.00);

-- Inventory: Chamarra Invierno (id 1) thin in Narvarte (stock-out risk), healthy elsewhere.
INSERT INTO inventario (sucursal_id, producto_id, stock) VALUES
  (1, 1, 3),  (1, 2, 120), (1, 3, 40),
  (2, 1, 55), (2, 2, 90),  (2, 3, 12),
  (3, 1, 80), (3, 2, 30),  (3, 3, 60);

-- Sales over the last ~40 days. Narvarte sells chamarras fast (3-day stock-out risk).
INSERT INTO ventas (sucursal_id, producto_id, cantidad, vendido_en)
SELECT
  s.sucursal_id,
  s.producto_id,
  s.cantidad,
  now() - (s.dias_atras || ' days')::interval
FROM (VALUES
  (1, 1, 5, 1), (1, 1, 4, 2), (1, 1, 6, 3), (1, 2, 10, 4), (1, 3, 3, 6),
  (2, 1, 2, 1), (2, 2, 8, 2), (2, 3, 5, 3), (2, 1, 1, 10), (2, 2, 4, 20),
  (3, 1, 3, 1), (3, 3, 7, 2), (3, 2, 2, 5), (3, 1, 2, 15), (3, 3, 4, 35)
) AS s(sucursal_id, producto_id, cantidad, dias_atras);

-- Composite FK — exercises ordinal FK pairing in describe_table (no cross-product).
DROP TABLE IF EXISTS promociones CASCADE;
DROP TABLE IF EXISTS precios_region CASCADE;

CREATE TABLE precios_region (
  region      TEXT NOT NULL,
  producto_id INTEGER NOT NULL REFERENCES productos(id),
  precio      NUMERIC(10,2) NOT NULL,
  PRIMARY KEY (region, producto_id)
);

CREATE TABLE promociones (
  id          SERIAL PRIMARY KEY,
  region      TEXT NOT NULL,
  producto_id INTEGER NOT NULL,
  descuento   NUMERIC(4,2) NOT NULL,
  FOREIGN KEY (region, producto_id) REFERENCES precios_region(region, producto_id)
);

INSERT INTO precios_region (region, producto_id, precio) VALUES
  ('centro', 1, 879.00), ('norte', 1, 899.00);
INSERT INTO promociones (region, producto_id, descuento) VALUES
  ('centro', 1, 0.10);
