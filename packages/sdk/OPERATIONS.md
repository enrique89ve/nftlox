# Catálogo de Operaciones NFTLox Protocol v0.2.1

Referencia completa de las 23 operaciones del protocolo NFTLox. Cada operación se transmite como `custom_json` en la blockchain de Hive con `id = "nftlox_testnet"`.

---

## Resumen

| # | Acción | Categoría | Key | Descripción |
|---|--------|-----------|-----|-------------|
| 1 | `create_collection` | Core | posting | Crea una colección (arquetipo) |
| 2 | `mint` | Core | posting | Crea un seed NFT dentro de una colección |
| 3 | `transfer` | Core | posting | Transfiere ownership de un NFT |
| 4 | `burn` | Core | posting | Destruye un NFT permanentemente |
| 5 | `replicate` | Core | posting | Crea una réplica derivada de un NFT original |
| 6 | `bulk_distribute` | Core | posting | Mintea múltiples instancias desde seeds |
| 7 | `set_data` | Core | posting | Actualiza datos mutables y tags de un NFT |
| 8 | `list` | Marketplace | posting | Pone un NFT a la venta |
| 9 | `unlist` | Marketplace | posting | Retira un NFT del marketplace |
| 10 | `buy` | Marketplace | active | Compra un NFT listado (multisig con nodo) |
| 11 | `pack_create` | Pack | posting | Crea un pack con drop table probabilístico |
| 12 | `pack_buy` | Pack | posting | Compra packs (gratis o pagados) |
| 13 | `pack_transfer` | Pack | posting | Transfiere packs entre usuarios |
| 14 | `pack_open` | Pack | posting | Abre packs y genera instancias NFT |
| 15 | `nft_approve` | Approve | posting | Aprueba spender para UN NFT específico |
| 16 | `nft_approve_all` | Approve | posting | Aprueba spender para TODOS los NFTs de una colección |
| 17 | `nft_transfer_from` | Approve | posting | Spender aprobado transfiere NFT del owner |
| 18 | `pack_approve` | Approve | posting | Aprueba spender para gastar N packs |
| 19 | `pack_transfer_from` | Approve | posting | Spender aprobado transfiere packs del owner |
| 20 | `nft_lend` | Lending | posting | Presta un NFT a un borrower |
| 21 | `nft_return` | Lending | posting | Devuelve un NFT prestado |
| 22 | `data_operator_approve` | DataOperator | posting | Autoriza operador externo para una colección |
| 23 | `set_data_from` | DataOperator | posting | Operador aprobado modifica datos de NFTs |

---

## Core (7 operaciones)

### 1. `create_collection`

**Constante SDK**: `ACTION_CREATE_COLLECTION`
**Descripción**: Crea una colección que agrupa NFTs bajo reglas comunes (transferencia, burn, royalties).
**Key authority**: posting — acción de configuración del creator.
**Signer role**: El signer se convierte en el creator de la colección (campo `creator` del payload se ignora).

**Payload del SDK**:
| Campo | Tipo | Requerido | Descripción |
|-------|------|-----------|-------------|
| `id` | string | sí | ID determinístico de la colección |
| `name` | string | sí | Nombre (max 100 chars) |
| `symbol` | string | sí | Símbolo 3-8 chars, A-Z0-9 |
| `totalPotential` | number | no | Supply potencial total (default 0) |
| `originDna` | string | no | DNA de la colección (16 chars hex) |
| `metadata.description` | string | no | Descripción |
| `metadata.image` | string | no | URL de imagen |
| `metadata.externalUrl` | string | no | URL externa |
| `rules.transferable` | boolean | no | Si los NFTs son transferibles (default true) |
| `rules.burnable` | boolean | no | Si los NFTs se pueden quemar (default true) |
| `rules.royaltyPct` | number | no | Porcentaje de royalty 0-50 (default 0) |
| `rules.royaltyRecipient` | string | no | Cuenta que recibe royalties |

**Validaciones del indexer**:
- `id` no debe existir previamente
- `creator` se fuerza a `op.signer` (Fix 5)
- Campos faltantes usan defaults seguros

**Cambios de estado**: Inserta fila en `collections`.
**Restricciones**: ID duplicado → rechazado (ON CONFLICT DO NOTHING).

---

### 2. `mint`

**Constante SDK**: `ACTION_MINT`
**Descripción**: Crea un seed NFT (plantilla) o instancia dentro de una colección. Solo el creator de la colección puede mintear.
**Key authority**: posting — solo el creator necesita firmar.
**Signer role**: Debe ser el creator de la colección.

**Payload del SDK**:
| Campo | Tipo | Requerido | Descripción |
|-------|------|-----------|-------------|
| `id` | string | sí | ID del NFT. Prefijo `seed_` → tipo seed, otro → instancia |
| `collectionId` | string | sí | Colección destino |
| `edition` | number | no | Edición (default 1) |
| `owner` | string | no | Owner inicial (default signer) |
| `originDna` | string | no | DNA del origen |
| `instanceDna` | string | no | DNA de la instancia |
| `uniqueAccessKey` | string | no | Clave de acceso única |
| `birthBlock` | — | ignorado | Forzado a `op.blockNum` |
| `birthTx` | — | ignorado | Forzado a `op.txId` |
| `mintedBy` | — | ignorado | Forzado a `op.signer` |
| `maxReplicas` | number | no | Máximo de réplicas permitidas (default 1) |
| `metadata.name` | string | no | Nombre del NFT |
| `metadata.description` | string | no | Descripción |
| `metadata.imageUrl` | string | no | URL de imagen |
| `metadata.imageHash` | string | no | Hash de imagen |
| `tags` | string[] | no | Tags (max 4, max 8 chars c/u) |
| `data` | object | no | Datos custom mutables |
| `collectionBlock` | number | sí | Bloque donde se creó la colección (trazabilidad L1 sin indexer) |

**Validaciones del indexer**:
- NFT con ese `id` no debe existir
- La colección debe existir
- `collection.creator === op.signer` (Fix 5 — solo el creator puede mintear)
- Tipo determinado por prefijo del ID

**Cambios de estado**: Inserta fila en `nfts` con status `active`.
**Restricciones**: ID duplicado o colección inexistente → rechazado.

---

### 3. `transfer`

**Constante SDK**: `ACTION_TRANSFER`
**Descripción**: Transfiere la propiedad de un NFT a otra cuenta. Limpia approvals y listings.
**Key authority**: posting — el owner firma la transferencia.
**Signer role**: Debe ser el owner actual del NFT.

**Payload del SDK**:
| Campo | Tipo | Requerido | Descripción |
|-------|------|-----------|-------------|
| `nftId` | string | sí | ID del NFT a transferir |
| `to` | string | sí | Username del destinatario |

**Validaciones del indexer**:
- NFT debe existir
- Status no puede ser `burned` ni `lent`
- `nft.owner === op.signer`

**Cambios de estado**: Actualiza `owner` en `nfts`, limpia listing fields, elimina `nft_allowances` para ese NFT.
**Restricciones**: NFT quemado, prestado, o signer no es owner → rechazado.

---

### 4. `burn`

**Constante SDK**: `ACTION_BURN`
**Descripción**: Destruye un NFT permanentemente. Estado terminal irreversible.
**Key authority**: posting — el owner firma la destrucción.
**Signer role**: Debe ser el owner actual del NFT.

**Payload del SDK**:
| Campo | Tipo | Requerido | Descripción |
|-------|------|-----------|-------------|
| `nftId` | string | sí | ID del NFT a quemar |

**Validaciones del indexer**:
- NFT debe existir
- Status no puede ser `burned` (previene doble-burn)
- Status no puede ser `lent`
- `nft.owner === op.signer`

**Cambios de estado**: Status → `burned`, limpia listing, elimina `nft_allowances`.
**Restricciones**: Ya quemado, prestado, o signer no es owner → rechazado.

---

### 5. `replicate`

**Constante SDK**: `ACTION_REPLICATE`
**Descripción**: Crea una réplica derivada de un NFT original. La réplica es un NFT nuevo con referencia al original.
**Key authority**: posting — el owner del original firma.
**Signer role**: Debe ser el owner del NFT original.

**Payload del SDK**:
| Campo | Tipo | Requerido | Descripción |
|-------|------|-----------|-------------|
| `id` | string | sí | ID de la nueva réplica |
| `originalId` | string | sí | ID del NFT original |
| `newOwner` | string | sí | Owner de la réplica |
| `originDna` | string | no | DNA del origen |
| `instanceDna` | string | no | DNA de la instancia |
| `uniqueAccessKey` | string | no | Clave de acceso (ignorada por indexer, genera la suya) |
| `name` | string | no | Nombre (default: "Original Name (Replica)") |

**Validaciones del indexer**:
- Réplica con ese `id` no debe existir
- Original debe existir
- `original.owner === op.signer` (Fix 3)
- Original no puede estar `burned` ni `lent`

**Cambios de estado**: Inserta fila en `nfts` con `nft_type = "replica"`, `originalId` referenciando al original.
**Restricciones**: ID duplicado, original inexistente/quemado/prestado, o signer no es owner → rechazado.

---

### 6. `bulk_distribute`

**Constante SDK**: `ACTION_BULK_DISTRIBUTE`
**Descripción**: Mintea múltiples instancias de uno o varios seeds en una sola operación. Genera DNA determinístico.
**Key authority**: posting — el creator o seed owner firma.
**Signer role**: Debe ser owner del seed O creator de la colección.

**Payload del SDK**:
| Campo | Tipo | Requerido | Descripción |
|-------|------|-----------|-------------|
| `to` | string | no | Owner de las instancias (default signer) |
| `items` | array | sí | `[{ seedId, quantity, originBlock }]` — max 50 items |
| `items[].originBlock` | number | sí | Bloque donde se minteó el seed original (trazabilidad L1 sin indexer) |
| `imageOverrides` | object | no | `{ seedId: imageUrl }` — override por seed |
| `data` | object | no | Datos custom para las instancias |

**Validaciones del indexer**:
- Items no vacío, máx 50
- No puede haber seedIds duplicados en items
- Cada seed debe existir y tener supply disponible (`distributed + quantity ≤ maxReplicas`)
- Signer debe ser owner del seed o creator de la colección

**Cambios de estado**: Inserta N filas en `nfts` (tipo `instance`), incrementa `distributed` del seed.
**Idempotencia**: Detecta re-envíos del mismo txId y ajusta contadores.
**Restricciones**: Supply excedido, seeds inexistentes, signer sin permiso → rechazado.

---

### 7. `set_data`

**Constante SDK**: `ACTION_SET_DATA`
**Descripción**: El owner actualiza datos mutables y tags de su NFT.
**Key authority**: posting — el owner firma.
**Signer role**: Debe ser el owner del NFT.

**Payload del SDK**:
| Campo | Tipo | Requerido | Descripción |
|-------|------|-----------|-------------|
| `nftId` | string | sí | ID del NFT |
| `instanceDna` | string | sí | DNA de la instancia (debe coincidir) |
| `data` | object | sí | Datos custom a escribir |
| `tags` | string[] | no | Tags (max 4, max 8 chars c/u) |

**Validaciones del indexer**:
- NFT debe existir y no estar `burned`
- `nft.owner === op.signer`
- `instanceDna` debe coincidir con el DNA almacenado

**Cambios de estado**: Actualiza `custom_data` y `tags` en `nfts`.
**Restricciones**: NFT quemado, signer no es owner, DNA no coincide → rechazado.

---

## Marketplace (3 operaciones)

### 8. `list`

**Constante SDK**: `ACTION_LIST`
**Descripción**: Pone un NFT a la venta en el marketplace con precio y moneda.
**Key authority**: posting — el owner firma el listing.
**Signer role**: Debe ser el owner del NFT.

**Payload del SDK**:
| Campo | Tipo | Requerido | Descripción |
|-------|------|-----------|-------------|
| `nftId` | string | sí | ID del NFT |
| `price` | HiveAmount | sí | `{ amount: "10.000", currency: "HIVE"|"HBD" }` |
| `expiresAt` | string | no | Fecha de expiración ISO |
| `marketplace` | string | no | ID del marketplace tercero |

**Validaciones del indexer**:
- NFT debe existir
- Status no puede ser `burned` ni `lent`
- `nft.owner === op.signer`
- Precio debe tener formato Hive válido (3 decimales)
- Moneda debe ser HIVE o HBD

**Cambios de estado**: Status → `listed`, almacena `listing_price`, `listing_currency`, `listing_expires_at`, `listing_marketplace`.
**Restricciones**: NFT quemado, prestado, o signer no es owner → rechazado.

---

### 9. `unlist`

**Constante SDK**: `ACTION_UNLIST`
**Descripción**: Retira un NFT del marketplace.
**Key authority**: posting — el owner firma.
**Signer role**: Debe ser el owner del NFT.

**Payload del SDK**:
| Campo | Tipo | Requerido | Descripción |
|-------|------|-----------|-------------|
| `nftId` | string | sí | ID del NFT |

**Validaciones del indexer**:
- NFT debe existir
- Status debe ser `listed`
- `nft.owner === op.signer`

**Cambios de estado**: Status → `active`, limpia todos los campos de listing.
**Restricciones**: NFT no listado o signer no es owner → rechazado.

---

### 10. `buy`

**Constante SDK**: `ACTION_BUY`
**Descripción**: Compra un NFT listado. Operación especial: el nodo co-firma con active key (multisig). El buyer se extrae de los transfers pareados, no del signer.
**Key authority**: active — firmado por el nodo indexador (multisig).
**Signer role**: El nodo que co-firma. Buyer se identifica de `pairedTransfers[0].from`.

**Payload del SDK**:
| Campo | Tipo | Requerido | Descripción |
|-------|------|-----------|-------------|
| `nftId` | string | sí | ID del NFT a comprar |

**Transfers pareados** (generados por el SDK como operaciones HIVE):
- Transfer al seller (precio - royalty - fee)
- Transfer al royaltyRecipient (si aplica y ≠ seller)
- Transfer al feeAccount (fee del protocolo 2.5%, si ≠ seller)

**Validaciones del indexer**:
- NFT debe existir y estar `listed`
- Buyer ≠ seller
- `verifyTransfers()` valida montos exactos de cada transfer
- Si `royaltyRecipient === seller`, royalty se fusiona en el pago al seller
- Si `feeAccount === seller`, fee se fusiona en el pago al seller

**Cambios de estado**: `owner` → buyer, status → `active`, limpia listing y allowances.
**Restricciones**: NFT no listado, pagos incorrectos, buyer = seller → rechazado.

---

## Packs (4 operaciones)

### 11. `pack_create`

**Constante SDK**: `ACTION_PACK_CREATE`
**Descripción**: Crea un pack con tabla de drop probabilístico. Al abrir un pack, se generan instancias según los pesos de la tabla.
**Key authority**: posting — el creator de la colección firma.
**Signer role**: Debe ser el creator de la colección asociada.

**Payload del SDK**:
| Campo | Tipo | Requerido | Descripción |
|-------|------|-----------|-------------|
| `id` | string | sí | ID determinístico del pack |
| `collectionId` | string | sí | Colección asociada |
| `name` | string | sí | Nombre del pack |
| `description` | string | no | Descripción |
| `imageUrl` | string | no | URL de imagen |
| `dropTable` | array | sí | `[{ seedId, weight }]` — max 50 entries, weight 1-10000 |
| `itemsPerPack` | number | sí | Items por apertura (max 10) |
| `price` | HiveAmount | no | Precio por pack (null = gratis) |
| `maxSupply` | number | sí | Supply máximo |

**Validaciones del indexer**:
- Pack con ese `id` no debe existir
- `pack.creator === collection.creator === op.signer`
- Cada seed del dropTable debe existir, ser tipo "seed", y pertenecer a la colección
- Supply de seeds debe soportar la demanda (maxSupply × itemsPerPack)
- Precio si existe debe ser > 0

**Cambios de estado**: Inserta fila en `packs`.
**Restricciones**: ID duplicado, seeds inválidos, creator mismatch → rechazado.

---

### 12. `pack_buy`

**Constante SDK**: `ACTION_PACK_BUY`
**Descripción**: Compra packs. Si el pack tiene precio, requiere transfer HIVE/HBD pareado del buyer al creator.
**Key authority**: posting — el buyer firma.
**Signer role**: Buyer.

**Payload del SDK**:
| Campo | Tipo | Requerido | Descripción |
|-------|------|-----------|-------------|
| `packId` | string | sí | ID del pack |
| `quantity` | number | sí | Cantidad a comprar |

**Validaciones del indexer**:
- Pack debe existir y estar activo
- Quantity > 0
- Supply disponible (`current_supply + quantity ≤ max_supply`)
- Para packs pagados: transfer pareado con monto exacto (price × quantity)

**Cambios de estado**: Incrementa `current_supply` en `packs`, upsert en `user_pack_balances`.
**Restricciones**: Supply agotado, pago insuficiente → rechazado.

---

### 13. `pack_transfer`

**Constante SDK**: `ACTION_PACK_TRANSFER`
**Descripción**: Transfiere packs entre usuarios.
**Key authority**: posting — el sender firma.
**Signer role**: Debe ser el poseedor de los packs.

**Payload del SDK**:
| Campo | Tipo | Requerido | Descripción |
|-------|------|-----------|-------------|
| `from` | string | sí | Sender (debe ser signer) |
| `to` | string | sí | Recipient |
| `packId` | string | sí | ID del pack |
| `quantity` | number | sí | Cantidad a transferir |

**Validaciones del indexer**:
- Pack debe existir
- `from ≠ to`
- Quantity > 0
- `getPackBalance(from, packId) ≥ quantity`

**Cambios de estado**: Debita balance del sender, acredita al recipient en `user_pack_balances`.
**Restricciones**: Balance insuficiente, self-transfer → rechazado.

---

### 14. `pack_open`

**Constante SDK**: `ACTION_PACK_OPEN`
**Descripción**: Abre packs y genera instancias NFT determinísticas basadas en la drop table. El RNG es determinístico (txId, blockNum, signer, packId, index).
**Key authority**: posting — el owner de los packs firma.
**Signer role**: Debe poseer los packs.

**Payload del SDK**:
| Campo | Tipo | Requerido | Descripción |
|-------|------|-----------|-------------|
| `packId` | string | sí | ID del pack |
| `quantity` | number | sí | Cantidad de packs a abrir (max 10) |

**Validaciones del indexer**:
- Pack debe existir
- Quantity > 0
- `getPackBalance(signer, packId) ≥ quantity`

**Cambios de estado**: Debita balance, incrementa `total_opened`, inserta N instancias en `nfts`, incrementa `distributed` por seed.
**Idempotencia**: Detecta re-envíos del mismo txId.
**Restricciones**: Balance insuficiente, seeds sin supply → skip (no error).

---

## Approve/Delegación (5 operaciones)

### 15. `nft_approve`

**Constante SDK**: `ACTION_NFT_APPROVE`
**Descripción**: Aprueba a un spender para transferir UN NFT específico del owner.
**Key authority**: posting — el owner firma la aprobación.
**Signer role**: Debe ser el owner del NFT.

**Payload del SDK**:
| Campo | Tipo | Requerido | Descripción |
|-------|------|-----------|-------------|
| `spender` | string | sí | Cuenta aprobada |
| `instanceId` | string | sí | ID del NFT |
| `approved` | boolean | sí | true = aprobar, false = revocar |

**Validaciones del indexer**:
- `spender ≠ op.signer`
- NFT debe existir
- `nft.owner === op.signer`
- NFT no puede estar `burned` ni `lent`

**Cambios de estado**: Upsert/delete en `nft_allowances`.
**Restricciones**: Self-approval, NFT quemado/prestado, signer no es owner → rechazado.

---

### 16. `nft_approve_all`

**Constante SDK**: `ACTION_NFT_APPROVE_ALL`
**Descripción**: Aprueba a un spender para transferir TODOS los NFTs del signer en una colección. Análogo a ERC-721 `setApprovalForAll`.
**Key authority**: posting — el owner firma.
**Signer role**: El signer es el owner que concede permiso (firmó la tx).

**Payload del SDK**:
| Campo | Tipo | Requerido | Descripción |
|-------|------|-----------|-------------|
| `spender` | string | sí | Cuenta aprobada |
| `collectionId` | string | sí | ID de la colección |
| `approved` | boolean | sí | true = aprobar, false = revocar |

**Validaciones del indexer**:
- `spender ≠ op.signer`
- Colección debe existir

**Cambios de estado**: Upsert en `collection_allowances` con `owner = op.signer`.
**Restricciones**: Self-approval, colección inexistente → rechazado.

---

### 17. `nft_transfer_from`

**Constante SDK**: `ACTION_NFT_TRANSFER_FROM`
**Descripción**: Un spender aprobado transfiere el NFT del owner a otro destinatario.
**Key authority**: posting — el spender firma.
**Signer role**: Debe tener approval específico del NFT o approval de toda la colección.

**Payload del SDK**:
| Campo | Tipo | Requerido | Descripción |
|-------|------|-----------|-------------|
| `from` | string | sí | Owner actual |
| `to` | string | sí | Destinatario |
| `instanceId` | string | sí | ID del NFT |

**Validaciones del indexer**:
- `from ≠ to`
- NFT debe existir, `nft.owner === from`
- Status: no `burned`, no `lent`, no `listed`
- Colección debe ser `transferable`
- Autorización: `getNftAllowance(nftId)` o `hasCollectionAllowance(from, signer, collectionId)`

**Cambios de estado**: `owner` → `to`, limpia allowances.
**Restricciones**: Sin autorización, NFT no transferible/quemado/prestado/listado → rechazado.

---

### 18. `pack_approve`

**Constante SDK**: `ACTION_PACK_APPROVE`
**Descripción**: Aprueba a un spender para gastar N packs del owner. Análogo a ERC-20 `approve`.
**Key authority**: posting — el owner firma.
**Signer role**: Debe poseer balance del pack.

**Payload del SDK**:
| Campo | Tipo | Requerido | Descripción |
|-------|------|-----------|-------------|
| `spender` | string | sí | Cuenta aprobada |
| `packId` | string | sí | ID del pack |
| `quantity` | number | sí (si approved) | Cantidad aprobada |
| `approved` | boolean | sí | true = aprobar, false = revocar |

**Validaciones del indexer**:
- `spender ≠ op.signer`
- Pack debe existir
- Si `approved`: quantity > 0 y `getPackBalance(signer, packId) ≥ 1` (Fix 2)

**Cambios de estado**: Upsert en `pack_allowances`.
**Restricciones**: Self-approval, pack inexistente, sin balance → rechazado.

---

### 19. `pack_transfer_from`

**Constante SDK**: `ACTION_PACK_TRANSFER_FROM`
**Descripción**: Un spender aprobado transfiere packs del owner a otro destinatario.
**Key authority**: posting — el spender firma.
**Signer role**: Debe tener allowance del owner para ese pack.

**Payload del SDK**:
| Campo | Tipo | Requerido | Descripción |
|-------|------|-----------|-------------|
| `from` | string | sí | Owner de los packs |
| `to` | string | sí | Destinatario |
| `packId` | string | sí | ID del pack |
| `quantity` | number | sí | Cantidad a transferir |

**Validaciones del indexer**:
- `from ≠ to`, quantity > 0
- Pack debe existir
- `getPackAllowance(signer, from, packId) ≥ quantity`
- `getPackBalance(from, packId) ≥ quantity`

**Cambios de estado**: Deduce allowance PRIMERO (previene doble-gasto), luego transfiere balance.
**Restricciones**: Sin allowance, balance insuficiente → rechazado.

---

## Lending (2 operaciones)

### 20. `nft_lend`

**Constante SDK**: `ACTION_NFT_LEND`
**Descripción**: Presta un NFT a un borrower. El NFT queda bloqueado (no se puede transferir, listar, quemar ni aprobar).
**Key authority**: posting — el owner/lender firma.
**Signer role**: Debe ser el owner del NFT.

**Payload del SDK**:
| Campo | Tipo | Requerido | Descripción |
|-------|------|-----------|-------------|
| `instanceId` | string | sí | ID del NFT |
| `borrower` | string | sí | Cuenta del prestatario |

**Validaciones del indexer**:
- `borrower ≠ op.signer`
- NFT debe existir, `nft.owner === op.signer`
- Status debe ser `active` (no listed, burned, o ya lent)
- Colección debe ser `transferable` (NFTs no-transferibles no se pueden prestar)
- No debe existir préstamo activo para este NFT

**Cambios de estado**: Status → `lent`, inserta fila en `nft_loans`, elimina `nft_allowances`.
**Restricciones**: Self-lend, NFT no transferible/quemado/listado/ya prestado → rechazado.

---

### 21. `nft_return`

**Constante SDK**: `ACTION_NFT_RETURN`
**Descripción**: Devuelve un NFT prestado. Tanto el lender como el borrower pueden ejecutar esta acción.
**Key authority**: posting — lender o borrower firma.
**Signer role**: Debe ser el lender o el borrower del préstamo activo.

**Payload del SDK**:
| Campo | Tipo | Requerido | Descripción |
|-------|------|-----------|-------------|
| `instanceId` | string | sí | ID del NFT |

**Validaciones del indexer**:
- NFT debe existir, status debe ser `lent`
- Préstamo debe existir en `nft_loans`
- `op.signer === loan.lender || op.signer === loan.borrower`

**Cambios de estado**: Status → `active`, elimina fila de `nft_loans`.
**Restricciones**: NFT no prestado, signer no es lender ni borrower → rechazado.

---

## Data Operators (2 operaciones)

### 22. `data_operator_approve`

**Constante SDK**: `ACTION_DATA_OPERATOR_APPROVE`
**Descripción**: El creator de una colección autoriza a un operador externo para modificar datos de NFTs en esa colección.
**Key authority**: posting — el creator firma.
**Signer role**: Debe ser el creator de la colección.

**Payload del SDK**:
| Campo | Tipo | Requerido | Descripción |
|-------|------|-----------|-------------|
| `collectionId` | string | sí | ID de la colección |
| `operator` | string | sí | Cuenta del operador |
| `approved` | boolean | sí | true = aprobar, false = revocar |

**Validaciones del indexer**:
- `operator ≠ op.signer`
- Colección debe existir
- `collection.creator === op.signer`

**Cambios de estado**: Upsert/delete en `data_operators`.
**Restricciones**: Self-approval, colección inexistente, signer no es creator → rechazado.

---

### 23. `set_data_from`

**Constante SDK**: `ACTION_SET_DATA_FROM`
**Descripción**: Un operador aprobado modifica datos de NFTs sin ser owner. Los datos se almacenan en campo separado (`operatorData`) del `customData` del owner.
**Key authority**: posting — el operador firma.
**Signer role**: Debe estar aprobado como data operator para la colección del NFT.

**Payload del SDK**:
| Campo | Tipo | Requerido | Descripción |
|-------|------|-----------|-------------|
| `nftId` | string | sí | ID del NFT |
| `instanceDna` | string | sí | DNA de la instancia (debe coincidir) |
| `data` | object | sí | Datos a escribir en `operatorData` |
| `tags` | string[] | no | Tags |

**Validaciones del indexer**:
- NFT debe existir y no estar `burned`
- `instanceDna` debe coincidir
- `hasDataOperatorApproval(signer, collectionId)` debe ser true

**Cambios de estado**: Actualiza `operator_data` y `tags` en `nfts`.
**Restricciones**: NFT quemado, DNA no coincide, sin aprobación de operador → rechazado.

---

## Notas de arquitectura

### Key Authority
El indexer extrae el signer de `required_auths[0] ?? required_posting_auths[0]`. No valida el tipo de key directamente — la validación de key la hace la blockchain de Hive al aceptar la transacción. El SDK marca la autoridad correcta al construir el `custom_json`.

### Idempotencia
Las operaciones `bulk_distribute` y `pack_open` son idempotentes: si se re-envía la misma transacción (mismo `txId`), detectan las instancias ya creadas y ajustan contadores para no duplicar NFTs.

### IDs determinísticos
Collections, seeds y packs usan IDs determinísticos generados por el SDK (hash de campos únicos). Esto previene la creación de duplicados incluso si la misma transacción se procesa múltiples veces.

### Payment Splits (Marketplace)
La función `calculatePaymentSplit()` del SDK se reutiliza en el indexer para verificar pagos. El split es:
- **Seller**: precio - royalty - fee
- **Royalty**: `totalPrice × royaltyPct / 100` (si royaltyRecipient ≠ seller)
- **Fee**: `totalPrice × 2.5%` (si feeAccount ≠ seller)

Si royaltyRecipient o feeAccount coinciden con el seller, esos montos se fusionan en el pago al seller.

### Multisig (Buy)
La operación `buy` es la única que requiere active key porque el nodo co-firma. El buyer envía transfers HIVE/HBD y el nodo valida y co-firma el `custom_json`. Si el nodo rechaza, los fondos nunca salen de la cuenta del buyer.
