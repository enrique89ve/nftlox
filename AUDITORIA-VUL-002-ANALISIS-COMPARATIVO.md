# Análisis Comparativo — VUL-002: Corrupción de contadores denormalizados
## NFTLox vs nft-tracker-temp (HAF Reference)

**Auditoría original:** [Auditoría Ciberseguridad NFTLox](./AUDITORIA-CIBERSEGURIDAD-NFTLOX.md)  
**Hallazgo:** VUL-002 — Corrupción de contadores denormalizados en re-procesamiento post-crash  
**Fecha:** 2026-04-22

---

## 1. Contexto del problema

Durante sincronización masiva (`behind > 100`), NFTLox activa `SET LOCAL synchronous_commit = OFF` para maximizar throughput. Si el worker crasha, la última transacción del batch se pierde. Los contadores denormalizados (`owner_nft_counts`, `collection_stats`) aplican deltas (`+1`, `-1`) que no son idempotentes, causando divergencia entre la tabla canónica (`nfts`) y los contadores si la operación se re-procesa.

---

## 2. Qué hace nft-tracker-temp (y por qué no tienen este problema)

nft-tracker-temp es una aplicación HAF (Hive Application Framework) que corre íntegramente dentro de PostgreSQL. Revisamos sus archivos clave:

### 2.1. Sin contadores denormalizados

En `db/nft_actions.sql`, la validación del límite `max_count` se hace con `COUNT(*)` directo sobre la tabla canónica en cada operación:

```sql
CREATE OR REPLACE FUNCTION nfttracker_app.is_max_count_reached(...)
RETURNS bool AS $$
DECLARE
  _max_count INT;
  _issued_count INT;
BEGIN
  SELECT id, max_count INTO _type_id, _max_count FROM nfttracker_app.types ...;
  SELECT COUNT(*) INTO _issued_count FROM nfttracker_app.instances WHERE type_id = _type_id;
  RETURN _max_count IS NOT NULL AND _issued_count >= _max_count;
END $$;
```

No existe `collection_stats` ni `owner_nft_counts`. Todo es `COUNT(*)` en tiempo real contra la fuente de verdad.

### 2.2. `synchronous_commit = OFF` sin riesgo de corrupción

En `db/main_loop.sql` también activan `synchronous_commit = OFF` durante massive processing:

```sql
CREATE OR REPLACE PROCEDURE nfttracker_app.massive_processing(...)
AS $$
BEGIN
  PERFORM set_config('synchronous_commit', 'OFF', false);
  PERFORM nfttracker_app.block_range_data(_from, _to);
END $$;
```

**Pero sus handlers son intrínsecamente idempotentes:**

- `INSERT` en `instances` usa un `id` determinista derivado de `_operation_id` + `_subsequent_no`. Re-procesar el mismo INSERT colisionaría en PK; HAF maneja el cursor de forma que no ocurre, y si ocurriera sería un `unique_violation` manejado.
- `UPDATE` de `transfer` cambia `holder = a.id`. Re-procesar el mismo `transfer` no cambia nada (el holder ya es el destinatario).

### 2.3. No hay "delta no idempotente"

NFTLox aplica deltas acumulativos:

```ts
await adjustOwnerNftCount(ctx.oldOwner, ctx.nftType, -1, txn);
await adjustOwnerNftCount(newOwner, ctx.nftType, 1, txn);
```

nft-tracker-temp no tiene equivalente. Si quisieran saber cuántos NFTs tiene un owner, hacen:

```sql
SELECT COUNT(*) FROM nfttracker_app.instances WHERE holder = a.id;
```

---

## 3. Diagnóstico raíz

El problema VUL-002 **no existe en nft-tracker-temp porque eligieron consistencia sobre performance**: no mantienen contadores denormalizados.

NFTLox, en cambio, **optó por performance** (`owner_nft_counts`, `collection_stats`) pero esa denormalización es **incompatible con `synchronous_commit=OFF` + re-procesamiento post-crash** sin mecanismo de reconciliación.

| Aspecto | nft-tracker-temp | NFTLox |
|---------|-----------------|--------|
| Contadores denormalizados | No | Sí |
| Validación de límites | `COUNT(*)` directo | Lectura de tabla denormalizada |
| Idempotencia post-crash | Intrínseca | Requiere mecanismo externo |
| Performance de límites | Menor (COUNT) | Mayor (lectura de fila única) |
| `synchronous_commit=OFF` | Seguro | Riesgo de corrupción |

---

## 4. Opciones de solución evaluadas

### Opción A — Eliminar contadores denormalizados (estilo nft-tracker-temp)

**Descripción:** Reemplazar `owner_nft_counts` y `collection_stats` por cálculos en línea desde `nfts` + `burned_nfts`. Las funciones `assertWithinLimit` pasan a hacer `COUNT(*)`.

**Pros:**
- 100% idempotente ante re-procesamiento.
- Cero riesgo de divergencia permanente.
- Alineado con el patrón de referencia HAF.

**Contras:**
- `assertWithinLimit` pasa de leer 1 fila a hacer `COUNT` o `SUM` sobre `nfts`. En un creator con 3M instancias, eso es costoso.
- Los endpoints de dashboard (estadísticas de colección) se degradarían significativamente.

### Opción B — Reconciliación automática post-crash (recomendada)

**Descripción:** Mantener los contadores denormalizados para performance, pero añadir una función `reconcileCounters()` que los recalcule directamente desde `nfts`/`burned_nfts` y se ejecute automáticamente:
- Al startup del sync worker (antes de procesar el primer bloque).
- Al finalizar massive sync (cuando el indexer pasa de `behind > 100` a `in sync`).
- Opcionalmente: cada N bloques durante massive sync.

**Pros:**
- Mantiene la performance en operación normal.
- Se auto-sana después de cualquier crash o divergencia.
- Mínima invasión al router de acciones (los handlers no cambian).
- Reduce el riesgo combinándolo con `synchronous_commit = local` (más durable que `OFF`).

**Contras:**
- Durante el massive sync, si el crash ocurre justo antes de la reconciliación, los límites pueden estar incorrectos hasta el próximo ciclo de reconciliación.
- Requiere una reconciliación inicial potencialmente lenta si la tabla `nfts` es muy grande.

### Opción C — Tabla de eventos acumulativos por `operation_id`

**Descripción:** Convertir `owner_nft_counts` en una tabla de eventos:

```sql
CREATE TABLE owner_nft_count_events (
  operation_id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  nft_type TEXT NOT NULL,
  delta INT NOT NULL
);
```

Y una vista agregada:

```sql
CREATE VIEW owner_nft_counts AS
SELECT owner,
       COALESCE(SUM(delta) FILTER (WHERE nft_type='seed'), 0) AS seeds,
       COALESCE(SUM(delta) FILTER (WHERE nft_type='instance'), 0) AS instances,
       COALESCE(SUM(delta), 0) AS total
FROM owner_nft_count_events
GROUP BY owner;
```

**Pros:**
- Idempotencia perfecta: `ON CONFLICT (operation_id) DO NOTHING` evita duplicados.
- Mantiene la velocidad de lectura (la vista puede ser materializada).

**Contras:**
- Remodelado del schema. Los `+1`/`-1` actuales se convierten en INSERTs.
- La tabla de eventos crece indefinidamente (necesita TTL/compactación periódica).
- `collection_stats` tendría que hacer lo mismo con una clave compuesta `(collection_id, operation_id)`.

---

## 5. Recomendación del auditor

**Implementar Opción B** con los siguientes componentes:

| Paso | Implementación |
|------|---------------|
| 1 | Cambiar `synchronous_commit = OFF` → `synchronous_commit = local` en `sync-engine.ts` |
| 2 | Crear `reconcileOwnerNftCounts()` y `reconcileCollectionStats()` en `nft-counters.ts` (recálculo directo desde `nfts` + `burned_nfts`) |
| 3 | Ejecutar reconciliación **al inicio de cada ciclo de sync** si `last_block < head_block - MASSIVE_THRESHOLD` |
| 4 | Ejecutar reconciliación **al finalizar massive sync** (cuando `behind <= SYNC_TOLERANCE_BLOCKS`) |
| 5 | Añadir guard anti-negativo en `adjustOwnerNftCount`: `WHERE total + ${delta} >= 0` |

Esto proporciona **la robustez del modelo de nft-tracker-temp** (consistencia eventual garantizada) sin sacrificar la **performance operativa** de los contadores denormalizados.

---

## 6. Notas de implementación

### 6.1. `synchronous_commit = local` vs `OFF`

| Valor | Garantía de durabilidad | Ventana de pérdida |
|-------|------------------------|-------------------|
| `off` | Ninguna (commit asíncrono) | Crash del proceso Node/Bun |
| `local` | WAL escrito en servidor local | Crash del OS/kernel del host Postgres |
| `on` (default) | WAL fsync + réplicas | Ninguna |

`local` es el compromiso óptimo: protege contra el crash del worker (el escenario de VUL-002) mientras mantiene throughput cercano a `OFF`.

### 6.2. Pseudocódigo de reconciliación

```ts
// nft-counters.ts
export async function reconcileOwnerNftCounts(txn: Queryable): Promise<void> {
  await txn`
    WITH actual AS (
      SELECT owner,
             COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE nft_type = 'seed')::int AS seeds,
             COUNT(*) FILTER (WHERE nft_type = 'instance')::int AS instances
      FROM nfts
      GROUP BY owner
    )
    INSERT INTO owner_nft_counts (owner, total, seeds, instances)
    SELECT owner, total, seeds, instances FROM actual
    ON CONFLICT (owner) DO UPDATE SET
      total = EXCLUDED.total,
      seeds = EXCLUDED.seeds,
      instances = EXCLUDED.instances
  `;
  await txn`
    DELETE FROM owner_nft_counts
    WHERE owner NOT IN (SELECT DISTINCT owner FROM nfts)
  `;
}

export async function reconcileCollectionStats(txn: Queryable): Promise<void> {
  await txn`
    WITH actual AS (
      SELECT collection_id,
             COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE nft_type = 'seed')::int AS seeds,
             COUNT(*) FILTER (WHERE nft_type = 'instance')::int AS instances,
             COUNT(*) FILTER (WHERE nft_type = 'instance' AND status = 'listed'
                              AND (listing_expires_at IS NULL OR listing_expires_at > NOW()))::int AS listed
      FROM nfts
      GROUP BY collection_id
    ),
    burned AS (
      SELECT collection_id, COUNT(*)::int AS burned
      FROM burned_nfts
      GROUP BY collection_id
    )
    INSERT INTO collection_stats (collection_id, total, seeds, instances, listed, burned)
    SELECT a.collection_id, a.total, a.seeds, a.instances, a.listed, COALESCE(b.burned, 0)
    FROM actual a
    LEFT JOIN burned b ON b.collection_id = a.collection_id
    ON CONFLICT (collection_id) DO UPDATE SET
      total = EXCLUDED.total,
      seeds = EXCLUDED.seeds,
      instances = EXCLUDED.instances,
      listed = EXCLUDED.listed,
      burned = EXCLUDED.burned
  `;
}
```

---

## 7. Conclusión

nft-tracker-temp demuestra que la idempotencia intrínseca (sin contadores denormalizados) elimina el riesgo de VUL-002. Sin embargo, NFTLox tiene requisitos de performance que justifican los contadores. La **Opción B** (reconciliación automática + `synchronous_commit = local`) es el compromiso técnicamente sólido que cierra el vector de corrupción sin remodelar la arquitectura.

---

*Análisis realizado por revisión estática de código comparativo. Fuentes: `nft-tracker-temp/db/nft_actions.sql`, `nft-tracker-temp/db/main_loop.sql`, `nft-tracker-temp/db/schema.sql`.*
