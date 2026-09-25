# Sesión 2026-09-25 — Ajustes del POS de restaurante (Pedidos y Despacho)

Solo frontend, en `restaurante_app`. **Sin commit ni despliegue** al cierre de la sesión. No se tocó el
backend: todo se apoya en endpoints que ya existían.

Verificación hecha: `ng build` sin warnings y `ng test` 178/178 (incluye el spec nuevo del menú
lateral). **No se vio en pantalla**: la sesión no abrió el navegador (regla: pedir permiso antes,
gasta créditos). Lo de móvil se razonó sobre el CSS y hay que mirarlo.

## Qué se hizo

### Vista de Pedidos (`restaurante/features/pedidos/`)

| # | Cambio | Dónde |
|---|---|---|
| 1 | El menú lateral se pliega solo al entrar a Pedidos y vuelve a como el usuario lo tenía al salir. Mismo patrón que `PantallaAnchaService` del admin (contador `pedir()/soltar()`, preferencia guardada aparte). | `core/services/sidebar.service.ts` (+ `.spec.ts` nuevo), `pedidos.ts` (`ngOnInit`/`ngOnDestroy`) |
| 2 | Se quitó «$ c/u» de cada ítem; queda `x3 = $precio`. | `pedidos.html` |
| 3 | Encabezado «Pedido» más bajo. Espacio entre los botones de tipo y la fila Mesa/Pago a la mitad (se sumaban el `gap` de `.mesa-field` y un `margin-top` propio de `.mesa-pago-row`; se quitó este último). | `pedidos.scss` |
| 4 | Botón «Editar pedido» junto al título de categoría + modal con pestañas En mesa / Para llevar / Domicilio (solo las que el rol permite), estado vacío informativo, «Editar» / «Cancelar». Carga tipo, mesa o datos de domicilio, forma de pago, productos con exclusiones, nota, descuento y domicilio. En móvil no abre el panel: el botón flotante se alarga con «Pedido cargado correctamente» ~2,8 s. | `pedidos.ts` (`abrirModalEditar`, `cambiarTipoEditar`, `editarPedidoSeleccionado`, `volcarPedidoEditable`, `avisarPedidoCargado`), `pedidos.html`, `pedidos.scss` |
| 5 | Móvil: categorías fijas; scroll propio en productos (con el buscador) y en categorías. `:host` y `.pos-layout` acotados al alto de `.content` en todos los anchos; `.products-panel` con `overflow-y: auto` bajo 992 px. | `pedidos.scss` |
| 6 | Móvil: los botones de acción van al fondo del panel cuando sobra espacio (`.action-btns { margin-top: auto }`); con muchos ítems quedan tras la lista. | `pedidos.scss` |
| 7 | Móvil ≤560 px: En mesa / Para llevar / Domicilio con icono y texto en una línea. | `pedidos.scss` |
| 9 | Móvil ≤767 px: el fondo blanco de la vista llega al borde (margen negativo de `--spacing-md` en `:host`, compensando el padding de `.content`). Solo esta vista. | `pedidos.scss` |
| 10 | Botones de acción con alto único (`$pos-btn-h: 38px`); bloque Total y Nota más compactos y juntos. | `pedidos.scss` |
| 11 | (Petición posterior) Botón de ingredientes: icono `Salad` (antes la tuerca `settings`), a la **izquierda** de `−  n  +` y en la misma fila, 26×26, para que el ítem no crezca en alto por tenerlo. | `pedidos.html`, `pedidos.scss`, `app.config.ts` (registro del icono) |

### Vista de Despacho (`restaurante/features/despacho/`)

- **#8**: se eliminó el chip «Cancelados hoy» y su panel aparte. Los cancelados de hoy
  (`GET /despacho/cancelados`) se pintan como una tarjeta más en la cuadrícula, marcada «Cancelado»
  (color de error, sin interacción de tarjeta) con botón **Finalizar** que la quita.
- Los contadores de los chips (Todos / Para llevar / Domicilio) cuentan también los cancelados
  visibles. Bajo el filtro WhatsApp no se muestran (el endpoint no trae `de_whatsapp`).

## Decisiones y trampas para quien continúe

- **«Finalizar» en un cancelado solo se recuerda en ESE equipo** (`localStorage`,
  clave `despacho_cancelados_finalizados_v1`, ids podados contra lo que el servidor sigue
  devolviendo). No hay columna en el servidor para «ya visto». El endpoint solo devuelve los de hoy,
  así que al día siguiente desaparecen solos. **Decisión abierta:** si debe compartirse entre
  equipos, hace falta columna + migración + endpoint (all-layers).
- **Editar pedido** carga en MESA la orden desde `GET /pedidos/abiertas` (filtra `id_mesa != null`
  y `tipo_pedido` MESA) y en LLEVAR/DOMICILIO desde `GET /despacho` (`estado_pago = pendiente_pago`),
  igual que ya hacía el desplegable de Pedidos. La carga usa `limpiarOrden(false)` primero para que
  no se mezclen datos del pedido anterior. La ruta de MESA además llama `hidratarAjustesPrecio`
  (descuento y domicilio), cosa que `cargarOrdenActivaMesa` (elegir mesa a mano) **no** hace — si
  alguien lo unifica, ojo con esa diferencia.
- **Altura en móvil (#5, #9):** depende de que `:host` con `height: 100%` resuelva contra `.content`
  (`flex: 1; min-height: 0`). En escritorio ya funcionaba así; en móvil es lo nuevo y **es lo
  primero que hay que mirar en pantalla**. Tablet (768–991 px) también recibe el scroll por
  columnas pero conserva el marco gris (el #9 es solo ≤767 px).
- `SidebarService.alternar()` dentro de Pedidos vale para esa visita y **sí** actualiza la
  preferencia guardada (mismo comportamiento que el admin).
- El botón «Editar pedido» se deshabilita con la caja cerrada.

## Pendiente / para mañana

1. **Mirar en pantalla** (con permiso para abrir el navegador): móvil 360–390 px — categorías fijas,
   scroll doble, botones al fondo, margen gris fuera, botón flotante con mensaje, modal Editar,
   fila de acciones del ítem con icono de ingredientes; y Despacho con una tarjeta Cancelado.
2. **Decidir** si «Finalizar» de cancelados debe persistir en el servidor.
3. **Commit y despliegue** (`restaurante_app`): el árbol tiene además cambios de otras sesiones
   (carta virtual, planes, usuarios) — ver `despliegue-pendiente-2026-09-24.md` y la guía de
   pendientes del 25. Archivos de esta sesión: `pedidos.{ts,html,scss}`, `despacho.{ts,html,scss}`,
   `core/services/sidebar.service.ts` y su `.spec.ts`, `app.config.ts` (solo la línea de `Salad`).
   Recordar: commit y push **no** son desplegar; comprobar el VPS mismo.
4. Nota de plan de pruebas si se quiere blindar: no hay spec de `PedidosComponent` ni de
   `DespachoComponent`; los nuevos flujos (modal Editar, finalizar cancelado) están sin test.
