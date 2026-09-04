# Precios y planes: qué cobrar por el sistema, por WhatsApp y por la facturación

**Estado:** propuesta de trabajo, **no hay precios nuevos publicados todavía** · **Fecha:** 2026-09-02
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

Calculado sobre un **restaurante de 900 documentos al mes** (≈30 tiquetes al día), que es la
hipótesis de trabajo hasta que se cuenten los tiquetes reales de Pregonchos.

| Concepto | Costo/mes | De dónde sale |
|---|---|---|
| Infraestructura | ~$1.000 | 1 VPS entre todos los inquilinos |
| WhatsApp — **hoy** | ~$0 | Las conversaciones las inicia el cliente: categoría *Servicio*, gratis |
| WhatsApp — **desde oct-2026** | ~$8.000 *(estimado)* | Meta empieza a cobrar los mensajes de servicio (§4) |
| Facturación — documentos | ~$28.000 | Proveedor de **costo plano**; con cobro por documento serían $22.500 y subiendo |
| Facturación — certificado digital | ~$8.300 | $100.000/año por NIT ÷ 12, si el proveedor es «software propio» |

⚠️ **Las dos cifras de WhatsApp y la de facturación son estimaciones, no mediciones.** Las acciones
para convertirlas en datos reales están en §6.

---

## 3. La estructura de precios propuesta

| Paquete | Qué incluye | Precio | Costo | Margen |
|---|---|---|---|---|
| **Básico** | El sistema: operación, caja, productos | $27.999 | $1.000 | **$26.999** |
| **Básico + WhatsApp** | + asistente que toma pedidos y agenda | $49.999 | $9.000 | **$40.999** |
| **Básico + Facturación** | + tiquete POS y factura electrónica | $69.999 | $37.300 | **$32.699** |
| **Completo** | Sistema + WhatsApp + facturación | **$89.999** | $45.300 | **$44.699** |
| **Avanzado** | Sistema completo: inventario, reportes, sucursales | $59.999 | $1.000 | **$58.999** |
| **Avanzado completo** | Todo | $119.999 | $45.300 | **$74.699** |

### Por qué esos números

- **Cada módulo cuesta aproximadamente lo que cuesta, más un margen parecido.** WhatsApp añade
  $22.000 sobre la base y cuesta ~$9.000; facturación añade $42.000 y cuesta ~$37.300. No es un
  recargo inventado.
- **El paquete Completo premia comprarlo todo** ($89.999 frente a $91.999 sumando módulos sueltos) y
  es el que conviene vender: es donde el margen absoluto es mayor.
- **Sigue siendo barato.** Un restaurante que compra esto por separado paga hoy alrededor de $62.000
  solo de facturación electrónica (GridPOS, 20.000 doc/año), más el software de caja, más lo que
  cueste un bot de WhatsApp. El Completo a $89.999 es menos de la mitad de esa cuenta.
- **El margen más delgado es el de facturación**, y es justo el que depende de un precio que todavía
  no tenemos. **Si el proveedor sale en $50.000 por inquilino, ese módulo sube a $85.000 o se vende
  solo dentro del Avanzado.**

### Lo que no hay que hacer

1. **Regalar la facturación en el Básico.** Cada cliente nuevo costaría dinero.
2. **Cobrarla por documento al cliente final.** Sería trasladarle nuestra incertidumbre y hace la
   factura del cliente impredecible, que es justo lo que odia un negocio pequeño.
3. **Prometer «cumplimiento garantizado ante la DIAN» en el copy.** Es una obligación de resultado —
   ver [`obligaciones-escalapp.md`](obligaciones-escalapp.md) §6.4.

### El certificado digital: absorberlo o pasarlo

Arriba está **absorbido** en el módulo ($8.300/mes). La alternativa es cobrárselo al cliente como lo
que es —un costo suyo, de su NIT, $100.000 al año— y bajar el módulo a $60.000. Es más honesto y más
barato de vender, pero añade una línea a la factura y una conversación. **Decisión abierta.**

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

## 5. Lo que este documento NO decide

- **El precio del plan base.** $27.999 y $59.999 se conservan tal cual; no había razón para tocarlos
  en esta sesión.
- **El IVA sobre las mensualidades.** Hoy no se cobra porque la empresa no es responsable de IVA
  ([`obligaciones-escalapp.md`](obligaciones-escalapp.md) §2). Cuando eso cambie, «$89.999» y
  «$89.999 + IVA» son dos promesas distintas y hay clientes firmados de por medio.
- **Cómo se cobra.** Hoy no hay pasarela ni débito automático. Y si el cliente es persona jurídica,
  **retiene en la fuente**: se factura $89.999 y llega menos (§3 de `obligaciones-escalapp.md`).
- **Qué pasa al pasar de 20 números de WhatsApp.** Embedded Signup cambia quién le paga a Meta y por
  tanto cambia esta tabla entera. Está en `ESTADO-Y-CONTINUACION.md` §4-0.

---

## 6. Qué hay que medir para que esto deje de ser una estimación

| # | Qué | Dónde está el dato | Bloquea |
|---|---|---|---|
| 1 | **Tiquetes reales al mes** de Pregonchos (`id_negocio` 12) | `restaurante.pedid_orden` con estado pagada, agrupado por mes | La elección de proveedor y todo el costo de facturación |
| 2 | **Mensajes salientes al mes** por negocio | Panel de Meta (*Insights*) y el Ledger de Intelligence | El costo de WhatsApp desde octubre |
| 3 | **Precio de Factus por cuenta** y si es ilimitado de verdad | Correo a Factus | Si el modelo de costo plano es viable |
| 4 | **Cotización de un PT** (Alegra, Dataico, HKA) | Un correo | Si el certificado de $100.000/año desaparece |

Los dos primeros **no dependen de nadie de fuera** y son los que más mueven la aguja.

---

## 7. Fuentes

- Precios de proveedores consultados el 2026-09-02 en sus páginas públicas; el detalle y el análisis
  de la forma del costo, en [`facturacion-electronica.md`](facturacion-electronica.md) §8
- Cobro de Meta: <https://developers.facebook.com/docs/whatsapp/pricing> y el panel de la WABA
- El cambio del 1 de octubre de 2026 sobre mensajes de servicio: anuncio de Meta, recogido por
  varios integradores en agosto de 2026 — **confirmarlo en el panel antes de la fecha**
