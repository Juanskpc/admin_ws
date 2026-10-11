# Sesión 2026-10-10 — Zona Burger: auditoría del canal y los mensajes que sobraban

**Estado:** desplegado en producción · **Ventana auditada:** 2026-10-05 → 2026-10-10 ·
**Documento anterior:** [`sesion-2026-10-07-zona-burger-auditoria-y-menos-mensajes.md`](sesion-2026-10-07-zona-burger-auditoria-y-menos-mensajes.md)

> Cierra el pendiente §0.1 de la sesión del 07 («auditar la noche del 07 en adelante»), que llevaba
> tres noches sin hacerse. **No se tocó ninguna conversación de clientes**: la auditoría es de solo
> lectura y lo que se cambió es cómo decide el bot.

---

## 1. Lo que estaba sano, y conviene no volver a preguntar

- **Canal:** WABA `Escalapp` (`4199925320246584`) con revisión `APPROVED`; `AVAILABLE` en WABA,
  BUSINESS y APP. Nada bloqueado, incluidos los mensajes iniciados por la empresa.
- **Servicio:** `escalapp-api` activo, sin errores ni warnings en `journalctl`.
- **Turnos:** **0 con error** en todo octubre. Latencia p50 2.658 ms con modelo, 51 ms en el
  determinista (p90 4.230 / 131).
- **IA:** US$0,22 en cinco días para 106 pedidos ≈ US$0,002 por pedido. El modelo no es el problema.

## 2. El problema real: el techo del plan, no la factura de Meta

El día 10 iban **1.905 mensajes facturables** de los **6.000** que incluye el plan
(`migrate:cobranza-paquetes-mensajes`, techo del 2026-10-10). A ~205/día de servicio real la
proyección de cierre de mes era **~6.300**: el freno que degrada el asistente habría entrado en la
última semana del mes, que es la peor.

Lo de Meta, en cambio, es calderilla: pasados sus 1.000 gratis, los ~905 restantes a US$0,0008 son
~US$0,72 (~$3.000 COP) **y se los cobra a la tarjeta del inquilino**, no a nosotros (somos Tech
Provider, ver [`embedded-signup.md`](embedded-signup.md) §9.1).

**La consecuencia para el diseño:** recortar mensajes dejó de ser una cuestión de dinero y pasó a
ser una de **cupo**. Un mensaje que no aporta nada no cuesta $3, cuesta un pedido en la última
semana del mes.

### Reparto de los 1.905 (mes completo)

| Clase | Mensajes | % |
|---|---|---|
| Conversación normal | 1.005 | 52,8 |
| Resumen de confirmación | 281 | 14,8 |
| Bienvenida + carta | 228 | 12,0 |
| **Relleno corto (<45 car.)** | **187** | **9,8** |
| Handoff a persona | 101 | 5,3 |
| Local cerrado | 56 | 2,9 |
| Aviso de estado del pedido | 47 | 2,5 |

**Mensajes del bot por pedido: 9,1** en el mes (7,3 a 10,3 según el día). La meta de §6 del 07 era
4–5 y **no se cumplió**: el cambio de las 22:15 de ese día no movió la aguja. Sigue abierto.

## 3. Lo que se cambió (los cuatro recortes)

Medidos sobre la ventana 10-05 → 10-10, que tuvo **1.166 salientes facturables**.

### 3.1 La cortesía de cierre ya no contesta — 47 mensajes (4,0 %)

`intelligence/engine/cortesia.js`.

Hasta hoy el PRIMER agradecimiento de cierre se contestaba una vez con `¡Con gusto! 😊`. Fueron
**47 en seis días, en 40 conversaciones**, todos detrás de un «Gracias» / «Muchas gracias» a secas
con la conversación ya terminada.

Era una decisión del dueño del 2026-10-01, tomada cuando el mensaje era gratis. Dejó de serlo ese
mismo día. Callar ahí no es descortesía: en WhatsApp nadie contesta al «gracias» final, el cliente
ve el visto, y el módulo **ya** callaba el segundo «gracias» y cualquier «ok». Se quitó la
excepción, no se inventó una regla.

`RESPUESTA` se conserva en el módulo: volver a mandarla es un cambio de una línea.

### 3.2 El aviso de «local cerrado» no se repite a los segundos — 12 mensajes (1,0 %)

`intelligence/adapters/restaurante/flujo.js`, constante nueva `SILENCIO_CERRADO_MS` (5 min).

El aviso corto de §4-sexies arregló la **longitud** y se olvidó de la **cuenta**: dentro de la media
hora de `AVISO_CERRADO_MS`, cada mensaje entrante recibía otra vez la misma frase. Zona Burger,
**10-08 17:12**: un cliente escribió tres veces y recibió tres veces la misma línea en 35 segundos.
En la ventana fueron **12 de los 33 avisos**, todos a menos de cinco minutos del anterior.

Ahora, si la línea corta salió hace menos de cinco minutos, **no sale nada**. Pasados los cinco
vuelve, porque entonces ya puede ser otra intención. El sello largo sigue midiendo aparte, así que
la carta sigue volviendo a la media hora.

⚠️ **Esto no arregla la causa de ese caso**, que es otra: el local estaba **en horario pero sin caja
abierta** (`aun_no_abre`), y el bot despachó a un cliente que pedía domicilio hasta que un cajero lo
rescató 15 minutos después. Es el ⚠️ que §4-sexies ya anticipaba, ahora con un cliente real. Queda
en §6.

### 3.3 Un turno sale en los menos mensajes que quepan — 9 mensajes (0,8 %)

Módulo nuevo `intelligence/engine/unirRespuestas.js`, aplicado en `engine/motor.js`.

La regla 1 de [`whatsapp-costo-mensajes.md`](whatsapp-costo-mensajes.md) §4 («un aviso y una
pregunta van en el mismo mensaje») vivía desde el 2026-10-02 dentro de
`adapters/reserva/flujoCita.js`. Esa misma regla decía que va **en un solo sitio**, «porque en cada
rama por separado sería olvidarlo en la que nadie probó». Y así fue: nadie la llevó a **restaurante**,
que es el vertical que más mensajes manda.

Nueve turnos de la ventana salieron partidos en dos, **ocho de ellos el mismo par**: la respuesta del
modelo y, suelto detrás, el «Todavía no he enviado tu pedido. ¿Lo confirmo?» con botones que pega
`manejadorEscalera.conSiPendiente`. Ahora van en un mensaje, con los botones al final.

Se movió al motor y no al adaptador a propósito: ahí vale para **todos** los flujos, todos los
verticales y también para el turno del modelo, que es el que más veces devuelve dos cosas. Se aplica
después del cortacircuito —que necesita ver las respuestas como las pensó el manejador para detectar
el bucle— y antes de encolar. `flujoCita.js` sigue llamándolo porque `anteponer` y `conRastro`
necesitan la decisión ya unida antes de devolverla; es idempotente.

**De paso arregla una rama de reserva que se le escapaba a la propia regla:** `horaRechazada`
devuelve `[aviso, ...respuestas]` a mano, sin pasar por `conRastro`, así que el «No pude agendar esa
hora: …» salía suelto delante de las horas recalculadas — que es *literalmente* el primer ejemplo que
pone el comentario original de `unirRespuestas`. Es la misma lección de arriba vista desde dentro:
una regla que hay que acordarse de llamar se deja de llamar.

### 3.4 Un sticker no contesta una pregunta — 5 mensajes (0,4 %)

`intelligence/engine/cortesia.js`, bandera nueva `soloMedio` en `leer()`.

La regla 3 del módulo deja pasar la cortesía cuando el asistente acababa de preguntar, porque «¿la
quieres para recoger?» → «ok» es una respuesta. Pero un **sticker** o una **reacción** no contestan
nada: 5 de los 22 stickers de la ventana despertaron al asistente por el `?` del mensaje anterior, y
lo que salió fue un «😊 ¿Te muestro algo del menú?» que nadie pidió.

`soloMedio` es cierto cuando no había **ni una palabra**. Con una tarea a medias el flujo lo sigue
leyendo antes (`hayTarea`), así que el 👍 que confirma un pedido no se pierde.

### Lo que suman

**73 de 1.166 = 6,3 %** de lo facturable en la ventana; **~190 mensajes al mes** a este volumen. Eso
baja la proyección de cierre de ~6.300 a **~6.100**, que sigue rozando el techo: los 6,3 % compran
margen, no resuelven el 9,1 por pedido de §2.

## 4. Lo que se miró y se decidió NO tocar

- **Las «ráfagas» de dos salientes seguidos no son un bug.** De 36 rachas, **25 están separadas más
  de 2 minutos**: son la respuesta del bot y, bastante después, el aviso de «pedido listo» que
  dispara el personal. Son dos cosas distintas y juntarlas sería mentir sobre cuándo pasó cada una.
  Solo 9 eran del mismo turno — las de §3.3. *(La primera lectura de la auditoría dijo «52 mensajes
  de más» por no separar por tiempo; el número bueno es 9.)*
- **Los resúmenes de confirmación repetidos** (1–2 por conversación) son el
  `confirmacion_si_tras_persona` de §3.2 del 07, que existe a propósito.
- **La bienvenida + carta repetida 3–4 veces** por conversación está separada por **días**: son
  clientes que vuelven. No es repetición.
- **`ENTREGA_SIN_DECIR` (16 veces en tres noches)** cuesta un mensaje cada vez, pero ese mensaje es
  necesario: hay que preguntar cómo lo recibe. La guardia funcionó — **ningún pedido con la entrega
  equivocada** en la ventana, que era el problema del 07.
- **Las búsquedas repetidas de producto** (`buscar_producto` 205 veces para 58 pedidos) **no son un
  bucle**: al agrupar por turno, ningún término se repite dentro del mismo. Son clientes distintos
  pidiendo lo mismo.

## 5. Pruebas

`__tests__/intelligence/menos_mensajes_2026_10_10.test.js` — **22 casos**, uno por patrón real de la
ventana. Sin base de datos.

Regresión: `fuera_de_servicio` (16), `menos_mensajes_por_pedido` (14), `confirmacion`,
`auditoria_2026_10_02/03/04/05/05_noche/06/07`, `cupo_freno`, `motor`, `cortacircuito` — en verde.
`auditoria_2026_10_01` se actualizó: el caso que fijaba `¡Con gusto!` ahora fija el silencio, con la
historia del cambio en el comentario.

## 6. Pendientes

Los de §9 del 07 siguen vigentes salvo el §9.1 (auditar), que es esto. Nuevos o reordenados:

1. **Los 9,1 mensajes por pedido.** Es el número que decide el cupo y no bajó. Lo que queda por
   mirar: el resumen de confirmación (281 mensajes, 14,8 %) y la bienvenida + carta (228, 12 %).
2. **Caja sin abrir en horario** (§3.2): con el personal retrasado, el bot despacha a clientes que
   sí podrían pedir. Opciones: que `aun_no_abre` tome el pedido y lo deje esperando, o avisar al
   personal de que tiene caja cerrada con gente escribiendo.
3. **~10 clientes sin respuesta**, 4 de ellos quejas de la noche del 10-05 («mal servicio», «nada
   que llega»), hasta 142 h. El bot escaló bien; nadie abrió la Bandeja. **No es código** — pero
   quizá sí lo sea avisar mejor.
4. **El Ledger subestima la IA ~40 %.** OpenAI factura una línea `gpt-5.6-luna, cache writes`
   (US$0,1292 de US$0,379 en cinco días) que `model/adaptadores/openai.js` declara en cero a
   propósito: «La caché de OpenAI no cobra escritura». La factura dice que sí. En valor absoluto da
   igual, pero es la cifra con la que se dimensionan los paquetes de
   [`asistente-economia.md`](asistente-economia.md) §6. **No se tocó**: corregirlo a ojo sería
   cambiar un error por otro; hay que confirmar primero qué campo del `usage` lo trae.
5. **El motivo de un envío fallido no se guarda.** Los 50 fallidos del 10-01 19:37–19:38 (uno en cada
   una de ~50 conversaciones, en dos minutos) no se pueden explicar: `crudo->>'error'` es NULL. No se
   repite desde el 10-04, pero si vuelve seguiremos a ciegas.
6. **`gpt-4o-mini` en la factura de OpenAI** (US$0,0037 en cinco días) y el código no lo usa: solo
   aparece en un comentario de `model/precios.js`. Sigue del 07 §9.9.

## 7. Cómo deshacer

Nada de esto lleva migración ni toca el frontend: `git checkout <commit anterior>` en
`/var/www/admin_ws` y `sudo systemctl restart escalapp-api`.

Para recuperar solo el «¡Con gusto!»: devolver `respuestas: [RESPUESTA]` en el último `return` de
`cortesia.decidir`. Para solo dejar de juntar mensajes: quitar `unirRespuestas(...)` del bucle de
`motor.js` (el de `flujoCita.js` es independiente y seguía ahí desde el 02).
