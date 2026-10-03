# Auditoría de la primera noche de WhatsApp — Zona Burger (2026-10-01)

Zona Burger (`id_negocio` 6) conectó su número por coexistencia a las 19:33. Se auditaron las 81
conversaciones de esa noche (11 pedidos reales, 253 mensajes salientes, 50 no entregados) y se
corrigió lo siguiente.

> **✅ DESPLEGADO el 2026-10-02 a las 00:18** — backend `admin_ws` **1f0c7cf**, admin
> `admin_app-v21` **df97079**, ambos en GitHub. Respaldo previo: `~/backups/db_2026-10-02_0018.dump`
> en el VPS. Las 3 migraciones corrieron (el backfill marcó los 15 mensajes que esperaban en
> conversaciones con una persona atendiendo) y el reinicio **no reencoló nada viejo**.
>
> **Para retomar, ir directo a «Cómo seguir» al final.**

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

## Despliegue (orden) — ya hecho, queda como referencia

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

Si hubiera que revertir: `git checkout f7f9db4` en `/var/www/admin_ws` + reinicio. Las dos
columnas nuevas (`mensaje.sin_turno_motivo`, `gener_negocio.info_asistente`) son nullable y el
código viejo las ignora, así que no hace falta deshacer las migraciones.

## Dónde configura el negocio cada cosa (para explicárselo al cliente)

Admin (`escalapp.cloud/admin`) → **WhatsApp** → «Ver conversaciones» → elegir el negocio. En la
barra superior de la Bandeja:

- **«Asistente vuelve tras … min»** — reactivación tras una respuesta humana.
- **«Entrega en … a … min»** — lo que contesta a «¿cuánto se demora?». El botón *Guardar* aparece
  solo después de escribir.
- **«Info para el asistente»** — texto libre: Nequi, valor del domicilio, formas de pago.
- **«Al asistente le faltan datos (N)» / «Asistente listo»** — la revisión de preparación.

⚠️ Esos campos **solo los edita un ADMINISTRADOR de ese negocio** (`puede_editar`). Entrando como
superadministrador salen deshabilitados: hay que usar «entrar como» con el admin del negocio. Es
la razón más probable de que el 2026-10-01 el tiempo de entrega de Zona Burger «se configurara» y
no quedara guardado (en la base seguía NULL y no había evento de auditoría).

Lo demás se configura en la **App del restaurante**: Horarios, Menú (carta), Configuración
(métodos de pago y barrios con valor de domicilio). En reserva: Servicios, Equipo, Horarios.

## Estado de los negocios al cerrar (revisión de preparación, 2026-10-02 00:20)

| Negocio | Necesario | Recomendado pendiente |
|---|---|---|
| 6 Zona Burger | — (horario y carta ✓) | info para el asistente, tiempo de entrega, valor del domicilio |
| 12 Pregonchos | — | info, reactivación, tiempo de entrega, domicilio |
| 10 D'Alex Barbería | — | info, reactivación |

## Cómo seguir (próxima sesión)

1. **Revisar la primera noche con los arreglos.** Repetir la auditoría sobre los mensajes de la
   noche del 2026-10-02 (mismo método: script de solo lectura por `scp` + `node` en el VPS, nunca
   `psql` con la clave). Qué mirar:
   - turnos con `regla:cortesia_contestada` / `cortesia_sin_respuesta` — que no calle algo útil;
   - que no haya respuestas a mensajes de más de 30 min, ni a mensajes llegados en handoff
     (`sin_turno_motivo` con valor y `id_turno` NULL es lo correcto);
   - invocaciones de `consultar_info_negocio` y si `tomar_pedido` ya entra al primer intento
     (antes: 7 de 7 con `ARGUMENTOS_INVALIDOS`);
   - pasos `confirmacion_anotada` (lo añadido al confirmar → nota del pedido);
   - `journalctl`: ya no debería salir «el indicador de escritura no se encendió (400)».
2. **Que Zona Burger complete lo recomendado** (tiempo de entrega, info con Nequi y domicilio
   $8.000). El panel de preparación se lo pide solo al entrar.
3. **Sin hacer, por orden de valor:**
   - Respuesta fija, sin modelo, a imágenes y audios sueltos (hoy van al modelo y contesta
     «no puedo ver imágenes»). Ojo: una imagen tras un pedido suele ser el comprobante de Nequi.
   - Freno a bots nuestros hablándose: si el `id_externo` es un número de `platform.numero_canal`,
     no contestar. El 2026-10-01 se probó desde el número de D'Alex hacia Zona Burger.
   - Tolerancia a erratas en `buscar_producto` («pap house» no encontró «papa»).
   - Plantilla `pedido_listo` en la WABA de Zona Burger: el aviso ya sale como texto libre dentro de
     las 24 h; la plantilla solo hace falta para pedidos de más de un día.
4. **Pruebas que ya fallaban y nadie arregló** (no son de esto): en la base local
   `e2e_agendar` (espera «10:00», el flujo ahora usa franjas), `reportes` («controlador is not a
   function»), `reinicio_por_inactividad`, `whatsapp_embedded_signup` (falta `pin_cifrado` en la
   local). En el admin, `admin-dashboard.component.spec.ts › error state`.

## Adenda 2026-10-02 (tarde) — el domicilio pasa a ser un RANGO

Cargar el precio barrio por barrio era tedioso. Desde el commit `1463f91` (backend) y `649c914`
(admin) el negocio escribe en la Bandeja **«Domicilio $ … a $ …» + una nota corta**
(`gener_negocio.domicilio_valor_min/max/nota`, `npm run migrate:negocio-domicilio-rango`). El
asistente contesta «¿cuánto vale el domicilio?» sin modelo, lo da en `consultar_info_negocio` y lo
nombra en el aviso del total al confirmar — **sin sumarlo**, porque no hay un valor exacto. Los
barrios con precio siguen funcionando y, si el cliente elige uno, su valor manda.

Desplegado el 2026-10-02 13:11 (respaldo `db_2026-10-02_1310.dump`). Zona Burger cargado:
$7.000–$9.000, nota «Fuera de Pasto, desde $10.000.»; su revisión de preparación queda con
`domicilio: ok`. **Falta migrar la base compartida (5433)**: el túnel estaba cerrado.

## Adenda 2026-10-02 (noche) — auditoría de la tarde y sus arreglos

Auditoría con `scripts/auditoria_banderas.js` y `scripts/auditoria_conversacion.js` (solo
lectura). Lo grave: a una clienta se le dijo que la **Discordia no está en la carta** — estaba
agotada porque `controla_inventario` estaba encendido con el pan brioche en −321 (el negocio ya lo
apagó). El asistente además le contestó el tiempo «de tu pedido» sin pedido, le preguntó con qué
pagaba, y dijo «ya queda enviado el comprobante». Oscar creó el pedido a mano (ORD-7562).

Desplegado el 2026-10-02 19:18 (`c5427a2`, admin `888ec77`):
- **`pasar_a_persona`** (motor, `manejadorLlm.js`): sin el dato, handoff real en vez de
  «confírmalo con ZONA BURGER». Prompt **`sistema.v8`**.
- **`agotados_ahora`** en `buscar_producto`: agotado ≠ no existe.
- **Tiempo sin pedido**: «desde que se confirman» + «todavía no tengo ningún pedido tuyo».
- **Confirmación**: no anota precios como nota, una foto no repite el resumen, y al 2.º desvío un
  pedido pasa a una persona.
- **Bandeja**: `CO.1084…` ya no se muestra como teléfono.

Pendiente, decidido para después: **comprobantes de pago** (fotos) y **domicilio por comuna**.
