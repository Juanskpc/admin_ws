# Sesión 2026-10-07 — Zona Burger: auditoría de dos noches, entrega mal tomada, inventario del asistente, «confirmar cambio» y menos mensajes por pedido

**Estado al cerrar (2026-10-07 ~22:20):** todo lo de este documento está **en producción**.
`admin_ws` `2eabb43` (`master`), `admin_app-v21` `5336368` (`main`), `restaurante_app` `5ac76c4`
(`master`, que incluye `e16caf9`). El commit siguiente de `admin_ws` solo añade esta documentación.
Documento anterior:
[`sesion-2026-10-05-auditoria-en-vivo-zona-burger.md`](sesion-2026-10-05-auditoria-en-vivo-zona-burger.md).

> Se trabajó **con el local atendiendo** (17:00–22:20). Cuatro reinicios del servidor (17:10, 20:49, 21:19 y 22:14),
> cada uno con respaldo de la base antes si llevaba migración. Lo del asistente pasó por el arnés
> con `gpt-5.6-luna` antes de subir.

## 0. Para retomar mañana

1. **Auditar la noche del 2026-10-07 desde las 20:49** (primer despliegue de los arreglos) y sobre
   todo desde las 22:15 (menos mensajes por pedido). Nada de lo de §3, §5 y §6 se llegó a ver en
   un pedido real completo:
   ```bash
   ssh escalapp@45.63.105.95
   cd /var/www/admin_ws
   node scripts/auditoria_banderas.js 6 "2026-10-07 20:49"
   node scripts/auditoria_transcripciones.js 6 "2026-10-07 20:49"
   ```
   Qué mirar: cuántos mensajes del asistente lleva cada pedido (meta: 4–5), si la pregunta única
   («¿Cómo lo quieres? 🛵 … 🏃 …») sale y se entiende, si el resumen trae la línea `⏱️`, si algún
   pedido quedó con la entrega equivocada, y qué dice ante un producto desactivado.
2. **Correr las tres migraciones de hoy en la base compartida de desarrollo** (no se abrió el
   túnel): `migrate:negocio-asistente-stock`, `migrate:restaurante-cambio-cliente`,
   `migrate:negocio-tiempo-recoger`. En producción y en la local ya están.
3. Avisar a Juan David (§8): salieron a producción dos cosas suyas, y hay tres cambios en cómo el
   asistente pregunta que él no ha visto.
4. Los pendientes de §9.

## 1. Vista «Terceros»: días de Colombia y saldo que cuadra

`admin_ws` `00021a6`, `admin_app-v21` `37d16a5`. Sin migración.

- **Los días salían en hora UTC.** OpenAI solo entrega costos por día UTC (`bucket_width=1d`; con
  `1h` contesta 400), y ese día corta a las 7 p. m. de Colombia: lo de la noche aparecía como
  «de mañana». Ahora se pide además el **uso por hora** (`/v1/organization/usage/completions`, que
  sí acepta `1h`, 168 cubetas por página, pedidas por semanas en paralelo) y el costo de cada
  concepto de cada día UTC se reparte entre sus horas en proporción a los tokens de ESE concepto y
  modelo (`consumoIaService.repartirPorHora`). El total no cambia. Si el uso por hora falla,
  `reparto: 'aproximado'` y la pantalla lo dice.
- **El saldo no coincidía** (OpenAI US$10.98, la vista más). El día del SALDO se restaba con el
  Ledger, que solo ve al bot; esa noche hubo gasto fuera del bot. Ahora `calcularSaldo` resta el
  gasto **oficial desde la hora exacta** del SALDO (`metodo_dia_partida: 'por_hora'`), con la hora
  del registro prorrateada. Con los datos reales dio **US$10.99**. Los métodos `foto`, `interno` y
  `dia_completo` quedan de respaldo.
- **Hallazgo sin cerrar:** hay gasto en OpenAI que no es del bot. El 4 de octubre: US$1.83
  oficiales frente a US$0.73 del Ledger (coincide con las pruebas del cambio de modelo). El 6 por
  la noche (22–23 h): ~170 llamadas en OpenAI frente a 9 del bot, y algunas con `gpt-4o-mini`, que
  el asistente no usa. Preguntar a Juan David si corrió algo con la clave.

## 2. Auditoría: 53 conversaciones, noches del 6 y del 7

Desde el cierre anterior (2026-10-05 23:44) hasta el 7 a las 19:50. 33 pedidos del asistente.

**Noche del 6 (24 pedidos, 4 mal):** un domicilio duplicado (ORD-7809), uno con dirección
«pendiente» (ORD-7815), uno a nombre de «cliente» (ORD-7811) y uno para recoger que era un domicilio
a una clínica (ORD-7812). Los tres primeros se arreglaron esa misma noche (`437da29`, 22:04) y el 7
no se repitieron. **El de la clínica sigue abierto** (§9).

**Noche del 7 (9 pedidos hasta las 19:50, 3 con la entrega equivocada):**

| Pedido | Qué pasó | Causa |
|---|---|---|
| ORD-7878 | Dictó productos sin decir cómo lo quería; quedó «para servir» con mesa; era domicilio | La guardia se conformaba con que se hubiera PREGUNTADO |
| ORD-7876 | «Una salchilimón personal» → «para recoger» sin preguntar; el cajero contestó y el «sí» de la clienta lo ejecutó el asistente | La guardia dio por dicho un «para recoger» del 2 de octubre; y el «sí» era para el cajero |
| ORD-7877 | Con un domicilio esperando: «¿o me queda cerca para ir a recoger?»; el «sí» tomó el domicilio | El resumen viejo seguía vivo |

Lo que funcionó: los 7 pedidos de la carta digital, los mensajes con todo en uno, fotos y
ubicaciones a persona, «cancelo por transferencia» → «¿anular o pagar?», local cerrado sin modelo.

Del negocio: una persona preguntó por trabajo y esperó 22 h; una creadora de contenido, 21 h; un
domicilio que atendió el cajero se perdió.

## 3. Arreglos de la toma de pedidos (`9e3ccaa`, en producción 20:49)

Tests: `__tests__/intelligence/auditoria_2026_10_07.test.js`.

1. **`ENTREGA_SIN_DECIR` mira solo el pedido en curso y exige respuesta.**
   `pedidoEnCurso(hilo)` corta el historial en el último «pedido tomado», saludo con la carta o
   cancelación (`FRONTERA_DE_PEDIDO`): la conversación de WhatsApp no se acaba nunca y el historial
   son los últimos 20 mensajes, de cualquier día. `contestoComoLoRecibe` exige que después de la
   pregunta haya una respuesta que no sea otro producto (`SIGUE_PIDIENDO`) ni un sí suelto
   (`SI_SUELTO`); un resumen ya visto con esa entrega también vale. Sin `hilo` (quien llame a la
   antigua) se comporta como antes.
2. **Un «sí» tras escribir una persona no ejecuta.** `personaEscribioTrasElResumen`
   (`humano_ultimo_en > preguntado_en`) → `confirmacion_si_tras_persona`: se enseña el resumen otra
   vez y se pone `preguntado_en` al día. No se suelta, porque los cajeros le piden al cliente
   «confirma con el botón» (visto dos veces).
   **Límite conocido:** el eco del mensaje del cajero puede llegar después del «sí» del cliente
   (un segundo de diferencia en ORD-7876) y entonces no se detecta.
3. **Nombrar otra entrega suelta el resumen siempre**, no solo hacia domicilio
   (`entregaQueCambia`). Cambió una expectativa de `auditoria_2026_10_04.test.js`.
4. **Un producto añadido con el resumen esperando ya no reemplaza el pedido.** El flujo cede al
   modelo con `notaParaElModelo` (lo que ya estaba anotado); la escalera pasa esa nota **también
   sin soltar la tarea** (antes solo con `soltarTarea`).
5. **Producto desactivado → «agotado por hoy».** `agotadosQueCoinciden` comparaba letra por letra y
   «salchilimon» no está dentro de «Salchi-limón»: a «¿tienes disponible salchilimon?» se contestó
   dos veces «no encuentro». Ahora hay una pasada con el nombre pegado (`pegado`), y
   `buscar_producto` devuelve `nota_agotado` con la frase («Hoy se nos agotó la *X* 🙏 ¿Te provoca
   otra cosa?») y la orden de no decir «no encuentro». Visto en un chat real a las 20:49: «La
   *Salchi-limón* está agotada hoy 😕».

## 4. El inventario del asistente, aparte del de caja (`9e3ccaa`, `82c2217`)

`general.gener_negocio.asistente_mira_stock` — `npm run migrate:negocio-asistente-stock`.

Zona Burger apagó `controla_inventario` para que caja no se bloqueara y con eso el asistente dejó
de mirar existencias: colgaban del mismo interruptor. Ahora son **dos decisiones independientes y
valen las cuatro combinaciones** (pedido expreso del dueño: aunque el restaurante controle
inventario, el asistente puede no mirarlo).

- Solo habla de EXISTENCIAS. Lo desactivado a mano en Productos (`disponible`) el asistente no lo
  ofrece nunca.
- **La carta digital no cambia:** sigue a `controla_inventario`. En `cartaService` las vistas
  públicas aceptan `{ miraStock }`; el adaptador lo pasa con `asistenteMiraStock(idNegocio)`
  (`opcionDeStock`), y quien no lo pasa sigue al control de caja (`miraElStock`).
- La migración deja a cada negocio como estaba (`= controla_inventario`, una sola vez, al crear la
  columna). Zona Burger (6) y Pregonchos (12) quedaron en `false`.
- Se cambia en Bandeja → Ajustes del asistente → «Inventario». La pantalla avisa de las dos
  combinaciones raras.

⚠️ Antes de encenderla en Zona Burger hay que revisar Inventario: con el control de caja apagado
las existencias no bajan solas, y tuvo insumos en negativo (la Discordia, −321).

⚠️ Con caja controlando y el asistente sin mirar, el asistente puede ofrecer algo que `tomar_pedido`
rechaza por falta de insumos (lo descubre el dry-run del Gate antes de preguntar).

Tests: `__tests__/restaurante/asistente_mira_stock.test.js`.

## 5. «Confirmar cambio» en Despacho (`5ca9ff3`, `restaurante_app` `e16caf9`)

`restaurante.pedid_orden.cambio_cliente_en` — `npm run migrate:restaurante-cambio-cliente`.

ORD-7888: confirmado a $31.500; quince minutos después el cliente pidió «otras alitas», el
asistente las agregó y quedó en $47.000 sin que la tarjeta —ya confirmada— dijera nada.

- `agregarItemsPorCliente` pone `cambio_cliente_en`.
- `pedidoService.estadoDeConfirmacion` → `{ pendiente, cambio }`: pendiente si es del asistente y
  nadie lo confirmó, o si el cambio es posterior a `confirmado_en`. **Vale también para una orden
  que tomó una persona** (incluye lo que un cliente suma a la cuenta de su mesa por el chat).
- Despacho recibe `pendiente_confirmar` (como siempre) y `cambio_por_confirmar` (nuevo): etiqueta
  «Pedido modificado», botón «Confirmar cambio», y ofrece imprimir la comanda actualizada.
- `confirmarPedidoAsistente` confirma también ese cambio (ya no rechaza por «lo tomó una persona»
  si hay un cambio pendiente).
- No se borra `confirmado_en` al cambiar: diría «pedido nuevo» de uno ya visto.

Hoy el único cambio que el asistente hace solo es **agregar**. La tarjeta no señala cuáles
productos son los nuevos (§9).

Tests: `__tests__/restaurante/confirmacion_asistente.test.js` (6 nuevos).

## 6. Menos mensajes por pedido (`2eabb43`, `5336368`, en producción 22:15)

`general.gener_negocio.tiempo_recoger_min/max` — `npm run migrate:negocio-tiempo-recoger`.

Una salchipapa para recoger costó **siete** mensajes del asistente (conversación del 21:11): pidió
el nombre y la entrega en turnos separados, a «me confirmas en cuánto está, yo paso a recogerla»
contestó solo el tiempo («todavía no tengo ningún pedido tuyo») y el tiempo que dijo era el del
domicilio.

1. **Lo que falta se pide junto.** `tomar_pedido.falta` → `loQueFalta`: con una falta, su código
   de siempre; con varias, `FALTAN_DATOS` y la frase hecha («¿Cómo lo quieres? 🛵 *A domicilio*:
   mándame la dirección con el barrio y un teléfono. 🏃 *Para recoger o comer aquí*: dime a nombre
   de quién.»). La comprobación de la entrega quedó en `entregaSinDecir`.
2. **El resumen dice cuánto falta** (`lineaDeTiempo`), después del total: «⏱️ Estará listo en unos
   20 a 40 minutos, contados desde que confirmes.» / «⏱️ Te llega en unos 40 a 60 minutos…». No
   con una mesa ya asignada.
3. **Tiempo de recoger aparte.** Sin configurar, para recoger se dice el estimado de siempre.
   Zona Burger quedó en **20–40** (decisión del dueño; escrito con un script por SSH y auditado
   como `tiempo_recoger_configurado`). Se cambia en Bandeja → Ajustes del asistente → «Tiempo de
   entrega», segunda fila.
4. **«¿Cuánto se demora?»** (`flujo.js`): con pedido, el tiempo de ESE pedido
   (`pago.ultimoPedidoVivo().tipo_pedido`); sin pedido, los dos (`fraseDeLosDosTiempos`); con un
   resumen esperando, el de esa entrega; y si el mensaje además dice cómo lo recibe
   (`entregaNombrada`), **lo sigue el modelo** con el tiempo en una nota
   (`tiempo_con_entrega_al_modelo`).

Los pedidos de la carta digital siguen su flujo paso a paso; ahí solo cambió el resumen.

Tests: `__tests__/intelligence/menos_mensajes_por_pedido.test.js` (14).

## 7. La evaluación y las pruebas

`intelligence/evaluacion/conversaciones/respuestas_restaurante.json`: de 32 a **34 casos**
(`sigue-dictando-sin-decir-como-lo-recibe`, `recoger-de-otro-dia-no-cuenta`). Con luna y
`sistema.v15`: 33/34, 34/34, 34/34 tras §3 y 34/34, 34/34 tras §6. Cada ronda ≈ US$0,015.

```bash
LLM_MAX_VUELTAS=8 DB_HOST=localhost DB_PORT=5432 DB_USER=escalapp_dev DB_PASS=<la local> \
DB_NAME=escalapp_dev FEATURES_FORZADAS=asistente_ia LLM_MODELO=gpt-5.6-luna \
    node scripts/evaluar.js respuestas_restaurante --negocio 1815 --detalle
```

**No se tocó el prompt** (`sistema.v15`, de Juan David): todo va en las reglas de la plataforma y
en los textos que devuelven las herramientas.

**La suite completa en la base LOCAL tiene 76 fallos que ya estaban** (los mismos con y sin los
cambios de hoy, comprobado con `git stash`): a la local le faltan migraciones
(`id_metodo_pago_domicilio`, `pin_cifrado`, entre otras) y hay tests que dependen de la hora.
Ponerla al día está pendiente. `canal.test.js` y `ventana.test.js` fallaron una vez con la
máquina cargada y pasan solos.

## 8. Lo que hay que saber antes de desplegar otra vez

- **`restaurante_app`: producción no es `origin/master`.** Este PC estaba 6 commits por detrás y,
  ya al día, producción tenía una versión de Proveedores que no estaba en ninguna rama: Juan David
  despliega desde su PC trabajo sin subir. Subir el build local lo habría revertido. Comparar
  nombres de chunks no sirve (sin `package-lock.json` las versiones de Angular difieren y los
  hashes cambian en cascada: coincidió 1 de 39). Lo que sirve: bajar los `.js` del VPS y comparar
  los textos (`ssh … "cd /var/www/html/restaurante && tar -czf - *.js"`); si producción tiene
  textos que el build no, no subir.
- **Salieron dos cosas de Juan David que estaban subidas sin desplegar:** `admin_ws` `e94d195`
  (historial de pagos con comprobante en PDF) y `admin_app-v21` `cf61b5f` (pestaña «Historial» de
  Mis pagos). Avisarle.
- **Orden con migración de columna en un modelo de Sequelize:** `pull` → respaldo → migrar →
  reiniciar. El proceso viejo sigue con el código viejo hasta el reinicio; si se reinicia antes de
  migrar, toda consulta a ese modelo falla.
- El reinicio de las 17:10 (por «Terceros») cayó con el local ya abierto. No se perdió ningún
  mensaje, pero un cambio que no urge va con el local cerrado.
- Respaldos de hoy en `/home/escalapp/backups/`: `db_2026-10-07_2049`, `_2119`, `_2214`;
  `admin_front_2026-10-07_1710`, `_2051`, `_2216`; `restaurante_front_2026-10-07_2202`.

## 9. Pendientes, por prioridad

1. **Auditar esta noche** (§0).
2. **«Para llevar» + un sitio durante la confirmación** (ORD-7812): «Para llevar amor» → para
   recoger; «Clínica Proinsalud» → nota. Era un domicilio. Una dirección dicha con un pedido para
   recoger esperando debería hacer preguntar.
3. **Ligar pedido ↔ conversación con una columna** (sigue del 2026-10-05): a un cliente sin número
   visible se le dio el número de orden «para consultar cómo va» y veinte segundos después «no
   pude verificar que ese pedido sea tuyo».
4. **El eco del cajero que llega tarde** (§3.2): el «sí» que es para él todavía se puede colar.
5. **Decir qué cambió** en «Confirmar cambio» (los productos nuevos resaltados en la tarjeta).
6. `tiempoDelPedido` / `pasado_del_tiempo_estimado` siguen midiendo contra el tiempo de entrega
   también para los pedidos de recoger.
7. Detalles de la auditoría: «Vale, claro que sí, muchas gracias» no se lee como sí; el teléfono
   pedido cuatro veces a quien no podía darlo; el nombre del perfil de WhatsApp por encima del que
   el cliente escribió (ORD-7866); «una sin cebolla» que no quedó en la nota; el asistente
   contestando en chats de proveedores; un pedido del carrito rechazado 53 s después del cierre.
8. Poner al día la base local (§7) y migrar la compartida (§0.2).
9. El gasto de OpenAI que no es del bot (§1).
10. Siguen de antes: orden de llegada de dos mensajes del mismo turno; el envío semanal del informe.

## 10. Cómo deshacer

- Solo lo de §6: `git checkout 5ca9ff3` en `/var/www/admin_ws` y reiniciar. Las columnas nuevas no
  estorban al código anterior.
- Todo lo del asistente de hoy: `git checkout 00021a6` y reiniciar. Despacho deja de pedir
  «Confirmar cambio» y vuelve a su comportamiento anterior sin tocar el frontend.
- Frontends: restaurar el `.tgz` correspondiente de `/home/escalapp/backups/`.
