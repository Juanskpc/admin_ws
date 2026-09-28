# Sesión 2026-09-28 — Venta de productos en `reserva`

> **Estado: TODO EN LOCAL. Nada está commiteado, nada está en la base compartida, nada
> desplegado.** Las migraciones nuevas solo se corrieron contra la base **local** de este PC
> (`DB_PORT=5432`). La base compartida del VPS de desarrollo (`5433`) y producción no tienen
> ninguna de las tablas ni columnas de este documento. Ver §5 para el orden exacto de retomar.

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
