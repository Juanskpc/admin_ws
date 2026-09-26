# Sesión 2026-09-25 (tarde) — Restaurante, carta digital y despliegues

> Continuación de `sesion-2026-09-25-pos-pedidos.md` (la de la mañana, solo POS). Esta cubre todo lo
> demás que se construyó, se corrigió y **se desplegó a producción** el mismo día. Al cierre **todo está
> commiteado, subido y en producción**; nada queda pendiente de subir.

## 1. Dónde quedó producción

| Pieza | Commit | Notas |
|---|---|---|
| `admin_ws` (backend) | `194171d` | VPS `45.63.105.95`, servicio `escalapp-api` activo |
| `restaurante_app` (frontend) | `9c369ac` | Build local → `/var/www/html/restaurante` (38 chunks coinciden) |
| `admin_app-v21`, `reserva_app` | `086400a`, `0a4ced5` | Sin cambios en esta sesión |

**Respaldos previos a cada despliegue** (`/home/escalapp/backups/`): `db_2026-09-25_0932 / 1601 / 1609 /
1613 / 1637(1731)` y `front_restaurante_pre-deploy_2026-09-25_*` (0937, 1602, 1613, 1629, 1632, 1645,
1732). Revertir el frontend = extraer el `tar` de la hora anterior sobre `/var/www/html`; el backend =
`git checkout <commit anterior>` + reiniciar.

## 2. Despliegues, en orden

1. **Mañana (09:32):** barrido restaurante (`d805d5c` / `9959540`): conciliación de pagos Wompi/dLocal,
   reinicio del bot por inactividad, usuarios de restaurante, carta con datos del cliente, POS.
2. **`b543744` + frontend:** Mesas rediseñadas, Despacho (chip «Cancelados», «Cancelar»), Pedidos, Caja,
   carta digital («Procesando», nota en todos los tipos, pie compacto), **migración
   `migrate:restaurante-mesa-seccion`** (texto libre; luego reemplazada) y «sin cebolla» en Despacho/Mesas.
3. **`fbb1d30`:** el bot dice «empaque» en vez de «desechables».
4. **`ea73edb` / `c9a4da1` / `c49dc7b`:** lectura del «sin» en ítems ya pagados, nota de WhatsApp al sumar a
   una cuenta de mesa abierta.
5. **Colores de Mesas:** primero ligados a la marca (`3db1fd4`), luego **semánticos e independientes de la
   paleta** (decisión final, ver §4).
6. **`194171d` / `9c369ac` (cierre):** **secciones de mesas como entidad + pestañas**, migración
   `migrate:restaurante-mesa-secciones` en producción (antes de reiniciar, sin tocar datos).

## 3. Qué se construyó

**Mesas** (`restaurante_app`)
- Tarjeta rediseñada: mesa vista desde arriba (forma y sillas según puestos), capacidad como `[👥 n]`,
  monto/tiempo en fila fija, alerta a los 45 min, una sola acción principal («Tomar pedido» / «Editar
  pedido» → POS con `?mesa=<id>`, sin confirmación), cancelar pedido (tarjeta y modal, mismo permiso que
  Despacho: `despacho_cancelar_no_pagado`), modal con **un solo scroll y pie fijo**.
- Ícono propio `mesa` (mesa redonda con 4 sillas) en `core/icons/mesa-icon.ts`.
- Encabezado: «Editar mesas», «Secciones», «Cambiar tamaño»; sin «Actualizar»; filtros en una fila.
- **Secciones** (ver `secciones-de-mesas.md`): crear/renombrar/ordenar/borrar/asignar; **pestañas** por
  sección («Todas» = vista agrupada de siempre), contadores por pestaña, recuerda la pestaña por equipo.

**Despacho / Pedidos / Caja**
- Despacho: chip «Cancelados», «Cancelar» (antes «Eliminar»), «Sin cebolla» en tarjeta, detalle y tiquete.
- Pedidos: botones «Enviar a caja/despacho/cocina», sin selector de «pedido pendiente», pie (nota + totales
  + botones) al fondo, ingredientes editables en pedidos cargados, categorías en móvil.
- Caja: hora 12 h AM/PM, filas de una línea, margen móvil de 10 px, sin título repetido.

**Carta digital**: pantalla «Procesando» hasta tener identidad de marca, selector inicial sin scroll de
fondo, nota especial opcional en mesa/recoger/domicilio, pie del pedido compacto, «Pedir aquí» en escritorio.

**Backend**: secciones (`rest_mesa_seccion`), exclusiones en `getOrdenesDespacho` y tablero de Mesas,
texto «empaque» y nota de WhatsApp en cuenta de mesa abierta.

## 4. Decisiones que conviene recordar

- **Colores de las mesas: semánticos, NO ligados a la marca.** Libre = verde `#2e8b57`, ocupada =
  naranja-rojo `#d9622b`, por cobrar = dorado `#d99a00` (valores fijos en `_theme.scss`, `--mesa-*`).
  Se probó ligarlos al color del negocio (giro de tono en OKLCH y luego inclinación 20 %); con la marca
  **roja** de Zona Burger «libre» salía rojo, que en un POS se lee como error. La marca solo tiñe botón
  principal, filtros activos y acentos. El código de esa exploración se eliminó (`tonos-mesas.ts`).
- **Sección = entidad, no texto.** Texto libre equivalía a escribirla a mano en cada mesa; el «piso1» por
  error de dedo creaba otra sección. La columna de texto `rest_mesa.seccion` **se conserva** (el código
  anterior la lee); ninguna mesa de producción la había usado (0 de 27).
- **Asignar mesas es completo** (lo marcado en pantalla), y reordenar exige **todas** las secciones.
- **Cancelar el pedido de una mesa** = cancelar la orden + devolver la mesa (libre, u «ocupada» si ya se
  cobró parte). Son dos llamadas.

## 5. Trampas pagadas hoy

- **Rejilla + `overflow: hidden` = tarjetas recortadas.** Con la rejilla al alto de la pantalla y
  `overflow: hidden` en la tarjeta, el alto mínimo automático es 0 y las filas se reparten el espacio.
  Arreglo: `grid-auto-rows: max-content`.
- **`<select [value]>` no elige nada si las opciones se crean a la vez.** Hay que marcar `[selected]` en
  cada `<option>` (Pedidos, Menú y el formulario de Mesas ya lo hacen).
- **Un hijo con `overflow` en una columna flex con scroll se encoge a 0** (la tira de categorías de
  Pedidos en móvil). Arreglo: `> * { flex-shrink: 0 }`.
- **Despacho y Mesas no traían las exclusiones**: la orden se guardaba bien (Cocina y Caja las leían) pero
  esas dos pantallas veían un pedido normal. Un «sin cebolla» de WhatsApp llegaba sin decirlo.
- **La base compartida de desarrollo (5433) no se migró sola**: el backend nuevo lee `id_seccion` en cada
  consulta de mesas y dio 500 hasta correr la migración allí. **Migrar SIEMPRE antes de reiniciar el
  backend** y en cada base donde se trabaje.
- **Sass:** `unquote()` global está deprecado; para valores `oklch(from …)` en custom properties usar
  interpolación `#{'…'}`.
- **Lucide no trae mesa de comedor** (`armchair` era un sofá, `concierge-bell` no se entendía): ícono propio.
- **Heredocs de shell con comillas/acentos fallan a menudo** en esta máquina: escribir los scripts con la
  herramienta de archivos y ejecutarlos.

## 6. Wompi

La «URL de eventos» del panel apuntaba a un túnel temporal (`trycloudflare.com`) que ya no existe: por eso
en producción no llegó nunca un evento. Se cambió a `https://api.escalapp.cloud/admin/cobranza/webhook/wompi`
(la ruta responde 401 «Firma inválida» sin firma). **Falta comprobar** que el «secreto de eventos» del
panel coincida con `WOMPI_EVENTS_SECRET` y ver el primer evento real en `cob_evento_webhook`.

## 7. Pendiente (decide el dueño o queda para otra tanda)

1. **Auditoría de colores y contrastes de TODAS las paletas** (motivo: el rojo de Rojo Gastronómico es
   difícil de contrastar). Revisar cada paleta contra fondos, textos y estados en admin y verticales.
2. **Bot:** el aviso del total todavía sale en pedidos de MESA (la carta ya no lo muestra).
3. **«Sin cebolla» por chat libre:** el bot no puede quitarlo por línea (no tiene los ids de ingredientes;
   `agregar_items_pedido` no acepta «sin»).
4. **Límite de líneas:** `tomar_pedido` acepta 20 y el lector del código de la carta 30; con exclusiones
   distintas las líneas se multiplican y entre 21 y 30 el pedido se rechaza. Igualar.
5. **Borrar la columna de texto `rest_mesa.seccion`** cuando ya no haga falta volver atrás.
6. **Stock al editar ingredientes de un pedido cargado:** quitar la línea vieja NO devuelve stock (regla de
   `quitarItemsOrden`) y la nueva vuelve a descontar.
7. **Sin test de `PedidosComponent` ni `DespachoComponent`**; los flujos nuevos (editar ingredientes,
   finalizar cancelado) solo se probaron por unidades y a mano.
8. **Nada de esto se vio en pantalla por las sesiones** (regla: no abrir el navegador sin permiso): la
   revisión visual la hace el dueño con cuentas reales.
9. Que el dueño cree una sección de prueba en una cuenta real y la borre (es la parte que no se puede
   ejercitar sin sesión).

## 8. Cómo se verificó

- Backend: `npx jest --forceExit` con `DB_PORT=5432` → 88 suites, 1360 pruebas (antes de subir).
- Frontend: `ng test` → 224 pruebas; `ng build` sin errores.
- Producción, solo lectura, antes y después de migrar: estado de las 27 mesas de los 4 negocios (Zona
  Burger, Pregonchos, La Esquina del Barril, Iconic), log sin errores tras el reinicio, rutas con 401.
