# Sesión 2026-10-14 — Estándares visuales, una sola rama, seguridad en producción y cobro automático

Punto de entrada para retomar. Todo lo de abajo está **en producción** salvo donde se dice otra
cosa. Cada apartado dice cómo deshacerlo.

## 0. Qué hay que mirar mañana (2026-10-15)

| Cuándo | Qué | Dónde | Qué debe decir |
|---|---|---|---|
| Después de las 03:30 | Primera copia nocturna subida a Cloudflare R2 | `tail -3 /home/escalapp/backup.log` | «copia externa enviada (Cloudflare R2)» |
| Después de las 08:15 | Primera corrida del cobro automático | `sudo journalctl -u escalapp-api --since "08:10" \| grep Cobranza` | «Nada por cobrar hoy» (nadie ha registrado tarjeta todavía) |
| Al día | Rechazos por el bloqueo entre negocios | `sudo journalctl -u escalapp-api --since today \| grep BLOQUEADO` | nada; si aparece algo, ver §3.1 |
| Al día | UptimeRobot | correo de escalappsystem@gmail.com | sin avisos de caída |

## 1. Estándares visuales de `restaurante_app` (desplegado)

- **Margen de página:** lo pone solo `.content` del layout; ninguna pantalla añade relleno ni ancho
  máximo propio. Antes Promociones, Caja y Personal lo tenían y las pestañas hermanas saltaban al
  cambiar (commit `ae6a057`).
- **Pestañas y filtros:** `src/styles/_pestanas.scss`. Raya debajo (`.ui-pestanas`) = cambiar de
  sección; botoncitos (`.ui-filtros`) = filtrar la misma lista (commit `63319ee`).
- **Tipografía:** h1 24/700, título de tarjeta 16/700, subtítulo 14, botón 14/600, etiqueta 12/600,
  campo 14/400; mayúscula solo en la primera palabra (commit `6f84dcb`).
- Detalle de las reglas en el `CLAUDE.md` del workspace (sección Angular patterns).

## 1-bis. El mismo estándar en `admin_app-v21` (desplegado 22:49)

Auditoría de las 18 pantallas de la consola y estándar aplicado: ancho completo en todas, `h1`
24/700 (Configuración estrena el suyo; «Tipos de negocio» en vez de «Registrar — Tipos…»),
títulos de tarjeta 16/700, botones y campos 14, etiquetas 12/600, pestañas y filtros con el
mismo `_pestanas.scss` que el restaurante (adiós a las flechas en las pestañas de Terceros y
Cartera), tarjetas de cifras de Cobranza e Intelligence alineadas, y **Cobranza dice «Vencido» /
«Por pagar» cuando hay deuda** (antes «Al día» a La Esquina del Barril con ~50 días de deuda).
Celular a 390 px: las 17 pantallas sin desborde lateral (las causas, en el `CLAUDE.md`).
Commits `4e5f98a`, `39685d5`. Respaldo: `admin_front_antes_estandar_20261014_2249.tgz`.
**Pendiente:** mirar en producción, con sesión, el chip «Vencido» de La Esquina del Barril.
`restaurante_app` recibió el mismo ajuste del estándar (`3b60f54`) en GitHub, **sin desplegar**:
trae encima la carta con sedes de Juan David, que él aún no ha publicado.

## 2. Una sola rama: `master` en los 7 repos

`main` se borró de `restaurante_app`, `admin_app-v21`, `reserva_app`, `gym_app`,
`parqueadero_app` y `tienda_app` (antes se comprobó que apuntaba al mismo commit que `master`), y
`master` es la rama principal en GitHub en todos. Reglas y cómo pasar un clon viejo:
[`estandar-ramas.md`](estandar-ramas.md). **Juan David tiene que pasar su clon a `master` una vez.**

## 3. Seguridad en producción

Detalle completo en [`auditoria-2026-10-04-pendientes.md`](auditoria-2026-10-04-pendientes.md)
§«Avance — tercera tanda».

### 3.1 Bloqueo entre negocios — `AUTHZ_MODO=bloqueo` (15:19)

Un usuario ya no puede pedir datos de un negocio al que no pertenece (403). Antes de activarlo:
cero eventos `authz` en `auditoria.audit_evento` desde el 2026-09-30. Super admin e impersonación
siguen pasando. **Deshacer:** `AUTHZ_MODO=observacion` en `/var/www/admin_ws/.env` + reinicio.
Respaldo del `.env`: `/home/escalapp/backups/env_antes_authz_*`.

### 3.2 Límite de peticiones — ya estaba encendido

Nace encendido desde la tanda de seguridad (que falte `RATE_LIMIT_ENABLED` en el `.env` NO lo
apaga). 0 respuestas 429 en 7 días.

### 3.3 Cabeceras de seguridad en Caddy

Snippet `(seguridad)` en `/etc/caddy/Caddyfile`, importado en los tres sitios: HSTS, nosniff,
Referrer-Policy, Permissions-Policy (sin cámara/micrófono/ubicación), sin cabecera `Server`.
`X-Frame-Options: SAMEORIGIN` **solo en `/admin/*`** — la carta del restaurante podría estar
incrustada en la web de un cliente. **Deshacer:** copiar
`/home/escalapp/backups/Caddyfile_antes_cabeceras_*` encima y `sudo systemctl reload caddy`
(validar antes con `sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile`).

### 3.4 Monitor externo — UptimeRobot

Cuenta escalappsystem@gmail.com. Vigila `https://api.escalapp.cloud/health` (toca la base) y
`https://escalapp.cloud/restaurante/` cada 5 min y avisa por correo.

### 3.5 Respaldos: restauración probada y copia fuera del servidor

- Primera restauración de la historia: el dump de las 03:30 en una base temporal, 7 s, 0 errores,
  147/147 tablas. `postgres` no lee los `.dump` (dueño `escalapp`): pasárselos por stdin.
- **Cloudflare R2** (cuenta escalappsystem@gmail.com, con la tarjeta del dueño; gratis hasta
  10 GB): bucket privado `escalapp-backups`, borra a los 30 días. La clave solo sirve para ese
  bucket y solo desde `45.63.105.95`. `rclone` en el VPS con el remoto `backups`
  (`~/.config/rclone/rclone.conf`, con `no_head = true` — sin eso rclone 1.60 da 501 en R2 aunque
  el archivo suba). `backup.sh` sube solo `db_*.dump` y `uploads_*.tar.gz`.

## 4. Cobro automático OPCIONAL (en producción desde las 16:49)

Diseño, trampas del sandbox y pruebas en
[`cobro-mensualidades.md`](cobro-mensualidades.md) §«Pago automático OPCIONAL».

**Qué quedó vivo:**

- `admin_ws` `0aeebc0`: servicio, rutas `/admin/cobranza/pago-automatico`, cron con conciliación
  previa (sin cobro doble), rechazos que cuentan una vez, correos.
- Migración `cobranza-pago-automatico` aplicada y **registrada** (`node scripts/migrar.js`) en
  producción y en la base compartida. En producción limpió la fecha de cobro automático que tenían
  sin tarjeta **Zona Burger (6) y El Callejero (13)**; en la compartida, los negocios 4, 63 y 17.
- `admin_app-v21` `810009c`: tarjeta «Pago automático» en «Mis pagos» → «Pagar mi plan».
- **`COBRANZA_AUTO_ENABLED=true`** en el `.env` del VPS: el cron corre a las 08:15 Bogotá.
  Al encenderlo: 0 suscripciones por cobrar y 0 tarjetas activas. **Solo cobra a quien registró
  su tarjeta o Nequi**; hoy nadie.

**Respaldos de este despliegue** (en `/home/escalapp/backups/`):
`db_predeploy_pago_automatico_20261014_1647.dump`, `env_antes_pago_automatico_20261014_1647`,
`admin_front_antes_pago_automatico_20261014_1649.tgz`.

**Deshacer, de menos a más:**

1. Parar los cobros sin tocar nada más: `COBRANZA_AUTO_ENABLED=false` + reinicio.
2. Consola anterior: descomprimir `admin_front_antes_pago_automatico_*.tgz` en
   `/var/www/html/admin` (sin renombrar `index.csr.html`) y `chown -R caddy:caddy`.
3. Backend anterior: `git checkout 8c520a5` en `/var/www/admin_ws` + reinicio. La migración no
   estorba al código viejo (solo añade columnas).

**Probado antes de desplegar** (sandbox de Wompi, consola real en local): activar con 4242,
cobro PENDING → aprobado una sola vez, rechazo con 4111 → «Reintentando» + correo + reintento a
3 días, cambiar tarjeta, desactivar. Revisión visual: alineación, contraste AA en todos los
estados y celular a 390 px. 218 pruebas de backend en verde.

**Lo que NO se ha visto todavía:** un cobro real con dinero real. El primero será cuando un
cliente active el pago automático; conviene mirar ese día la transacción en el panel de Wompi y
`cobranza.cob_transaccion`.

## 5. Pendientes

1. **Juan David:** pasar sus clones a `master` (`estandar-ramas.md`).
2. **Avisar a los clientes** de que existe el pago automático (Zona Burger, El Callejero, ICONIC,
   La Esquina del Barril, D'Alex solo con enlace: es Chile).
3. **Negocios sin confirmar** si son clientes o pruebas: 2 Parkin CR, 7 Mi Gimnasio, 8 Tienda Demo
   (factura pendiente desde septiembre), 14 La Esquina del Barril (plan vencido el 2026-08-24).
   Los de prueba confirmados son 10 y 12.
4. Seguridad que queda de la auditoría: forzar cambio de contraseña a las cuentas con la cédula y
   sacar el correo transaccional de la cuenta personal de Gmail.
5. Mejoras menores del pago automático: la factura pendiente de un cliente con débito activo
   todavía enseña el botón «Pagar» (pagar a mano no cobra doble, pero sobra); la marca de la
   tarjeta llega vacía de Wompi («Tarjeta ···4242»).
6. Auditar `admin_app` y `reserva_app` con los mismos estándares visuales de `restaurante_app`.
