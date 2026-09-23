# VPS de desarrollo — acceso y emergencias

Desde 2026-09-22 hay **dos VPS de Vultr, separados a propósito**: uno es producción y ya no se usa
para nada de desarrollo; el otro es solo para desarrollo (incluida la base compartida de los dos
devs). Ver `[[project-vps-desarrollo]]` en memoria para el porqué de la decisión.

| | Producción | Desarrollo |
|---|---|---|
| Nombre en Vultr | `escalapp-prod` | `escalapp-dev` |
| IP | `45.63.105.95` | `45.77.161.164` |
| Ubicación | Miami (AMER) | Miami (AMER) |
| OS | Ubuntu 24.04 LTS | Ubuntu 24.04 LTS |
| Usuario SSH | `escalapp` (root deshabilitado) | `escalapp` (root deshabilitado) |
| Autenticación | Solo llave ed25519, sin contraseña | Solo llave ed25519, sin contraseña |
| PostgreSQL | 17, solo `localhost:5432` | 17, solo `localhost:5432` |
| Qué corre ahí | API (`escalapp-api`, puerto 3000), Caddy, frontends, BD `escalapp` (real) | Nada de app — solo Postgres con las BD de desarrollo |
| Firewall | (ver Caddyfile / systemd) | `ufw`: solo puerto 22 abierto |

## Entrar por SSH

```bash
ssh escalapp@45.63.105.95   # producción
ssh escalapp@45.77.161.164  # desarrollo
```

Requiere la llave privada `~/.ssh/id_ed25519` de este PC (o la del otro dev, una vez añadida — ver
abajo). `sudo` no pide contraseña para el usuario `escalapp` en ninguno de los dos VPS.

## Bases de datos en el VPS de desarrollo

Un único cluster de PostgreSQL 17 con dos bases aisladas (cada rol tiene `CONNECT` solo a la suya,
`PUBLIC` revocado — mismo patrón que ya existía en producción para `escalapp` / `escalapp_dev`):

| Base | Rol dueño | Contraseña | Para qué |
|---|---|---|---|
| `escalapp_dev` | `escalapp_dev` | `/home/escalapp/.dbpass_escalapp_dev` (chmod 600) | La base compartida de los 2 devs — **migrada aquí el 2026-09-22 desde el VPS de producción**, ya no vive allá |
| `jdd_dev` | `jdd_dev` | `/home/escalapp/.dbpass_jdd_dev` (chmod 600) | Desarrollo local de `sst_ws` (repo JDD Consultores/Orbita) — migrado aquí desde Neon el 2026-09-22 (esquema `sst`, 37 tablas, seed cargado). También la base para el futuro adaptador de facturación electrónica de EscalApp hacia JDD (ver `facturacion-electronica.md`). No tiene ni tendrá datos reales de Orbita, que vive en su propio VPS (`45.77.118.62`) |

Para conectarse desde el `.env` local vía túnel, igual que se hacía antes con el 5433 del VPS de
producción:

```bash
ssh -N -L 5433:localhost:5432 escalapp@45.77.161.164
# .env:  DB_HOST=localhost  DB_PORT=5433  DB_NAME=escalapp_dev  DB_USER=escalapp_dev  DB_SSL=false
```

**Ya NO usar el túnel al `45.63.105.95` para desarrollo.** Ese VPS solo debe tocarse para lo que ya
documenta el `CLAUDE.md` raíz bajo "Infraestructura" (desplegar, backups, revisar logs).

## Acceso de emergencia (si SSH no responde)

1. Panel de Vultr → `Compute` → la instancia (`escalapp-prod` o `escalapp-dev`) → pestaña
   **Overview**, botón junto a "Username/Password" → da acceso por consola web (noVNC) con
   usuario `root` y una contraseña que genera Vultr ahí mismo.
2. Esa consola entra como si estuvieras frente al teclado del servidor — sirve aunque `sshd` esté
   caído o el firewall bloquee todo. **OJO**: como aquí `PermitRootLogin no` y
   `PasswordAuthentication no` están activos, esa contraseña de root **solo sirve dentro de la
   consola web**, no por SSH normal desde afuera.
3. Si hace falta recuperar SSH: desde la consola web, añadir la llave pública que haga falta a
   `~/.ssh/authorized_keys` del usuario correspondiente (ver el bloque de comandos usado el
   2026-09-22 al aprovisionar `escalapp-dev`, abajo).

**Nunca dejar `PasswordAuthentication yes` activo más tiempo del necesario para arreglar algo.**

## Añadir la llave del segundo dev

Desde una sesión que ya tenga acceso:

```bash
ssh escalapp@<ip> "echo '<clave pública ssh-ed25519 ...>' >> ~/.ssh/authorized_keys"
```

O, si esa llave está subida a GitHub, usar el mismo método que se usó para dar acceso al VPS de
producción: `sudo -u escalapp ssh-import-id-gh <usuario-github>` (importa, deduplica y deja dueño y
permisos correctos).

## ⚠️ Pendiente de revisar

`escalapp-dev` llegó con una llave ya presente en `authorized_keys` con el comentario
`escalapp-vps` (no es la llave de este PC ni la de GitHub) — probablemente generada por Vultr al
crear la instancia. Nadie tiene identificada su privada. No se retiró todavía por si es necesaria
para algo del propio Vultr; **decidir si se retira** (`sed -i '/escalapp-vps/d' ~/.ssh/authorized_keys`
en cada usuario que la tenga) la próxima vez que se entre a este VPS.
