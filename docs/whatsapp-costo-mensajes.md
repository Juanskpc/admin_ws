# Lo que cuesta cada mensaje de WhatsApp, desde el 1 de octubre de 2026

**Estado:** vigente · **Fecha:** 2026-10-02 ·
**Hermano de:** [`canal-whatsapp.md`](canal-whatsapp.md) (el canal) ·
[`asistente-reserva.md`](asistente-reserva.md) (el flujo que los gasta)

> **En una frase.** Hasta el 30 de septiembre de 2026 contestar por WhatsApp era gratis y el flujo
> se diseñó sabiéndolo. Desde el 1 de octubre, Meta cobra **por mensaje entregado** pasada una
> asignación de **1.000 mensajes de servicio por número y por mes**. Eso convierte «cuántos
> mensajes gasta una conversación» en una decisión de producto con factura.

---

## 1. Qué cambió exactamente

| | Hasta 2026-09-30 | Desde 2026-10-01 |
|---|---|---|
| Respuesta de texto libre dentro de la ventana de 24 h (*service message*) | **gratis, sin límite** | **1.000 gratis por número y mes**; a partir del 1.001 entregado, se cobra a la tarifa del mercado del destinatario |
| Plantilla *utility* dentro de la ventana (nuestro `recordatorio_cita`) | gratis | **se cobra**, y **no** consume la asignación de servicio |
| Mensaje que escribe el cliente | gratis | gratis |
| Mensaje que el dueño manda desde su móvil (coexistencia) | no pasa por la Cloud API | sigue sin pasar: **no se factura** |

Tres cosas que importan y no son evidentes:

- **La asignación es por número de teléfono, no por cuenta.** En nuestra arquitectura cada inquilino
  conecta su propio número (`platform.numero_canal`, coexistencia), así que **cada inquilino tiene
  sus propios 1.000**. No se comparten. Eso fue suerte de una decisión tomada por otra razón —el
  aislamiento por `id_negocio`— y conviene no perderla: un día que varios inquilinos salieran por
  un número común, compartirían la cuota.
- **No se acumula.** Lo que no se gasta en octubre no está en noviembre. Se renueva el día 1.
- **Lo que se cobra es lo *entregado*.** Un mensaje que Meta rechaza (`estado_entrega = 'fallido'`)
  no se paga.

> ⚠️ **`canal-whatsapp.md` dice «agendó dos citas reales y no costó un centavo».** Era verdad el
> 2026-08-24 y ya no lo es. Esa línea es histórica; lo vigente es este documento.

---

## 2. Qué significa en números nuestros

Lo que se paga es **lo que manda el asistente**, no lo que escribe el cliente. Así que la métrica
que decide la factura es **mensajes salientes por cita agendada**, y la asignación partida por ella
es cuántas citas al mes entran gratis:

| Mensajes por cita | Citas gratis al mes |
|---|---|
| 10 | 100 |
| 7 | 142 |
| 6 | 166 |
| 3 | 333 |

**Medido en restaurante el 2026-10-08** (Zona Burger, `id_negocio` 6, modelo `luna`): **8,6
mensajes salientes por pedido conseguido**, contando también las conversaciones que no acaban en
pedido. Con los 1.000 gratis eso son **unos 115 pedidos al mes** antes de que Meta empiece a
cobrar. Es la equivalencia que hay que enseñarle al dueño —él cuenta pedidos, no mensajes— y la
que usan los paquetes de [`asistente-economia.md`](asistente-economia.md) §6.

Medido sobre el catálogo real de D'ALEX (17 servicios en 4 categorías, 10 profesionales, horario de
09:00 a 19:00 en pasos de 30 min), antes del 2026-10-02 una cita costaba **9 o 10 mensajes**:
categorías → servicios → «Ver más» → días → jornada → horas → nombre → profesional → resumen →
listo. Después de los cambios de ese día, **6 por el camino del menú y 3 cuando el cliente escribe
lo que quiere** (ver [`asistente-reserva.md`](asistente-reserva.md) §13).

---

## 3. Cómo se mira, sin esperar a la factura

El dato ya estaba en `intelligence.mensaje` y nadie lo miraba. Ahora hay dos formas de verlo:

```bash
npm run whatsapp:cuota                 # todos los números, con barra de progreso
npm run whatsapp:cuota -- --negocio 10 # uno, con su gasto por cita
npm run whatsapp:cuota -- --dias 7     # la media de la última semana
```

⚠️ **Cuenta la base del `.env`.** En local cuenta los mensajes de local. Para ver producción hay que
correrlo por SSH en el VPS, donde está la base que de verdad atiende a los clientes.

Y hay aviso automático: `intelligence/avisos/cuotaWhatsapp.js` revisa una vez al día y deja una
**campanita** en el admin del inquilino al llegar al 80 % y otra al agotarla. Dos por mes como
máximo, y el mensaje dice **dónde está el gasto** («cada cita gasta 7 mensajes de media, así que
caben unas 142 al mes»), porque «vas por el 80 %» no es información sobre la que nadie pueda actuar.

### Qué se cuenta y qué no

```sql
direccion = 'saliente'
AND canal = 'whatsapp'
AND estado_entrega = 'entregado'        -- lo fallido no se factura
AND COALESCE(crudo->>'origen','') <> 'app_negocio'   -- el móvil del dueño no pasa por la API
AND plantilla IS NULL                   -- las plantillas se cobran aparte
```

Sale de `intelligence.mensaje` y **no** de un contador propio, por lo mismo que el aviso de escalado
reutiliza la campanita: un contador paralelo sería una segunda verdad sobre lo mismo, y la primera
vez que divergieran —un reintento, un acuse tardío— no habría forma de saber cuál mentía.

Es una aproximación honesta, no la factura. Sirve para lo que tiene que servir: ver si un número va
camino de pasarse **con tiempo para hacer algo**.

---

## 4. Las reglas que salen de aquí, y hay que aplicar sin que nadie lo pida

1. **Un aviso y una pregunta van en el mismo mensaje.** Dos mensajes cuestan dos y se leen peor: el
   aviso llega suelto, sin la cosa a la que se refiere al lado. Lo hace `unirRespuestas` en
   `adapters/reserva/flujoCita.js`, en un solo sitio y para todas las ramas — en cada rama por
   separado sería olvidarlo en la que nadie probó, y aquí el olvido se paga.
2. **Antes de partir un menú en dos, comprobar si cabe enumerado.** Un listado de hasta 24 opciones
   en un mensaje es más barato **y** mejor que tres menús paginados: el cliente ve todo de una vez.
   Por encima de eso, agrupar sí ayuda (`seEnumera`).
3. **Antes de añadir un paso, comprobar si el dato ya se sabe.** El nombre venía en el webhook
   (`contacts[].profile.name`) y se preguntaba igual. Un paso que pregunta algo que ya tenemos es
   un mensaje facturado a cambio de nada.
4. **Los recordatorios se cobran desde el primero.** Hoy hay uno por cita, 24 h antes, y está bien.
   Añadir un segundo recordatorio es una decisión de coste, no de cortesía.

---

## 5. Lo que queda por decidir

1. **La tarifa de Colombia.** ⚠️ **Cifra de trabajo desde el 2026-10-08: $2,9455 COP por mensaje
   de servicio entregado a un número colombiano (≈ USD 0,0008).** Coincide en varias fuentes de
   integradores y encaja con que Meta facture en COP desde abril de 2026, pero **no se ha leído
   del tarifario oficial**. Antes de imprimirla en la landing hay que verla en el panel de la WABA
   de un cliente real. Con ella ya se pudo poner precio a los paquetes del plan: ver
   [`asistente-economia.md`](asistente-economia.md) §6.
2. ~~**¿Quién paga el exceso?**~~ **Resuelto y verificado** ([`embedded-signup.md`](embedded-signup.md)
   §9.1): como Tech Provider, el número del inquilino crea una empresa y una WABA separadas de las
   nuestras y **Meta le cobra a su tarjeta**. La consecuencia comercial importa y está en
   [`asistente-economia.md`](asistente-economia.md) §3: **no podemos revender mensajes**. Lo que
   vendemos en un paquete es capacidad del asistente —nuestro costo de IA—, y lo de Meta se lo
   cobran a él aparte. Sigue en pie el aviso de siempre: si algún día un inquilino sale por un
   número nuestro, esto cambia y hay que decidirlo antes, no después.
3. **El umbral del aviso.** 80 % es un punto de partida (`WHATSAPP_CUOTA_UMBRAL`). Con un mes de
   datos reales se sabrá si llega demasiado tarde.
