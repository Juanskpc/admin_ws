# Auditoría del asistente — Zona Burger, 2026-10-04

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

## Visto y NO arreglado (para decidir)
- **Durante una confirmación, una pregunta se repregunta sin contestar** («¿Lo tienes en combo?»,
  «El domicilio siempre me cobran 6 mil») y otras frases se anotan como nota de cocina («Si.
  Cambios», «Voy para allá», «No necesito empaque allá voy a consumir» — este último debía cambiar
  a *para servir* y quitar el empaque).
- **Fuera de horario, una queja recibe «seguimos fuera de horario» tres veces** (11:42, la
  salchipapa «mojada»). Al abrir, el modelo la pasó bien a una persona. Valdría marcarla para la
  Bandeja aunque esté cerrado.
- «gaseosa personal sabor cuatro» no encontró el producto «cuatro» a la primera.
- La **familiar** es un solo producto con el sabor en la nota («The House»): dato de la carta.
- `[reaction]` sigue saliendo en la Bandeja en producción: el arreglo (`a47a8ac`) está en `master`
  pero **no desplegado**.

## Lo que NO es del código (decisiones del negocio)
- Domicilio: el personal dio 5, 6, 7 y 8 mil en distintos chats; el rango configurado es 7–9 mil.
  Si el valor real baja de 7 mil, hay que corregir el rango (Bandeja → configuración).
- Empleo: el personal contesta «escribe al número del video»; si es la respuesta fija, cabe en
  `info_asistente` y el bot la daría sin persona.

Tests: `__tests__/intelligence/auditoria_2026_10_04.test.js` (14). Suite de `intelligence` contra
la local: 1134 pasan; los 30 que fallan (`e2e_agendar`, `reinicio_por_inactividad`,
`whatsapp_embedded_signup`, `reportes`) fallan igual sin estos cambios (deriva de la base local).
