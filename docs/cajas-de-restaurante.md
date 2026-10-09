# Las cajas del restaurante: qué funciona, qué está roto y cómo ligarles el catálogo

**Estado:** análisis y plan · **Fecha:** 2026-10-08 ·
**Implementado y en PROD desde:** 2026-09-23 (`migrate_restaurante_cajas.js`) ·
**Relacionado:** [`precios-y-planes.md`](precios-y-planes.md) (el tope de cajas), [`secciones-de-mesas.md`](secciones-de-mesas.md)

> Preguntas de origen: «¿los productos/categorías deben ir ligados a una caja? ¿al tomar el
> pedido el mesero debe elegir caja y según eso ver categorías/productos? ¿funcionan bien hoy
> las múltiples cajas en Caja, Mesas, Despacho?»
>
> **Respuesta corta:** el catálogo **sí** debe ligarse a la caja, pero por **categoría** y de
> forma **opcional** (NULL = «se vende en todas»), nunca por producto. El mesero **no** debe
> elegir la caja como paso previo del pedido: ya la elige una vez (el selector que existe) y
> eso debe **filtrar** lo que ve. Y no, hoy no funcionan bien: hay **tres fallos latentes** que
> rompen el POS y el asistente de WhatsApp en el instante en que alguien cree su segunda caja,
> y **seis vistas** que mezclan los rubros. Nadie en la base de desarrollo tiene todavía dos
> cajas activas, así que hay margen para hacerlo bien antes del primer cliente que las use.

---

## 1. Qué es una caja aquí (y por qué eso ya responde media pregunta)

Una caja es un **rubro de ingreso**, no un computador ni un cajón. El caso que la originó: un
restaurante que además tiene mini-tienda y quiere ver la plata de la comida por un lado y la de
la tienda por otro — dos arqueos, dos cuentas de resultados. Que dos cajeros cobren a la vez
desde equipos distintos ya se podía antes.

De ahí sale toda la respuesta a la pregunta del catálogo: **si la caja es un rubro, el rubro lo
define lo que se vende.** Una gaseosa sacada de la nevera de la tienda es ingreso de tienda; la
misma gaseosa servida en una mesa es ingreso de restaurante. El vínculo natural no es «producto
→ caja» sino «**categoría de la carta → caja**», con la posibilidad de que una categoría no esté
ligada a ninguna (las bebidas se venden en las dos).

El modelo que ya existe:

| Tabla / columna | Qué es |
|---|---|
| `restaurante.rest_punto_caja` | La caja de verdad: «Restaurante», «Tienda». Nombre, orden, estado. |
| `rest_punto_caja_usuario` | Qué cajas puede usar cada usuario. **Vacía = todas las activas.** |
| `rest_caja.id_punto_caja` | El **turno** (apertura/cierre/arqueo) cuelga de una caja. Índice único parcial: un turno abierto por caja. |
| `pedid_orden.id_punto_caja` | NOT NULL. Es **la** columna que separa los rubros. |
| `pedid_orden.id_caja` | El turno en el que se **cobró**. No es la caja; no confundirlas. |

Y el único sitio donde se decide: `puntoCajaService.resolverPuntoCaja()`. Con una caja la
resuelve sola (de ahí que producción no haya notado nada); con varias y sin elección **lanza**
`PUNTO_CAJA_REQUERIDO` con la lista. Ese «lanza» es el origen de los tres fallos del §3.

---

## 2. Lo que sí funciona

Esto está bien hecho y no hay que tocarlo:

- **Turno por caja.** Abrir, cerrar, arqueo, movimientos, resumen de domiciliarios y validación
  de pendientes al cerrar: todo pasa por `resolverPuntoCaja` y está acotado
  (`cajaService.js:100, 235, 335, 427, 504`). La regla vieja «un turno abierto por negocio» la
  dropeó la migración; ahora la garantiza un índice único parcial por caja, en la base y no en
  JavaScript.
- **El cobro entra en la caja del pedido, no en la del cajero** (`puntoDeOrden`). Es la decisión
  correcta y está aplicada de forma consistente, incluidas las anulaciones
  (`cajaService.js:1128, 1211, 1334`): la reversa vuelve a donde entró la plata.
- **Historial y seguimiento de pedidos filtran por caja** (`cajaService.js:638`,
  `seguimientoPedidoService.js:153`), y el seguimiento del turno incluye los pedidos tomados en
  *su mismo rubro* entre apertura y cierre.
- **Tope por plan** al crear y **también al reactivar** una caja (sin eso bastaba
  desactivar/reactivar para saltarse el límite).
- **Gestión:** pestaña Configuración → Cajas con permiso `caja_gestionar`, asignación por
  usuario en el modal de Usuarios, y selector `shared/caja-selector` que **no se pinta** con una
  sola caja. La elección se recuerda por negocio en `localStorage`.
- **Auditoría** con `trg_audit` en las dos tablas nuevas.

---

## 3. Lo que está roto: tres fallos latentes

Ninguno se nota hoy porque **ningún negocio tiene dos cajas activas** (comprobado en
`escalapp_dev`: todos con una, «Caja principal»). Los tres estallan el día que alguien cree la
segunda, y dos de ellos de forma silenciosa.

### 3.1 — Quitar ítems de un pedido deja de funcionar

`pedidoService.js:897`, en `quitarItemsOrden`:

```js
await cajaService.requireCajaAbierta(idNegocio, { transaction: t });
```

Sin `punto` ni `idUsuario` eso llama a `resolverPuntoCaja` sin ninguna pista → con dos cajas
activas lanza `PUNTO_CAJA_REQUERIDO` (409). **El POS no puede quitar un producto de ningún
pedido**, del rubro que sea. El hermano de al lado, `agregarItemsOrden`, lo hace bien
(`pedidoService.js:688`: `punto: await cajaService.puntoDeOrden(...)`) — es exactamente el
arreglo que falta aquí.

### 3.2 — El asistente de WhatsApp deja de tomar pedidos, alegando que está cerrado

Dos sitios, mismo origen:

- `intelligence/adapters/restaurante/index.js:1171` comprueba la caja abierta sin decir cuál.
- `index.js:1445` llama a `pedidoService.crearOrden` **sin `idPuntoCaja`**, y el autor es el
  usuario «Asistente» (`usuarioAsistenteDao`), que **no tiene ninguna asignación** en
  `rest_punto_caja_usuario` → «ve» todas las cajas → `PUNTO_CAJA_REQUERIDO`.

Lo peor es cómo falla: el `try/catch` del paso 1 traduce *cualquier* error a «el restaurante está
cerrado ahora mismo y no puedo tomar pedidos». Un negocio con dos cajas tendría un bot
rechazando a todos los clientes por estar cerrado, con la caja abierta y en pleno horario.
Añadir ítems por ese mismo camino falla igual (`pedidoService.js:851`,
`agregarItemsPorCliente`, que también lo disfraza de «restaurante cerrado»).

**El arreglo elegante no es cablear un id**: es **asignarle al usuario Asistente su caja** en la
tabla que ya existe. Con una fila en `rest_punto_caja_usuario`, `resolverPuntoCaja` la resuelve
sola y al adaptador solo hay que pasarle `idUsuario`. La pregunta «¿en qué caja entran los
pedidos de WhatsApp?» pasa a tener una respuesta que el administrador puede cambiar desde la
pantalla de Usuarios, en vez de ser una constante en el código.

### 3.3 — Los informes salen mezclados

`reporteService.js` no conoce `id_punto_caja`. Los cinco informes (ventas por período, productos
más vendidos, rendimiento de mesas, rendimiento de usuarios, estado de cocina) suman los dos
rubros en la misma cifra. **Esto vacía de sentido la función entera**: separar los ingresos era
el objetivo, y el sitio donde el administrador va a mirarlos no los separa. Ya estaba anotado
como pendiente desde el despliegue de septiembre.

---

## 4. Lo que está mezclado: las vistas que no saben de cajas

No son fallos —no revientan— pero enseñan los dos rubros revueltos:

| Vista | Función | Qué pasa con dos cajas |
|---|---|---|
| **Pedidos** (lista de abiertos) | `pedidoService.js:1325` `getOrdenesAbiertas(idNegocio)` | El cajero de Tienda ve los pedidos del restaurante, y al revés. |
| **Cocina** | `pedidoService.js:1397` `getOrdenesCocina(idNegocio)` | Una venta de abarrotes aparece en la pantalla de cocina. |
| **Despacho** | `pedidoService.js:1087` `getOrdenesDespacho` | Un `LLEVAR` de la tienda cae en la cola de domicilios. |
| **Informes** | `reporteService.js` (todo) | Ver §3.3. |
| **Dashboard** | `dashboardService.js:559` | KPIs del día sumando rubros. *Discutible: «el negocio entero» puede ser justo lo que se quiere ver ahí.* |
| **Mesas** | `mesaService.js` | En la práctica se salva: un pedido de tienda es `LLEVAR` y no tiene mesa. No requiere cambio. |

Y lo que **no** debe saber de cajas, para que quede dicho: inventario y stock (un insumo es uno
solo, físico, y no tiene rubro), proveedores y compras, clientes/fiado/tiqueteras, usuarios,
horarios, métodos de pago, barrios de domicilio y la vitrina pública. Meterles caja es inventar
trabajo y duplicar datos.

---

## 5. La decisión de fondo: cómo se liga el catálogo

### 5.1 — Las tres opciones

**A. Categoría ligada a caja, opcional.** `carta_categoria.id_punto_caja` nullable: NULL = «se
vende en todas las cajas». El producto **no** lleva columna: hereda la de su categoría. La caja
elegida en el selector **filtra** lo que el POS enseña.

**B. Dejarlo como hoy** (solo el selector de caja, catálogo completo siempre). Sale gratis, pero
el reparto por rubro queda a merced de la disciplina de quien cobra: nada impide meter un
producto de la tienda en un pedido de restaurante, y entonces los informes del §3.3 —ya
arreglados— seguirían mintiendo. Cuesta cero y deja el objetivo a medias.

**C. Caja deducida de los ítems, sin selector.** Elegante sobre el papel y mala en la práctica:
no resuelve el pedido mixto, no resuelve las categorías comunes, y choca con que la caja también
determina el **turno** — el cajero necesita saber en qué turno está *antes* de tocar nada, no
después del primer producto.

**Recomendada: A.** Es la única que hace que los números por rubro sean ciertos por
construcción y no por confianza, y la que menos pregunta: el mesero ya elige su caja una vez al
entrar (o nunca, si solo tiene una), no una vez por pedido.

### 5.2 — Por categoría y no por producto

Tres razones, en orden de peso:

1. **Una sola fuente de verdad.** Con columna en las dos tablas aparece el estado imposible
   (producto de la caja Tienda dentro de una categoría de Restaurante) y alguien tiene que
   decidir cuál gana, en cada consulta, para siempre.
2. **Es como piensa el negocio.** «La tienda» es un bloque de categorías («Abarrotes»,
   «Mecato»), no una selección suelta de productos.
3. **Es la mitad de trabajo.** El POS ya trae el catálogo por categorías
   (`cartaService.js:62, 233`); filtrar ahí son tres consultas, no una revisión de todo el árbol
   de productos.

### 5.3 — Qué significa NULL

«Se vende en todas las cajas». Es el valor con el que nace **todo** lo que ya existe, y es lo que
hace que el negocio de una caja no note nada: con una sola caja el filtro no filtra. Y es
imprescindible para las bebidas y el mecato, que son del restaurante y de la tienda a la vez.

### 5.4 — El pedido mixto

Con el catálogo filtrado un pedido no puede nacer mixto desde el POS. Pero hay que cerrarlo **en
el servidor**, porque la API es alcanzable por cualquiera con token y el asistente escribe por
otro camino: al crear o al añadir ítems, **ningún ítem puede pertenecer a una categoría de otra
caja** (las NULL siempre valen). Error tipado `PRODUCTO_DE_OTRA_CAJA` (422). Sin esa validación
la opción A es solo un adorno de la interfaz.

### 5.5 — Lo que NO cambia

El selector se queda como está: no se pinta con una caja, es un grupo de botones y no un
`<select>`, y recuerda la elección. Lo único nuevo es que además de decidir el turno, decide el
catálogo. **No se añade ningún paso al flujo del pedido.**

---

## 6. Plan por fases

### Fase 0 — Los tres fallos (antes que nada, y antes de que nadie cree su segunda caja)

1. `quitarItemsOrden`: `punto: await cajaService.puntoDeOrden({ idOrden, transaction: t })`,
   igual que `agregarItemsOrden`. (`pedidoService.js:897`)
2. `agregarItemsPorCliente`: lo mismo. (`pedidoService.js:851`)
3. Asistente: migración idempotente que **asigne el usuario Asistente a la caja principal** de su
   negocio (`rest_punto_caja_usuario`), pasar `idUsuario` en `index.js:1171` y dejar que
   `crearOrden` resuelva. Y que el `catch` de «restaurante cerrado» **no** se coma los códigos
   `PUNTO_CAJA_*`: un fallo de configuración no debe disfrazarse de horario.
4. Un test que cree dos cajas y recorra el flujo completo —tomar, añadir, quitar, cobrar— por las
   dos. Es lo que habría cazado los tres.

Sin nada del resto, esto ya deja el sistema **honesto**: con dos cajas funciona, aunque enseñe
los rubros mezclados.

### Fase 1 — Informes por caja

`reporteService`: parámetro `id_punto_caja` opcional en los cinco informes (filtro sobre
`o.id_punto_caja`, con el patrón `CAST(:idPunto AS integer) IS NULL OR ...` que ya usa
`listarHistorialCajas`), columna «Caja» en las exportaciones y selector en la vista de Informes
que solo se pinta con más de una caja. **Es la fase que le da sentido a la función**; si solo se
hace una cosa después de la fase 0, es esta.

### Fase 2 — El catálogo ligado (la opción A)

1. Migración: `carta_categoria.id_punto_caja` nullable + FK + índice, todo lo existente en NULL.
2. `cartaService.getCategorias` / `getProductosByCategoria` / `buscarProductos`: parámetro
   opcional de caja, filtro `id_punto_caja IS NULL OR id_punto_caja = :idPunto`.
3. Validación servidor `PRODUCTO_DE_OTRA_CAJA` en `crearOrden` y en los dos `agregarItems`.
4. Admin de la carta: selector de caja en la categoría, visible solo con más de una.
5. POS: pasar la caja activa al pedir el catálogo y recargarlo al cambiar de caja.

### Fase 3 — Las vistas operativas

`getOrdenesAbiertas`, `getOrdenesCocina` y `getOrdenesDespacho` con filtro opcional por caja; el
frontend manda la activa. Mesas no necesita nada. El Dashboard es una decisión de producto:
sumar los rubros ahí probablemente sea lo correcto, y si no, el mismo filtro.

### Lo que no hay que hacer

- **Columna `id_punto_caja` en `carta_producto`.** Ver §5.2.
- **Ligar mesas o secciones a una caja.** No hace falta: un pedido de tienda no tiene mesa.
- **Sembrar asignaciones de usuario** al crear la segunda caja. Ya se intentó en la migración
  original y rompía: la caja nueva quedaba inusable para todos. «Sin asignación = todas» se
  queda.
- **Hacer obligatoria la caja en el pedido desde el frontend.** El negocio de una caja no debe
  ver la pregunta nunca, y hoy no la ve: el frontend solo manda `id_punto_caja` cuando hay más
  de una.
