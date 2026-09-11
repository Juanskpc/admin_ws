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
| Vender tiquetera / recibir abono | **no** | **sí** | INGRESO en caja, **sin pedido** + ABONO en el libro |
| Comer con la cuenta | **sí** | **no** | pedido normal + INGRESO **y** EGRESO que se anulan + CARGO en el libro |

Lo segundo es literalmente el truco que ya usaba el cobro del domicilio. **Si el EGRESO faltara,
al cajero le faltaría en el cuadre exactamente lo que comieron los de tiquetera, todos los días, y
el fallo no daría ningún error.** Está cubierto por `__tests__/restaurante/cuentas_tiquetera.test.js`,
que mide el neto de caja antes y después.

Se mantiene el INGRESO de cero en vez de no anotar nada por el mismo motivo que en los pedidos
regalados: sin él, el pedido desaparecería del listado del turno, y ahí es justo donde el negocio
quiere ver lo que sirvió.

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

`clientes_ajustar` es el delicado: permite hacer desaparecer una deuda sin dejar rastro en la caja.
Por eso va aparte, el cajero no lo tiene, y **no se hereda por ser administrador** (`adminSiempre:
false`) — se concede a dedo. Todo ajuste exige un motivo escrito.

## Lo que este módulo NO hace

- No cobra solo ni manda recordatorios de cobro. El dueño mira quién debe y llama.
- No maneja vencimiento de tiqueteras (una tiquetera no caduca).
- El asistente de WhatsApp todavía no sabe responder «¿cuánto me queda?». Es lo natural después:
  la cuenta ya cuelga de la misma ficha de persona que usa el bot.
