# intelligence-ops-mcp — Documento Fundacional

> Capa de inteligencia sobre tus propios datos. Sin dependencias externas, sin data out of house, sin black boxes.

---

## Por qué existe este proyecto

El módulo Intelligence Ops de EurekaMS necesitaba una capa de conexión con los datos del cliente — inventario, throughput, comportamiento de compra, KPIs operativos. La primera versión asumía Wilab como proveedor de ese puente.

La decisión cambió: **construimos ese puente nosotros**.

Las razones son tres:

1. **Control total de la experiencia.** El SQL Agent, el renderizado de resultados, el trail de auditoría — todo dentro de EurekaMD. Si algo falla, lo resolvemos. Si queremos mejorarlo, lo mejoramos.
2. **El dato nunca sale del cliente.** El agente corre contra la base de datos del cliente (Postgres, MySQL, BigQuery, Snowflake). No hay extracción, no hay espejo, no hay sync a servidores de terceros. El cliente pregunta en lenguaje natural; el agente genera SQL, lo ejecuta en la fuente original y regresa la respuesta.
3. **Escalabilidad comercial.** Wilab es un costo variable por cliente. `intelligence-ops-mcp` es un activo que amortizamos en cada contrato. El undécimo cliente no cuesta más que el primero en el stack de inteligencia.

---

## Qué hace

`intelligence-ops-mcp` es un servidor MCP (Model Context Protocol) con un SQL Agent integrado. Se instala junto al motor de EurekaMS y expone 5 capacidades que, combinadas, forman el loop de inteligencia que el cliente experimenta como "pregunta en lenguaje natural → respuesta con datos → gráfica → siguiente acción".

### Las 5 capacidades

| #   | Capacidad            | Qué resuelve                                                                                                         |
| --- | -------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 1   | **MCP Connector**    | Conexión read-only a la base de datos del cliente (Postgres primero, luego MySQL, BigQuery, Snowflake)               |
| 2   | **Schema Discovery** | El agente aprende el esquema del cliente automáticamente: tablas, columnas, tipos, relaciones                        |
| 3   | **SQL Agent**        | Genera SQL a partir de lenguaje natural → valida la consulta → la ejecuta → regresa resultado estructurado           |
| 4   | **Result Renderer**  | Transforma el resultado en narrativa + ECharts (tablas, barras, líneas de tendencia)                                 |
| 5   | **Audit Trail**      | Registra cada consulta, el SQL generado, el tiempo de respuesta y el resultado — para trazabilidad y mejora continua |

### El loop completo

```
Cliente pregunta en lenguaje natural
        ↓
Schema Discovery aporta contexto del esquema
        ↓
SQL Agent genera + valida + ejecuta la consulta
        ↓
Result Renderer produce narrativa + gráfica
        ↓
Audit Trail registra el ciclo completo
```

---

## Preguntas que responde

Las mismas que el agente de inventario demuestra en el landing de EurekaMS:

- _¿Cuál es el stock actual de la referencia 4521 en mis 5 tiendas?_
- _¿Qué producto tiene el throughput más bajo en los últimos 30 días?_
- _¿En qué tienda hay exceso de inventario que podría redirigir a otra con escasez?_
- _¿Cuál fue la jornada de mayor venta la semana pasada y a qué hora se concentró?_
- _Dame los SKUs con stock bajo que históricamente se agotan en menos de 3 días._
- _¿Cuánto dinero tengo paralizado en inventario muerto en la tienda del norte?_

La respuesta llega en menos de 60 segundos desde la base de datos del cliente — sin dashboards preconstruidos, sin reportes programados, sin intermediarios.

---

## Para quién

**Primario:** el motor de Intelligence Ops dentro de EurekaMS, para el segmento de cadenas multitienda en México con 5+ puntos de venta.

**Secundario:** cualquier integracion donde EurekaMS necesite leer datos estructurados del cliente y responder con inteligencia — por ejemplo, contexto de inventario para los agentes de Voice Solutions, o datos de densidad para Territory Ops.

**No es un producto standalone.** No tiene UI propia, no tiene login, no se licencia por separado. Es la capa de datos que hace inteligente al resto del sistema.

---

## Arquitectura

### Flujo de una consulta

```
[Usuario, en el chat de Intelligence Ops]
  "¿Qué producto tiene más rotación esta semana?"
        ↓
[MCP Connector]
  Conexión activa a la DB del cliente (Postgres, read-only)
        ↓
[Schema Discovery]
  Carga el esquema relevante: tablas 'productos', 'ventas', 'movimientos'
  Context: columnas, tipos, relaciones
        ↓
[SQL Agent — LLM]
  Genera:
    SELECT p.nombre, SUM(v.cantidad) AS unidades_vendidas
    FROM ventas v
    JOIN productos p ON p.id = v.producto_id
    WHERE v.fecha >= CURRENT_DATE - INTERVAL '7 days'
    GROUP BY p.nombre
    ORDER BY unidades_vendidas DESC
    LIMIT 10;
  Valida: sintaxis + lectura-only (no INSERT/UPDATE/DELETE/DROP)
  Ejecuta: query contra la DB del cliente
  Resultado: 10 filas, <60ms
        ↓
[Result Renderer]
  Narrativa: "El producto con mayor rotación esta semana es X con 340 unidades..."
  Visual: barra horizontal ECharts top-10
        ↓
[Audit Trail]
  Registra: consulta, SQL, latencia, n_filas, timestamp
```

### Stack técnico

- **Runtime:** Node.js + TypeScript (ESM)
- **Protocolo:** `@modelcontextprotocol/sdk` — expone 3 herramientas MCP: `list_tables`, `describe_table`, `execute_query`
- **Connectors:** `pg` (Postgres) en Phase 1; `mysql2`, `@google-cloud/bigquery` en fases posteriores
- **SQL Validation:** whitelist de verbos (SELECT, WITH, EXPLAIN); bloqueo de DDL/DML
- **Result Rendering:** ECharts JSON spec generado por el LLM, renderizado en el frontend
- **Audit Trail:** SQLite local o Supabase (configurable por deployment)
- **LLM:** vía el router de inferencia de EurekaMS — Claude como primario, compatible con cualquier proveedor que soporte tool calling

### Herramientas MCP expuestas

```typescript
// Lista las tablas accesibles en el esquema del cliente
list_tables(schema?: string): Table[]

// Describe una tabla específica: columnas, tipos, constraints
describe_table(table: string, schema?: string): TableSchema

// Ejecuta una consulta read-only y regresa filas + metadata
execute_query(sql: string, params?: unknown[]): QueryResult
```

---

## Fases de construcción

### Phase 1 — MCP Core (Postgres) `[next]`

**Meta:** agente funcional contra cualquier base de datos Postgres del cliente.

- [ ] Servidor MCP básico con `@modelcontextprotocol/sdk`
- [ ] Connector Postgres (read-only, connection pool)
- [ ] `list_tables` — lista tablas en el schema público
- [ ] `describe_table` — columnas, tipos, PKs, FKs
- [ ] `execute_query` — ejecuta SELECT, valida que no sea DDL/DML
- [ ] SQL Validator: bloquear INSERT, UPDATE, DELETE, DROP, TRUNCATE, GRANT
- [ ] Audit Trail básico: SQLite local, tabla `query_log`
- [ ] Tests: unit (validator) + integration (Postgres en Docker)

**Criterio de done:** el SQL Agent en el demo de Intelligence Ops corre sobre una DB Postgres real del cliente, con las 3 preguntas del landing respondidas en <60s.

### Phase 2 — Schema Discovery inteligente `[after P1]`

**Meta:** el agente infiere contexto del esquema sin necesidad de manual annotation.

- [ ] Schema embeddings: vectoriza columnas + tablas para retrieval semántico
- [ ] Table aliases: mapeo "ventas" → tabla `tbl_fac_venta_detalle` real del cliente
- [ ] Relationship inference: detecta FKs implícitas por nombre de columna
- [ ] Schema snapshot: caché local para deployments con DB grande

**Criterio de done:** un cliente con nombres de tablas en formato legacy (ej. ERP SAP) puede preguntar "ventas del mes" y el agente resuelve la tabla correcta sin configuración manual.

### Phase 3 — Result Renderer avanzado `[after P2]`

**Meta:** la respuesta incluye gráficas ECharts autogeneradas por el LLM.

- [ ] LLM genera ECharts spec (JSON) junto con la narrativa
- [ ] Renderer valida el spec antes de enviarlo al frontend
- [ ] Tipos: barras horizontales, líneas de tendencia, scatter, heatmap
- [ ] Exportar resultado como imagen PNG (para reportes por WhatsApp/email)

**Criterio de done:** la demo del landing usa gráficas reales generadas por el agente, no mocks.

### Phase 4 — Multi-connector `[after P3]`

- [ ] MySQL / MariaDB connector
- [ ] BigQuery connector (Google Cloud SA auth)
- [ ] Snowflake connector (JWT auth)
- [ ] Connection testing endpoint: valida credenciales sin ejecutar queries

---

## Puntos de integración con EurekaMS

| Módulo EurekaMS      | Cómo usa intelligence-ops-mcp                                                                 |
| -------------------- | --------------------------------------------------------------------------------------------- |
| **Intelligence Ops** | SQL Agent principal — toda la experiencia conversacional de datos                             |
| **Voice Solutions**  | Contexto de inventario para el agente de voz: "¿hay stock de X antes de ofrecer en llamada?"  |
| **Territory Ops**    | Cruza datos del cliente (ventas por zona) con DENUE 6.1M para validar oportunidad de apertura |

---

## Qué NO es

- **No es un ETL.** No mueve datos del cliente. No los replica.
- **No es un BI tool.** No tiene dashboards preconstruidos ni reportes programados.
- **No es un producto standalone.** No tiene UI, no tiene autenticación propia.
- **No es Wilab.** Wilab era un proveedor externo. Este stack vive dentro del control de EurekaMD.

---

## Estado actual

| Item                                   | Estado                                                                                                                    |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Decisión arquitectural                 | ✅ Tomada — 2026-06-26                                                                                                    |
| Repositorio                            | ✅ Creado — `EurekaMD-net/intelligence-ops-mcp`                                                                           |
| Phase 1 — MCP Core (Postgres)          | ✅ Completado — 2026-06-27 (3 tools, read-only estructural, audit trail; 36 tests)                                        |
| Phase 2 — Schema Discovery + SQL Agent | ✅ Completado — 2026-06-27 (`get_schema_context` + `validate_query` + `retail_sql_agent` prompt; LLM host-side; 42 tests) |
| Phase 3                                | 🔲 Pendiente                                                                                                              |
| Phase 4                                | 🔲 Pendiente                                                                                                              |

---

_Documento fundacional v1.0 — 2026-06-26_
_Autor: EurekaMD / Federico Moctezuma_
