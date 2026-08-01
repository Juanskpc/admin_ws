# Entorno de desarrollo local

Cómo levantar una base de datos local para trabajar sin tocar producción.

> **Por qué existe este documento.** Hasta 2026-07-31 el `.env` de desarrollo apuntaba
> directamente a la RDS de producción con el usuario `postgres`. Es decir: cualquier
> `npm run dev`, cualquier migración lanzada por error y cualquier test escribían en
> producción. El trabajo de EscalApp Intelligence (F0 en adelante) crea esquemas y tablas
> nuevas, así que trabajar contra local dejó de ser opcional.

## Requisitos

- PostgreSQL 17 o superior instalado localmente (producción corre 17.9).
- Node 22.

## 1. Crear rol y base

Con `psql` como superusuario (`postgres`):

```sql
CREATE ROLE escalapp_dev LOGIN PASSWORD '<tu-password-local>' CREATEDB;
CREATE DATABASE escalapp_dev OWNER escalapp_dev ENCODING 'UTF8';
ALTER DATABASE escalapp_dev SET timezone TO 'America/Bogota';
```

Y dentro de `escalapp_dev`, como superusuario (la extensión lo requiere):

```sql
CREATE EXTENSION IF NOT EXISTS pgcrypto;
```

## 2. Cargar el esquema

**No construyas el esquema corriendo las migraciones.** El repo tiene más archivos en
`migrations/` que scripts `migrate:*` registrados en `package.json`, así que el resultado
diverge de producción. Usa un volcado de estructura:

```bash
# Solo estructura: no baja ni una fila, por lo tanto no baja PII.
pg_dump --schema-only --no-owner --no-privileges \
        -h <host-produccion> -U postgres -d postgres -f prod_schema.sql

psql -U escalapp_dev -h localhost -d escalapp_dev -v ON_ERROR_STOP=1 -f prod_schema.sql
```

Resultado esperado: 7 esquemas (`general`, `restaurante`, `parqueadero`, `gym`, `tienda`,
`reserva`, `auditoria`) y 72 tablas.

> **No hagas un dump con datos.** Bajaría PII de clientes reales a una máquina de
> desarrollo, con las implicaciones de la Ley 1581 que recoge
> [ADR-024](adr/ADR-024-persistencia.md). Si necesitas medir algo sobre datos reales,
> lanza una consulta agregada de solo lectura contra producción y baja el resultado, no
> las filas.

### Diferencias esperadas contra producción

Si comparas catálogos entre local (PG18) y producción (PG17), estas dos diferencias son
normales y no indican deriva:

- **`pg_constraint` trae ~428 filas de más, de tipo `n`.** PostgreSQL 18 cataloga los
  `NOT NULL` como constraints; PG17 no. Los tipos reales (`c`, `f`, `p`, `u`) sí deben
  coincidir exactamente.
- **Sobra la función `public.fips_mode`.** La aporta la versión de `pgcrypto` que trae PG18.

## 3. Configurar el `.env`

```ini
DB_HOST=localhost
DB_PORT=5432
DB_NAME=escalapp_dev
DB_USER=escalapp_dev
DB_PASS=<tu-password-local>
DB_SSL=false
```

`.gitignore` cubre `.env` y todas sus variantes (`.env.*`), salvo `.env.example`. Si
guardas las credenciales de producción en un `.env.produccion.bak`, queda ignorado.

## 4. Sembrar datos mínimos

```bash
npm run migrate                  # catálogos: 7 tipos de negocio + 29 roles
node scripts/seed_dev_local.js   # planes, negocio demo, usuarios y roles
```

`seed_dev_local.js` es idempotente y **aborta si `DB_HOST` no es local**, así que no puede
ejecutarse contra producción por accidente.

Credenciales que deja listas (el login es por **número de identificación**, no por email):

| Usuario | Identificación | Password | Alcance |
|---|---|---|---|
| Super admin | `1000000001` | `Admin123*` | Rol global SUPER ADMINISTRADOR |
| Admin de negocio | `1000000002` | `Admin123*` | ADMINISTRADOR de "Restaurante Demo" |

Dos migraciones **no** sirven para sembrar sobre una base vacía, y por eso el seed existe:

- `migrate:admin-principal` no crea ningún usuario; solo añade una columna y marca a un
  administrador que ya exista.
- `migrate:planes-base` inserta en `gener_negocio_plan` con `id_negocio = 6` hardcodeado,
  que en local no existe: viola la FK y hace rollback.

## 5. Verificar

```bash
npm run dev

curl -X POST http://localhost:3000/admin/auth/login \
     -H "Content-Type: application/json" \
     -d '{"num_identificacion":"1000000001","password":"Admin123*"}'
```

Debe responder `success: true` con un token y `roles_globales` conteniendo
`SUPER ADMINISTRADOR`.

## Nota sobre el modelo de acceso

Vincular un usuario a un negocio requiere **dos** filas, en tablas distintas:

- `general.gener_negocio_usuario` — la **membresía**. De aquí sale la lista de negocios que
  devuelve el login (`LoginDao.getUsuarioLogin`).
- `general.gener_usuario_rol` — el **rol** que ejerce dentro de ese negocio.

Si solo insertas el rol, el usuario inicia sesión correctamente pero ve la lista de
negocios vacía.
