# Venta de productos en `reserva`

**Estado:** implementado (Fase 1 + portal) en local, sin desplegar · **Fecha:** 2026-09-28 ·
**Parte de:** [`perfiles-de-reserva.md`](perfiles-de-reserva.md) (el motor de funciones que esto reutiliza)

> **La idea, en una frase.** Cualquier negocio de `reserva` —barbería, salón, spa, estética,
> tatuador, cuidado de mascotas, alojamiento— puede publicar un catálogo de productos físicos
> junto a sus servicios. El cliente los compra en el mismo portal, con o sin cita; el negocio
> también los vende de mostrador. Es una función más del perfil, como Mascotas o Cabinas: **se
> ofrece a los siete oficios y nace apagada de fábrica.**

---

## 1. Por qué es una función del perfil y no una pantalla aparte

`reserva` ya tiene el mecanismo exacto que esto necesita
(`app_reserva_api/perfiles/definiciones.js`): un catálogo de `FUNCIONES`, una lista de qué
perfiles la tienen `disponibles`, y `exigirFuncion()` para cortar una ruta entera si el negocio
no la encendió. Añadir `productos` ahí en vez de inventar un sistema de banderas propio significa
que **todo lo demás llega gratis**:

- La vista `/productos` se quita sola del menú y del guard cuando la función está apagada
  (`vistasPermitidas` / `VISTAS_SOLO_DE_PERFIL` en el frontend).
- El interruptor aparece solo en Configuración → Funciones (`funcionesConfigurables` ya es
  genérico: no hay una lista blanca que actualizar).
- `exigirFuncion('productos')` protege las rutas del panel y la del portal con la misma línea
  que usan Mascotas o Estancias.

Ninguna de las siete definiciones de perfil la trae en `activas`: **nace apagada en todos**, a
diferencia de `controla_inventario` en restaurante (que nace encendida porque retira una
comprobación que ya corría). Aquí se añade una función que no existía, así que el criterio es el
mismo que `permite_cuentas_cliente`: opt-in.

---

## 2. Modelo de datos (todo aditivo — `reserva` tiene cliente en producción desde 2026-09-09,
   ADR-003 aplica)

`npm run migrate:reserva-productos`, seguida de `npm run migrate:reserva-subniveles` (las
acciones cuelgan de una vista que la primera migración tiene que crear antes).

| Tabla | Para qué |
|---|---|
| `reserva_producto_categoria` | Secciones del catálogo de productos. **Propia**, no `reserva_categoria` (esa es de servicios): mezclarlas habría obligado a filtrar por tipo en cada sitio que ya la consulta. |
| `reserva_producto` | El catálogo. `controla_stock` nace en `false` — la mayoría de negocios no va a mantener un inventario al día, y un stock sin mantener cayendo a negativo es peor que no tener stock. `publico_activo` decide si se ve en el portal (`false` = solo mostrador). |
| `reserva_venta_producto` | La venta (mostrador o portal). `id_cita` es **nullable**: se puede comprar sin cita. `id_profesional` es quién vendió, para una comisión futura — nunca obligatorio. `canal` (`MOSTRADOR`\|`PORTAL`) y `entrega` (`MOSTRADOR`\|`RECOGER`; domicilio queda para después, ver §6). |
| `reserva_venta_producto_detalle` | Líneas con precio congelado (`precio_snapshot`), igual que `reserva_cita_servicio`. |
| `reserva_movimiento_caja.id_venta_producto` | Para que una venta de producto se vea en el cuadre exactamente como un cobro de cita. |
| `reserva_config.comision_productos_pct` | `0` por defecto — la comisión es una decisión del negocio, nunca algo que se enciende solo. |

---

## 3. El dinero: reutiliza el patrón de citas, no lo duplica

`ventaProductoService.js` toma prestadas las piezas de `cobroService.js`
(`normalizarPagos`, ahora también `centavos` exportado) en vez de reimplementar la validación de
multipago. Tres operaciones:

- **`crear`** — dos pasos (crea PENDIENTE, cobra después): el flujo de un pedido del portal.
  Relee el catálogo y congela el precio; un `precio` que llegara en el `item` se ignora — nunca
  se confía en el cliente para decidir cuánto cobrarle.
- **`cobrar`** — exige caja abierta (`CajaService.requireCajaAbierta`, igual que una cita) y
  asienta **un movimiento de caja por forma de pago**. Descuenta stock si `controla_stock` está
  activo — **sin bloquear la venta** si el stock no alcanza: un conteo desactualizado no debe
  impedir una venta real.
- **`venderYCobrar`** — los dos pasos en una transacción: el «un clic» del mostrador.

**Verificado, no asumido:** `getTotales`, `getDesglosePorMetodo` y `getResumenPorProfesional` no
filtran por `id_cita`, así que una venta de producto entra sola al cuadre general, al desglose
por forma de pago y —si lleva `id_profesional`— al resumen de liquidación por persona, sin tocar
ese código. Lo que `getResumenPorProfesional` cuenta como «citas» (`COUNT(DISTINCT id_cita)`)
tampoco se infla: una venta de producto no tiene `id_cita`.

### El bug real que cazó la suite de tests

`cobrar()` intentaba bloquear la fila de la venta (`FOR UPDATE`) en la misma consulta que traía
el detalle (`include`), y Postgres lo rechaza: *"FOR UPDATE no puede ser aplicado al lado nulable
de un outer join"*. Se soluciona bloqueando la cabecera sola y leyendo el detalle aparte, sin
lock (no se muta ahí). Sin el test de cobro con stock, esto habría llegado a producción.

---

## 4. Permisos

Vista `/productos` (rol ADMINISTRADOR: todo; RECEPCIONISTA: crear/editar; PROFESIONAL: nada por
defecto — se ajusta desde Usuarios → Roles). Dos acciones, sembradas en
`migrate_reserva_subniveles.js`:

- `productos_editar` — el catálogo (ADMINISTRADOR).
- `productos_vender` — vender de mostrador y cobrar pedidos del portal (ADMINISTRADOR,
  RECEPCIONISTA).

---

## 5. El portal público

`vitrinaService.getVitrina` añade `productos` (plano) y `producto_secciones` (agrupado por
categoría, igual que `secciones` para servicios), solo cuando `fx.has('productos')`. Es la misma
llamada de siempre — «una sola vez, no seis» — no un endpoint nuevo.

El carrito (`carrito-productos.service.ts`) es hermano del carrito de restaurante, más simple
porque aquí no hay WhatsApp de por medio: el pedido va directo por API
(`POST /publico/:id_negocio/venta-producto`), no por un mensaje. Por eso el portal sí necesita
pedir nombre (obligatorio) y teléfono (opcional, para avisar) — el cliente no llega por su
WhatsApp como en restaurante, así que no hay un número que el canal ya haya probado.

El pedido nace **PENDIENTE**: el negocio lo ve en Productos → Pedidos del portal y lo cobra al
entregarlo (misma pantalla, mismo permiso `productos_vender`). El precio, otra vez, lo relee el
servidor — el carrito solo manda `id_producto` y `cantidad`.

---

## 6. Lo que decidió el dueño del producto (2026-09-28)

1. **Domicilio, más adelante.** Hoy solo «recoger en el local» (`entrega = 'RECOGER'`). El
   esquema ya reserva la columna `entrega` con el valor `MOSTRADOR`\|`RECOGER`; domicilio es un
   tercer valor y una pantalla de dirección, no un cambio de forma.
2. **Comprar sin cita: sí.** `id_cita` es nullable desde el día uno; es el caso más simple, no
   una excepción.
3. **Comisión: opcional, apagada por defecto.** `reserva_config.comision_productos_pct = 0`.
   Cada línea de venta guarda `id_profesional` (quién vendió) para que el cálculo de la comisión
   sea un informe futuro, no una reescritura del modelo.

---

## 7. Lo que falta (a propósito, fuera de esta fase)

- **Calcular y pagar la comisión.** El dato ya se guarda (`id_venta_producto.id_profesional`,
  `reserva_config.comision_productos_pct`); falta el informe que lo multiplique. No estaba
  pedido para esta entrega.
- **Domicilio de productos.** Ver §6.1.
- **Seguimiento del pedido para quien vuelve.** La cita tiene `GET /publico/cita/:codigo`
  (`consultarCita`) para que el cliente vuelva a ver su reserva; la venta de producto no tiene su
  equivalente todavía — la confirmación se muestra una vez, en el momento de pedir.
- **Producto como cargo de una estancia** (minibar, souvenirs en la recepción de un hostal).
  `reserva_estancia_cargo` ya existe para cargos sueltos; conectarlo con el catálogo de
  productos es una extensión natural, no construida aquí.
- **Galería de fotos por producto.** Hoy una sola imagen (`imagen_url`), como tenían los
  servicios antes de su galería. Se puede repetir el patrón de `servicio_imagen` si hace falta.

## 8. Verificación

- Backend: `__tests__/reserva/productos.test.js` (19 casos: catálogo, el precio siempre se relee
  del servidor, cobro con y sin stock controlado, `venderYCobrar`, cancelar, venta sin cita) +
  `__tests__/reserva/perfiles.test.js` (la función en los siete perfiles, apagada de fábrica, sin
  tocar el golden test de la barbería). Suite completa de `reserva` y del backend, en verde
  contra la base local.
- Frontend: build de producción limpio; `carrito-productos.service.spec.ts` (12 casos: sumar/
  restar, persistencia por negocio, vigencia de 90 días, y que el pedido nunca manda un precio).
