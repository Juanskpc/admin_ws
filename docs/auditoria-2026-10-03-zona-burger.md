# Auditoría del asistente — Zona Burger, 2026-10-03

Ventana: 00:00 a 20:30 (32 conversaciones, 15 pedidos tomados por el asistente, 7 `pasar_a_persona`).
Método: `scripts/auditoria_banderas.js` y `auditoria_transcripciones.js` (solo lectura, en el VPS).

## Lo que funcionó
- Pedidos del menú digital: 8 de 8 entraron a la primera, con empaque automático correcto
  (pequeño/mediano según el producto y la cantidad) y el domicilio como rango sin sumarlo.
- «Sí para recoger», «cuánto se demora», cortesías y avisos de «listo» sin gastar modelo.
- El nombre del perfil de WhatsApp se usó (Gustavo, Farid, Caro…): menos un paso por pedido.
- Agotados dicen «hoy se nos acabó» y no «no existe» (PANCETA / preparaciones al barril).

## Hallazgos y qué se hizo

| # | Gravedad | Qué pasó | Arreglo |
|---|---|---|---|
| 1 | **Alta** | `consultar_info_negocio` **no estaba habilitada para ningún restaurante** (faltaba su fila en `platform.capacidad_habilitada`): cero invocaciones desde su despliegue. Todo «dame el Nequi», «por transferencia», «cuánto es con el domicilio» acabó en una persona (≥6 chats hoy) aunque el dato estaba cargado. | Migración `migrate:intelligence-info-negocio` (a quien ya tiene `consultar_estado_pedido`). |
| 2 | **Alta** | Una persona entra a «confirmar» un pedido que el cliente ya tenía delante, el cliente dice «sí» y ese «sí» se pierde (conversación en handoff): el pedido no se crea y se teclea a mano. 2 pedidos hoy (Natha, Diana). | `motor.recibir` + `repositorio.reanudarConfirmacionPendiente`: un sí claro a una confirmación vigente (10 min) se ejecuta y la conversación vuelve a la persona, sin aviso de escalada nuevo. |
| 3 | Media | Adiciones (papa, queso gratinado, chicharrón, maicitos) no existían: el bot decía «no me aparece» y pasaba a una persona; el personal las anotaba en la nota o como pedido aparte (ORD-7616). | Categoría **ADICIONALES** con las 7 de la carta impresa (`scripts/cargarAdicionesZonaBurger.js`) y regla en el prompt: se agregan como producto aparte. |
| 4 | Media | Pregunta de tiempo no reconocida («Cuánto te demoras?», «cuanto tienpo se demora»): el modelo contestó «aún no tengo un tiempo estimado» y, durante una confirmación, la pregunta se **anotó como nota de cocina**. | Patrones de tiempo ampliados; las preguntas de cuánto/tiempo no se anotan; `consultar_estado_pedido` devuelve `tiempo_estimado_del_negocio`. |
| 5 | Media | Foto/audio/ubicación sueltos (comprobante de Nequi) → el modelo contestaba «¿quieres que revise las imágenes o te ayudo a elegir otra hamburguesa?». | Respuesta fija «Recibí tu foto… se la paso al equipo» + handoff (sale en «Esperan respuesta»). |
| 6 | Media | Quien pregunta por empleo/hoja de vida/ser domiciliario recibió promesas del bot («Listo, si necesitamos apoyo te escribimos», «Perfecto, para mañana»). | Prompt `sistema.v11`: no es un cliente → `pasar_a_persona` sin prometer nada. |
| 7 | Media | Búsqueda sin tolerancia a erratas: «papas con limos» y «visiosa» → «no encuentro» con el producto en la carta. | `mismaPalabra` acepta 1 error (2 en palabras de 8+). |
| 8 | Media | Nombre de perfil: «. 𐙚 Natha 𝜗𝜚» llegó tal cual al resumen; el modelo mezcló el nombre dicho con el del perfil («Danniel paz» en vez de «Carlos paz»; «Franchesca Ramirez»); un perfil de negocio («Arteforinox») quedó como nombre. | `nombreLegible` deja solo letras latinas; el prompt prohíbe mezclar; el cliente puede corregir con «a nombre de …». **El caso del perfil-empresa no tiene solución automática**: se ve en el resumen. |
| 9 | Baja | «Con el domicilio» tras oír el total → una persona. | Patrón de domicilio (mensaje entero) + info del negocio. |
| 10 | Baja | Saludo «¡Buenas tardes!» a quien escribió «buenas noches» (18:52). | El saludo devuelve el del cliente. |

## Lo que NO es del código (decisiones del negocio)
- **PANCETA** figuraba disponible a las 17:31 («sí tenemos») y el personal respondió «no tenemos
  preparaciones al barril». Cuando se acaba algo, marcarlo como no disponible en Menú al instante: el
  bot ya contesta «hoy se nos acabó».
- **Empaque de las adiciones**: se cargaron sin empaque. Las porciones (papa, chicharrón, maicitos,
  patacón, costilla) probablemente llevan envase: se liga desde Menú → editar → Empaque.
- El **valor exacto del domicilio** sigue siendo del domiciliario (rango 7–9 mil): el bot da el rango.
- ORD-7608 a 7645 quedan `ABIERTA`: el personal los confirma en Caja (el pedido del bot nace «por confirmar»).

## Pendiente
- Total con domicilio calculado por el bot (hoy da el total y el rango por separado).
- Pedidos del bot **sin teléfono visible** (BSUID): no se les puede avisar de «listo» salvo por el chat.
- Por la noche de hoy no se vio ningún error de modelo ni de entrega.

Tests: `__tests__/intelligence/auditoria_2026_10_03.test.js` (40) y `confirmacion_nombre_y_entrega.test.js` (21).
