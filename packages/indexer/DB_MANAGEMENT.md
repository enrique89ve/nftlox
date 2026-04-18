# Database Management Scripts

Scripts para instalar, desinstalar y reiniciar el schema de la BD en testnet.

## Requisitos

- PostgreSQL 16+ corriendo y accesible
- `psql` CLI instalado
- Bun 1.1+
- Variable de ambiente `DATABASE_URL` configurada, o `.env` con `DATABASE_URL`

## Scripts

### `./scripts/install_schema.sh`

Aplica schema baseline + todas las migraciones pendientes.

**Uso:**
```bash
./scripts/install_schema.sh
```

**Qué hace:**
1. Lee `schema.sql` y aplica el baseline (crea `schema_migrations` table)
2. Ejecuta `run-migrations.ts` que aplica todos los `.sql` del directorio `migrations/`
3. Registra cada migración en `schema_migrations` con checksum SHA-256

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
3. Default: `postgresql://postgres:postgres@localhost:5432/nftlox`

**Ejemplo con Docker Postgres:**
```bash
export DATABASE_URL="postgresql://postgres:postgres@localhost:5432/nftlox"
./scripts/install_schema.sh
```

---

## Flujo típico

**Primer boot:**
```bash
./scripts/install_schema.sh
# Carga baseline + 0001_init.sql
```

**Desarrollo: agregar columna**
```bash
# Crea src/db/migrations/0002_add_foo.sql con ALTER TABLE
./scripts/install_schema.sh
# Aplica 0002 automáticamente
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
├── schema.sql                  # Baseline (baseline + schema_migrations table)
├── migrations/
│   ├── 0001_init.sql          # Baseline DDL
│   ├── 0002_add_foo.sql       # Futuras migraciones
│   └── ...
└── migration-runner.ts         # Lee migrations/, aplica en orden
```

**`schema_migrations` table:**
```sql
CREATE TABLE schema_migrations (
    version TEXT PRIMARY KEY,           -- e.g. "0001_init"
    applied_at TIMESTAMPTZ NOT NULL,    -- Cuándo se aplicó
    checksum TEXT NOT NULL              -- SHA-256 del SQL
);
```

---

## Troubleshooting

**"Connection refused"**
- PostgreSQL no está corriendo
- DATABASE_URL apunta al host/puerto incorrecto

**"psql: FATAL password authentication failed"**
- Credenciales en DATABASE_URL incorrectas
- Usuario no tiene permisos en la BD

**"migration failed: ENOENT migrations directory"**
- Asegúrate de estar en `/packages/indexer`
- El directorio `src/db/migrations/` debe existir

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
