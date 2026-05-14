# Database Management Scripts

Scripts para instalar, desinstalar y reiniciar el schema de la BD en testnet.

## Requisitos

- PostgreSQL 16+ corriendo y accesible
- `psql` CLI instalado
- Bun 1.1+
- Variable de ambiente `DATABASE_URL` configurada, o `.env` con `DATABASE_URL`

## Scripts

### `./scripts/install_schema.sh`

Aplica el baseline completo desde `src/db/schema.sql`.

**Uso:**
```bash
./scripts/install_schema.sh
```

**Qué hace:**
1. Lee `src/db/schema.sql`
2. Crea tablas, índices, triggers y filas singleton
3. Puede ejecutarse más de una vez porque el baseline usa DDL idempotente donde hace falta

**Cuándo usar:**
- Primer boot (BD vacía)
- Después de `uninstall_schema.sh`
- Después de limpiar la BD manualmente

---

### `./scripts/uninstall_schema.sh`

Borra completamente el schema (DROP CASCADE).

**Uso:**
```bash
./scripts/uninstall_schema.sh
```

**Qué hace:**
1. Pide confirmación (escribe "yes")
2. `DROP SCHEMA IF EXISTS public CASCADE;`
3. `CREATE SCHEMA public;` (schema vacío)

**Cuándo usar:**
- Reset total de testnet
- Antes de un cambio de genesis
- Cuando hay corrupción de datos

---

### `./scripts/reset_db.sh`

Uninstall + install en un comando.

**Uso:**
```bash
./scripts/reset_db.sh
```

**Qué hace:**
1. Ejecuta `uninstall_schema.sh` (pide "yes")
2. Ejecuta `install_schema.sh`

**Cuándo usar:**
- Reset rápido en testnet
- Before rebasing desde genesis

---

## Configuración

### DATABASE_URL

Los scripts leen `DATABASE_URL` en este orden:

1. Variable de ambiente: `export DATABASE_URL=postgresql://user:pass@host:port/db`
2. Archivo `.env` en la raíz del indexer:
   ```bash
   DATABASE_URL=postgresql://user:pass@host:port/db
   ```
3. Default local: `postgres://nftlox:nftlox_dev@localhost:5432/nftlox_indexer`

**Ejemplo con Docker Postgres:**
```bash
export DATABASE_URL="postgres://nftlox:nftlox_dev@localhost:5432/nftlox_indexer"
./scripts/install_schema.sh
```

---

## Flujo típico

**Primer boot:**
```bash
./scripts/install_schema.sh
# Carga schema.sql
```

**Desarrollo antes de testnet: cambiar el schema**
```bash
# Edita src/db/schema.sql directamente
./scripts/install_schema.sh
```

**Reset testnet:**
```bash
./scripts/reset_db.sh
# Borra todo, reinicia limpio
```

---

## Estructura interna

```
src/db/
├── schema.sql                  # Baseline completo
├── migration-runner.ts         # Aplica schema.sql
└── queries/                    # Queries tipadas usadas por handlers/API
```

Mientras no haya despliegue público, los cambios de DB se pliegan al baseline.
Después de desplegar testnet/mainnet, los cambios incompatibles deberán ir en
migraciones explícitas para preservar datos.

---

## Troubleshooting

**"Connection refused"**
- PostgreSQL no está corriendo
- DATABASE_URL apunta al host/puerto incorrecto

**"psql: FATAL password authentication failed"**
- Credenciales en DATABASE_URL incorrectas
- Usuario no tiene permisos en la BD

**"Schema already exists" error**
- OK, los scripts usan `IF NOT EXISTS` y son idempotentes
- `install_schema.sh` puede ejecutarse múltiples veces

---

## Seguridad

⚠️ **`uninstall_schema.sh` es destructivo:**
- Pide confirmación explícita ("yes")
- No tiene --force flag
- Usa `DROP CASCADE` (borra todo relacionado)

Nunca hagas `reset_db.sh` en production. Solo testnet.
