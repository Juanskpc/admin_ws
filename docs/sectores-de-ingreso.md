# Sectores de ingreso del restaurante (rubros)

**Estado:** implementado, **SIN desplegar** · **Fecha:** 2026-10-10 ·
**Migración:** `restaurante-rubros` ·
**Relacionado:** [`cajas-de-restaurante.md`](cajas-de-restaurante.md) (por qué las cajas no servían para esto)

> Pregunta de origen: «un restaurante maneja 3 tipos de comida y quiere ver cuánto queda en cada
> uno al final del día y del mes. Pensaba en cajas separadas, pero no lo veo necesario porque
> solo habrá un único pago si una mesa pide de los 3 sectores.»
>
> **La intuición de no usar cajas era correcta, y por una razón dura:** una orden pertenece a una
> sola caja (`pedid_orden.id_punto_caja` es NOT NULL), así que el pedido mixto con un solo pago
> no se puede representar — habría que partir la cuenta en tres y cobrar tres veces. El rubro
> tiene que vivir un nivel más abajo: en el **ítem**.

---

## 1. Caja y sector son dos ejes distintos

Lo que los separa no es el nombre, es **a qué se pega la atribución**:

| | Caja (`rest_punto_caja`) | Sector (`rest_rubro`) |
|---|---|---|
| Se pega a | la **orden** | el **ítem**, vía la categoría del producto |
| Para qué | dos arqueos, dos cajones, dos turnos | dos cuentas de resultados |
| Pedido mixto | imposible: una orden, una caja | se reparte solo |
| Cuesta | cuenta contra el tope del plan y se vende como complemento | nada |
| Toca el flujo del POS | sí (selector de caja, decide el turno) | **no** |

Las dos pueden coexistir y ninguna estorba a la otra. Un negocio con una caja y tres sectores es
el caso normal de esta función.

La cadena de atribución:

```
pedid_detalle.subtotal
  → carta_producto.id_categoria      (NOT NULL: cubre el 100 % de los ítems)
    → carta_categoria.id_rubro       (nullable: NULL = «General»)
      → rest_rubro
```

Como `id_categoria` es NOT NULL, **no hay datos que retro-llenar**: el día que alguien cree sus
sectores y marque las categorías, los informes de los meses anteriores ya salen partidos.

## 2. Por categoría y no por producto

Tres razones, en orden de peso:

1. **Una sola fuente de verdad.** Con columna en las dos tablas aparece el estado imposible
   (producto del sector Sushi dentro de una categoría de Parrilla) y alguien tiene que decidir
   cuál gana, en cada consulta, para siempre.
2. **Es como piensa el negocio.** «La parrilla» es un bloque de categorías, no una selección
   suelta de productos.
3. **Es la mitad del trabajo.** El POS y los informes ya agrupan por categoría.

Si una categoría de verdad está partida entre dos sectores, la respuesta es **partir la
categoría**, no añadir una columna al producto.

## 3. `id_rubro IS NULL` = «General»

Es el valor con el que nace todo lo que ya existe, y es imprescindible: las bebidas y el mecato
son de todos los sectores a la vez. En los informes salen agrupados en una fila «General».

## 4. La tabla nace vacía, y eso **es** la función

«Solo para negocios que separen sectores» no necesita un interruptor en `gener_negocio`: lo dice
el propio dato. `rubroService.negocioUsaRubros()` es el único conmutador, y de él cuelgan:

- la pestaña **Informes → Ventas por sector** (`tipoOptions` en `reportes.ts`),
- el bloque **Venta por sector** de Caja y del modal de cierre,
- y el rechazo `RUBROS_NO_CONFIGURADOS` (422) del informe por API, para que la pantalla y el
  servidor digan lo mismo.

El negocio que no crea ningún sector no ve nada nuevo en ninguna pantalla.

## 5. El cuadre: lo que no es producto va aparte, no prorrateado

El sector solo puede explicar la venta de **productos**. El impuesto, el domicilio y el descuento
son de la orden completa, y se enseñan en líneas propias:

```
Parrilla            $1.240.000
Sushi                 $890.000
General (bebidas)     $320.000
                    ───────────
Venta de productos  $2.450.000
  + Impuestos           $34.000
  + Domicilios          $85.000
  − Descuentos          $19.000
                    ───────────
TOTAL COBRADO       $2.550.000
```

**No se prorratean a propósito.** Repartirlos haría que la suma de sectores diera el total
exacto, pero cada cifra llevaría centavos que nadie puede reconstruir desde los tiquetes — y la
pregunta «¿por qué Parrilla da $1.283.512 y no $1.240.000?» habría que contestarla cada vez.

La fórmula cuadra por construcción porque es la misma que usa `pedidoService` al cobrar
(`pedidoService.js:466`): `total = subtotal + impuesto + domicilio − descuento`, y `subtotal` es
la suma de los detalles. `graficas.conciliacion.descuadre` lo comprueba en cada consulta y la
pantalla **lo enseña** cuando no es 0, en vez de esconderlo: un descuadre ahí es un dato roto.

## 6. Qué hay en cada capa

### Base de datos — `migrate_restaurante_rubros.js`

| | |
|---|---|
| `restaurante.rest_rubro` | nombre, descripción, color (#RRGGBB para las gráficas), orden, estado. `UNIQUE (id_negocio, nombre)`. Sin tope de plan. |
| `carta_categoria.id_rubro` | nullable, `ON DELETE SET NULL`, índice parcial `WHERE id_rubro IS NOT NULL` |
| `trg_audit` | en `rest_rubro`: mover una categoría de sector cambia un número que alguien va a comparar contra el mes pasado |

**La FK nueva no rompe el borrado de negocios** (ver el gotcha de
`gener_negocio.id_metodo_pago_domicilio`): no sale de la fila del negocio, sino de una tabla que
cuelga de él hacia otra que también cuelga de él, así que el orden topológico de `construirPlan`
la resuelve. Centinela: `__tests__/negocios/eliminar_orden.test.js`.

### Backend

- **`rubroService.js`** — CRUD + `fijarCategorias` (fija de una vez el reparto; una categoría
  solo puede estar en un sector, así que marcarla aquí la saca de donde estuviera) +
  `negocioUsaRubros`. Escribir exige **`caja_gestionar`**, reusado a propósito: es la misma
  decisión que las cajas, la toma la misma persona en la misma pantalla, y un subnivel nuevo
  exigiría sembrarlo en TRUE y desplegarlo antes del frontend. Leer no exige nada.
- **`reporteService.js`** — dos informes nuevos (`ventas_rubro`, `ventas_dia_semana`), el cruce
  con productos en `rendimiento_usuarios`, y `getCatalogoProductos` para el selector.
- **`cajaService.getDesglosePorRubro(idCaja, idNegocio)`** — ver §8.
- **Rutas:** `GET/POST /rubros`, `PUT /rubros/:id`, `PUT /rubros/:id/categorias`,
  `DELETE /rubros/:id`, `GET /reportes/productos`.

### Frontend (`negocio_app`)

- `core/services/rubro.service.ts` — la lista, cacheada por negocio; `tieneRubros()` es lo que
  consultan las pantallas.
- `configuracion/rubros-panel/` — pestaña **Configuración → Sectores**. Crear el sector y
  repartir las categorías se hacen en la misma pantalla, a propósito: desde la carta habría que
  entrar categoría por categoría y recordar el reparto de memoria.
- `reportes/` — pestañas nuevas, selector de productos, tarjeta de cuadre, matriz usuario ×
  producto.
- `caja/` — bloque «Venta por sector» en el panel y en el modal de cierre.

## 7. Los informes nuevos

### `ventas_rubro`

Tabla: sector · unidades · pedidos · venta · participación. La participación sale de una ventana
sobre **todos** los grupos, así que la fila dice su peso en el período y no en la página.

«Pedidos» cuenta los pedidos que incluyeron **algo** de ese sector, así que un pedido mixto cuenta
en los tres y la columna **no suma** al total de pedidos. Es lo correcto para la pregunta («cuántos
pedidos tocaron la parrilla») y por eso el total de pedidos vive en el cuadre, no en la tabla.

El sector **no se filtra por estado**: un sector desactivado sigue saliendo separado en el
histórico, o los meses anteriores cambiarían de cifras al desactivarlo.

### `ventas_dia_semana`

Siete filas siempre (lunes → domingo), sin paginar. La cifra que de verdad compara es
**`promedio_por_dia`**, no el total: un rango de 30 días trae cinco lunes y cuatro martes, y el
total del lunes sale más alto solo por eso. `dias_en_rango` cuenta cuántas veces cayó ese día en
el rango —**incluidos los que no vendieron nada**— y va como columna para que el promedio se pueda
rehacer a mano. El ranking de la gráfica y los KPI «día que más/menos vende» usan el promedio.

### `rendimiento_usuarios` + productos

`?id_producto=3,7` (lista o CSV, tope 20). Con productos elegidos **cambian las columnas**:
las cifras pasan a salir de `pedid_detalle` y no de la orden, así que un pedido de $80.000 en el
que el mesero puso una gaseosa de $4.000 aporta $4.000. Mezclar las dos formas en las mismas
columnas invitaría a sumar peras con manzanas.

El usuario es `pedid_orden.id_usuario`, **quien tomó** el pedido: es la pregunta que se hace
(«quién lo vendió»), no quién lo cobró.

`graficas.matriz` trae la matriz usuario × producto ya armada, con una celda por producto
seleccionado **en el orden de las columnas y con los ceros incluidos**. Un producto elegido que no
vendió nada sale igual: si solo apareciera cuando vendió, no se podría distinguir «nadie lo
vendió» de «me equivoqué al seleccionarlo».

## 8. El corte por sector en Caja

**No es un segundo arqueo.** El arqueo es `ingresos_por_metodo`, que cuadra el cajón.

Los pedidos que cuentan son los que tienen un **INGRESO vigente en ese turno**, con el mismo
criterio que `getDesglosePorMetodo` (del par anulado no cuenta ninguna de las dos filas).

**Por qué no `pedid_orden.id_caja`:** esa columna se escribe al cobrar y puede quedar apuntando a
un turno sin su movimiento detrás. Pasa con datos cargados en bloque — en `escalapp_dev` el turno
15 tiene 535 pedidos con `id_caja = 15` y solo 15 movimientos, y anclarlo ahí enseñaba $31 M de
venta por sector junto a $887 k de cajón esperado. Atado al movimiento, el corte habla de la
plata que de verdad entró, que es la pregunta de quien cierra.

La suma **sigue sin tener que cuadrar con el cajón**, y eso está bien: ahí también hay abonos a
cuentas y egresos manuales sin productos detrás, y la parte de un pedido que pagó una tiquetera no
entró como plata. La pantalla lo dice en el subtítulo.

Sin `caja_ver_ingresos` el bloque se va entero (`ocultarImportesCaja`), igual que el de formas de
pago: es una cifra de venta y dejarla sería contar la plata del turno por otra vía.

> **Ojo al tocar Caja:** `getCajaAbierta` lleva sus propios totales y **no** pasa por
> `calcularTotalesCaja` (tiene los movimientos ya incluidos y se ahorra una consulta). Lo que se
> añada a uno hay que añadirlo al otro — `/caja/abierta` es la pantalla principal.

## 9. Lo que NO cambia

- **El flujo del pedido.** El sector no se elige, se deduce. No hay un paso nuevo en el POS, ni
  un selector, ni una pregunta. El catálogo del POS **no** se filtra por sector: eso sería la
  opción A de [`cajas-de-restaurante.md`](cajas-de-restaurante.md), que es para las cajas.
- **El cobro.** Un pago por pedido, como siempre. Que el pedido sea mixto es justo el caso que
  esto resuelve.
- **Inventario, proveedores, clientes, mesas, cocina y despacho.** Un insumo es uno solo y físico;
  un sector no es un sitio.
- **El tope del plan.** Los sectores no se cobran.

## 10. Pendientes

- **Desplegar.** Migración ANTES del backend, y el frontend al final. Ver abajo.
- **Dashboard por sector.** Decidido dejarlo fuera: el dashboard mira el día en curso con pedidos
  todavía abiertos, y ahí «el negocio entero» suele ser lo que se quiere ver.
- **Filtro de sector en los informes que ya existen** (ventas por pedido, productos más vendidos).
  Se valoró y se dejó fuera: `ventas_rubro` más el cruce con productos cubren las preguntas, y un
  selector más en la barra de filtros se paga en ruido.
- **Informes por sector consolidados entre sedes.** Cada sede es un `id_negocio` con sus propios
  sectores; juntarlos es el mismo pendiente que el resto de los informes consolidados (ver
  [`sedes.md`](sedes.md)).

## 11. Orden de despliegue

```bash
# 1. VPS: backup y migración ANTES del backend
ssh escalapp@45.63.105.95
cd /var/www/admin_ws
pg_dump ... > ~/backups/db_predeploy_rubros.dump      # como siempre
git pull && npm install --omit=dev
node scripts/migrar.js restaurante-rubros
node scripts/migrar.js --estado                        # comprobar que quedó apuntada
sudo systemctl restart escalapp-api
journalctl -u escalapp-api -n 30 --no-pager

# 2. Frontend (desde el PC), ya construido
cd negocio_app && npm run build
tar -czf negocio.tgz -C dist/negocio-app/browser .
# ... y el `cp index.csr.html index.html` de siempre (esta app no prerenderiza)
```

La migración es aditiva y nace vacía: entre el paso 1 y el 2 no hay ventana de incoherencia —
sin sectores creados, el frontend viejo y el nuevo se comportan igual.

## 12. Tests

`npx jest __tests__/restaurante/rubros.test.js` — 35 casos. Los que de verdad defienden el
diseño:

- el pedido mixto con un solo pago se reparte entre los tres sectores;
- la suma de sectores es la venta de productos, y productos + impuesto + domicilio − descuento da
  el total cobrado, con `descuadre === 0`;
- lo que no es producto **no** se reparte entre sectores;
- la participación se mide sobre el período y no sobre la página;
- una categoría vive en un solo sector, y la de otro negocio no se puede escribir por la API;
- desactivar un sector no desasigna sus categorías;
- el promedio por día divide por las veces que cayó ese día, no por los días con venta;
- con productos elegidos las cifras son del ítem y no del pedido;
- el corte de caja se mide sobre los movimientos, no sobre `pedid_orden.id_caja`.
