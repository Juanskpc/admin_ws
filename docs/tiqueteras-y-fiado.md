# Tiqueteras y fiado (cuentas de cliente) — restaurante

**Desde 2026-09-11.** Pantalla `Clientes` en `restaurante_app`, API en `/restaurante/clientes/*`,
migración `npm run migrate:restaurante-cuentas`.

## Qué resuelve

En Colombia es corriente que un cliente de confianza **pague por adelantado** la comida del mes
(la «tiquetera») o que **coma y pague al final** (el fiado). Lo pidió el dueño de un restaurante,
y es común en su zona.

La decisión de partida, que es la que ahorra la mitad del trabajo: **no son dos funciones, son la
misma cuenta con el signo cambiado.**

| | Saldo | Significa |
|---|---|---|
| Tiquetera (prepago) | **positivo** | el restaurante le debe comida |
| Fiado (pospago) | **negativo** | el cliente debe plata, hasta su `cupo` |

Por eso hay un módulo y no dos, y por eso se llama *Clientes* y no *Tiqueteras*.

## ⚠️ Nace APAGADO: `gener_negocio.permite_cuentas_cliente`

**Opt-in por negocio, el mismo patrón que `permite_multipago`, `permite_descuento` y
`pregunta_cobro_envio`.** Mientras el interruptor esté apagado —y nace apagado para todos— el
módulo **no existe** para ese negocio:

- no aparece el menú *Clientes* (ni escribiendo la URL a mano: lo para el guardia),
- la forma de pago «Cuenta / Tiquetera» está `estado='I'`, así que **no sale en el cobro**,
- y la API `/restaurante/clientes/*` responde 403 `CUENTAS_NO_HABILITADAS`.

Lo último importa: esconder un menú no cierra una API. Se comprueba en el servidor.

Se enciende en **Configuración → Tiqueteras y fiado**, y el interruptor activa también su forma
de pago en la misma transacción: un negocio con las cuentas apagadas pero «Cuenta / Tiquetera» en
el desplegable de cobro es justo el estado confuso que esto existe para evitar.

**Apagarlo esconde, no borra**: los saldos quedan intactos y vuelven al encenderlo.

## El cliente no es una tabla nueva

Es `platform.persona_negocio` (ADR-006), la misma ficha que ya usan los pedidos
(`pedid_orden.id_persona_negocio`) y el asistente de WhatsApp. `reserva` hizo lo mismo con su
cartera de clientes. El teléfono es **opcional**: media clientela de tiquetera de un restaurante
de barrio no lo da, y exigirlo llevaría a inventar números.

## ⚠️ Lo importante: que la plata no se cuente dos veces

Hasta ahora el sistema descansaba en una equivalencia: **pedido = venta = plata en el cajón**. Los
informes sacan las ventas de `pedid_orden.total` y la caja saca el efectivo de
`rest_movimiento_caja`. Una tiquetera rompe eso, porque el dinero entra un día y la comida sale
otro.

El reparto, que es la decisión central del módulo:

| Cuándo | ¿Es venta? | ¿Mueve el cajón? | Cómo se anota |
|---|---|---|---|
| Vender tiquetera / recibir abono | **no** | **sí** | INGRESO en caja «Tiquetera &lt;cliente&gt;», **sin pedido** + ABONO en el libro |
| Comer con la cuenta | **sí** | **no** | pedido normal + **un solo INGRESO por lo que NO paga la cuenta** (de cero si la paga toda) + CARGO en el libro |

### ⚠️ Cambió el 2026-09-14: ya no hay EGRESO al comer con la tiquetera

Hasta ese día, comer con la cuenta dejaba un INGRESO por el total del pedido y un EGRESO por la
parte de la cuenta que lo anulaba — el truco del cobro del domicilio. El arqueo cuadraba, pero:

1. **En Caja el EGRESO salía como «Domicilio»**, porque `getMovimientos` etiquetaba así cualquier
   egreso atado a un pedido. El cajero veía un domicilio que no existía.
2. **En un multipago el desglose por forma de pago mentía.** El EGRESO se repartía en proporción
   contra *todas* las formas de pago, efectivo incluido: un pedido de $15.000 pagado con $5.000 en
   efectivo y $10.000 de tiquetera dejaba $1.667 de efectivo en el desglose, con $5.000 en el cajón.

Ahora el ingreso **nace ya sin la parte de la cuenta**: `cajaService.registrarIngresoOrden` recibe
`montoContraCuenta`, y `pedidoService` lo calcula *antes* de anotar el ingreso (en `marcarPagado` y
en `cerrarOrden`). El desglose (`getDesglosePorMetodo`) y la columna de formas de pago
(`formasPagoDeMovimiento`) reparten solo entre las formas de pago que **no** son de cuenta, y la de
cuenta sale con valor cero — sigue en la lista para que filtrar por ella encuentre el pedido. Ese
mismo reparto deja bien los turnos viejos: su ingreso por el total y su egreso de la cuenta caen
enteros sobre las formas de pago reales y el neto es la plata que entró.

Los EGRESOS «Consumo de …» de antes del cambio se siguen viendo en los turnos viejos, ahora
etiquetados como «Tiquetera» y no como domicilio.

**Sigue habiendo INGRESO aunque sea de cero**, por el mismo motivo que en los pedidos regalados: sin
él, el pedido desaparecería del listado del turno, y ahí es justo donde el negocio quiere ver lo que
sirvió. Un cero que pagó la cuenta no pasa por `exigirCeroJustificadoPorDescuento`.

Cubierto por `__tests__/restaurante/cuentas_tiquetera.test.js`: el neto de caja antes y después,
que el pedido deje un único INGRESO de cero, y el multipago efectivo + cuenta midiendo el desglose.

## Vender una tiquetera por producto: el valor lo pone la carta (desde 2026-09-14)

Una tiquetera se paga por adelantado y vale **precio del producto × cantidad − descuento**.
`registrarAbono` lo calcula con el precio de `carta_producto` e **ignora el `monto` que mande el
navegador**: antes el cajero escribía el total a mano, y un error de dedo vendía 20 almuerzos por lo
que valen dos sin que nada lo advirtiera. El **descuento** sí es decisión del negocio y es lo único
que se pide; tiene que ser menor que el valor (`DESCUENTO_INVALIDO`): un descuento que se come la
tiquetera entera es un regalo, y los regalos van por «Corregir saldo», que exige motivo.

En la pantalla el total se ve calculado y sin campo editable, y el selector muestra el valor de cada
producto. En una cuenta en dinero no cambia nada: el monto es el que el cliente entrega.

El concepto en caja es siempre **«Tiquetera &lt;cliente&gt;»** y la columna «Tipo pedido» dice
**Tiquetera** (antes «No aplica»: el movimiento no lleva pedido). Lo que se sabe porque
`rest_cuenta_movimiento.id_movimiento_caja` apunta a él. La nota opcional va al libro del cliente,
no al listado del turno.

## Eliminar una tiquetera (desde 2026-09-14)

`DELETE /restaurante/clientes/:id?id_negocio=N`, detrás del subnivel **`clientes_eliminar`**
(`npm run migrate:restaurante-clientes-eliminar`), que nace **denegado para todos, administrador
incluido**, y se concede en **Usuarios → Roles y permisos**, igual que `caja_eliminar_pedido`.

- **No borra: marca `rest_cuenta.estado = 'E'`.** El libro cuelga de pedidos y de movimientos de caja
  con `ON DELETE RESTRICT`, y aunque no colgara, borrarlo haría imposible explicarle a un cliente qué
  pasó con su tiquetera. La cuenta deja de salir en la lista y en el selector del cobro; cobrar con
  ella responde `CUENTA_NO_EXISTE`.
- **No devuelve plata.** Lo pagado entró a una caja, quizá de un turno ya cerrado. La pantalla avisa
  de lo que le quedaba al cliente antes de confirmar, y la auditoría (`cuenta_eliminada`) lo guarda.
- **Si el cliente vuelve con el mismo teléfono, se reactiva con su historia** (hay una sola cuenta
  por persona, `uq_rest_cuenta_negocio_persona`). Lo que tuviera a favor o debiendo sigue siendo suyo.

⚠️ La migración siembra la fila en `gener_nivel_negocio` **solo en los negocios que ya tenían
filas propias**: meterle una al que no tenía ninguna lo convertiría en «negocio con ajustes propios»
y se quedaría sin ver el resto de la vertical.

## La pantalla es una tabla (desde 2026-09-14)

Sin tarjetas de resumen arriba («Me deben», «Pagado por adelantado», «Tiqueteras»): se quitaron el
2026-09-15 porque solo restaban espacio. La pantalla es buscador + filtros + tabla a todo el ancho.

**El detalle del cliente es un modal** (`.modal--detalle`), no un panel lateral: se abre al tocar
la fila y lleva saldo, acciones e historial. Vender, corregir saldo y editar abren **encima** de él
(`.overlay--encima` / `.modal--encima`, z-index 1002/1003): al cerrarlos el detalle sigue abierto y
ya refrescado, que es donde se comprueba que el movimiento quedó.

Columnas: Cliente · Tipo de tiquetera (en dinero / por producto, con los productos) · Saldo en dinero
(a favor o debe) · Tiquetes comprados · Tiquetes restantes. `listarCuentas` devuelve `tiquetes_comprados`,
`tiquetes_restantes` y `productos`, sumados del libro con el mismo criterio que el saldo (los
anulados y sus reversas no cuentan). `total_tiquetes` se conserva y vale lo mismo que restantes.

## Dos unidades, un solo libro

`rest_cuenta.modo` decide si ese cliente lleva la cuenta **en pesos** (`DINERO`) o **en tiquetes
contados** (`TIQUETES`, «20 almuerzos»). Los tiquetes protegen al cliente si sube el precio; la
plata aguanta que pida almuerzo, gaseosa y postre.

No son dos contabilidades: es **un solo libro** (`rest_cuenta_movimiento`) donde cada apunte se
expresa en pesos o en tiquetes de un producto. El saldo **nunca se guarda**, siempre se suma — así
no puede desajustarse, y quién hizo qué queda escrito.

El modo **solo se puede cambiar con los dos saldos en cero**: hacerlo con saldo vivo dejaría plata
o comida pagada que el cliente no podría gastar, y no hay forma honesta de convertir 8 almuerzos en
pesos sin decidir por él a qué precio.

## Cómo se cobra

La forma de pago «Cuenta / Tiquetera» se reconoce por la marca `rest_metodo_pago.es_cuenta`,
**nunca por el nombre**: el negocio puede renombrarla. No se puede desactivar (devuelve
`METODO_PAGO_PROTEGIDO`), porque apagarla dejaría el módulo sin manera de cobrar y el fallo
aparecería lejos, al intentar cobrar.

Al cobrar con ella hay que mandar **`id_cuenta`**. El servidor **no lo deduce** del
`id_persona_negocio` del pedido a propósito: un pedido para llevar puede tener el teléfono de quien
lo recoge, y adivinar de quién es la tiquetera le descontaría el almuerzo a otra persona.

Si la cuenta no cubre todo el pedido, el resto se cobra con otra forma de pago — el **Multipago**
que ya existía. La cobertura se calcula **siempre en el servidor**, tanto para pintarla como al
cobrar de verdad: lo que manda el navegador es una propuesta, nunca la última palabra.

## Detalles que costaron trabajo y conviene no re-descubrir

- **El fiado NO deja el pedido «sin cobrar».** `validarPendientesCierre` impide cerrar caja con
  pedidos abiertos: si el fiado se modelara así, el restaurante no podría cerrar caja nunca. El
  pedido se marca pagado y la deuda vive en la cuenta.
- **`FOR UPDATE` sobre la cuenta al cobrar.** Dos cajeros cobrando a la vez contra la misma
  tiquetera leerían el mismo saldo y los dos lo darían por suficiente.
- **Anular un pedido pagado con la cuenta devuelve el consumo** (`revertirConsumoDeOrden`). Sin
  eso, anular le quitaba al cliente la comida *y* el almuerzo pagado.
- **`rest_movimiento_caja.id_metodo_pago`** se añadió aquí: sin ella, un abono de $400.000 salía
  en el arqueo como «Manual / Sin orden» y el cajero no sabía si esa plata estaba en el cajón o
  había llegado por transferencia.
- **`rest_cuenta_movimiento.id_movimiento_caja`** ata el apunte del cliente con el de la caja.
  Antes se cruzaban por el texto del concepto y dos abonos iguales se duplicaban en el historial.

## La cuenta se recuerda desde que se toma el pedido

`pedid_orden.id_cuenta` guarda de quién es la tiquetera desde que el pedido se crea, igual que
`id_metodo_pago` guarda la intención de forma de pago. Es una **intención, no un cobro**: nada se
descuenta hasta cobrar.

Sin esa columna, el cajero elegía el cliente en el POS y al ir a cobrar la mesa el sistema se lo
volvía a preguntar, porque no había dónde recordarlo. Al cobrar, lo que mande quien cobra manda;
si no dice nada, vale la cuenta que traía el pedido.

El selector de cliente vive **dentro de `MultipagoSelectorComponent`**, que comparten las tres
pantallas que cobran (POS, Mesas y Despacho). Ponerlo en cada pantalla ya falló una vez: Mesas se
quedó sin él y el cobro moría con un 422 que no explicaba nada.

## Permisos

| Subnivel | Qué permite | Quién lo tiene al migrar |
|---|---|---|
| *(módulo)* `/clientes` | ver las cuentas | ADMINISTRADOR, CAJERO |
| `clientes_abonar` | vender tiqueteras y recibir pagos (**entra plata**) | ADMINISTRADOR, CAJERO |
| `clientes_ajustar` | perdonar deudas y corregir saldos (**no entra plata**) | ADMINISTRADOR |
| `clientes_eliminar` | eliminar la tiquetera (sale de la lista y del cobro) | **nadie** — se concede a mano |

`clientes_ajustar` es el delicado: permite hacer desaparecer una deuda sin dejar rastro en la caja.
Por eso va aparte, el cajero no lo tiene, y **no se hereda por ser administrador** (`adminSiempre:
false`) — se concede a dedo. Todo ajuste exige un motivo escrito. `clientes_eliminar` sigue la misma
regla (`SUBNIVELES_A_DEDO` en `cuentaController.js`).

## Lo que este módulo NO hace

- No cobra solo ni manda recordatorios de cobro. El dueño mira quién debe y llama.
- No maneja vencimiento de tiqueteras (una tiquetera no caduca).
- El asistente de WhatsApp todavía no sabe responder «¿cuánto me queda?». Es lo natural después:
  la cuenta ya cuelga de la misma ficha de persona que usa el bot.
