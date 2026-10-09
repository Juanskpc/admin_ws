# Lo que cuesta y lo que deja el Asistente IA — medido, no estimado

**Estado:** vigente · **Fecha:** 2026-10-08 ·
**Cierra:** la medición #2 de [`precios-y-planes.md`](precios-y-planes.md) §6, que era «la única
que de verdad bloquea» ·
**Hermanos:** [`whatsapp-costo-mensajes.md`](whatsapp-costo-mensajes.md) (qué cobra Meta) ·
[`nivel-4.md`](nivel-4.md) (qué modelo contesta)

> **En una frase.** Con el modelo que se usa desde el 5 de octubre, el asistente le cuesta a
> EscalApp **$4.900 al mes** por el cliente que más lo usa y le genera a ese cliente **$17,9
> millones en pedidos**. El plan de $59.999 no estaba mal puesto: lo que estaba mal era el
> modelo, que se llevaba el 82% del plan y ahora se lleva el 8%.

---

## 1. Por qué este documento existe ahora y no antes

Hasta el 2026-10-01 no había nada que medir: WhatsApp era gratis y el costo del modelo nunca se
había mirado contra un plan concreto. Las dos cosas cambiaron a la vez —Meta empezó a cobrar, y
el gasto de IA se disparó— y la gráfica de consumo mostró un pico el 4 de octubre que no tenía
explicación comercial.

La tenía técnica: hasta ese día el asistente contestaba con **`gpt-5.6-terra`** ($2 / $12 por
millón de tokens) y desde el 5 de octubre contesta con **`gpt-5.6-luna`** ($0,20 / $1,20). El
cambio no se hizo por dinero y resultó ser la decisión económica más grande del trimestre.

Todo lo que sigue sale de `intelligence.costo` e `intelligence.mensaje` en **producción**, no de
una proyección. Es el Ledger de ADR-022 contestando para lo que se construyó.

---

## 2. El cambio de modelo, en números

Negocio 6 (Zona Burger), que es el único cliente con uso real del asistente:

| Día | Modelo | Turnos | Costo IA (USD) | Mensajes salientes |
|---|---|---|---|---|
| 01-oct | `terra` | 231 | $0,33099 | 177 |
| 02-oct | `terra` | 152 | $0,30222 | 178 |
| 03-oct | `terra` | 212 | $0,42040 | 223 |
| 04-oct | `terra` | 350 | $0,72827 | 360 |
| **05-oct** | **`luna`** | 154 | **$0,03746** | 179 |
| 06-oct | `luna` | 192 | $0,04373 | 187 |
| 07-oct | `luna` | 218 | $0,05302 | 172 |
| 08-oct | `luna` | 168 | $0,04204 | 160 |

Proyectado a 30 días, con el mismo ritmo:

| | `terra` (hasta el 4-oct) | `luna` (desde el 5-oct) |
|---|---|---|
| Costo IA al mes | **$13,36** ≈ $49.200 COP | **$1,32** ≈ **$4.900 COP** |
| Como % del plan de $59.999 | **82 %** | **8 %** |

**El plan vendía casi a costo y nadie lo sabía.** No por estar mal puesto el precio: por el
modelo. Es exactamente el escenario que ADR-019 quería poder ver, y se vio.

### 2.1 La unidad que de verdad importa: el mensaje

Sobre los cuatro días con el modelo nuevo: **698 mensajes salientes** y **732 turnos**. Es
prácticamente **un turno por mensaje** (0,95), y eso simplifica todo el modelo comercial:

> **Costo de IA por mensaje del asistente: $0,00025 USD ≈ $0,93 COP.**

Medir en «mensajes del asistente» —que es lo que el cliente entiende y lo que Meta factura— sigue
nuestro costo con un error de menos del 5 %. No hace falta explicarle a nadie qué es un token.

---

## 3. Quién le paga a Meta, y por qué eso cambia el diseño del plan

**El cliente, no nosotros.** Está verificado de primera mano en
[`embedded-signup.md`](embedded-signup.md) §9.1: como **Tech Provider**, el número que conecta el
inquilino crea una empresa y una WABA **separadas** de las nuestras, y Meta le cobra a su tarjeta.

Eso tiene una consecuencia incómoda que hay que decir en voz alta:

> ⚠️ **EscalApp no puede revender mensajes de WhatsApp.** No pasan por nuestra cuenta. Un
> «paquete de 5.000 mensajes» vendido por nosotros no es un paquete de mensajes de Meta: es un
> paquete de **capacidad del asistente**, que es lo que sí pagamos. Lo que Meta cobre por encima
> de los 1.000 gratis se lo cobra a él, lo vendamos o no.

Lo que sí podemos —y debemos— hacer es **decírselo antes**, con la cifra. Un cliente que se
entera por la factura de Meta es un cliente que cree que le escondimos algo.

### 3.1 La asignación gratuita de Meta, confirmada

Confirmado el 2026-10-08 contra fuentes externas, no solo contra nuestra documentación:

- **1.000 mensajes de servicio gratis por NÚMERO y por mes.** Es por número de teléfono, no por
  cuenta: como cada inquilino conecta el suyo, **cada inquilino tiene sus propios 1.000**.
- **No se acumulan.** Se renuevan el día 1 y lo que no se gastó se pierde.
- **Lo que escribe el cliente final es gratis**, siempre. Se paga lo que sale.
- **Las plantillas `utility` NO entran en la asignación** y se cobran desde la primera. La
  nuestra es `recordatorio_cita` (solo Reserva).
- Tarifa para Colombia: **≈ $2,9455 COP por mensaje** entregado a un número colombiano
  (≈ USD 0,0008).

> **Sobre la tarifa.** El valor en dólares (US$0,0008) **sale del propio rate card de Meta** —lo
> leyó el dueño el 2026-10-05, ver [`whatsapp-costo-mensajes.md`](whatsapp-costo-mensajes.md)
> §5— y coincide con lo que publican varios integradores, que además lo dan en pesos
> ($2,9455). O sea que está mejor fundada de lo que parecía al escribir este documento.
>
> ⚠️ Lo que sigue sin confirmarse es **el cobro real**: la cifra no se ha visto todavía en una
> factura de Meta ni en `/admin/terceros`. Y el equivalente en pesos depende del tipo de cambio
> que aplique Meta, que no es el que usemos nosotros: aquí se usa 3.682 COP/USD y la medición del
> 5 de octubre usó ~4.125, que da $3,3 por mensaje en vez de $2,95. Para presupuestar, la cifra
> honesta es **la de dólares**.

---

## 4. La cuenta completa de un cliente

Negocio 6, plan «Emprendedor + Asistente IA» ($59.999), con el modelo nuevo:

| Concepto | Al mes | % del plan |
|---|---|---|
| **Ingreso** | **$59.999** | 100 % |
| − Pasarela (Wompi: 2,65 % + $700 + IVA) | −$2.725 | 4,5 % |
| − IA (≈5.500 turnos) | −$4.900 | 8,2 % |
| − Infraestructura (VPS de producción ÷ 9 negocios activos) | −$2.400 | 4,0 % |
| − WhatsApp | **$0** | 0 % |
| **Margen bruto** | **$49.974** | **83 %** |

Con el modelo viejo ese margen era **$5.674 (9,5 %)**. Un cliente más y la línea se hundía.

### 4.1 Y lo que el cliente recibe

Mismos cuatro días (5 al 8 de octubre), mismo negocio:

| | |
|---|---|
| Pedidos tomados por el asistente | **81** de 206 (**39 %** de todos los pedidos) |
| Valor de esos pedidos | **$2.213.000** |
| Proyectado al mes | ~608 pedidos · **~$16,6 millones** |
| Mensajes del asistente por pedido conseguido | **8,6** |
| **Lo que nos cuesta en IA cada pedido que captura** | **$8 COP** |
| **Lo que vale ese pedido** | **$27.321 COP** |

> Nos cuesta **$8 de IA** capturar un pedido de **$27.321**. El plan entero ($59.999) es el
> **0,36 %** de lo que el asistente le mete al negocio cada mes.

Esto no es un argumento para subir el precio. Es el argumento para **no tener miedo de cobrar
los paquetes**: están muy por debajo de lo que valen.

---

## 5. El problema que sí hay: la cola larga

El margen del 83 % es el del cliente medido. El riesgo no está en él, está en el que venga:

| Mensajes/mes | Costo IA | % del plan de $59.999 |
|---|---|---|
| 1.000 | $930 | 1,6 % |
| 5.235 *(el cliente real)* | $4.900 | 8,2 % |
| 15.000 | $13.950 | 23 % |
| 30.000 | $27.900 | 47 % |
| 60.000 | $55.800 | **93 %** |

Un plan plano y sin techo es una apuesta a que nadie use mucho el producto que le vendimos.
**El techo no existe para cobrar más: existe para que el éxito de un cliente no sea una pérdida.**

---

## 6. La propuesta

### 6.1 El plan base no se mueve

**«Emprendedor + Asistente IA» se queda en $59.999.** Con el modelo nuevo deja 83 % de margen;
no hay nada que arreglar en el precio. Subirlo sería cobrar por un problema que ya se resolvió
cambiando de modelo, y bajarlo sería regalar margen sin motivo.

**Lo que se añade es el techo:** el plan incluye **1.000 mensajes del asistente al mes**.

La cifra no es arbitraria y ahí está su gracia: **es exactamente la asignación gratuita de Meta**.
Dentro del paquete incluido, el cliente no le paga nada a nadie — ni a nosotros ni a Meta. Es la
única cifra con la que esa frase es verdad, y se puede decir en la landing sin letra pequeña.

> ⚠️ **Hay que decir también la otra mitad.** 1.000 mensajes son **la quinta parte** de lo que
> consume el único restaurante que de verdad usa el asistente. Un negocio activo va a necesitar
> un paquete casi seguro. Si eso no está dicho **en la tarjeta del plan, antes de comprar**, el
> paquete se lee como una trampa. La landing tiene que llevar la equivalencia en el lenguaje del
> cliente: *«1.000 mensajes ≈ 115 pedidos al mes tomados por el asistente»* (8,6 mensajes por
> pedido), que es lo que el dueño sabe medir. «Mensajes» no le dice nada.

### 6.2 Los paquetes

Se suman al plan, como los complementos que ya existen (`cob_complemento`):

| Paquete | Mensajes/mes | Pedidos ≈ | Precio EscalApp | Lo que Meta le cobrará aparte | Nuestro costo | Margen |
|---|---|---|---|---|---|---|
| **Incluido** | 1.000 | ~115 | — | **$0** | $930 | — |
| **S** | 3.000 | ~350 | **+$12.000** | ~$5.900 | $2.790 | 84 % |
| **M** | 6.000 | ~700 | **+$24.000** | ~$14.700 | $5.580 | 81 % |
| **L** | 12.000 | ~1.400 | **+$42.000** | ~$32.400 | $11.160 | 76 % |

Tres decisiones dentro de esta tabla:

1. **La columna de Meta se publica.** No es un descargo de responsabilidad en letra chica: va en
   la misma tabla, con el mismo tamaño. El cliente tiene que poder sumar las dos columnas antes
   de decidir, porque las dos las va a pagar.
2. **El escalón entre paquetes baja de precio por mensaje** ($6,00 → $4,00 → $3,50 el mensaje
   adicional). Quien más usa el asistente es quien más valor saca de él y quien más probable es
   que se quede: cobrarle proporcionalmente más por crecer es el incentivo equivocado.
3. **El paquete no se consume: se contrata.** Es una cuota mensual con un techo, no una bolsa que
   se agota. Una bolsa obliga a decidir qué pasa a mitad de mes con un cliente a punto de
   quedarse sin asistente en plena hora de almuerzo, y esa decisión no tiene buena respuesta.

Dónde vive: **los tres paquetes son `cob_complemento`**, con `cantidad_maxima = 1` (se tiene uno o
ninguno). La maquinaria de prorrateo, renovación y cambio de plan ya los sabe cobrar: no hace
falta nada nuevo en cobranza.

### 6.3 Qué pasa al pasarse del techo

**No se corta.** Nunca. Cortar el asistente a mitad de servicio le hace al cliente un daño mayor
que el costo que nos ahorra, y lo hace en el peor momento posible.

El camino, apoyado en lo que ya existe (`intelligence/avisos/cuotaWhatsapp.js`, que ya avisa al
80 % y al 100 %):

| Consumo | Qué pasa |
|---|---|
| 80 % del paquete | Campanita: «vas por el 80 %, a este ritmo llegas a X este mes» + el paquete que le toca |
| 100 % | Campanita y correo al administrador. **El asistente sigue contestando.** |
| 100–150 % | Sigue contestando. En la factura siguiente entra el paquete que corresponda, avisado antes |
| > 150 % dos meses seguidos | Conversación comercial, no un corte automático |

El único corte automático que debe existir es el que ya existe y es por **abuso**, no por volumen:
`reporteAutomatico.js` y el bloqueo por contacto. Un cliente que usa mucho el producto no es un
abusador; alguien que descubrió que al otro lado hay un modelo, sí.

---

## 7. Lo que hay que hacer para que esto deje de ser un documento

| # | Qué | Quién lo bloquea |
|---|---|---|
| 1 | **Ver el cobro real de Meta** en una factura o en `/admin/terceros`. La tarifa en dólares ya salió del rate card; lo que falta es verla cobrada | Nadie: se mira y ya |
| 2 | Sembrar los tres paquetes en `cob_complemento` + `cob_precio_complemento` (COP) | Decisión de precios (esta) |
| 3 | Contar mensajes **por paquete contratado** y no solo contra los 1.000 de Meta (`whatsapp:cuota` ya cuenta; le falta saber qué paquete tiene el negocio) | 2 |
| 4 | Tarjetas de la landing: el techo, la equivalencia en pedidos y la columna de Meta | 2 |
| 5 | Repetir esta medición con **un mes completo** y con más de un cliente | El tiempo |

---

## 8. Lo que este documento no decide

- **El precio en CLP de los paquetes.** Chile tiene su propia tarifa de Meta y su propio precio
  de plan ([`precios-y-planes.md`](precios-y-planes.md) §8). Un paquete sin fila en CLP cobraría
  el precio por defecto, que es justo el error que se corrigió el 2026-10-08.
- **Qué pasa con Reserva.** La medición es de un restaurante. Reserva gasta mensajes de otra
  forma (6 por cita por el camino del menú, 3 si el cliente escribe lo que quiere, según
  [`whatsapp-costo-mensajes.md`](whatsapp-costo-mensajes.md) §2) y su plan cuesta $10.000 más.
  **Los paquetes de arriba no están medidos para Reserva.**
- **Si `luna` aguanta.** Todo este documento descansa en que un modelo 10 veces más barato hace
  el trabajo igual de bien. Cuatro días dicen que sí. Si hay que volver a un modelo caro para
  alguna tarea, la tabla de márgenes se recalcula entera — y por eso el Ledger registra el
  modelo en cada turno.

---

## 9. Fuentes

- Costos de IA y mensajes: `intelligence.costo` e `intelligence.mensaje` en producción,
  1 al 8 de octubre de 2026. Los 5.235 mensajes/mes de §2 cuentan **solo lo que Meta factura**
  (entregado, sin plantillas y sin lo que el dueño manda desde su móvil); contando todo lo
  saliente son ~9.300, y la medición del 2026-10-05 dio ~7.000 con un filtro intermedio. Las
  tres son correctas: miden cosas distintas
- Pedidos y valor: `restaurante.pedid_orden` (`confirmado_en IS NOT NULL` = lo tomó el asistente)
- Precios de los modelos: `intelligence/model/precios.js` (lista pública verificada el 2026-08-17)
- Quién le paga a Meta: [`embedded-signup.md`](embedded-signup.md) §9.1, verificado pantalla a
  pantalla el 2026-09-19
- Asignación de 1.000 mensajes: consultado el 2026-10-08 en documentación de integradores
  (Courier, EngageLab, Zendesk, Zenvia, respond.io, Hint, Simla)
- Tarifa de Colombia (US$0,0008): **rate card de Meta**, leído por el dueño el 2026-10-05
  ([`whatsapp-costo-mensajes.md`](whatsapp-costo-mensajes.md) §5); las fuentes de integradores
  coinciden y añaden el equivalente en pesos. **Sin confirmar todavía contra un cobro real**
- Tipo de cambio: **$3.682 COP/USD**, derivado del propio tarifario de Meta (USD 0,0008 = COP
  2,9455). No es la TRM: es la que usa Meta para convertir, que es la que aplica a esta cuenta
