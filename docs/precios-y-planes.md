# Precios y planes: qué cobrar por el sistema, por WhatsApp y por la facturación

**Estado:** propuesta de trabajo, **no hay precios nuevos publicados todavía** · **Fecha:** 2026-09-02
· **Última revisión:** 2026-09-12 (§2 y §3 rehechas con los costos reales de Factus y el volumen medido)
· **Relacionado:** [`facturacion-electronica.md`](facturacion-electronica.md) §8 ·
[`canal-whatsapp.md`](canal-whatsapp.md) · [`obligaciones-escalapp.md`](obligaciones-escalapp.md)

> Este documento existe porque hasta ahora los precios eran dos números sueltos ($27.999 y $59.999)
> sin nada detrás. En cuanto entran la facturación electrónica y el cobro de WhatsApp, cada
> inquilino empieza a tener **un costo externo real**, y un precio plano que no lo contempla deja de
> ser un precio: es una apuesta.

---

## 1. El principio: base fija, módulos aparte

**El plan base no puede incluir la facturación electrónica.** No es una opinión comercial, sale de
la estructura de costos:

| Qué | Costo por inquilino |
|---|---|
| **El sistema** (operación, caja, productos, reportes) | **Casi cero.** Un VPS de ~$24.000/mes repartido entre todos |
| **WhatsApp** | Real y por cliente. Hoy casi nada, desde octubre de 2026 no (§4) |
| **Facturación electrónica** | Real, por cliente, **y variable con lo que venda** |

Meter los dos últimos en el precio base obliga al plan a absorber un costo variable que no puede
predecir. El día que entre un restaurante de 100 tiquetes diarios, ese cliente cuesta más de lo que
paga — y no habrá hecho nada malo: simplemente vendió.

> **Regla de diseño comercial:** lo que tiene costo externo por inquilino se cobra como módulo. Lo
> que no lo tiene, va en la base.

Esto encaja con lo que el producto ya sabe hacer: `modo_facturacion` nace en `NINGUNO`
([`facturacion-electronica.md`](facturacion-electronica.md) §4.2) y `asistente_ia` es una feature de
plan ([ADR-021](adr/ADR-021-features.md)). **La costura ya existe; lo que falta es el precio.**

---

## 2. Lo que cuesta cada módulo

> **Reescrita el 2026-09-12.** La versión anterior calculaba sobre «un restaurante de 900 documentos
> al mes» —una cifra inventada— y sobre un proveedor de **costo plano**, que resultó **no existir**.
> Las dos cosas ya son dato: el volumen está contado y los precios de Factus están sobre la mesa
> ([`facturacion-electronica.md`](facturacion-electronica.md) §8.1 y §8.2-quater).

El costo de la facturación **no es un número, es una función de cuánto venda el cliente**. Por eso
la tabla lleva dos columnas y no una: son los dos extremos reales de la cartera de hoy.

| Concepto | **Restaurante grande**<br>(Zona Burger, 1.730 doc/mes) | **Negocio pequeño**<br>(barbería, ~15 doc/mes) |
|---|---|---|
| Infraestructura | ~$1.000 | ~$1.000 |
| WhatsApp — **hoy** | ~$0 | ~$0 |
| WhatsApp — **desde oct-2026** *(estimado)* | ~$8.000 | ~$3.000 |
| Facturación — documentos | **$31.500** (1.750 × $18) | **~$300** |
| Facturación — certificado digital | **$10.833** ($130.000/año ÷ 12) | **$10.833** |
| **Total por inquilino** | **~$51.300** | **~$15.100** |

Las cifras de facturación salen de la decisión de
[`facturacion-electronica.md`](facturacion-electronica.md) §8.7: **bolsa de documentos repartida
entre varios NIT, comprada por nosotros**, con el certificado digital aparte a $130.000/año por
cliente.

**Tres cosas que esta tabla enseña y la anterior escondía:**

1. **El suelo del costo es el certificado, no los documentos.** Un negocio pequeño cuesta $10.833 al
   mes casi enteros de certificado. Por debajo de cierto tamaño, **facturar cuesta lo mismo factures
   lo que factures**, y ese piso fijo es lo que hace inviable regalar el módulo.
2. **El cliente grande cuesta 3,4 veces más que el pequeño** y con un precio plano paga lo mismo. Es
   literalmente el problema de §8.1 de aquel documento, ahora con nombre y apellido.
3. **$18 por documento es el tramo alto de la bolsa**, y solo se alcanza agregando el volumen de
   varios clientes. Con uno o dos, el costo real por documento está entre $22 y $31, y el margen de
   los tramos de §3 se estrecha en consecuencia.

⚠️ **Lo único de esta tabla que sigue sin medir son las dos cifras de WhatsApp.** §6 dice cómo.

---

## 3. La estructura de precios propuesta

> **Reescrita el 2026-09-12**, por dos razones distintas y las dos de peso: el costo de la
> facturación resultó **variable** (§2), y resultó que **cobramos un tercio de lo que cobra el
> mercado** — Loggro pide ~$167.000/mes por lo mismo, sin asistente de WhatsApp
> ([`facturacion-electronica.md`](facturacion-electronica.md) §8.8).

### La regla nueva: el módulo de facturación va por tramos de volumen

No es una preferencia comercial, es aritmética. Si el costo sube con lo que venda el cliente y el
precio no, **el cliente que más factura es el que menos margen deja**, y pasado cierto punto tenerlo
cuesta dinero. Los tramos son por **documentos al mes**, se anuncian de antemano y el cliente sabe
siempre en cuál está.

| Tramo | Documentos/mes | Costo nuestro | **Precio del módulo** | Margen |
|---|---|---|---|---|
| **S** | hasta 100 | ~$12.700 | **$39.000** | $26.300 |
| **M** | hasta 500 | ~$19.900 | **$59.000** | $39.100 |
| **L** | hasta 1.200 | ~$32.500 | **$79.000** | $46.500 |
| **XL** | hasta 2.500 | ~$55.900 | **$99.000** | $43.100 |

*(Costo = $10.833 de certificado + documentos × $18. Por encima de 2.500 al mes se cotiza: es un
cliente que factura más de $80 millones y merece una conversación, no una tabla.)*

> ⚠️ **El tramo se mide por documentos EMITIDOS, no por tiquetes vendidos**, y no son el mismo
> número: en la práctica muchos negocios solo emiten cuando el cliente lo pide
> ([`facturacion-electronica.md`](facturacion-electronica.md) §8.1). Por eso **un cliente nuevo
> arranca en el tramo bajo, se mide un mes real y se ajusta después**, avisado — nunca se le asigna
> tramo por lo que vende. La consecuencia práctica: **Zona Burger podría no caer en XL.** Sus 1.730
> tiquetes son el techo; lo que emita de verdad se sabrá el primer mes de FE-2.

**Si Zona Burger emitiera todo lo que vende**, cae en XL: paga $99.000, cuesta $42.333, deja
**$56.667** de margen. Es el peor caso para nosotros y el que hay que poder aguantar.

### Los paquetes

| Paquete | Qué incluye | Precio | Costo | Margen |
|---|---|---|---|---|
| **Básico** | El sistema: operación, caja, productos | $27.999 | $1.000 | **$26.999** |
| **Básico + WhatsApp** | + asistente que toma pedidos y agenda | $49.999 | $9.000 | **$40.999** |
| **Avanzado** | Sistema completo: inventario, reportes, sucursales, asistente | $59.999 | $9.000 | **$50.999** |
| **Avanzado + Facturación S** | + factura electrónica, negocio pequeño | $98.999 | $21.700 | **$77.299** |
| **Avanzado + Facturación XL** | + factura electrónica, restaurante grande | $158.999 | $51.300 | **$107.699** |

### Por qué esos números

- **Un restaurante grande completo cuesta $158.999 y el mercado cobra ~$167.000** por menos —Loggro
  Restobar Básico con documentos ilimitados, sin asistente de WhatsApp. Seguimos siendo los baratos
  **y** dejamos de vender por debajo del costo. Ese era el objetivo.
- **El tramo S existe para no perder al cliente pequeño.** $39.000 por encima del plan es mucho para
  una barbería, pero el certificado son $10.833 fijos: por debajo de ese precio el módulo no se
  sostiene. Si hace falta ganar ese segmento, la salida no es bajar el precio sino **que el cliente
  compre su propio paquete individual** (opción A de §8.7 de aquel documento), donde el certificado
  va incluido.
- **El margen más ancho está en el cliente grande**, que es lo contrario de antes. Es la consecuencia
  buena de cobrar por tramos.

### Lo que no hay que hacer

1. **Regalar la facturación en el Básico.** Cada cliente nuevo costaría $10.833 al mes antes de
   emitir un solo documento.
2. **Cobrarle al cliente final por documento.** Los tramos **no son eso**: la factura del cliente es
   el mismo número todos los meses y solo cambia cuando cambia de tramo, avisado. Una factura
   variable es justo lo que odia un negocio pequeño.
3. **Prometer «cumplimiento garantizado ante la DIAN» en el copy.** Es una obligación de resultado —
   ver [`obligaciones-escalapp.md`](obligaciones-escalapp.md) §6.4.
4. **Vender un tramo y no vigilarlo.** Si el cliente se pasa de tramo y nadie lo mira, el margen se
   evapora en silencio; y si se agota la bolsa, **Factus bloquea la emisión automáticamente** y el
   cliente no puede vender (§8.2-bis de aquel documento). Vigilar el consumo es parte del producto,
   no una tarea administrativa.

### El certificado digital: decidido, se absorbe

Antes era una decisión abierta. Ya no: los tramos de arriba **lo incluyen**, y por una razón
concreta —en la modalidad de bolsa repartida el certificado lo compramos nosotros, así que
cobrárselo aparte al cliente sería facturarle un costo que él no contrata. Lo que sí se le cobra
aparte, si algún día se elige la opción A, es el **paquete individual completo**, donde el
certificado va incluido de fábrica y la línea es suya de verdad.

### Los tramos aguantan aunque nunca lleguemos a la bolsa (2026-09-14)

Los costos de arriba suponen la **bolsa repartida**, que solo sale a cuenta con varios clientes. En
la reunión con Factus se confirmó que **paquete individual y bolsa se pueden mezclar**, y hoy no hay
ningún cliente que haya pedido facturación, así que el primero seguramente irá en **paquete
individual**. Hay que comprobar que los precios aguantan también así, antes de anunciarlos.

Peor caso de cada tramo: el cliente emite el máximo del tramo y se le compra el paquete individual
más barato que lo cubre (lista pública de Factus, certificado incluido).

| Tramo | Máx. documentos/año | Paquete que lo cubre | Costo/mes | Precio | **Margen** |
|---|---|---|---|---|---|
| **S** | 1.200 | 1.600 · $220.000 | $18.333 | $39.000 | **$20.667** |
| **M** | 6.000 | 10.000 · $390.000 | $32.500 | $59.000 | **$26.500** |
| **L** | 14.400 | 15.000 · $440.000 | $36.667 | $79.000 | **$42.333** |
| **XL** | 30.000 | 35.000 · $820.000 | $68.333 | $99.000 | **$30.667** |

**Aguantan los cuatro.** El margen es más estrecho que con la bolsa, pero ninguno queda en pérdida,
así que **los precios se pueden publicar sin esperar a tener varios clientes**. La bolsa, cuando
llegue, solo mejora el margen.

### ⚠️ Quién pone la plata del año — decidir ANTES de anunciar

Factus se paga **por adelantado, por un año**, sin devolución pasados 5 días hábiles, y los
documentos que sobran caducan. Nuestro cliente paga **mes a mes**. Si un cliente XL se va al segundo
mes, ya pagamos $820.000 y cobramos $198.000. Tres salidas, sin decidir todavía:

1. **Permanencia de 12 meses** en el módulo de facturación, o pago anual con descuento.
2. **Cobro de activación** que cubra parte del paquete.
3. **Que el cliente compre su propio paquete** (opción A de `facturacion-electronica.md` §8.7) y
   nosotros cobremos solo la integración, más barata. El riesgo pasa a ser suyo.

Lo que no hay que hacer es anunciar «facturación desde $39.000 al mes» sin haber elegido una.

⚠️ **Cerrado el 2026-09-15: no existe paquete mensual de Factus.** Se esperaba que lo hubiera —sus
Términos y Condiciones §f.2 mencionan «de manera mensual o anual»— porque habría resuelto buena
parte de este problema solo. Por escrito confirmaron lo contrario: *«nuestros paquetes son anuales,
tanto en individuales como en bolsas»* (`facturacion-electronica.md` §8.2-sexies). Las tres salidas
de arriba siguen siendo las únicas, y no hay que decidir cuál hasta que exista un cliente real:
firmar la alianza con Factus no obliga a comprar nada todavía.

---

## 4. ⚠️ El 1 de octubre de 2026 WhatsApp deja de ser gratis

**Es lo más urgente de este documento y no depende de la facturación.**

Hoy el asistente sale prácticamente gratis porque casi todo lo que hace es de categoría *Servicio*:
el cliente escribe primero y el negocio responde dentro de las 24 h. **Meta empieza a cobrar los
mensajes de servicio salientes el 1 de octubre de 2026.**

Lo que esto cambia:

- El costo de WhatsApp pasa de ~$0 a una cifra que **hoy no sabemos**, y depende de cuántos mensajes
  emite el bot por conversación — no de cuántas conversaciones hay.
- Un asistente que contesta en tres mensajes cortos cuesta el triple que uno que contesta en uno.
  **De golpe, la verbosidad del bot es una línea de costo.**
- Los recordatorios (`recordatorio_cita`, categoría *Utility*) ya se cobraban y no cambian.

**Hay que medir antes de esa fecha, no después.** El detalle del cobro de Meta está en
[`canal-whatsapp.md`](canal-whatsapp.md) §«Cómo funciona el cobro de Meta».

---

## 4-bis. Qué pasa cuando un cliente no paga a tiempo (desde 2026-09-11)

**Vencer el plan ya no corta la operación el mismo día: hay 5 días de gracia.**

| Estado | Qué ve el cliente | ¿Puede trabajar? |
|---|---|---|
| `ACTIVO` | nada | sí |
| `GRACIA` (día 1 a 5 tras `fecha_fin`) | franja «tu plan está vencido, tienes N días para actualizar tu pago» | **sí, con normalidad** |
| `VENCIDO` (día 6 en adelante) | pantalla `/sin-plan` | no |
| `SIN_PLAN` | pantalla `/sin-plan` | no |

Por qué: el pago de un negocio pequeño casi nunca cae el día exacto, y cerrarle la caja a un
restaurante en plena hora de almuerzo por un retraso de un día es la forma más cara de cobrar
$59.999. El aviso llega **antes** del corte, que es cuando todavía se puede arreglar.

Dónde vive: `app_core/helpers/planHelper.js` — `DIAS_GRACIA_PLAN = 5` y `evaluarPlan()`. La
bandera que miran los guardias de las apps sigue siendo `plan_activo`, que ahora **incluye la
gracia**; el detalle viaja aparte en `plan` (`estado`, `en_gracia`, `dias_gracia_restantes`,
`fecha_fin`) y es lo que pinta la franja en admin, restaurante y reserva. Cambiar los 5 días es
cambiar una constante, pero es una **decisión comercial**: está cubierta por
`__tests__/negocios/plan_gracia.test.js`.

La franja se puede cerrar con una «x» y **vuelve a salir al siguiente inicio de sesión** (lo
cerrado se guarda contra el token de la sesión, no «para siempre»).

Lo que esto **no** hace: no cobra, no renueva y no avisa por WhatsApp ni por correo. El pago se
sigue confirmando a mano, y hasta que alguien renueve la fila de `gener_negocio_plan` el reloj
corre.

---

## 5. Lo que este documento NO decide

- **El precio del plan base.** $27.999 y $59.999 se conservan tal cual; no había razón para tocarlos
  en esta sesión.
- **El IVA sobre las mensualidades.** Hoy no se cobra porque la empresa no es responsable de IVA
  ([`obligaciones-escalapp.md`](obligaciones-escalapp.md) §2). Cuando eso cambie, «$158.999» y
  «$158.999 + IVA» son dos promesas distintas y hay clientes firmados de por medio.
- **Cómo se cobra.** Ya está resuelto: ver [`cobro-mensualidades.md`](cobro-mensualidades.md)
  (Wompi, con cobro automático 5 días antes del vencimiento). Y si el cliente es persona jurídica,
  **retiene en la fuente**: se factura $158.999 y llega menos (§3 de `obligaciones-escalapp.md`).
- **Qué pasa al pasar de 20 números de WhatsApp.** Embedded Signup cambia quién le paga a Meta y por
  tanto cambia esta tabla entera. Está en `ESTADO-Y-CONTINUACION.md` §4-0.

---

## 6. Qué hay que medir para que esto deje de ser una estimación

| # | Qué | Dónde está el dato | Bloquea |
|---|---|---|---|
| 1 | ✅ **Tiquetes reales al mes** | Contados el 2026-09-11: **1.730/mes en Zona Burger** (`id_negocio` 6), no Pregonchos, que es mucho más pequeño | — |
| 2 | ⬜ **Mensajes salientes al mes** por negocio | Panel de Meta (*Insights*) y el Ledger de Intelligence | El costo de WhatsApp desde octubre |
| 3 | ✅ **Precio de Factus** | Lista completa recibida el 2026-09-11 y las 11 preguntas contestadas el 2026-09-12. **No es plano: bolsa anual por documentos** | — |
| 4 | ✅ **Certificado digital** | **$130.000/año por NIT** en bolsa repartida; incluido en el paquete individual | — |
| 5 | ⬜ **Cotización de Alegra** como contraste | Un correo | Nada: es comparación, ya no decisión |
| 6 | ✅ **Precio de aliado de Factus** — **no existe**: aplica la lista pública (reunión del 2026-09-14) | — | Los tramos de §3 ya están calculados con esa lista, así que su margen es el real |

**La número 2 es ahora la única que de verdad bloquea**, y es la que más urge: el cobro de Meta
empieza el 1 de octubre y no depende de nadie de fuera medirlo.

---

## 7. Fuentes

- Precios de proveedores consultados el 2026-09-02 en sus páginas públicas; el detalle y el análisis
  de la forma del costo, en [`facturacion-electronica.md`](facturacion-electronica.md) §8
- Cobro de Meta: <https://developers.facebook.com/docs/whatsapp/pricing> y el panel de la WABA
- El cambio del 1 de octubre de 2026 sobre mensajes de servicio: anuncio de Meta, recogido por
  varios integradores en agosto de 2026 — **confirmarlo en el panel antes de la fecha**
