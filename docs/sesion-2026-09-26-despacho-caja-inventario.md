# Sesión 2026-09-25/26 — Despacho, Caja, Inventario, sidebar y permisos del admin

> **Estado: TODO EN LOCAL. Nada está commiteado ni desplegado.** Producción sigue en lo que dice
> `sesion-2026-09-25-restaurante-y-carta.md` (`admin_ws` `194171d`, `restaurante_app` `9c369ac`,
> `admin_app-v21` `086400a`). Nada de esto se vio en pantalla por la sesión: la revisión visual
> la hace el dueño.

## 0. Lo que hay que hacer para que llegue a producción (en este orden)

1. **Backend, migración de permisos** — la única pieza que toca datos:
   `npm run migrate:restaurante-domiciliario-solo-suyos` (§4). Ya corrió en la base compartida de
   desarrollo. **En producción NO se ha corrido** y hay que hacerlo con respaldo antes.
   Hasta entonces los domiciliarios reales siguen viendo todos los pedidos.
2. **Frontends** — compilar en local y subir, como siempre (`restaurante_app` → `/restaurante/`,
   `admin_app-v21` → `/admin/`, sin renombrar `index.csr.html` en el admin).
3. Comprobar el VPS mismo, no el `push` (ver la trampa del `pull` en `CLAUDE.md`).

## 1. Despacho (`restaurante_app/.../features/despacho`)

**Tarjeta rediseñada** (jerarquía en vez de lista plana):
- Encabezado: `#0056` grande + acciones sutiles (editar/cancelar) a la derecha; badges de tipo en
  su propia fila. Domicilio = azul, Llevar = verde, WhatsApp = neutro con el ícono verde.
- Cuerpo: dirección primero y en negrita (hasta 2 líneas; «Sin dirección» en ámbar), cliente y
  teléfono, «N productos • hora», domiciliario (o «Sin asignar»), quién tomó el pedido.
- Pie: total + badge de pago, y **una sola acción principal de ancho completo**:
  `accionPrincipal(p)` = *avisar* (si el backend lo permite) → *cobrar* → *finalizar*. Imprimir es
  un botón cuadrado a su lado.
- El hover solo flota (sube 3 px + `--shadow-lg`); **el borde no cambia de color**. También en las
  tarjetas canceladas.
- La tarjeta cancelada usa el mismo esqueleto que la activa (antes conservaba el marcado viejo:
  por eso su «Finalizar» era una pastilla de 11 px). Botón de contorno rojo.
- Token nuevo `--despacho-domicilio` (+ `-bg/-border/-text`) en `styles/_theme.scss`: azul
  **semántico y fijo**, igual criterio que los colores de mesa. No derivarlo de `--color-primary`.

**Comportamiento:**
- **«Cobrar» en la tarjeta cobra enseguida** si el pedido ya trae forma de pago
  (`seleccionGuardada`); si no, abre el modal. También abre el modal cuando un multipago ya no suma
  el total o cuando la forma es Cuenta/Tiquetera y el pedido no dice de quién es la cuenta
  (el servidor no la adivina).
- **«Finalizar todo»** ahora incluye los cancelados. Causa del bug: solo miraba `pedidosFiltrados()`
  y los cancelados (lista aparte, `canceladosFiltrados()`) nunca se conectaron; con solo cancelados
  el botón quedaba deshabilitado, y los pedidos que el propio botón cancelaba reaparecían como
  «Cancelado». Además ya no esconde una tarjeta cuya petición falló.
- **«Finalizar» de un cancelado es local al navegador** (`localStorage`), no del servidor: por eso
  un admin y un domiciliario en equipos distintos ven cosas distintas. Es el diseño original.
- Se quitó el botón «Actualizar» (la pantalla se refresca sola por SSE).
- **Fecha del pedido** (`etiqueta-fecha.ts`, con spec): hoy `8:02 p. m.`, ayer `ayer 8:02 p. m.`,
  dos días o más `03 abr`. «Ayer» es día de calendario, no 24 h.
- **Domiciliario** (rol único DOMICILIARIO, `esDomiciliario`): sin botón Imprimir (ni en la
  tarjeta ni en el modal) y sin el chip «Para llevar» (`muestraLlevar`).
- **Densidad en móvil:** arranca en «mediana» (2 por fila) si el usuario no eligió nada
  (`VistaTarjetasService.densidad(modulo, 'compacta')`). Solo se guarda lo que el usuario elige con
  el botón; antes «Ver productos» guardaba también la densidad `normal` como si fuera una elección.
  En la vista pequeña, los botones principales pierden el ícono.
- Móvil: botones de arriba en una fila a todo el ancho; filtros en una fila con scroll horizontal.

## 2. Caja

- Se quitó «Actualizar». Verificado en el backend que apertura, cierre, movimientos manuales,
  transferencias de domiciliario, anulaciones y cobros emiten el aviso `caja`/`pedidos`.
- La tarjeta de productos de un movimiento ya no se corta a la derecha: su ancho es el de lo que se
  ve (`container-type: inline-size` en `.movimientos__table` + `100cqw`) y sigue anclada (`sticky`)
  mientras la fila se desliza. Encabezados de tabla en negrita (700). Botones del encabezado a todo
  el ancho en móvil.

## 3. Inventario

- Banner de «control apagado» → etiqueta ámbar «Control apagado» junto al título (detalle en tooltip).
- KPIs con fondo pastel; «Agregar nuevo insumo» pasó a un modal (botón **+ Nuevo insumo**).
- Tabla: fila agotada con fondo rosado + franja roja; barra de stock por estado; ajuste rápido como
  **stepper** `[− n + ↺]` con el reset dentro del mismo grupo.
- **Recetas leen el stock de `insumos()`** (`productoActivoVista`), no la copia que trae cada receta;
  el servidor ya devolvía datos coherentes (comprobado), el desajuste venía de una pantalla que no se
  refrescaba. Ahora se recarga en silencio al llegar un pedido (`realtime.alCambiar(['pedidos'])`) y
  una respuesta vieja no pisa a una nueva. **No hay tema de tiempo real `inventario`**: un ajuste
  manual hecho desde otro equipo no avisa.
- Layout de viewport fijo: la vista mide el alto del shell, las dos columnas llenan el alto y la
  tabla hace scroll interno con `<thead>` pegado. **25 filas por página por defecto** (era 15;
  se probó 8 y dejaba un hueco). Receta activa anclada abajo, alto `clamp(170px, 30vh, 260px)`,
  cabecera fija, insumos en una línea.
- **Móvil (≤ 767 px): sin scrolls verticales internos** y margen de 10 px como Caja. Columna
  «Mínimo» **comentada** en todas las pantallas (para volver: descomentar `<th>` y `<td>` y
  `tableColspan` base 5). «Acciones» mide solo lo que ocupan sus íconos (`.col-gestion`).
- ⚠️ Archivos `inventario.*` son CRLF: al editar por script, respetar el fin de línea.

## 4. Permisos

**DOMICILIARIO veía todo Despacho.** El permiso `despacho_ver_todos` tenía `puede_ver = true` para
el rol DOMICILIARIO en `gener_rol_nivel` (y en `gener_nivel_negocio` del negocio de pruebas), aunque
`migrate_restaurante_domicilio.js` solo lo sembró para administrador, mesero y cajero. El backend
(`getOrdenesDespacho`) ya filtraba por `id_domiciliario`; el dato era el problema.
- Migración `migrate_restaurante_domiciliario_solo_suyos.js` (idempotente, solo apaga `puede_ver`).
- **Producción (consulta de solo lectura, 2026-09-25): el catálogo global también tiene
  DOMICILIARIO en `true` y ningún negocio lo ajusta.** Un negocio que quiera lo contrario lo activa
  en Usuarios → Roles.

**Admin principal** (`admin_app-v21`): WhatsApp, Facturación y Mis pagos llevan `soloAdministrador`
en el menú. La definición única vive en `admin.guard.ts` (`esAdministrador` = super admin o
ADMINISTRADOR en algún negocio; compara sin mayúsculas ni espacios); el menú y los guards la usan.
Un usuario con sesión pero sin permiso ahora vuelve a `/admin/dashboard`, no al login.
Pendiente: la campana de notificaciones sigue visible para todos los roles.

## 5. Sidebar de restaurante

«Mesas» pasó a Principal y «Menú» a Gestión. La barra inferior móvil usa los de Principal, así que
**en móvil Mesas ocupa el lugar de Menú y Menú queda en «Más»**. Los títulos «Principal» y
«Gestión» solo salen si hay vistas dentro.

## 6. Archivos tocados

- `restaurante_app`: `core/services/vista-tarjetas.service.ts`, `layout/sidebar/sidebar.{ts,html}`,
  `features/caja/caja.{html,scss}`, `features/despacho/despacho.{ts,html,scss}` + nuevos
  `etiqueta-fecha.{ts,spec.ts}`, `features/inventario/inventario.{ts,html,scss}`, `styles/_theme.scss`.
- `admin_app-v21`: `admin/guards/admin.guard.{ts,spec.ts}`, `admin/layout/admin-layout.component.ts`.
- `admin_ws`: `migrations/migrate_restaurante_domiciliario_solo_suyos.js` y su entrada en `package.json`.

## 7. Trampas de esta sesión

- **Heredocs con comillas fallan en Bash** (y a veces también con `python - <<'EOF'`): escribir los
  scripts con la herramienta Write y ejecutarlos. Con CRLF, un `replace("\n", …)` no encuentra nada.
- Un `s.index("    </div>")` puede coincidir dentro de un `</div>` más indentado: al cortar bloques
  HTML por marcador, usar un marcador que no sea subcadena de otro.
- «RESTAURANTE CHAYANE» es el negocio 17 **de la base de desarrollo**, no existe en producción
  (los restaurantes reales son 6, 12, 13, 14 y 15).

## 8. Pendientes que quedan abiertos

1. Correr la migración de §4 en producción (con respaldo) y desplegar los tres repos.
2. Revisión visual del dueño: móvil angosto (~360 px) en Despacho y Caja, densidad mini con
   «Avisar que va en camino», Inventario con varios agotados.
3. Decidir si «Finalizar» de un cancelado debe guardarse en el servidor (hoy es por navegador).
4. Decidir si la campana de notificaciones del admin se oculta a no administradores.
5. Los pendientes de `sesion-2026-09-25-restaurante-y-carta.md` §7 siguen igual (auditoría de
   colores y contrastes de todas las paletas, etc.).
