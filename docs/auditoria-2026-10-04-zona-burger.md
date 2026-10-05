# Auditoría del asistente — Zona Burger, 2026-10-04

> Todo lo de este documento está **desplegado** desde la noche del 2026-10-04. Lo que vino después
> en la misma sesión (modelo luna, búsqueda afinada, carta renombrada, pausa, cajero, diagnóstico e
> informe) está en [`sesion-2026-10-04-zona-burger-costo-carta-diagnostico.md`](sesion-2026-10-04-zona-burger-costo-carta-diagnostico.md).

Ventana: 2026-10-03 20:30 → 2026-10-04 20:06 (63 conversaciones, 34 pedidos tomados por el
asistente, 4 `pasar_a_persona`, 24 `consultar_info_negocio` — ya funciona tras el arreglo de ayer).
Método: `scripts/auditoria_banderas.js` y `auditoria_transcripciones.js` (solo lectura, en el VPS).

## Lo que funcionó
- Pedidos del menú digital y por chat entran a la primera en la gran mayoría; «¿cuánto se demora?»,
  cortesías y avisos de «listo» sin modelo.
- `consultar_info_negocio` ya se usa (24 veces): horario, domicilio, Nequi.
- Agotados («hoy se nos acabó») y adiciones a un pedido ya tomado (`agregar_items_pedido`).

## Hallazgos y qué se hizo

| # | Gravedad | Qué pasó | Arreglo |
|---|---|---|---|
| 1 | **Alta** | El personal manda la plantilla «📝 Pedido 📍 Dirección 👤 Nombre 📞 Teléfono 💳 Medio de pago» y el cliente la devuelve llena. `esPreguntaDePago` miraba solo la **última línea** («💳 Medio de pago: efectivo») y el bot contestaba las formas de pago **en vez de tomar el pedido**. 4 veces en la tarde (Mario, Leidy, Erika ×2); Mario acabó con pedido duplicado ofrecido y la queja «Sean serios de verdad». | `pago.pareceDatosDePedido` mira el mensaje entero (emojis de la plantilla, teléfono, rótulos `Pedido:`/`Dirección:`, más de 25 palabras) y «medio de pago: X» cuenta como dicho, no preguntado. Igual en `esCancelarAmbiguo`. |
| 2 | **Alta** | El saludo devolvía «¡Buenas tardes!» a «Buenas noches» a las 6 PM **aunque el arreglo de ayer estaba desplegado**: los `\b` de `saludoDelCliente` se habían guardado como el carácter de retroceso U+0008 (invisible), así que ninguna expresión casaba. 3 casos hoy. | Reemplazados por `\b` reales; cualquier espacio (también U+00A0) cuenta. Test que lo cubre. Revisado que no hay otro U+0008 en el repo. |
| 3 | **Alta** | Una persona tomó el pedido a mano por el chat, el plazo de reactivación devolvió la conversación al asistente y, cuando el cliente preguntó cómo iba, el bot dijo «todavía no tengo ningún pedido tuyo, ¿te lo tomo?» (Mauricio, Mario). | `preguntaPorSuPedido` + `personaAtendioHacePoco` (6 h, `humano_ultimo_en`, que ahora viaja en la conversación bloqueada): si no hay pedido del asistente, se devuelve a la persona con «Tu pedido lo está llevando alguien del equipo». |
| 4 | Media | El modelo decidió que **San Vicente (barrio de Pasto) era «fuera de Pasto»** y dio «desde $10.000»; el cliente, frecuente y acostumbrado a $8.000, dijo que dejaba de pedir. Lo rescató el personal. | `consultar_info_negocio.domicilio_rango.como_usarlo` + descripción: nunca decidir si un barrio queda dentro o fuera; la nota de «fuera» solo si el cliente dice que es otro municipio. (Sin tocar el prompt `sistema.v11`.) |
| 5 | Media | Teléfono con una frase detrás («3169932352 , porfa es que pago es con tarjeta») se guardó entero: `tomar_pedido` lo rechazó y el cliente leyó «"cliente_telefono" es demasiado largo (máximo 40)». | El paso TELÉFONO guarda solo el número; el resto va a la nota. |
| 6 | Media | El modelo llamó `tomar_pedido` con `id_producto: 0` sin buscar el producto (2 veces) y a una clienta le dijo «no pude registrarla por un problema interno». | El error de argumentos le llega al modelo con `instruccion`: corregir, buscar el id, no contárselo al cliente. |

## Segunda tanda (pedidos del dueño, misma noche)

| # | Qué pasó | Arreglo |
|---|---|---|
| 7 | Con un pedido esperando el sí, una pregunta («¿Lo tienes en combo?», «el domicilio siempre me cobran 6 mil») se repreguntaba sin contestar, y un cambio («Si. Cambios», «No necesito empaque, allá voy a consumir») acababa en la nota de cocina. | `vaAlModeloDuranteLaConfirmacion` (flujo): preguntas, cobros y cambios —incluido cambiar la entrega— los contesta el modelo **sin cerrar la confirmación**; el modelo recibe una nota de que el pedido aún no se envió, y la escalera añade «Todavía no he enviado tu pedido. ¿Lo confirmo?» (`conSiPendiente`). |
| 8 | «Voy para allá», «Para Servir», «Para recogerla» se anotaban como nota de cocina. | `confirmacion.lineasParaAnotar` ya no anota repetir la entrega ni avisar que va en camino. |
| 9 | Al reclamar la demora, el modelo dijo «Va en 57 minutos desde que se pidió… aún está dentro del tiempo». | `consultar_estado_pedido` ya no devuelve los minutos (solo si se pasó del tiempo). **La primera** pregunta por el pedido se contesta; **la segunda** va a una persona: «Ya le dejé tu mensaje a alguien del equipo…» (`yaSeContestoElEstado` mira tiempo contestado o `consultar_estado_pedido` después del último pedido). Reclamos de demora («ya son los 60 minutos», «no ha llegado») también cuentan. |
| 10 | «¿Cuántas cajas vienen?» → el modelo inventó «una sola caja» y discutió con quien siempre recibe caja y media. | Preguntas de cajas/empaques → «No tengo ese dato con exactitud 🙏 Ya le dejé tu pregunta a alguien del equipo», en Esperan respuesta. Y prompt **`sistema.v12`** (= v11 + dos párrafos): lo que ninguna herramienta dice no se afirma, se pasa a una persona; si ya dijo cómo va el pedido y repreguntan, no repite ni cuenta minutos. |
| 11 | Una clienta reaccionó con un emoji al aviso de «pedido listo» una hora después y recibió «Ahora mismo no tengo a nadie del negocio disponible…». La regla de cortesía no aplica en sesión nueva, el modelo se quedó en blanco y salió el respaldo. | El canal ya las descarta (`a47a8ac`, falta desplegar) y el motor guarda `[reaction]` como `sin_contenido`: nunca abre un turno. |

## Visto y NO arreglado
- **Fuera de horario, una queja recibe «seguimos fuera de horario» tres veces** (11:42, la
  salchipapa «mojada»). Al abrir, el modelo la pasó bien a una persona. Valdría marcarla para la
  Bandeja aunque esté cerrado.
- «gaseosa personal sabor cuatro» no encontró el producto «cuatro» a la primera.
- La **familiar** es un solo producto con el sabor en la nota («The House»): dato de la carta.

## Lo que NO es del código (decisiones del negocio)
- Domicilio: el personal dio 5, 6, 7 y 8 mil en distintos chats; el rango configurado es 7–9 mil.
  Si el valor real baja de 7 mil, hay que corregir el rango (Bandeja → configuración).
- Empleo: el personal contesta «escribe al número del video»; si es la respuesta fija, cabe en
  `info_asistente` y el bot la daría sin persona.

Tests: `__tests__/intelligence/auditoria_2026_10_04.test.js` (32). Suite de `intelligence` contra
la local: 1151 pasan; los 30 que fallan (`e2e_agendar`, `reinicio_por_inactividad`,
`whatsapp_embedded_signup`, `reportes`) fallan igual sin estos cambios (deriva de la base local);
`ventana.test.js` falló una vez dentro de la suite completa y pasa sola (intermitente, por tiempos).
