# Auditoría de la primera noche de WhatsApp — Zona Burger (2026-10-01)

Zona Burger (`id_negocio` 6) conectó su número por coexistencia a las 19:33. Se auditaron las 81
conversaciones de esa noche (11 pedidos reales, 253 mensajes salientes, 50 no entregados) y se
corrigió lo siguiente. Todo sin desplegar al cerrar este documento: ver «Despliegue».

## Lo que se corrigió

| # | Qué pasó | Corrección | Dónde |
|---|---|---|---|
| 1 | Mensajes que llegaban con una persona atendiendo (`handoff_humano`) quedaban «pendientes»; al volver la conversación al asistente (plazo de 15 min o reinicio) el bot los contestaba de golpe, ya atendidos a mano. A las 20:50 contestó 11 chats con mensajes de hasta 1 h. | Columna `intelligence.mensaje.sin_turno_motivo`: se marca al guardar si la conversación no es procesable. Además, `mensajesPendientes` ignora lo anterior a `humano_ultimo_en`. Backfill en la migración. | `engine/motor.js#recibir`, `engine/repositorio.js`, `migrate_intelligence_sin_turno.js` |
| 2 | Al conectar, Meta entregó por `messages` ~110 mensajes viejos de la app (stickers, fotos); el bot contestó a ~55 chats y 45 rebotaron con 131047. Todos tenían más de 1 h de retraso; los reales, 0 min. | `esAntiguo()`: más de `WHATSAPP_ANTIGUEDAD_MAX_MIN` (30 por defecto) de retraso → se guarda con `sin_turno_motivo='antiguo'` y no despierta al motor. | `channels/whatsapp/adaptador.js` |
| 3 | Indicador «escribiendo…» devolvía 400 en cada mensaje. | Se mandaba con el número y token GLOBALES; ahora con los del negocio, como `enviarMensaje`. | `channels/whatsapp/api.js` |
| 4 | Los 7 pedidos que tomó el modelo fallaron el primer intento (`items` como texto). | `renderizarEsquema` no tenía caso `lista` y lo describía como `string`. Ahora es `array` de objetos. | `model/adaptadores/openai.js`, `anthropic.js` |
| 5 | «¿Cuánto se demora?» no cubría a quien recoge. | Patrones «en cuánto puedo pasar/recoger», «a qué hora llega». | `adapters/restaurante/flujo.js` |
| 6 | No sabía pagos, Nequi, valor del domicilio ni horario; el personal entró a mano cada vez. | Capacidad `consultar_info_negocio` (estado de atención, horario de hoy, métodos de pago, barrios, tiempo estimado) + texto libre `gener_negocio.info_asistente` editable en la Bandeja («Info para el asistente»). | `adapters/restaurante/index.js`, `migrate_negocio_info_asistente.js`, Bandeja (admin) |
| 7 | «Cancelar» = pagar en Colombia; el bot ofrecía anular pedidos. | Aclarado en `cancelar_pedido` y `consultar_info_negocio`. | `adapters/restaurante/index.js` |
| 8 | «Pendiente de pago» confundía; «7541» sin `ORD-` no aparecía. | `consultar_estado_pedido` devuelve `estado_para_el_cliente` y busca por dígitos. | `adapters/restaurante/index.js` |
| 9 | «Si Veci» no confirmaba; lo añadido al confirmar se perdía. | `esAfirmacion()` (sí + cortesías); lo añadido va a la nota del pedido (`confirmacion.anotar`) y se enseña antes del «sí». | `engine/texto.js`, `engine/confirmacion.js` |
| 10 | Cortesías: «Gracias» → «¡Con gusto!» → «Gracias» → «¡Con gusto!», cada una con el modelo. | `engine/cortesia.js`: el primer agradecimiento de cierre se contesta con frase fija ($0); lo demás (ok, sticker, emoji, 2º gracias) se calla. No aplica si el asistente acaba de preguntar, con tarea a medias o en el primer mensaje. | `engine/cortesia.js`, `engine/manejadorEscalera.js` |
| 11 | Elegía el tamaño (ofreció *familiar*) cuando el cliente no lo dijo. | Instrucción en `buscar_producto`: preguntar el tamaño. | `adapters/restaurante/index.js` |

| 12 | Nadie le dijo a Zona Burger qué datos necesitaba el asistente. | **Revisión de preparación**: `GET /admin/intelligence/bandeja/preparacion` revisa número conectado, plan, horario, carta, tiempo de entrega, métodos de pago, domicilio, info libre y reactivación (reserva: servicios, profesionales, horario). En la Bandeja sale el botón «Al asistente le faltan datos (N)» y el panel **se abre solo** al entrar con algo pendiente —o sea, apenas se conecta el número—, con por qué importa cada cosa y dónde se arregla. | `app_admin_api/services/preparacionAsistenteService.js`, Bandeja (admin) |

Añadir una comprobación = añadir un objeto a `comunes()`, `deRestaurante()` o `deReserva()`.

Pruebas: `__tests__/intelligence/auditoria_2026_10_01.test.js` (33). Suite completa contra la local:
1644/1674; las 30 que fallan ya fallaban antes (pruebas desactualizadas de `reportes`,
`e2e_agendar`, `reinicio_por_inactividad` y `pin_cifrado` ausente en `whatsapp_embedded_signup`).

## Despliegue (orden)

```bash
ssh escalapp@45.63.105.95
~/backup.sh                                   # respaldo antes de migrar
cd /var/www/admin_ws && git pull && git log --oneline -1
npm install --omit=dev
npm run migrate:intelligence-sin-turno        # ANTES de reiniciar: el motor ya consulta la columna
npm run migrate:negocio-info-asistente
npm run migrate:restaurante-tiempo-estimado   # idempotente, por si no se corrió
sudo systemctl restart escalapp-api
```

⚠️ `migrate:intelligence-sin-turno` **antes** del reinicio: sin la columna, las consultas de
pendientes fallan y el bot no contesta a nadie. Su backfill además marca los mensajes que esa
noche quedaron pendientes en conversaciones con una persona atendiendo (15 al auditar).

Luego el admin (`admin_app-v21`, campo «Info para el asistente» en la Bandeja).

## Pendiente (no es código)

- Que Zona Burger llene en la Bandeja su **tiempo de entrega** y la **info para el asistente**
  (Nequi, domicilio $8.000, efectivo). Sin eso el bot sigue sin saberlo.
- Avisos de «pedido listo» que fallaron esa noche: ORD-7533, 7539, 7540, 7543 (ya entregados).
- Sin hacer: protección contra dos bots nuestros hablándose (un número de EscalApp escribiéndole
  a otro); respuesta fija sin modelo a imágenes/audios.
