# Sesión 2026-09-28 — Venta de productos en `reserva`

> **Estado: DESPLEGADO EN PRODUCCIÓN el 2026-09-28** (`admin_ws` `001bb54`, `restaurante_app`
> `74fab1d`, `reserva_app` `f67ac1d`; migraciones corridas también en la base compartida de
> desarrollo). El registro del despliegue está en §8; lo de §0–§7 es el historial de la sesión
> tal como se escribió antes de desplegar (donde dice «todo en local», ya no aplica).
>
> Esta misma sesión trajo dos cambios más, desplegados en el mismo lote: la sección
> **«Movimientos» en Caja de restaurante** (permiso `caja_ver_movimientos`, ver §8.3) y la
> **corrección del nombre y el teléfono** de la carta digital (§8.4).

**De dónde viene:** idea del usuario — vender productos físicos junto a los servicios en
`reserva`, con carrito en el portal, para los siete oficios (no solo salones). Documento de
diseño completo: [`productos-en-reserva.md`](productos-en-reserva.md). Este documento es el
registro de la sesión — qué se hizo, en qué orden, y qué falta para que llegue a algún lado.

---

## 0. Completitud de la tarea pedida

**Lo pedido** (carrito de productos en el portal, para todas las variaciones de reserva, con
las tres decisiones del usuario) **está funcionalmente completo y probado en local**:

| Pieza | Estado |
|---|---|
| Función `productos` en los 7 perfiles, apagada de fábrica | ✅ Hecho y probado |
| Catálogo (categorías + productos, con imagen, stock opcional) | ✅ Hecho y probado |
| Vender de mostrador (con o sin cita) | ✅ Hecho y probado |
| Comprar sin cita | ✅ Hecho (decisión del usuario) |
| Comisión por vendedor, opcional y apagada por defecto | ✅ Dato guardado; **el informe que la calcule NO existe** (ver §4) |
| Domicilio | ❌ Deliberadamente fuera de esta fase (decisión del usuario) |
| Carrito público + pedido para recoger | ✅ Hecho y probado |
| Seguimiento del pedido para quien vuelve más tarde | ❌ No existe (la cita sí lo tiene; el producto no) |
| Galería de fotos por producto (como tienen los servicios) | ❌ Solo una imagen por producto |

**Lo que NO se hizo, y es lo único que falta para que esto exista fuera de este PC:**

- No hay commit en ningún repo (`admin_ws`, `reserva_app`).
- No se corrió la migración en la base compartida (`5433`) ni en producción.
- No se compiló ni subió `reserva_app` al VPS. `reserva_app` **sí está desplegada en producción**
  desde 2026-08-24 (`admin`, `restaurante` y `reserva` son las tres apps servidas hoy), así que
  esto es un despliegue real pendiente, no una app que todavía no existe en el servidor.
- No hubo revisión visual del dueño de producto: todo lo de pantalla (colores, textos, la
  disposición del carrito) es una primera pasada, no algo validado con capturas.

En una palabra: **la parte de código está terminada y verificada; la parte de "que llegue a
alguien" no ha empezado.**

---

## 1. Qué se hizo — backend (`admin_ws`)

Todo en `app_reserva_api/`, siguiendo el mismo patrón que Mascotas/Recursos/Estancias
(`app_reserva_api/perfiles/`):

- **`perfiles/definiciones.js`**: nueva función `productos` en `FUNCIONES`, añadida a
  `disponibles` de los 7 perfiles (BASE, SALON, SPA, ESTETICA, TATUAJE, MASCOTAS, ALOJAMIENTO),
  en ninguno `activas`. Vista `/productos` en `VISTAS_POR_FUNCION`.
- **Migración `migrations/migrate_reserva_productos.js`** (`npm run migrate:reserva-productos`):
  4 tablas nuevas (`reserva_producto_categoria`, `reserva_producto`, `reserva_venta_producto`,
  `reserva_venta_producto_detalle`), 2 columnas nuevas (`reserva_movimiento_caja.id_venta_producto`,
  `reserva_config.comision_productos_pct`), vista `/productos` en el catálogo de permisos.
- **`migrations/migrate_reserva_subniveles.js`**: se le añadieron 2 acciones nuevas al final de su
  catálogo (`productos_editar`, `productos_vender`). Correrla de nuevo es idempotente y solo
  añade lo nuevo.
- **Modelos nuevos**: `app_core/models/reserva.reserva_producto{,_categoria}.js`,
  `reserva.reserva_venta_producto{,_detalle}.js`. Modelos tocados:
  `reserva.reserva_movimiento_caja.js`, `reserva.reserva_config.js`.
- **Servicios nuevos**: `productoService.js` (categorías + productos, CRUD), `ventaProductoService.js`
  (`crear`, `cobrar`, `venderYCobrar`, `cancelar`, `listar`). Reutiliza `normalizarPagos`
  (ahora también `centavos`) de `cobroService.js` en vez de reimplementarlo.
- **`cajaService.registrarMovimiento`**: acepta `idVentaProducto` (nuevo parámetro opcional,
  compatible hacia atrás).
- **Controladores nuevos**: `productoController.js`, `ventaProductoController.js`.
- **`vitrinaService.getVitrina`**: añade `productos` y `producto_secciones` a la respuesta,
  solo si la función está encendida — misma llamada de siempre, sin endpoint nuevo.
- **`publicoController.crearVentaProductoPublica`** + ruta
  `POST /reserva/publico/:id_negocio/venta-producto`.
- **`imagenService.js`**: tipo `producto` añadido al catálogo de carpetas de imágenes.
- **Rutas** (`routes/index.js`): todo el bloque de `/productos` y `/ventas-productos` protegido
  con `exigirVista('/productos')` + `exigirFuncion('productos')` + `exigirAccion(...)`, siguiendo
  el patrón de Recursos/Mascotas.

**Tests**: `__tests__/reserva/productos.test.js` (19 casos, contra la base real) +
ampliación de `__tests__/reserva/perfiles.test.js` (la función en los 7 perfiles). Suite completa
de `reserva` en verde (136/136) y el resto del backend también (ver §3 — con una salvedad).

---

## 2. Qué se hizo — frontend (`reserva_app`)

- **Tipos** (`core/models-perfil.ts`, `core/models.ts`): `Funcion` gana `'productos'`;
  interfaces `Producto`, `ProductoCategoria`, `VentaProducto`, `VentaProductoDetalle`,
  `ProductoPublico`, `ProductoSeccionPublica`; `Vitrina` gana `productos`/`producto_secciones`.
- **`perfil-api.service.ts`**: toda la sección «Venta de productos» (categorías, productos,
  imagen, ventas/vender/cobrar/cancelar) — mismo archivo que ya tiene Recursos/Mascotas/Ficha.
- **`reserva-api.service.ts`**: `publicoCrearVentaProducto`.
- **`auth.service.ts`**: `/productos` añadido a `APP_ROUTE_PRIORITY` y a `VISTAS_SOLO_DE_PERFIL`
  (se esconde sola si el negocio no tiene la función, igual que Mascotas/Recursos).
- **`layout/sidebar/sidebar.ts`**: ítem «Productos» con icono `shopping-bag`.
- **Pantalla nueva `reserva/productos/`** (`productos.ts/html/scss`): tres pestañas — Catálogo
  (categorías + productos + imagen), Vender (mostrador, un clic), Pedidos del portal (cobrar o
  cancelar lo que llegó pendiente).
- **`app.routes.ts`**: ruta `/productos`, perezosa, con `planGuard`.
- **`app.config.ts`**: iconos Lucide que faltaban (`Package`, `ShoppingBag`, `ShoppingCart`,
  `Camera`) — **si se te olvida esto al copiar el patrón a otro icono nuevo, la app no falla al
  compilar, revienta en tiempo de ejecución** (ya está advertido en el propio archivo).
- **Portal público** (`reserva/publico/`):
  - `vitrina.store.ts`: `usaProductos`, `productoSecciones`.
  - `carrito-productos.service.ts` (nuevo): carrito por negocio, persistido 90 días en
    `localStorage`, hermano del de `restaurante_app` pero sin WhatsApp de por medio — manda el
    pedido directo por API.
  - `inicio.ts/html/scss`: sección de productos (agrupada por categoría), botón flotante de
    carrito, panel de checkout (nombre obligatorio, teléfono opcional, nota opcional) y
    confirmación.

**Tests**: `carrito-productos.service.spec.ts` (12 casos). Build de producción
(`ng build --configuration development`) limpio, incluido el prerender.

---

## 3. Verificación — qué se corrió y qué encontró

- `npx jest --forceExit __tests__/reserva/` → **136/136**, contra la base local (`5432`).
- `npx jest --forceExit` (todo el backend) → **1429/1465**, 36 fallos en **5 suites que no
  tienen nada que ver con este trabajo**: `negocios/rubros`, `negocios/cupo_usuarios`,
  `restaurante/auditoria_actor_restaurante`, `restaurante/configuracion_flags`,
  `intelligence/reportes`. Causa: la base local llevaba meses sin varias migraciones de otras
  verticales (drift, ver §6). Se corrigieron las que bloqueaban *este* trabajo
  (`reserva-perfiles`, `reserva-estancias`, `reserva-caja-anular`, `reserva-*` en cadena,
  `rubros-negocio`, `restaurante-iconos-productos`); las 5 suites que quedan rojas necesitan más
  migraciones de otras verticales que no se tocaron por estar fuera de alcance.
- `npx ng build --configuration development` (reserva_app) → limpio.
- `npx ng test --watch=false` (reserva_app) → 32/33 (el único rojo, `app.spec.ts`, es el
  placeholder «Hello, reserva_app» del scaffold de Angular — no toca nada de esta sesión y ya
  estaba así antes).
- Bug real cazado por los tests: `cobrar()` intentaba `FOR UPDATE` sobre una consulta con
  `include` (outer join) — Postgres lo rechaza. Corregido separando la lectura del detalle.

---

## 4. Pendiente, documentado como deliberado

Todo esto está en la sección 7 de [`productos-en-reserva.md`](productos-en-reserva.md):

1. **Informe de comisión.** El dato ya se guarda (`id_profesional` por línea de venta,
   `reserva_config.comision_productos_pct`); no existe la pantalla ni el cálculo que lo use.
2. **Domicilio de productos.** `entrega` ya soporta un tercer valor el día que se construya.
3. **Seguimiento público del pedido.** La cita tiene `GET /publico/cita/:codigo`; la venta de
   producto no tiene su equivalente — hoy la confirmación se ve una sola vez, al pedir.
4. **Producto como cargo de estancia** (minibar, souvenirs en un hostal). `reserva_estancia_cargo`
   ya existe; conectarlo con el catálogo de productos no se construyó.
5. **Galería de fotos por producto** (como la de servicios). Hoy una sola imagen.

---

## 5. Cómo retomar — en este orden

1. **Decidir si esto se prueba en la base compartida (`5433`) o se queda en local.** Si se pasa
   a compartida: avisar al otro dev (regla del equipo) y correr, en este orden:
   ```bash
   npm run migrate:reserva-productos
   npm run migrate:reserva-subniveles
   ```
   Ambas son idempotentes; no hay riesgo de repetirlas.
2. **Revisión visual.** Nadie del lado de producto ha visto la pantalla de Productos ni el
   carrito público todavía. Antes de seguir construyendo (comisión, domicilio), vale la pena
   que el dueño la vea y diga si el diseño sirve.
3. **Si se decide seguir con comisión o domicilio**, son extensiones aditivas sobre lo que ya
   existe (ver §4) — no hace falta releer todo el diseño, solo esas dos secciones.
4. **Si se decide desplegar**: `reserva_app` ya está en el VPS (`/var/www/html/reserva`, desde
   2026-08-24), así que es el flujo de siempre — compilar en local, subir, migrar backend en el
   VPS **con respaldo antes** (`npm run migrate:reserva-productos` y `migrate:reserva-subniveles`
   contra la base de producción, por SSH, nunca desde aquí).
5. **Commit.** Todavía no se ha hecho ninguno de los dos repos. Sugerido: un commit por repo,
   mensaje en la línea de `feat(reserva): venta de productos, función del perfil en los 7 oficios`.

---

## 6. Drift de entorno encontrado (aparte, no de esta tarea)

La base local de este PC llevaba sin correrse, desde antes de esta sesión:
`migrate:reserva-perfiles`, `migrate:reserva-estancias`, `migrate:reserva-caja-anular`,
`migrate:reserva-informes`, `migrate:reserva-caja`, `migrate:reserva-reparar-vistas`,
`migrate:reserva-usuarios`, `migrate:reserva-eliminar`, `migrate:reserva-cita-editar`,
`migrate:reserva-marca`, `migrate:reserva-tiktok-telefono`, `migrate:reserva-cliente-pais`,
`migrate:reserva-horarios-editar-propio`, `migrate:reserva-servicio-rango-precio`,
`migrate:reserva-servicio-imagen`, `migrate:reserva-hold`, `migrate:reserva-vitrina`,
`migrate:reserva-categorias`, `migrate:reserva-clientes`, `migrate:reserva-codigo-corto`,
`migrate:rubros-negocio`, `migrate:restaurante-iconos-productos`. Todas corridas ya en esta
sesión, contra **local únicamente**. Quedan sin correr (y sin tocar en esta sesión, fuera de
alcance): lo que necesiten `negocios/rubros.test.js`, `negocios/cupo_usuarios.test.js`,
`restaurante/auditoria_actor_restaurante.test.js`, `restaurante/configuracion_flags.test.js`,
`intelligence/reportes.test.js`.

---

## 7. Archivos tocados (para el diff de mañana)

**`admin_ws`** — nuevos: `app_core/models/reserva.reserva_producto{,_categoria}.js`,
`reserva.reserva_venta_producto{,_detalle}.js`, `app_reserva_api/controllers/productoController.js`,
`ventaProductoController.js`, `app_reserva_api/services/productoService.js`,
`ventaProductoService.js`, `migrations/migrate_reserva_productos.js`,
`__tests__/reserva/productos.test.js`, `docs/productos-en-reserva.md`. Modificados:
`app_core/models/reserva.reserva_config.js`, `reserva.reserva_movimiento_caja.js`,
`app_reserva_api/controllers/publicoController.js`, `app_reserva_api/perfiles/definiciones.js`,
`app_reserva_api/routes/index.js`, `app_reserva_api/services/cajaService.js`,
`cobroService.js`, `imagenService.js`, `vitrinaService.js`,
`migrations/migrate_reserva_subniveles.js`, `package.json`,
`__tests__/reserva/perfiles.test.js`, `docs/perfiles-de-reserva.md`.

**`reserva_app`** — nuevos: `src/app/reserva/productos/` (carpeta completa),
`src/app/reserva/publico/carrito-productos.service.ts` (+ `.spec.ts`). Modificados:
`src/app/app.config.ts`, `app.routes.ts`, `core/models.ts`, `core/models-perfil.ts`,
`core/services/auth.service.ts`, `perfil-api.service.ts`, `reserva-api.service.ts`,
`layout/sidebar/sidebar.ts`, `reserva/publico/inicio/inicio.{ts,html,scss}`,
`reserva/publico/vitrina.store.ts`.

(Nota: además hay cambios de una tarea previa en la misma sesión, sin relación —
correcciones en `admin_ws/intelligence/adapters/restaurante/` y `restaurante_app` sobre el
nombre y teléfono del formulario de la carta digital. Ver el resumen de esa tarea si hace falta
retomarla; no la repite este documento.)

---

## 8. Despliegue a producción (2026-09-28, ~10:33–10:50 hora Bogotá)

Un solo commit por repo, subido por el dueño: `admin_ws` `001bb54`, `restaurante_app` `74fab1d`,
`reserva_app` `cf03743` (mergeado en `f67ac1d`, que además trae un cambio ajeno de la otra
persona: «escribir al cliente por WhatsApp desde el detalle de la cita», solo frontend).

### 8.1 Orden seguido (el de siempre: respaldo → backend → migración → frontends)

1. **Respaldo fresco** con `/home/escalapp/backup.sh` (`db_2026-09-28_1033.dump`). Sigue
   siendo solo local: no existe el remoto rclone.
2. **Backend**: `git pull` (verificado con `git log -1` → `001bb54`; era un pull real, no el
   «Already up to date» de la trampa documentada), `npm install --omit=dev` (nada nuevo).
3. **Migraciones en producción**, en este orden, con `npm run` desde `/var/www/admin_ws`:
   `migrate:reserva-productos` → `migrate:reserva-subniveles` (+2 acciones,
   `/productos/editar` y `/productos/vender`) → `migrate:restaurante-caja-movimientos`.
   Solo estas tres: las demás de reserva (perfiles, estancias…) ya estaban en producción — el
   «drift» de §6 era de la base **local**, no de producción.
4. `sudo systemctl restart escalapp-api`.
5. **Frontends** compilados en local y subidos: `restaurante` (con `cp index.csr.html
   index.html`, no prerenderiza) y `reserva` (**dos builds**, ver §8.2). Cada destino con su
   respaldo previo en `/home/escalapp/backups/front_*_pre-deploy_*.tar.gz`.

### 8.2 ⚠️ `reserva_app` se despliega DOS veces

El Caddyfile sirve dos builds del mismo código, y olvidar uno rompe cosas sin avisar:

| Destino en el VPS | Se sirve en | Cómo se compila |
|---|---|---|
| `/var/www/html/reserva` | `escalapp.cloud/reserva/*` (consola + portal) | `npm run build` (baseHref `/reserva/`) |
| `/var/www/html/reserva-portal` | `*.escalapp.cloud` (subdominio de cada negocio, p. ej. `d-alex-barberia.escalapp.cloud`) | `ng build --base-href=/ --output-path=dist/reserva_portal` |

- **En Git Bash de Windows, `--base-href=/` se convierte en `C:/Program Files/Git/`** y el build
  sale con un `<base href>` roto sin ningún error. Usar `MSYS_NO_PATHCONV=1 npx ng build
  --base-href=/ ...` (o PowerShell) y **comprobar** con `grep -o '<base href="[^"]*"'
  dist/reserva_portal/browser/index.csr.html` → debe decir `"/"`.
- No renombrar `index.csr.html` en ninguno de los dos (los dos prerenderizan).
- El subdominio de D'ALEX es **`d-alex-barberia`** (el slug real), no `dalex-barberia`: este
  último solo aparece como ejemplo en los comentarios del Caddyfile y da error de TLS porque el
  endpoint `ask` responde 404 y Caddy no emite certificado (comportamiento correcto).

### 8.3 Movimientos en Caja (restaurante)

Permiso `caja_ver_movimientos` sembrado en FALSE para todos los roles y negocios de
restaurante (25 filas de negocio en producción). **Nadie lo tiene todavía**: el administrador
debe activarlo en Usuarios → Roles y Permisos → Caja → «CAJA - VER MOVIMIENTOS» → Guardar, y
volver a iniciar sesión (los permisos se cargan al entrar). Ruta:
`GET /restaurante/caja/seguimiento`. Diseño y razones: `seguimientoPedidoService.js` (el rastro
sale de `pedid_orden`, `rest_movimiento_caja` y `auditoria.audit_dato`; no hay tablas nuevas).

### 8.4 Carta digital (restaurante) — nombre y teléfono

El nombre del formulario manda sobre el que el bot recordaba, y el formulario ya no pide
teléfono (lo prueba el canal). Sin migración. **Cartas ya abiertas en el navegador de algún
cliente** siguen mandando el bloque viejo con `Teléfono:`: el bot lo ignora, así que no rompe
nada.

### 8.5 Verificación posterior

- 60/60 chunks JS de cada build de reserva y 38/38 de restaurante coinciden con el build local
  (son hashes de contenido).
- `200` en `/admin/`, `/restaurante/`, `/reserva/`, `/reserva/dashboard` y en el subdominio
  `d-alex-barberia.escalapp.cloud`; las dos rutas nuevas del API responden `401` sin token
  (registradas, no 404/500); `GET /reserva/publico/16/vitrina` → 200 con `"productos":[]`
  (función apagada de fábrica, como debe ser).
- Backend `active` sirviendo tráfico real de D'ALEX durante todo el despliegue, sin errores.

### 8.6 Pendiente tras el despliegue

1. Que el dueño active `caja_ver_movimientos` para quien corresponda (§8.3).
2. Para probar productos en producción: Configuración → Funciones → «Venta de productos»
   (apagada de fábrica en los siete perfiles) y luego la vista Productos por rol.
3. Sigue pendiente lo de §4 (informe de comisión, domicilio, seguimiento público del pedido…).
4. Nada de esto se ha visto con ojos del dueño en pantalla real todavía.
5. Commit de esta documentación (los `.md` quedaron modificados en `admin_ws`).
