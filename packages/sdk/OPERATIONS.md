# Catalogo de Operaciones NFTLox Protocol v0.3.0

Referencia completa de las 25 operaciones del protocolo NFTLox. Cada operacion se transmite como `custom_json` en la blockchain de Hive con `id = "nftlox_testnet"`.

---

## Resumen

| # | Accion | Categoria | Key | Descripcion |
|---|--------|-----------|-----|-------------|
| 1 | `create_collection` | Core | posting | Crea una coleccion (arquetipo) |
| 2 | `mint` | Core | posting | Crea un seed NFT dentro de una coleccion |
| 3 | `transfer` | Core | posting | Transfiere ownership de un NFT |
| 4 | `burn` | Core | posting | Destruye un NFT permanentemente |
| 5 | `replicate` | Core | posting | Crea una replica derivada de un NFT original |
| 6 | `bulk_distribute` | Core | posting | Mintea multiples instancias desde seeds |
| 7 | `set_data` | Core | posting | Creator actualiza datos mutables de un NFT (requiere schema) |
| 8 | `set_owner_data` | Core | posting | Owner escribe datos propios en un NFT |
| 9 | `extend_schema` | Core | posting | Creator agrega campos al schema de una coleccion |
| 10 | `list` | Marketplace | posting | Pone un NFT a la venta |
| 11 | `unlist` | Marketplace | posting | Retira un NFT del marketplace |
| 12 | `buy` | Marketplace | active | Compra un NFT listado (multisig con nodo) |
| 13 | `pack_create` | Pack | posting | Crea un pack con drop table probabilistico |
| 14 | `pack_buy` | Pack | posting | Compra packs (gratis o pagados) |
| 15 | `pack_transfer` | Pack | posting | Transfiere packs entre usuarios |
| 16 | `pack_open` | Pack | posting | Abre packs y genera instancias NFT |
| 17 | `nft_approve` | Approve | posting | Aprueba spender para UN NFT especifico |
| 18 | `nft_approve_all` | Approve | posting | Aprueba spender para TODOS los NFTs de una coleccion |
| 19 | `nft_transfer_from` | Approve | posting | Spender aprobado transfiere NFT del owner |
| 20 | `pack_approve` | Approve | posting | Aprueba spender para gastar N packs |
| 21 | `pack_transfer_from` | Approve | posting | Spender aprobado transfiere packs del owner |
| 22 | `nft_lend` | Lending | posting | Presta un NFT a un borrower |
| 23 | `nft_return` | Lending | posting | Devuelve un NFT prestado |
| 24 | `data_operator_approve` | DataOperator | posting | Autoriza operador externo para una coleccion |
| 25 | `set_data_from` | DataOperator | posting | Operador aprobado modifica datos mutables de NFTs (requiere schema) |

---

## Core (9 operaciones)

### 1. `create_collection`

**Constante SDK**: `ACTION_CREATE_COLLECTION`
**Descripcion**: Crea una coleccion que agrupa NFTs bajo reglas comunes (transferencia, burn, royalties).
**Key authority**: posting -- accion de configuracion del creator.
**Signer role**: El signer se convierte en el creator de la coleccion (campo `creator` del payload se ignora).

**Payload del SDK**:
| Campo | Tipo | Requerido | Descripcion |
|-------|------|-----------|-------------|
| `id` | string | si | ID deterministico de la coleccion |
| `name` | string | si | Nombre (max 100 chars) |
| `symbol` | string | si | Simbolo 3-8 chars, A-Z0-9 |
| `totalPotential` | number | no | Supply potencial total (default 0) |
| `originDna` | string | no | DNA de la coleccion (16 chars hex) |
| `metadata.description` | string | no | Descripcion |
| `metadata.image` | string | no | URL de imagen |
| `metadata.externalUrl` | string | no | URL externa |
| `rules.transferable` | boolean | no | Si los NFTs son transferibles (default true) |
| `rules.burnable` | boolean | no | Si los NFTs se pueden quemar (default true) |
| `rules.replicable` | boolean | no | Si los NFTs se pueden replicar (default true) |
| `rules.royaltyPct` | number | no | Porcentaje de royalty 0-50 (default 0) |
| `rules.royaltyRecipient` | string | no | Cuenta que recibe royalties |
| `schema` | object | no | Schema tipado con campos `immutable` y `mutable` |

**Validaciones del indexer**:
- `id` no debe existir previamente
- `creator` se fuerza a `op.signer`
- Campos faltantes usan defaults seguros

**Cambios de estado**: Inserta fila en `collections`.
**Restricciones**: ID duplicado -> rechazado (ON CONFLICT DO NOTHING).

---

### 2. `mint`

**Constante SDK**: `ACTION_MINT`
**Descripcion**: Crea un seed NFT (plantilla) o instancia dentro de una coleccion. Solo el creator de la coleccion puede mintear.
**Key authority**: posting -- solo el creator necesita firmar.
**Signer role**: Debe ser el creator de la coleccion.

**Payload del SDK**:
| Campo | Tipo | Requerido | Descripcion |
|-------|------|-----------|-------------|
| `id` | string | si | ID del NFT. Prefijo `seed_` -> tipo seed, otro -> instancia |
| `collectionId` | string | si | Coleccion destino |
| `edition` | number | no | Edicion (default 1) |
| `owner` | string | no | Owner inicial (default signer) |
| `originDna` | string | no | DNA del origen |
| `instanceDna` | string | no | DNA de la instancia |
| `uniqueAccessKey` | string | no | Clave de acceso unica |
| `birthBlock` | -- | ignorado | Forzado a `op.blockNum` |
| `birthTx` | -- | ignorado | Forzado a `op.txId` |
| `mintedBy` | -- | ignorado | Forzado a `op.signer` |
| `maxReplicas` | number | no | Maximo de replicas permitidas (default 1) |
| `metadata.name` | string | no | Nombre del NFT |
| `metadata.description` | string | no | Descripcion |
| `metadata.imageUrl` | string | no | URL de imagen |
| `metadata.imageHash` | string | no | Hash de imagen |
| `immutableData` | object | no | Datos inmutables validados contra schema |
| `mutableData` | object | no | Datos mutables validados contra schema |
| `collectionBlock` | number | si | Bloque donde se creo la coleccion (trazabilidad L1 sin indexer) |

**Nota**: Si la coleccion tiene schema, `immutableData` y `mutableData` se validan contra el schema. Los campos inmutables no pueden modificarse despues del mint.

**Validaciones del indexer**:
- NFT con ese `id` no debe existir
- La coleccion debe existir
- `collection.creator === op.signer` (solo el creator puede mintear)
- Si la coleccion tiene schema, se valida `immutableData`/`mutableData` contra el schema
- Si la coleccion tiene `totalPotential > 0`, se valida el seed cap
- Tipo determinado por prefijo del ID

**Cambios de estado**: Inserta fila en `nfts` con status `active`. Almacena `immutable_data`, `immutable_data_hash`, `mutable_data`, `mutable_data_hash`.
**Restricciones**: ID duplicado, coleccion inexistente, seed cap alcanzado, o validacion de schema fallida -> rechazado.

---

### 3. `transfer`

**Constante SDK**: `ACTION_TRANSFER`
**Descripcion**: Transfiere la propiedad de un NFT a otra cuenta. Limpia approvals y listings.
**Key authority**: posting -- el owner firma la transferencia.
**Signer role**: Debe ser el owner actual del NFT.

**Payload del SDK**:
| Campo | Tipo | Requerido | Descripcion |
|-------|------|-----------|-------------|
| `nftId` | string | si | ID del NFT a transferir |
| `to` | string | si | Username del destinatario |

**Validaciones del indexer**:
- NFT debe existir
- Status no puede ser `burned` ni `lent`
- `nft.owner === op.signer`

**Cambios de estado**: Actualiza `owner` en `nfts`, limpia listing fields, elimina `nft_allowances` para ese NFT.
**Restricciones**: NFT quemado, prestado, o signer no es owner -> rechazado.

---

### 4. `burn`

**Constante SDK**: `ACTION_BURN`
**Descripcion**: Destruye un NFT permanentemente. Estado terminal irreversible.
**Key authority**: posting -- el owner firma la destruccion.
**Signer role**: Debe ser el owner actual del NFT.

**Payload del SDK**:
| Campo | Tipo | Requerido | Descripcion |
|-------|------|-----------|-------------|
| `nftId` | string | si | ID del NFT a quemar |

**Validaciones del indexer**:
- NFT debe existir
- Status no puede ser `burned` (previene doble-burn)
- Status no puede ser `lent`
- Status no puede ser `listed`
- `nft.owner === op.signer`

**Cambios de estado**: Status -> `burned`, registra `burned_by` (signer) y `burned_at_block` (bloque actual), limpia listing, elimina `nft_allowances`.
**Restricciones**: Ya quemado, prestado, listado, o signer no es owner -> rechazado.

---

### 5. `replicate`

**Constante SDK**: `ACTION_REPLICATE`
**Descripcion**: Crea una replica derivada de un NFT original. La replica es un NFT nuevo con referencia al original.
**Key authority**: posting -- el owner del original firma.
**Signer role**: Debe ser el owner del NFT original.

**Payload del SDK**:
| Campo | Tipo | Requerido | Descripcion |
|-------|------|-----------|-------------|
| `id` | string | si | ID de la nueva replica |
| `originalId` | string | si | ID del NFT original |
| `newOwner` | string | si | Owner de la replica |
| `originDna` | string | no | DNA del origen |
| `instanceDna` | string | no | DNA de la instancia |
| `uniqueAccessKey` | string | no | Clave de acceso (ignorada por indexer, genera la suya) |
| `name` | string | no | Nombre (default: "Original Name (Replica)") |

**Validaciones del indexer**:
- Replica con ese `id` no debe existir
- Original debe existir
- `original.owner === op.signer`
- Original no puede estar `burned` ni `lent`

**Cambios de estado**: Inserta fila en `nfts` con `nft_type = "replica"`, `originalId` referenciando al original.
**Restricciones**: ID duplicado, original inexistente/quemado/prestado, o signer no es owner -> rechazado.

---

### 6. `bulk_distribute`

**Constante SDK**: `ACTION_BULK_DISTRIBUTE`
**Descripcion**: Mintea multiples instancias de uno o varios seeds en una sola operacion. Genera DNA deterministico. Las instancias heredan `immutable_data` del seed automaticamente.
**Key authority**: posting -- el creator o seed owner firma.
**Signer role**: Debe ser owner del seed O creator de la coleccion.

**Payload del SDK**:
| Campo | Tipo | Requerido | Descripcion |
|-------|------|-----------|-------------|
| `to` | string | no | Owner de las instancias (default signer) |
| `items` | array | si | `[{ seedId, quantity, originBlock }]` -- max 50 items |
| `items[].originBlock` | number | si | Bloque donde se minteo el seed original (trazabilidad L1 sin indexer) |
| `imageOverrides` | object | no | `{ seedId: imageUrl }` -- override por seed |
| `mutableData` | object | no | Datos mutables para las instancias (validados contra schema) |

**Nota**: Las instancias heredan `immutable_data` y `immutable_data_hash` del seed automaticamente. Si la coleccion tiene schema, `mutableData` se valida contra los campos mutables del schema.

**Validaciones del indexer**:
- Items no vacio, max 50
- No puede haber seedIds duplicados en items
- Cada seed debe existir y tener supply disponible (`distributed + quantity <= maxReplicas`)
- Signer debe ser owner del seed o creator de la coleccion
- Si la coleccion tiene schema y se proporciona `mutableData`, se valida contra el schema

**Cambios de estado**: Inserta N filas en `nfts` (tipo `instance`), incrementa `distributed` del seed.
**Idempotencia**: Detecta re-envios del mismo txId y ajusta contadores.
**Restricciones**: Supply excedido, seeds inexistentes, signer sin permiso -> rechazado.

---

### 7. `set_data`

**Constante SDK**: `ACTION_SET_DATA`
**Descripcion**: El creator de la coleccion actualiza los datos mutables de un NFT. Requiere que la coleccion tenga schema definido.
**Key authority**: posting -- el creator firma.
**Signer role**: Debe ser el creator de la coleccion a la que pertenece el NFT.

**Payload del SDK**:
| Campo | Tipo | Requerido | Descripcion |
|-------|------|-----------|-------------|
| `nftId` | string | si | ID del NFT |
| `instanceDna` | string | si | DNA de la instancia (debe coincidir) |
| `mutableData` | object | si | Datos mutables a actualizar |

**Nota**: La coleccion DEBE tener un schema definido. No existe fallback legacy. Los datos enviados se validan contra los campos mutables del schema y se fusionan (merge) con los datos mutables existentes.

**Validaciones del indexer**:
- NFT debe existir y no estar `burned`
- `collection.creator === op.signer` (solo el creator puede usar set_data)
- `instanceDna` debe coincidir con el DNA almacenado
- La coleccion debe tener schema
- `mutableData` se valida contra el schema (campos y tipos)

**Cambios de estado**: Actualiza `mutable_data`, `mutable_data_hash`, `mutable_data_tx`, `mutable_data_block` en `nfts`.
**Restricciones**: NFT quemado, signer no es creator, DNA no coincide, coleccion sin schema, validacion de schema fallida -> rechazado.

---

### 8. `set_owner_data`

**Constante SDK**: `ACTION_SET_OWNER_DATA`
**Descripcion**: El owner del NFT escribe datos en el campo `owner_data`, separado del `mutable_data` del creator. No requiere validacion de schema.
**Key authority**: posting -- el owner firma.
**Signer role**: Debe ser el owner del NFT.

**Payload del SDK**:
| Campo | Tipo | Requerido | Descripcion |
|-------|------|-----------|-------------|
| `nftId` | string | si | ID del NFT |
| `instanceDna` | string | si | DNA de la instancia (debe coincidir) |
| `data` | object | si | Datos a escribir en `owner_data` |

**Validaciones del indexer**:
- NFT debe existir y no estar `burned`
- `nft.owner === op.signer`
- `instanceDna` debe coincidir con el DNA almacenado

**Cambios de estado**: Actualiza `owner_data`, `owner_data_hash`, `owner_data_tx`, `owner_data_block` en `nfts`.
**Restricciones**: NFT quemado, signer no es owner, DNA no coincide -> rechazado.

---

### 9. `extend_schema`

**Constante SDK**: `ACTION_EXTEND_SCHEMA`
**Descripcion**: El creator agrega nuevos campos al schema de una coleccion. No se pueden eliminar ni modificar campos existentes; solo se pueden agregar campos nuevos. Si la coleccion no tiene schema, se crea uno nuevo.
**Key authority**: posting -- el creator firma.
**Signer role**: Debe ser el creator de la coleccion.

**Payload del SDK**:
| Campo | Tipo | Requerido | Descripcion |
|-------|------|-----------|-------------|
| `collectionId` | string | si | ID de la coleccion |
| `newImmutableFields` | array | no | Nuevos campos inmutables `[{ name, type }]` |
| `newMutableFields` | array | no | Nuevos campos mutables `[{ name, type }]` |

**Tipos de campo soportados**: `string`, `bool`, `uint8`, `uint16`, `uint32`, `uint64`, `int8`, `int16`, `int32`, `int64`, `float`, `double`, y sus variantes array (`string[]`, `bool[]`, etc.).

**Validaciones del indexer**:
- Coleccion debe existir
- `collection.creator === op.signer`
- Si la coleccion ya tiene schema, los nuevos campos se fusionan (merge) con `mergeSchemas()` -- no se permiten campos duplicados ni modificaciones a campos existentes
- Si la coleccion no tiene schema, se crea uno nuevo validando la definicion

**Cambios de estado**: Actualiza `schema` en `collections`.
**Restricciones**: Coleccion inexistente, signer no es creator, campos duplicados, nombres de campo invalidos -> rechazado.

---

## Marketplace (3 operaciones)

### 10. `list`

**Constante SDK**: `ACTION_LIST`
**Descripcion**: Pone un NFT a la venta en el marketplace con precio y moneda.
**Key authority**: posting -- el owner firma el listing.
**Signer role**: Debe ser el owner del NFT.

**Payload del SDK**:
| Campo | Tipo | Requerido | Descripcion |
|-------|------|-----------|-------------|
| `nftId` | string | si | ID del NFT |
| `price` | HiveAmount | si | `{ amount: "10.000", currency: "HIVE"|"HBD" }` |
| `expiresAt` | string | no | Fecha de expiracion ISO |
| `marketplace` | string | no | ID del marketplace tercero |

**Validaciones del indexer**:
- NFT debe existir
- Status no puede ser `burned` ni `lent`
- `nft.owner === op.signer`
- Precio debe tener formato Hive valido (3 decimales)
- Moneda debe ser HIVE o HBD

**Cambios de estado**: Status -> `listed`, almacena `listing_price`, `listing_currency`, `listing_expires_at`, `listing_marketplace`.
**Restricciones**: NFT quemado, prestado, o signer no es owner -> rechazado.

---

### 11. `unlist`

**Constante SDK**: `ACTION_UNLIST`
**Descripcion**: Retira un NFT del marketplace.
**Key authority**: posting -- el owner firma.
**Signer role**: Debe ser el owner del NFT.

**Payload del SDK**:
| Campo | Tipo | Requerido | Descripcion |
|-------|------|-----------|-------------|
| `nftId` | string | si | ID del NFT |

**Validaciones del indexer**:
- NFT debe existir
- Status debe ser `listed`
- `nft.owner === op.signer`

**Cambios de estado**: Status -> `active`, limpia todos los campos de listing.
**Restricciones**: NFT no listado o signer no es owner -> rechazado.

---

### 12. `buy`

**Constante SDK**: `ACTION_BUY`
**Descripcion**: Compra un NFT listado. Operacion especial: el nodo co-firma con active key (multisig). El buyer se extrae de los transfers pareados, no del signer.
**Key authority**: active -- firmado por el nodo indexador (multisig).
**Signer role**: El nodo que co-firma. Buyer se identifica de `pairedTransfers[0].from`.

**Payload del SDK**:
| Campo | Tipo | Requerido | Descripcion |
|-------|------|-----------|-------------|
| `nftId` | string | si | ID del NFT a comprar |

**Transfers pareados** (generados por el SDK como operaciones HIVE):
- Transfer al seller (precio - royalty - fee)
- Transfer al royaltyRecipient (si aplica y != seller)
- Transfer al feeAccount (fee del protocolo 2.5%, si != seller)

**Validaciones del indexer**:
- NFT debe existir y estar `listed`
- Buyer != seller
- `verifyTransfers()` valida montos exactos de cada transfer
- Si `royaltyRecipient === seller`, royalty se fusiona en el pago al seller
- Si `feeAccount === seller`, fee se fusiona en el pago al seller

**Cambios de estado**: `owner` -> buyer, status -> `active`, limpia listing y allowances.
**Restricciones**: NFT no listado, pagos incorrectos, buyer = seller -> rechazado.

---

## Packs (4 operaciones)

### 13. `pack_create`

**Constante SDK**: `ACTION_PACK_CREATE`
**Descripcion**: Crea un pack con tabla de drop probabilistico. Al abrir un pack, se generan instancias segun los pesos de la tabla.
**Key authority**: posting -- el creator de la coleccion firma.
**Signer role**: Debe ser el creator de la coleccion asociada.

**Payload del SDK**:
| Campo | Tipo | Requerido | Descripcion |
|-------|------|-----------|-------------|
| `id` | string | si | ID deterministico del pack |
| `collectionId` | string | si | Coleccion asociada |
| `name` | string | si | Nombre del pack |
| `description` | string | no | Descripcion |
| `imageUrl` | string | no | URL de imagen |
| `dropTable` | array | si | `[{ seedId, weight }]` -- max 50 entries, weight 1-10000 |
| `itemsPerPack` | number | si | Items por apertura (max 20) |
| `price` | HiveAmount | no | Precio por pack (null = gratis) |
| `maxSupply` | number | si | Supply maximo |

**Validaciones del indexer**:
- Pack con ese `id` no debe existir
- `pack.creator === collection.creator === op.signer`
- Cada seed del dropTable debe existir, ser tipo "seed", y pertenecer a la coleccion
- Supply de seeds debe soportar la demanda (maxSupply x itemsPerPack)
- Precio si existe debe ser > 0

**Cambios de estado**: Inserta fila en `packs`.
**Restricciones**: ID duplicado, seeds invalidos, creator mismatch -> rechazado.

---

### 14. `pack_buy`

**Constante SDK**: `ACTION_PACK_BUY`
**Descripcion**: Compra packs. Si el pack tiene precio, requiere transfer HIVE/HBD pareado del buyer al creator.
**Key authority**: posting -- el buyer firma.
**Signer role**: Buyer.

**Payload del SDK**:
| Campo | Tipo | Requerido | Descripcion |
|-------|------|-----------|-------------|
| `packId` | string | si | ID del pack |
| `quantity` | number | si | Cantidad a comprar |

**Validaciones del indexer**:
- Pack debe existir y estar activo
- Quantity > 0
- Supply disponible (`current_supply + quantity <= max_supply`)
- Para packs pagados: transfer pareado con monto exacto (price x quantity)

**Cambios de estado**: Incrementa `current_supply` en `packs`, upsert en `user_pack_balances`.
**Restricciones**: Supply agotado, pago insuficiente -> rechazado.

---

### 15. `pack_transfer`

**Constante SDK**: `ACTION_PACK_TRANSFER`
**Descripcion**: Transfiere packs entre usuarios.
**Key authority**: posting -- el sender firma.
**Signer role**: Debe ser el poseedor de los packs.

**Payload del SDK**:
| Campo | Tipo | Requerido | Descripcion |
|-------|------|-----------|-------------|
| `from` | string | si | Sender (debe ser signer) |
| `to` | string | si | Recipient |
| `packId` | string | si | ID del pack |
| `quantity` | number | si | Cantidad a transferir |

**Validaciones del indexer**:
- Pack debe existir
- `from != to`
- Quantity > 0
- `getPackBalance(from, packId) >= quantity`

**Cambios de estado**: Debita balance del sender, acredita al recipient en `user_pack_balances`.
**Restricciones**: Balance insuficiente, self-transfer -> rechazado.

---

### 16. `pack_open`

**Constante SDK**: `ACTION_PACK_OPEN`
**Descripcion**: Abre packs y genera instancias NFT deterministicas basadas en la drop table. El RNG es deterministico (txId, blockNum, signer, packId, index).
**Key authority**: posting -- el owner de los packs firma.
**Signer role**: Debe poseer los packs.

**Payload del SDK**:
| Campo | Tipo | Requerido | Descripcion |
|-------|------|-----------|-------------|
| `packId` | string | si | ID del pack |
| `quantity` | number | si | Cantidad de packs a abrir (max 50) |

**Validaciones del indexer**:
- Pack debe existir
- Quantity > 0
- `getPackBalance(signer, packId) >= quantity`

**Cambios de estado**: Debita balance, incrementa `total_opened`, inserta N instancias en `nfts`, incrementa `distributed` por seed.
**Idempotencia**: Detecta re-envios del mismo txId.
**Restricciones**: Balance insuficiente, seeds sin supply -> skip (no error).

---

## Approve/Delegacion (5 operaciones)

### 17. `nft_approve`

**Constante SDK**: `ACTION_NFT_APPROVE`
**Descripcion**: Aprueba a un spender para transferir UN NFT especifico del owner.
**Key authority**: posting -- el owner firma la aprobacion.
**Signer role**: Debe ser el owner del NFT.

**Payload del SDK**:
| Campo | Tipo | Requerido | Descripcion |
|-------|------|-----------|-------------|
| `spender` | string | si | Cuenta aprobada |
| `instanceId` | string | si | ID del NFT |
| `approved` | boolean | si | true = aprobar, false = revocar |

**Validaciones del indexer**:
- `spender != op.signer`
- NFT debe existir
- `nft.owner === op.signer`
- NFT no puede estar `burned` ni `lent`

**Cambios de estado**: Upsert/delete en `nft_allowances`.
**Restricciones**: Self-approval, NFT quemado/prestado, signer no es owner -> rechazado.

---

### 18. `nft_approve_all`

**Constante SDK**: `ACTION_NFT_APPROVE_ALL`
**Descripcion**: Aprueba a un spender para transferir TODOS los NFTs del signer en una coleccion. Analogo a ERC-721 `setApprovalForAll`.
**Key authority**: posting -- el owner firma.
**Signer role**: El signer es el owner que concede permiso (firmo la tx).

**Payload del SDK**:
| Campo | Tipo | Requerido | Descripcion |
|-------|------|-----------|-------------|
| `spender` | string | si | Cuenta aprobada |
| `collectionId` | string | si | ID de la coleccion |
| `approved` | boolean | si | true = aprobar, false = revocar |

**Validaciones del indexer**:
- `spender != op.signer`
- Coleccion debe existir

**Cambios de estado**: Upsert en `collection_allowances` con `owner = op.signer`.
**Restricciones**: Self-approval, coleccion inexistente -> rechazado.

---

### 19. `nft_transfer_from`

**Constante SDK**: `ACTION_NFT_TRANSFER_FROM`
**Descripcion**: Un spender aprobado transfiere el NFT del owner a otro destinatario.
**Key authority**: posting -- el spender firma.
**Signer role**: Debe tener approval especifico del NFT o approval de toda la coleccion.

**Payload del SDK**:
| Campo | Tipo | Requerido | Descripcion |
|-------|------|-----------|-------------|
| `from` | string | si | Owner actual |
| `to` | string | si | Destinatario |
| `instanceId` | string | si | ID del NFT |

**Validaciones del indexer**:
- `from != to`
- NFT debe existir, `nft.owner === from`
- Status: no `burned`, no `lent`, no `listed`
- Coleccion debe ser `transferable`
- Autorizacion: `getNftAllowance(nftId)` o `hasCollectionAllowance(from, signer, collectionId)`

**Cambios de estado**: `owner` -> `to`, limpia allowances.
**Restricciones**: Sin autorizacion, NFT no transferible/quemado/prestado/listado -> rechazado.

---

### 20. `pack_approve`

**Constante SDK**: `ACTION_PACK_APPROVE`
**Descripcion**: Aprueba a un spender para gastar N packs del owner. Analogo a ERC-20 `approve`.
**Key authority**: posting -- el owner firma.
**Signer role**: Debe poseer balance del pack.

**Payload del SDK**:
| Campo | Tipo | Requerido | Descripcion |
|-------|------|-----------|-------------|
| `spender` | string | si | Cuenta aprobada |
| `packId` | string | si | ID del pack |
| `quantity` | number | si (si approved) | Cantidad aprobada |
| `approved` | boolean | si | true = aprobar, false = revocar |

**Validaciones del indexer**:
- `spender != op.signer`
- Pack debe existir
- Si `approved`: quantity > 0 y `getPackBalance(signer, packId) >= 1`

**Cambios de estado**: Upsert en `pack_allowances`.
**Restricciones**: Self-approval, pack inexistente, sin balance -> rechazado.

---

### 21. `pack_transfer_from`

**Constante SDK**: `ACTION_PACK_TRANSFER_FROM`
**Descripcion**: Un spender aprobado transfiere packs del owner a otro destinatario.
**Key authority**: posting -- el spender firma.
**Signer role**: Debe tener allowance del owner para ese pack.

**Payload del SDK**:
| Campo | Tipo | Requerido | Descripcion |
|-------|------|-----------|-------------|
| `from` | string | si | Owner de los packs |
| `to` | string | si | Destinatario |
| `packId` | string | si | ID del pack |
| `quantity` | number | si | Cantidad a transferir |

**Validaciones del indexer**:
- `from != to`, quantity > 0
- Pack debe existir
- `getPackAllowance(signer, from, packId) >= quantity`
- `getPackBalance(from, packId) >= quantity`

**Cambios de estado**: Deduce allowance PRIMERO (previene doble-gasto), luego transfiere balance.
**Restricciones**: Sin allowance, balance insuficiente -> rechazado.

---

## Lending (2 operaciones)

### 22. `nft_lend`

**Constante SDK**: `ACTION_NFT_LEND`
**Descripcion**: Presta un NFT a un borrower. El NFT queda bloqueado (no se puede transferir, listar, quemar ni aprobar).
**Key authority**: posting -- el owner/lender firma.
**Signer role**: Debe ser el owner del NFT.

**Payload del SDK**:
| Campo | Tipo | Requerido | Descripcion |
|-------|------|-----------|-------------|
| `instanceId` | string | si | ID del NFT |
| `borrower` | string | si | Cuenta del prestatario |

**Validaciones del indexer**:
- `borrower != op.signer`
- NFT debe existir, `nft.owner === op.signer`
- Status debe ser `active` (no listed, burned, o ya lent)
- Coleccion debe ser `transferable` (NFTs no-transferibles no se pueden prestar)
- No debe existir prestamo activo para este NFT

**Cambios de estado**: Status -> `lent`, inserta fila en `nft_loans`, elimina `nft_allowances`.
**Restricciones**: Self-lend, NFT no transferible/quemado/listado/ya prestado -> rechazado.

---

### 23. `nft_return`

**Constante SDK**: `ACTION_NFT_RETURN`
**Descripcion**: Devuelve un NFT prestado. Tanto el lender como el borrower pueden ejecutar esta accion.
**Key authority**: posting -- lender o borrower firma.
**Signer role**: Debe ser el lender o el borrower del prestamo activo.

**Payload del SDK**:
| Campo | Tipo | Requerido | Descripcion |
|-------|------|-----------|-------------|
| `instanceId` | string | si | ID del NFT |

**Validaciones del indexer**:
- NFT debe existir, status debe ser `lent`
- Prestamo debe existir en `nft_loans`
- `op.signer === loan.lender || op.signer === loan.borrower`

**Cambios de estado**: Status -> `active`, elimina fila de `nft_loans`.
**Restricciones**: NFT no prestado, signer no es lender ni borrower -> rechazado.

---

## Data Operators (2 operaciones)

### 24. `data_operator_approve`

**Constante SDK**: `ACTION_DATA_OPERATOR_APPROVE`
**Descripcion**: El creator de una coleccion autoriza a un operador externo para modificar datos mutables de NFTs en esa coleccion.
**Key authority**: posting -- el creator firma.
**Signer role**: Debe ser el creator de la coleccion.

**Payload del SDK**:
| Campo | Tipo | Requerido | Descripcion |
|-------|------|-----------|-------------|
| `collectionId` | string | si | ID de la coleccion |
| `operator` | string | si | Cuenta del operador |
| `approved` | boolean | si | true = aprobar, false = revocar |

**Validaciones del indexer**:
- `operator != op.signer`
- Coleccion debe existir
- `collection.creator === op.signer`

**Cambios de estado**: Upsert/delete en `data_operators`.
**Restricciones**: Self-approval, coleccion inexistente, signer no es creator -> rechazado.

---

### 25. `set_data_from`

**Constante SDK**: `ACTION_SET_DATA_FROM`
**Descripcion**: Un operador aprobado modifica los datos mutables (`mutable_data`) de un NFT. Funciona igual que `set_data` pero firmado por un operador autorizado en lugar del creator. Requiere que la coleccion tenga schema definido.
**Key authority**: posting -- el operador firma.
**Signer role**: Debe estar aprobado como data operator para la coleccion del NFT.

**Payload del SDK**:
| Campo | Tipo | Requerido | Descripcion |
|-------|------|-----------|-------------|
| `nftId` | string | si | ID del NFT |
| `instanceDna` | string | si | DNA de la instancia (debe coincidir) |
| `mutableData` | object | si | Datos mutables a actualizar |

**Nota**: La coleccion DEBE tener un schema definido. No existe fallback legacy. Los datos enviados se validan contra los campos mutables del schema y se fusionan (merge) con los datos mutables existentes.

**Validaciones del indexer**:
- NFT debe existir y no estar `burned`
- `instanceDna` debe coincidir
- `hasDataOperatorApproval(signer, collectionId)` debe ser true
- La coleccion debe tener schema
- `mutableData` se valida contra el schema (campos y tipos)

**Cambios de estado**: Actualiza `mutable_data`, `mutable_data_hash`, `mutable_data_tx`, `mutable_data_block` en `nfts`.
**Restricciones**: NFT quemado, DNA no coincide, sin aprobacion de operador, coleccion sin schema, validacion de schema fallida -> rechazado.

---

## Notas de arquitectura

### Key Authority
El indexer extrae el signer de `required_auths[0] ?? required_posting_auths[0]`. No valida el tipo de key directamente -- la validacion de key la hace la blockchain de Hive al aceptar la transaccion. El SDK marca la autoridad correcta al construir el `custom_json`.

### Idempotencia
Las operaciones `bulk_distribute` y `pack_open` son idempotentes: si se re-envia la misma transaccion (mismo `txId`), detectan las instancias ya creadas y ajustan contadores para no duplicar NFTs.

### IDs deterministicos
Collections, seeds y packs usan IDs deterministicos generados por el SDK (hash de campos unicos). Esto previene la creacion de duplicados incluso si la misma transaccion se procesa multiples veces.

### Payment Splits (Marketplace)
La funcion `calculatePaymentSplit()` del SDK se reutiliza en el indexer para verificar pagos. El split es:
- **Seller**: precio - royalty - fee
- **Royalty**: `totalPrice x royaltyPct / 100` (si royaltyRecipient != seller)
- **Fee**: `totalPrice x 2.5%` (si feeAccount != seller)

Si royaltyRecipient o feeAccount coinciden con el seller, esos montos se fusionan en el pago al seller.

### Multisig (Buy)
La operacion `buy` es la unica que requiere active key porque el nodo co-firma. El buyer envia transfers HIVE/HBD y el nodo valida y co-firma el `custom_json`. Si el nodo rechaza, los fondos nunca salen de la cuenta del buyer.

### Sistema de datos (v0.3.0)
El protocolo maneja tres capas de datos por NFT:

- **`immutable_data`**: Datos inmutables definidos en el mint. No se pueden modificar despues de la creacion. Solo el creator los establece. Se validan contra los campos `immutable` del schema.
- **`mutable_data`**: Datos mutables controlados por el creator de la coleccion (via `set_data`) o por operadores autorizados (via `set_data_from`). Requiere schema definido en la coleccion. Se validan contra los campos `mutable` del schema. Incluyen trazabilidad on-chain (`mutable_data_hash`, `mutable_data_tx`, `mutable_data_block`).
- **`owner_data`**: Datos escritos por el owner del NFT (via `set_owner_data`). No requiere schema. Incluyen trazabilidad on-chain (`owner_data_hash`, `owner_data_tx`, `owner_data_block`).

### Schema y validacion
Las colecciones pueden definir un schema tipado con campos inmutables y mutables. Las operaciones `set_data` y `set_data_from` requieren obligatoriamente que la coleccion tenga schema. El schema se puede extender con `extend_schema` (agregar campos nuevos) pero no se pueden eliminar ni modificar campos existentes.
