# Auditoría de Ciberseguridad — NFTLox Protocol & Indexer

**Fecha:** 2026-04-22  
**Alcance:** `packages/protocol`, `packages/indexer`, `packages/sdk`  
**Enfoque:** Emisión no autorizada, robo/reasignación de propiedad, abuso de seeds, manipulación del indexador, bypass de permisos, duplicación/replay, corrupción de estado.

---

## 1. Resumen Ejecutivo

Se auditaron ~8.500 líneas de código TypeScript/Bun que conforman el protocolo NFTLox (L1 Hive `custom_json`) y su indexador PostgreSQL. El diseño es **determinista sin smart contracts**: el estado se reconstruye íntegramente por indexación. Esta arquitectura descarga la seguridad al parser, al router de acciones y a la coherencia transaccional del indexer.

**Veredicto general:** No se detectaron vectores de **emisión no autorizada**, **robo directo de propiedad** ni **bypass de permisiones de ownership** en operación normal. La superficie de ataque más crítica reside en el **API multisig de compra** (validación criptográfica insuficiente) y en la **recuperación post-crash durante massive sync** (corrupción de contadores denormalizados). El resto son hipótesis de riesgo sustantivas que merecen defensa en profundidad.

---

## 2. Metodología

- Revisión estática de código fuente (protocol, indexer, SDK).
- Análisis de flujo de datos: L1 `custom_json` → parser → router → handler → PostgreSQL.
- Verificación de invariantes en schema SQL (constraints, triggers, CASCADE).
- Validación de idempotencia y atomicidad en sync masivo.
- Pruebas conceptuales de race conditions (commitment/buy, bulk distribute, batch transfer).
- **No se ejecutaron exploits activos**; todos los hallazgos son sustentados por trazas de código.

---

## 3. Hallazgos

### VUL-001: DoS/Griefing del marketplace por firma inválida en buy multisig

| Atributo | Valor |
|----------|-------|
| **Componente** | API multisig (`packages/indexer/src/api/services/multisig/buy.ts`, `transaction.ts`) |
| **Severidad** | **Alta** |
| **Tipo** | Denegación de servicio / Congelación de liquidez |

#### Descripción técnica
El endpoint `/api/multisig/buy` valida la estructura de la transacción y la firma del comprador **únicamente por formato** (regex de 130 caracteres hex). No verifica la validez criptográfica de la firma respecto al digest de la transacción antes de emitir el `buy_commitment` on-chain.

#### Precondiciones
- NFT listado en estado `listed`.
- Nodo de settlement activo y operativo.

#### Explotación (alto nivel)
1. El atacante construye una transacción de buy estructuralmente válida (transfers correctos, memos, custom_json).
2. Genera una cadena aleatoria de 130 caracteres hexadecimales y la coloca en `signatures[0]`.
3. Envía la transacción al endpoint `/api/multisig/buy`.
4. El nodo valida la estructura y el split de pago, pero **no la firma criptográfica**.
5. El nodo emite `buy_commitment` on-chain, proyectando el NFT a `pending_sale` por `BUY_COMMITMENT_TTL_BLOCKS` (10 bloques ≈ 30 s).
6. El nodo intenta broadcastear la transacción completa; Hive rechaza la firma inválida.
7. El NFT permanece bloqueado para otras compras hasta que el sweep lo libere.
8. Repitiendo cada ~30 s, el atacante congela la venta del NFT **indefinidamente sin costo** (el fee del `buy_commitment` lo paga el nodo).

#### Impacto real
- **Congelación de liquidez:** el vendedor no puede completar la venta ni unlistar mientras el commitment esté activo (la operación `unlist` rechaza `pending_sale`).
- **Orphaned buys indirectos:** si el vendedor intenta unlistar, falla; si baja el precio, no puede porque el listing está bloqueado.
- **Coste asimétrico:** el atacante no paga; el nodo asume el costo del `custom_json` de commitment.

#### Evidencia
```ts
// packages/indexer/src/api/services/multisig/transaction.ts:97-111
function validateBuyerSignatureArray(signatures: unknown): readonly [string] {
  if (!Array.isArray(signatures) || signatures.length !== 1) {
    throw createMultisigError("BUYER_SIGNATURE_MISSING", ...);
  }
  const [sig] = signatures;
  if (typeof sig !== "string" || !/^[0-9a-fA-F]{130}$/.test(sig)) {
    throw createMultisigError("BUYER_SIGNATURE_MISSING", ...);
  }
  return [sig.toLowerCase()];
}
```
No existe llamada a `verifyAuthority`, `PublicKey.verify`, o similar antes de `broadcastBuyCommitment` en `buy.ts:98`.

#### Mitigación recomendada
- **Verificar criptográficamente** la firma del buyer contra el digest de la transacción antes de emitir `buy_commitment`. `hive-tx` expone mecanismos para reconstruir la tx parcialmente firmada y validar la recuperación de clave pública.
- Si la verificación criptográfica es costosa, implementar **PoW o rate-limit por buyer/cuenta** antes del commitment.

---

### VUL-002: Corrupción de contadores denormalizados en re-procesamiento post-crash

| Atributo | Valor |
|----------|-------|
| **Componente** | Sync Engine (`scanner/sync-engine.ts`) + Handlers (`db/queries/nft-mutations.ts`, `nft-counters.ts`) |
| **Severidad** | **Media** |
| **Tipo** | Corrupción de estado / Inconsistencia entre eventos y estado final |

#### Descripción técnica
Durante sincronización masiva (`behind > 100`), el indexer activa `SET LOCAL synchronous_commit = OFF` para maximizar throughput. Si el proceso crasha entre el commit lógico de PostgreSQL y el fsync efectivo de WAL, la última transacción del batch se pierde. La protección de idempotencia (`isOperationConfirmed` en `routeOperation`) depende de la tabla `confirmed_operations`, que también se pierde en ese escenario.

Los handlers `updateNftOwner`, `recordCollectionBurn` y `adjustOwnerNftCount` **no son idempotentes**: re-procesar una operación ya aplicada decrementará de nuevo los contadores del antiguo owner e incrementará los del nuevo, mientras que la tabla `nfts` (protegida por PK y triggers) permanece consistente.

#### Precondiciones
- Indexer en **massive sync** (más de 100 bloques detrás de HEAD).
- Crash del worker (`SIGKILL`, OOM, panic de Node) durante la ventana de `synchronous_commit=OFF`.

#### Explotación (alto nivel)
1. El indexer procesa un bloque que contiene una `transfer` de Alice a Bob.
2. `updateNftOwner` actualiza la fila `nfts` y ajusta `owner_nft_counts` (-1 Alice, +1 Bob).
3. La transacción del batch se confirma lógicamente pero el proceso muere antes del fsync.
4. Al reiniciar, `last_block` retrocede al valor previo; el mismo rango se re-procesa.
5. `isOperationConfirmed` consulta `confirmed_operations` — la fila también se perdió — por lo que retorna `false`.
6. El handler se ejecuta de nuevo. `UPDATE nfts` es no-op por PK idéntica, pero `adjustOwnerNftCount` vuelve a ejecutar:
   - `-1` a Alice (ahora puede llegar a 0 o negativo; el `CHECK total >= 0` del schema evita negativo, pero si Alice tenía 2, ahora tiene 0 en lugar de 1).
   - `+1` a Bob (ahora tiene 2 en lugar de 1).

#### Impacto real
- **Divergencia entre fuentes de verdad:** `nfts` vs `owner_nft_counts` / `collection_stats`.
- **Falsos positivos/negativos en límites:** `assertWithinLimit` (seedsPerCreator, instancesPerCreator) puede bloquear legítimamente a un creator cuyos contadores están inflados, o permitir exceso si están deflacionados.
- **Imposibilidad de auditoría:** el state-root hash del indexer puede divergir silenciosamente si los contadores afectan su cálculo (aunque el state-root actual se calcula sobre `nfts`, los contadores son metadata operativa crítica).

#### Evidencia
```ts
// sync-engine.ts:410-412
if (isMassive && hasOps) {
  await txn`SET LOCAL synchronous_commit = OFF`;
}

// nft-mutations.ts:86-133 (updateNftOwner)
await txn`UPDATE nfts SET owner = ${newOwner}, ... WHERE id = ${nftId}`;
queueStateRootDelta(...);
await adjustOwnerNftCount(ctx.oldOwner, ctx.nftType, -1, txn);  // no verifica si ya se hizo
await adjustOwnerNftCount(newOwner, ctx.nftType, 1, txn);       // no verifica si ya se hizo

// nft-counters.ts:10-41 (adjustOwnerNftCount)
// No es idempotente: siempre aplica el delta numérico.
```

#### Mitigación recomendada
- **Opción A (preferida):** Eliminar `SET LOCAL synchronous_commit = OFF` y aceptar menor throughput, o usar `synchronous_commit = local` con `fsync = off` controlado a nivel de configuración del cluster (más predecible).
- **Opción B:** Hacer los ajustes de contadores **condicionales**. Por ejemplo:
  ```sql
  UPDATE owner_nft_counts SET total = total - 1
  WHERE owner = ${oldOwner} AND total > 0;
  ```
  y verificar que el `owner` actual del NFT coincida con `newOwner` antes de sumar.
- **Opción C:** Marcar operaciones procesadas en una tabla **UNLOGGED** o en un archivo de checkpoint fuera de la transacción principal, de modo que sobrevivan al rollback del sync masivo.

---

### RISK-003: Fee theft por ausencia de vinculación nodo-reservante en `handleBuy`

| Atributo | Valor |
|----------|-------|
| **Componente** | Processor / Marketplace (`packages/indexer/src/processor/handlers/marketplace/buy.ts`) |
| **Severidad** | **Media** (hipótesis — requiere bypass del commitment gate) |
| **Tipo** | Bypass de permisos / Defensa en profundidad insuficiente |

#### Descripción técnica
`handleBuy` verifica que el `txId` de la transacción coincida con `sale_commitment_buy_tx_hash`, pero **no verifica que `op.signer` sea el mismo nodo que emitió el `buy_commitment`** (`nft.sale_settlement_node`).

En operación normal, `handleBuyCommitment` actúa como gate: solo un nodo puede reservar, y otro nodo no puede emitir un commitment concurrente mientras haya uno activo. Sin embargo, si ese gate se bypasseara (por ejemplo, por un reorg de cadena que elimine el commitment pero no el buy, un bug en `sweepExpiredBuyCommitments`, o manipulación del estado del indexer), cualquier nodo activo podría co-firmar el buy y recibir la comisión de protocolo.

#### Precondiciones (hipotéticas)
- El commitment `buy_commitment` desaparece del estado del indexer (no de la cadena) mientras el buy aún es válido.
- O: un nodo malicioso explota una race condition en el sweep.

#### Explotación (alto nivel)
1. Nodo A reserva un NFT con `buy_commitment`.
2. Por alguna causa (reorg, bug, corrupción), el estado `pending_sale` se pierde o se invalida.
3. Nodo B (también activo) observa el buy original firmado por el comprador en el mempool.
4. Nodo B co-firma la misma transacción (el digest no cambia; solo cambia la segunda firma).
5. `handleBuy` acepta la operación porque `op.txId === sale_commitment_buy_tx_hash` (aún persistido) y `feeAccount: op.signer` envía la comisión a B.

#### Impacto real
- **Fee theft:** el nodo legítimo A no recibe la comisión que le correspondía.
- **Degradación de confianza:** los compradores/vendedores no tienen garantía de que el nodo que reservó sea quien cobre, rompiendo el contrato económico implícito.

#### Evidencia
```ts
// buy.ts:35-136
// Se verifican:
//   nft.status === 'pending_sale'
//   expectedBuyTxHash === op.txId
//   op.blockNum <= sale_expires_block
//   listing_id / listTxId
// PERO NO: op.signer === nft.sale_settlement_node
```

#### Mitigación recomendada
Añadir en `handleBuy` (después de la verificación de `pending_sale`):
```ts
if (nft.sale_settlement_node !== op.signer) {
  throw new Error(`Buy signer ${op.signer} does not match committed settlement node ${nft.sale_settlement_node}`);
}
```
Esto es una verificación de costo cero y elimina el vector en caso de compromiso del commitment gate.

---

### RISK-004: Orphaned buys por inconsistencia temporal API-indexer en expiración de listings

| Atributo | Valor |
|----------|-------|
| **Componente** | API multisig (`buy.ts:assertListingAlive`) vs Processor (`list.ts`, `buy.ts`) |
| **Severidad** | **Media** |
| **Tipo** | Inconsistencia entre eventos y estado final / Condición de carrera temporal |

#### Descripción técnica
El nodo multisig evalúa la vigencia del listing con `Date.now()` (reloj del servidor), mientras que el indexer evalúa la misma condición con `op.timestamp` (timestamp on-chain del bloque Hive). Estos dos relojes pueden divergir.

#### Escenarios de riesgo
| Escenario | Reloj del nodo | Resultado en API | Resultado on-chain (`handleBuy`) |
|-----------|----------------|------------------|----------------------------------|
| Atrasado | `Date.now()` < `expiresMs` | Firma el buy | `op.timestamp` ≥ `expiresAt` → **rechaza** → transfers ejecutados, NFT no transferido → **orphaned buy** |
| Adelantado | `Date.now()` ≥ `expiresMs` | **Rechaza** buy legítimo | — |

#### Impacto real
- **Orphaned buys:** fondos del comprador se transfieren al vendedor/nodo/royalty, pero la propiedad del NFT no cambia. El protocolo los registra en `orphaned_buys`, pero la recuperación es manual y no automatizada.
- **Denegación de servicio:** compradores legítimos son rechazados por desfase de reloj.

#### Evidencia
```ts
// API gate (buy.ts:249-258)
function assertListingAlive(listingExpiresAt: string | null): void {
  if (!listingExpiresAt) return;
  const expiresMs = Date.parse(listingExpiresAt);
  if (Date.now() >= expiresMs) {          // ← reloj del servidor
    throw createMultisigError("NFT_EXPIRED_LISTING", ...);
  }
}

// Indexer gate (buy.ts:67)
if (isListingExpired(nft.listing_expires_at, op.timestamp)) {  // ← timestamp del bloque
  throw new Error(`Listing has expired for NFT: ${nftId}`);
}
```

#### Mitigación recomendada
- Usar **`sync_state.hive_head_block`** y derivar su timestamp (o usar `last_block` con un offset de seguridad) como fuente de tiempo para la gate del API, en lugar de `Date.now()`.
- Alternativamente, rechazar listings cuya expiración esté dentro de `MULTISIG_TX_MAX_EXPIRATION_MS + BUY_TX_TTL_MS` del timestamp del último bloque indexado, eliminando la dependencia del reloj de pared.

---

### RISK-005: Heartbeats con `blockNum` de payload manipulado

| Atributo | Valor |
|----------|-------|
| **Componente** | Processor / Node (`packages/indexer/src/processor/handlers/core/node_heartbeat.ts`) |
| **Severidad** | **Baja** |
| **Tipo** | Manipulación de datos de auditoría |

#### Descripción técnica
`handleNodeHeartbeat` valida formato del `stateRoot` y `indexerVersion`, pero no correlaciona `data.blockNum` (declarado en el payload) con `op.blockNum` (el bloque real de la transacción en Hive). El nodo podría reportar un `blockNum` arbitrario en `l2_node_heartbeats`.

#### Impacto real
- No afecta `assertActiveSettlementNode`, que usa `op.blockNum` para calcular `activityAgeBlocks`.
- Pero introduce **inconsistencia en tablas de auditoría** (`l2_node_heartbeats.block_num` vs la realidad on-chain), dificultando la detección de Sybil o nodos deshonestos por consumidores externos.

#### Evidencia
```ts
// node_heartbeat.ts:72-111
const blockNum = requireNonNegativeInt(op.data.blockNum, "blockNum");
// ... valida stateRoot e indexerVersion ...
// INSERT INTO l2_node_heartbeats (..., block_num, ...) VALUES (..., ${blockNum}, ...)
// UPDATE l2_nodes SET last_heartbeat_block = ${op.blockNum} ...
```
Obsérvese que `l2_nodes.last_heartbeat_block` usa `op.blockNum` (correcto), pero `l2_node_heartbeats.block_num` usa `data.blockNum` (no validado).

#### Mitigación recomendada
```ts
if (Math.abs(op.data.blockNum - op.blockNum) > HEARTBEAT_BLOCK_TOLERANCE) {
  throw new Error(`Heartbeat blockNum divergence too large: payload=${op.data.blockNum}, tx=${op.blockNum}`);
}
```

---

## 4. Observaciones de Arquitectura (no vulnerabilidades, pero riesgos sistémicos)

### 4.1. Confianza centralizada en nodos de settlement
El protocolo delega la co-firma de `create_collection` y `buy` a nodos registrados. No existe mecanismo on-chain de **slashing** o **garantía de depósito** para penalizar nodos maliciosos (griefing, no-broadcast, fee redirection). Esto es una elección de diseño, pero en un contexto de custodia de activos digitales representa un **riesgo de contraparte no mitigado económicamente**.

### 4.2. Ausencia de límite superior de versión de protocolo
El parser (`operation-parser.ts`) acepta cualquier `payload.version >= MIN_PROTOCOL_VERSION` sin techo. Si una futura versión del SDK introduce semánticas incompatibles en campos existentes (ej. `owner` como array), el indexer actual las interpretaría como strings, causando fallos silenciosos o rechazos inesperados. Recomendación: mantener un mapa de versiones soportadas explícito.

### 4.3. `maxInstances` y `collection_stats` como contadores denormalizados
Toda la lógica de caps de instancias (`bulk_distribute`) depende de `collection_stats.instances`, que se mantiene manualmente. Aunque el schema tiene `CHECK (distributed + reserved_supply <= max_supply)` en `nfts`, el cap a nivel de colección no tiene constraint DB equivalente. Una corrupción de `collection_stats` (véase VUL-002) es el único vector para superar el `maxInstances` declarado.

---

## 5. Recomendaciones Prioritarias

| Prioridad | Ítem | Riesgo mitigado |
|-----------|------|-----------------|
| **P0** | Verificar criptográficamente la firma del buyer antes de `broadcastBuyCommitment` | DoS de marketplace (VUL-001) |
| **P1** | Eliminar o aislar `synchronous_commit = OFF`, o hacer contadores idempotentes | Corrupción de estado (VUL-002) |
| **P1** | Alinear gate temporal del API multisig con timestamp on-chain (`sync_state`) | Orphaned buys (RISK-004) |
| **P2** | Añadir `op.signer === sale_settlement_node` en `handleBuy` | Fee theft / bypass de reserva (RISK-003) |
| **P2** | Validar cercanía de `data.blockNum` vs `op.blockNum` en heartbeats | Integridad de auditoría (RISK-005) |
| **P3** | Implementar rate-limiting/PoW en API multisig para mitigar griefing aunque la firma sea válida | Resiliencia operativa |

---

## 6. Nota Final

No se encontraron vectores de **emisión no autorizada de seeds/instancias**, **robo directo de NFTs via transferencia sin permiso**, ni **manipulación de DNA/IDs** que comprometan la propiedad digital en el happy path. La arquitectura de IDs deterministas, los triggers de inmutabilidad de PostgreSQL y la validación de `collection.creator === op.signer` en `mint`/`set_data` son sólidos.

Los riesgos sustantivos se concentran en **(a) la frontera de confianza del nodo multisig** (validación insuficiente antes de acciones irreversibles) y **(b) la robustez del indexer ante fallos físicos** (corrupción de estado denormalizado). Ambos son corregibles con cambios localizados y de bajo riesgo de regresión.

---

*Auditoría realizada por revisión estática de código. No se ejecutaron exploits ni se realizaron pruebas de penetración activas contra endpoints en producción.*
