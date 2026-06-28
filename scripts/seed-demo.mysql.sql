-- MySQL/InnoDB port of seed-demo.sql for intelligence-ops-mcp Phase 4 integration tests.
-- ENGINE=InnoDB throughout so the FK graph, composite FK pairing, and the
-- START TRANSACTION READ ONLY safety-net are all exercised.
-- Run via a seed pool with multipleStatements:true (the CONNECTOR keeps it false).

SET FOREIGN_KEY_CHECKS = 0;
DROP TABLE IF EXISTS promociones;
DROP TABLE IF EXISTS precios_region;
DROP TABLE IF EXISTS ventas;
DROP TABLE IF EXISTS inventario;
DROP TABLE IF EXISTS numeros;
DROP TABLE IF EXISTS productos;
DROP TABLE IF EXISTS sucursales;
SET FOREIGN_KEY_CHECKS = 1;

CREATE TABLE sucursales (
  id     INT AUTO_INCREMENT PRIMARY KEY,
  nombre VARCHAR(255) NOT NULL,
  ciudad VARCHAR(255) NOT NULL
) ENGINE=InnoDB COMMENT='Tiendas físicas del retailer';

CREATE TABLE productos (
  id        INT AUTO_INCREMENT PRIMARY KEY,
  sku       VARCHAR(64) NOT NULL UNIQUE,
  nombre    VARCHAR(255) NOT NULL,
  categoria VARCHAR(128) NOT NULL,
  precio    DECIMAL(10,2) NOT NULL
) ENGINE=InnoDB;

CREATE TABLE inventario (
  sucursal_id INT NOT NULL,
  producto_id INT NOT NULL,
  stock       INT NOT NULL,
  updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (sucursal_id, producto_id),
  FOREIGN KEY (sucursal_id) REFERENCES sucursales(id),
  FOREIGN KEY (producto_id) REFERENCES productos(id)
) ENGINE=InnoDB;

CREATE TABLE ventas (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  sucursal_id INT NOT NULL,
  producto_id INT NOT NULL,
  cantidad    INT NOT NULL,
  vendido_en  DATETIME NOT NULL,
  FOREIGN KEY (sucursal_id) REFERENCES sucursales(id),
  FOREIGN KEY (producto_id) REFERENCES productos(id)
) ENGINE=InnoDB;
CREATE INDEX idx_ventas_fecha ON ventas (vendido_en);

INSERT INTO sucursales (nombre, ciudad) VALUES
  ('Narvarte',   'CDMX'),
  ('Roma Norte', 'CDMX'),
  ('Polanco',    'CDMX');

INSERT INTO productos (sku, nombre, categoria, precio) VALUES
  ('CH-001', 'Chamarra Invierno', 'Ropa',    899.00),
  ('PL-002', 'Playera Básica',    'Ropa',    199.00),
  ('TN-003', 'Tenis Running',     'Calzado', 1299.00);

-- Chamarra Invierno (id 1) thin in Narvarte (stock-out risk), healthy elsewhere.
INSERT INTO inventario (sucursal_id, producto_id, stock) VALUES
  (1, 1, 3),  (1, 2, 120), (1, 3, 40),
  (2, 1, 55), (2, 2, 90),  (2, 3, 12),
  (3, 1, 80), (3, 2, 30),  (3, 3, 60);

INSERT INTO ventas (sucursal_id, producto_id, cantidad, vendido_en) VALUES
  (1, 1, 5, NOW() - INTERVAL 1 DAY),  (1, 1, 4, NOW() - INTERVAL 2 DAY),
  (1, 1, 6, NOW() - INTERVAL 3 DAY),  (1, 2, 10, NOW() - INTERVAL 4 DAY),
  (1, 3, 3, NOW() - INTERVAL 6 DAY),  (2, 1, 2, NOW() - INTERVAL 1 DAY),
  (2, 2, 8, NOW() - INTERVAL 2 DAY),  (2, 3, 5, NOW() - INTERVAL 3 DAY),
  (2, 1, 1, NOW() - INTERVAL 10 DAY), (2, 2, 4, NOW() - INTERVAL 20 DAY),
  (3, 1, 3, NOW() - INTERVAL 1 DAY),  (3, 3, 7, NOW() - INTERVAL 2 DAY),
  (3, 2, 2, NOW() - INTERVAL 5 DAY),  (3, 1, 2, NOW() - INTERVAL 15 DAY),
  (3, 3, 4, NOW() - INTERVAL 35 DAY);

-- Composite FK — exercises ordinal FK pairing in describe_table (no cross-product).
CREATE TABLE precios_region (
  region      VARCHAR(64) NOT NULL,
  producto_id INT NOT NULL,
  precio      DECIMAL(10,2) NOT NULL,
  PRIMARY KEY (region, producto_id),
  FOREIGN KEY (producto_id) REFERENCES productos(id)
) ENGINE=InnoDB;

CREATE TABLE promociones (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  region      VARCHAR(64) NOT NULL,
  producto_id INT NOT NULL,
  descuento   DECIMAL(4,2) NOT NULL,
  FOREIGN KEY (region, producto_id) REFERENCES precios_region(region, producto_id)
) ENGINE=InnoDB;

INSERT INTO precios_region (region, producto_id, precio) VALUES
  ('centro', 1, 879.00), ('norte', 1, 899.00);
INSERT INTO promociones (region, producto_id, descuento) VALUES
  ('centro', 1, 0.10);

-- Numbers helper (MySQL has no generate_series): 5000 rows to exercise the row cap.
SET SESSION cte_max_recursion_depth = 20000;
CREATE TABLE numeros (n INT PRIMARY KEY) ENGINE=InnoDB;
INSERT INTO numeros (n)
WITH RECURSIVE seq(n) AS (
  SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 5000
)
SELECT n FROM seq;

-- SELECT-only user (no FILE privilege) — the AUTHORITATIVE read-only layer in production.
-- The connector connects as this user so the integration suite exercises the real posture
-- (and passes the FILE-privilege self-test); the seed itself runs as an admin user.
DROP USER IF EXISTS 'iomcp_ro'@'%';
CREATE USER 'iomcp_ro'@'%' IDENTIFIED BY 'ro_pw';
GRANT SELECT ON *.* TO 'iomcp_ro'@'%';
FLUSH PRIVILEGES;
