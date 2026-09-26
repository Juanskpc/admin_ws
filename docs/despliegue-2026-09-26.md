# Despliegue 2026-09-26 — cobro duplicado, multipago, iconos de producto y perfiles de reserva

> **Estado: DESPLEGADO PARCIALMENTE (2026-09-26, 12:05–12:07).** Entró lo de **restaurante** y el
> admin. **Los perfiles de reserva (§1.5), `reserva_app` y sus endpoints NO se desplegaron: decisión
> del dueño.** Lo que pasó de verdad está en la §7. Este documento se escribió antes de desplegar y
> planeaba subir reserva; las §3 y §5 describen ese plan completo, que sigue vigente para cuando se
> decida subirla (ver §7.3).

## 1. Qué entra

### 1.1 Cobro duplicado en caja (auditoría de El Callejero, ORD-0555)

**Síntoma.** El cierre de caja de El Callejero (negocio 13) salía con $39.000 de más en
«Transferencia». El comprobante mostraba el pedido `ORD-0555` **dos veces** en Caja.

**No era un pedido repetido: era un solo pedido con dos INGRESO.** Reconstruido desde
`auditoria.audit_dato` (caja 182):

| Hora     | Actor real            | Qué pasó                                                    |
|----------|-----------------------|-------------------------------------------------------------|
| 20:17:06 | Dayana Benavides (19) | toma el pedido, $39.000                                     |
| 20:36:32 | Nayive Santa Cruz (30)| Cobrar → INGRESO 8352 + `estado_pago='pagado'`              |
| 20:36:34 | Nayive (30)           | la orden pasa a CERRADA                                     |
| 20:39:44 | Dayana (19)           | vuelve a pulsar Cobrar → **INGRESO 8354, duplicado**        |

A las 20:39 no hay ningún `UPDATE` sobre el pedido: ya estaba pagado y cerrado, solo se creó dinero.

**Causa raíz (dos fallos que se suman):**

1. `pedidoService.marcarPagado` **no era idempotente**. Bloqueaba la fila con `LOCK.UPDATE` pero no
   comprobaba `estado_pago`, `id_caja` ni `estado`: cobrar un pedido ya cobrado, cerrado o incluso
   cancelado anotaba otro INGRESO. `cerrarOrden` sí se protegía; este era el único agujero.
2. El modal de Despacho guardaba una **copia** del pedido (`pedidoActivo`) que el refresco en vivo no
   actualizaba. La segunda pantalla siguió pintando «Cobrar» tres minutos después del cobro real.

Además el movimiento heredaba `orden.id_usuario` (quien *tomó* el pedido) y no quien *cobra*: por eso
ambas filas decían «Dayana» aunque el primer cobro lo hizo Nayive.

**Arreglo.**
- Backend: `marcarPagado` rechaza con **409** `ORDEN_YA_COBRADA` (si `id_caja` o `estado_pago='pagado'`)
  y `ORDEN_ANULADA` (CANCELADA/ANULADA). `cerrarOrden` también rechaza anuladas. La comprobación va
  contra la fila ya bloqueada, así que cubre dos peticiones simultáneas. El INGRESO lo firma quien
  cobra (`idUsuario || orden.id_usuario`). El controller reenvía los códigos como 409.
- Frontend (`despacho.ts`): `sincronizarPedidoActivo()` en cada refresco; el 409 se traduce en recargar
  la lista + aviso claro.

**Alcance histórico (NO se corrigió, decisión del dueño).** Había 14 pedidos con más de un INGRESO
activo en producción, todos salvo el de hoy en cajas ya CERRADAS:

- Negocio 6: ORD-0063, 0700, 1408, 3095, 3105, 3118, 3120, 4212, 5050.
- Negocio 13: ORD-0281, 0283, 0415, 0453 y **0555** (caja 182, abierta).

Corregir turnos cerrados descuadraría arqueos ya reportados. Consulta para volver a medirlo:

```sql
SELECT o.id_negocio, m.id_orden, o.numero_orden, count(*) AS ingresos, sum(m.monto) AS suma
FROM restaurante.rest_movimiento_caja m
JOIN restaurante.pedid_orden o ON o.id_orden = m.id_orden
WHERE m.tipo='INGRESO' AND m.id_movimiento_anula IS NULL
GROUP BY 1,2,3 HAVING count(*) > 1 ORDER BY 1, max(m.fecha) DESC;
```

Tras el despliegue esta consulta **no debe crecer**. Si se corrige el ORD-0555 (caja abierta), la vía
limpia es un EGRESO compensatorio con `id_movimiento_anula = 8354`; **no** la papelera de Caja, que
anula la orden entera y deja la venta real fuera del turno.

### 1.2 Multipago con dos formas de pago (ORD-0655)

**Síntoma.** «No pueden editar los montos de Efectivo y Transferencia». El ORD-0655 (id 8200, $19.000 =
$15.000 Efectivo + $4.000 Transferencia) acabó **CANCELADA** 19 minutos después.

**Causa.** `metodosDisponibles()` escondía de cada desplegable las formas ya usadas en las otras filas.
El Callejero tiene solo dos formas activas («Cuenta / Tiquetera» está inactiva), así que con Efectivo
arriba y Transferencia abajo cada desplegable solo se ofrecía a sí mismo: sin salida. No era un campo
deshabilitado ni CSS (comprobado contra el bundle desplegado).

**Arreglo** (`multipago-selector`):
- El desplegable ofrece **todas** las formas; elegir una que está en otra fila las **intercambia**. Se
  mantiene la regla de no repetir forma sin el callejón sin salida. El reparto del dinero no se mueve.
- Con **exactamente dos** formas de pago, al elegir «Multipago» ya vienen sembradas en las dos filas
  (la primera con el total). Si una de las dos es una cuenta de cliente **no** se siembra: abriría de
  entrada «¿de quién es la cuenta?» con el cobro inválido.

### 1.3 Interruptor «iconos de producto en Pedidos»

Configuración → Operación → *Utilizar iconos en la sección Pedidos para listar productos*.
Columna `general.gener_negocio.muestra_iconos_productos BOOLEAN NOT NULL DEFAULT true`.

- **Nace ENCENDIDA** (opt-OUT, como `controla_inventario`): los iconos son lo que todos ven hoy, así
  que un default en `false` cambiaría la pantalla de venta a todo el mundo. En la sesión, `undefined`
  también se lee como encendido, para que quien entró antes del despliegue no vea nada distinto.
- Afecta a los **productos** (rejilla, líneas del pedido pagadas y por cobrar, título de personalizar).
  Los iconos de las **categorías** se quedan.
- Migración: `npm run migrate:restaurante-iconos-productos`. Ruta de 5 puntos completa (modelo,
  `dashboardService`, `configuracionService`, controller + validador, frontend).

### 1.4 Permiso: DOMICILIARIO solo ve lo suyo en Despacho

`npm run migrate:restaurante-domiciliario-solo-suyos` (ya en `HEAD`, sesión 2026-09-25/26). Apaga
`puede_ver` de `despacho_ver_todos` para el rol DOMICILIARIO en `gener_rol_nivel` y
`gener_nivel_negocio`. Solo apaga, no crea ni borra filas. Un negocio que quiera lo contrario lo
enciende en Usuarios → Roles.

### 1.5 Perfiles de reserva (multi-rubro) e inteligencia

Trabajo de `docs/perfiles-de-reserva.md` y `docs/rubros-de-reserva.md`, **nunca desplegado**:
perfiles de rubro (barbería, salón, spa, estética, tatuaje, mascotas, alojamiento), segundo motor de
**estancias** (`services/estancia/`, `EXCLUDE gist` + iCal), fichas de clientes con consentimiento,
`intelligence.reporte` (el asistente marca a quien lo usa para nada; **solo escribe una fila, nunca
bloquea ni envía**, se apaga con `INTELLIGENCE_REPORTE_AUTO=false`).

Variables nuevas de entorno (ver `.env.example`):
- `RESERVA_PORTAL_URL=https://escalapp.cloud/reserva` — Caddy sirve la app bajo `/reserva`
  (el ejemplo decía `/reservas`, corregido). Sin ella el bot de un alojamiento no inventa enlace.
- `RESERVA_ICAL_ENABLED` / `RESERVA_ICAL_CRON` — importación de calendarios de Airbnb/Booking cada
  15 min; sin calendarios configurados no hace nada.

Estáticos nuevos en `app.js`: `/uploads/reserva/portafolio` y `/uploads/reserva/unidades`.
`uploads/reserva/fichas` **no** es público (consentimientos firmados; se descarga por ruta con token).

**Regla de oro de esta parte:** la barbería (negocios pagadores) **no debe cambiar de comportamiento**.
`__tests__/reserva/motor_dorado` guarda los snapshots previos al cambio.

## 2. Qué NO hay que correr

Las migraciones de la tanda del 2026-09-24 (`intelligence-reactivacion`, `planes-codigo`,
`cobranza-precio-aplicativo`, `planes-landing`) **ya están en producción** — comprobado el 2026-09-26
(existen `gener_negocio.reactivar_asistente_min`, `gener_plan.codigo`, `cob_precio_plan.id_tipo_modulo`
y los 8 planes de la landing). Todas son idempotentes, pero no hace falta repetirlas.

## 3. Orden de despliegue (NO alterar)

```bash
# 0. Respaldo SIEMPRE primero (BD + los tres frontends servidos)
ssh escalapp@45.63.105.95
/home/escalapp/backup.sh
pg_dump -Fc ... > /home/escalapp/backups/db_predeploy_2026-09-26_HHMM.dump

# 1. Ensayo en una BD descartable restaurada de ese respaldo (ver §5)

# 2. Código
cd /var/www/admin_ws && git pull && git log --oneline -1     # comprobar el commit, no el mensaje
npm install --omit=dev                                        # NO npm ci

# 3. Migraciones ANTES de reiniciar (el backend nuevo lee columnas y tablas que aún no existen)
npm run migrate:restaurante-iconos-productos
npm run migrate:restaurante-domiciliario-solo-suyos
npm run migrate:rubros-negocio
npm run migrate:reserva-perfiles
npm run migrate:reserva-estancias
npm run migrate:reserva-subniveles
npm run migrate:intelligence-reportes

# 4. Entorno: añadir RESERVA_PORTAL_URL al .env del VPS

# 5. Backend
sudo systemctl restart escalapp-api && journalctl -u escalapp-api -n 30 --no-pager

# 6. DESPUÉS los frontends: admin_app_v21, negocio_app (+ cp index.csr.html index.html), reserva_app
```

Por qué este orden: un backend nuevo sin sus migraciones rompe; un frontend nuevo contra un backend
viejo solo pierde funciones. Y los subniveles se siembran en TRUE **antes** del frontend que los usa
(en la sesión, «ausente» es indistinguible de «denegado»).

## 4. Comprobar en producción

- `journalctl -u escalapp-api` sin errores; al arrancar aparece el planificador de iCal.
- **Restaurante:** Configuración → Operación muestra el interruptor de iconos **encendido**; Pedidos
  sigue mostrando iconos; multipago con dos formas las trae puestas y se pueden intercambiar.
- **Cobro doble:** pulsar Cobrar dos veces sobre el mismo pedido devuelve el aviso «ya fue cobrado» y
  la consulta de la §1.1 no crece.
- **Barbería (negocios pagadores):** agenda, cobro y portal público `/p/:id` idénticos a antes.
- Admin: Facturación con el selector de negocio compartido; Mis pagos y WhatsApp siguen cargando.

## 5. Ensayo de las migraciones

Las migraciones de reserva nunca han corrido contra datos reales. Antes de tocar producción se
restaura el respaldo en una base descartable (`sudo -u postgres createdb`, el rol `escalapp` no tiene
`CREATEDB`) y se corren ahí. Verifica de paso que `btree_gist` (no instalada en prod; extensión
*trusted* desde PG13) se puede crear sin superusuario.

## 6. Cómo revertir

- **Código:** `git checkout a6948be` en el VPS + `systemctl restart escalapp-api`.
- **Frontends:** el `tar` de respaldo de cada uno en `/home/escalapp/backups/` (patrón
  `front_<app>_pre-deploy_2026-09-26_*.tar.gz`).
- **Migraciones:** todas son aditivas (columnas y tablas nuevas): el código viejo las ignora, no hace
  falta deshacerlas para volver atrás. Excepciones con datos: `domiciliario-solo-suyos` (vuelve a
  encenderse desde Usuarios → Roles) y `rubros-negocio` (mueve negocios de rubro retirado a su
  sucesor; el respaldo de la BD lo revierte).

## 7. Registro de lo que pasó

### 7.1 Qué se desplegó

| Pieza | Producción antes | Producción ahora |
|---|---|---|
| `admin_ws` | `194171d` (rama `master`) | **`a944ea6`**, en la rama `prod-sin-reserva` |
| `negocio_app` (`/restaurante/`) | `9c369ac` | `cebe303` |
| `admin_app_v21` (`/admin/`) | `086400a` | `5888390` |
| `reserva_app` (`/reserva/`) | sin cambios | sin cambios |

Migración corrida en prod: `restaurante-iconos-productos` (10 de 10 negocios con iconos activos).
Respaldos previos: `db_2026-09-26_1203.dump`, `uploads_2026-09-26_1203.tar.gz` y
`front_{admin,restaurante}_pre-deploy_2026-09-26_1203.tar.gz` en `/home/escalapp/backups/`.
Reversa rápida de los frontends: `/var/www/html/{admin,restaurante}.old` (el swap fue con dos `mv`).

**Por qué `a944ea6` y no `master`.** `master` ya llevaba el trabajo de reserva (`71f9cd5`) encima del
fix. Ese código declara columnas nuevas en los modelos de reserva: en producción, sin sus
migraciones, las consultas de la barbería habrían fallado. `a944ea6` es hijo directo de `a6948be` y
contiene solo 9 archivos de restaurante. El VPS quedó en la rama local `prod-sin-reserva` **sin
upstream a propósito**: un `git pull` ahí falla en vez de traer reserva sin querer.

### 7.2 Ensayo previo (copia de prod en `escalapp_ensayo`, ya borrada)

- Migraciones dos veces: idempotentes.
- Prueba funcional del guard con datos reales (10 controles, todos OK): recobrar el ORD-0555 → 409
  `ORDEN_YA_COBRADA` sin crear INGRESO; cobrar el ORD-0655 (cancelado) → 409 `ORDEN_ANULADA`; un pedido
  abierto SÍ se cobra, con 1 solo INGRESO firmado por quien cobra; segundo cobro → 409; **dos cobros
  simultáneos: uno gana y el otro se rechaza**.
- Tras el reinicio: 0 errores en el journal; un único 502 a las 12:05:38, la reconexión SSE en el
  instante del reinicio. Línea base de duplicados en caja: **14** (no debe crecer).

### 7.3 Pendiente de decisión

1. **`migrate:restaurante-domiciliario-solo-suyos` NO se corrió.** El ensayo con datos reales mostró
   que apagaría el permiso `despacho_ver_todos` en 4 filas por negocio con `puede_ver=true`:
   ZONA BURGER (id 6, cliente pagador, 5 usuarios DOMICILIARIO), ICONIC (id 15, 3), El Callejero
   (13, 0) y La Esquina del Barril (14, 0). `sesion-2026-09-25-26` §4 daba por hecho que ningún
   negocio ajustaba ese permiso; los datos dicen lo contrario. Puede que esas filas las creara
   `resolveDefaultSubnivelPermission` al abrir Roles (no deliberadas) o que sean elecciones reales:
   hay que preguntarlo a los negocios antes de correrla. Hasta entonces sus repartidores siguen
   viendo todo Despacho (statu quo, sin regresión).
2. **Perfiles de reserva / `reserva_app`.** Para subirlos: el orden de la §3 (respaldo, ensayo,
   `rubros-negocio` → `reserva-perfiles` → `reserva-estancias` → `reserva-subniveles` →
   `intelligence-reportes`, `RESERVA_PORTAL_URL`, backend, frontends). `reserva_app` local tiene
   2 merges sin empujar (`853045e`, `72447eb`). **El fix `fix/hora-chile` está en prod pero no en
   `origin/main`** hasta que se empuje ese merge: mientras tanto, un deploy de `reserva_app` desde
   `origin/main` lo revertiría.
3. Retirar `/var/www/html/{admin,restaurante}.old` cuando se confirme que todo va bien.

## 8. Pendientes que NO entran aquí

- **`generarNumeroOrden` puede repetir número.** Hace `MAX(numero)+1` **fuera de la transacción** de
  `crearOrden` y no hay índice único en `numero_orden`: dos pedidos simultáneos del mismo negocio
  pueden nacer con el mismo número. No causó el ORD-0555 (verificado: es una sola fila), pero es el
  mismo tipo de agujero.
- Los 13 duplicados históricos de caja (§1.1) siguen sin corregir por decisión del dueño.
- **`__tests__/intelligence/reportes.test.js` está en ROJO (9 tests) y se sube así a propósito.** Espera
  `Bandeja.reportar` y `Bandeja.retirarReporte` en `intelligenceBandejaController`, que aún no existen:
  el reporte a mano desde la bandeja está a medias (motor, repositorio y migración sí están completos).
  Es inocuo en producción: el frontend usa «bloquear», no esos endpoints. Falta implementar los dos
  handlers.
- **Pruebas que se saltaron y por qué (2026-09-26).** Suites verificadas verdes: `motor_dorado` (la
  barbería no cambia), `perfiles`, `motor_perfiles`, `estancia_ical`, `estancia_tarifas`. NO se pudo correr
  la suite completa: por el túnel a la BD remota cada suite de `intelligence` tarda 60-100 s y las que
  miden tiempos (debounce, ráfaga, temporizador) fallan por latencia, no por el código. Las de
  `restaurante` que fallan lo hacen en el *fixture* (`Named replacement ":p"`: la BD de desarrollo no
  tiene el producto que buscan), antes de tocar código; es la deuda de `despliegue-pendiente-2026-09-24.md` §6.
- Los pendientes de `despliegue-pendiente-2026-09-24.md` §6 (precios CLP, FE-2, contador de usuarios).
