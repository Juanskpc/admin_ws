# Relevo — WhatsApp de Zona Burger, 2026-10-02 (cierre ~20:45)

> **Para quien toma el control de los mensajes.** Todo lo de este documento está **commiteado,
> subido a GitHub, desplegado en producción y migrado** (producción y base compartida 5433). Al
> cierre, producción estaba sana: servicio activo, sin errores en el log, sin 4xx/5xx desde el
> último despliegue. Lo que falta está en «Pendiente».

---

## 1. Bajar los cambios

```bash
cd admin_ws        && git pull     # master — último: 48ac038 (+ este doc)
cd admin_app-v21   && git pull     # main   — último: 888ec77
cd restaurante_app && git pull     # master — último: be93da5
```

**Migraciones nuevas del día** (las tres ya están en producción **y** en la compartida 5433; en tu
base LOCAL 5432 hay que correrlas, o el código nuevo falla al leer `pedid_orden`):

```bash
npm run migrate:negocio-domicilio-rango        # gener_negocio.domicilio_valor_min/max/nota
npm run migrate:restaurante-para-servir        # pedid_orden.para_servir
npm run migrate:restaurante-empaque-producto   # (la de Juan David, también de hoy)
```

⚠️ `para_servir` está en el **modelo de Sequelize**: en cualquier entorno, migrar **antes** de
reiniciar el backend, o toda consulta a `PedidOrden` sin `attributes` revienta.

---

## 2. Qué se desplegó (orden cronológico)

| Commit | Repo | Qué |
|---|---|---|
| `1463f91` / `649c914` | ws / admin | **Domicilio como rango** («$7.000 a $9.000» + nota) en la Bandeja, en vez de barrio por barrio. Zona Burger: 7.000–9.000, «Fuera de Pasto, desde $10.000.» |
| `c5427a2` | ws | **`pasar_a_persona`** (herramienta del motor, no del Registry): sin el dato, handoff real en vez de «confírmalo con ZONA BURGER». **`agotados_ahora`** en `buscar_producto`. Tiempo estimado sin pedido no dice «tu pedido». Confirmación: precios no son nota, foto no repite el resumen, 2.º desvío de un PEDIDO → persona. Prompt **`sistema.v8`**. |
| `888ec77` | admin | Bandeja: `CO.1084…` (usuario de WhatsApp sin número, «BSUID») ya no sale como teléfono. |
| `da3b9e1` | ws | Scripts de auditoría de solo lectura (ver §4). |
| `21dc898` / `be93da5` | ws / restaurante | **«Para servir»** (comer en el local): MESA sin `id_mesa` → primera mesa libre, `para_servir`, nombre; marca «🍽️ Para servir · <nombre>» en **Mesas** y **Cocina**; botón «Para servir aquí» en el flujo si hay mesas. Prompt **`sistema.v9`** (sin pregunta de confirmación propia). `[revoke]` (mensaje borrado) sin turno. |
| `cac5a03` | ws | **Un número nunca es «cortesía»**: el filtro se comió los teléfonos de una clienta y el pedido no se creó. |
| `f079ccb` | ws | **«Avisar que está listo»** encuentra el chat por el número de pedido cuando el cliente no tiene teléfono (BSUID). |
| `48ac038` | ws | **Búsqueda**: pasadas 2 y 3 se juntan («salchipapa criollita» solo traía la familiar). **Preguntas de domicilio/tiempo durante la confirmación** se contestan. **Estado del pedido** sin etapa inventada + minutos/pasado del estimado. «Te paso con alguien» sin herramienta → **handoff real**. |

Respaldos de la base de producción antes de cada migración: `db_2026-10-02_1310.dump` y
`db_2026-10-02_1941.dump` en `/home/escalapp/backups/`.

---

## 3. Cómo se comporta ahora el asistente (lo que hay que saber al leer chats)

- **Cuando no sabe algo, pasa la conversación a una persona** («Eso te lo confirma alguien del
  equipo de ZONA BURGER por este mismo chat 🙌»). La conversación queda en **«Esperan respuesta»**
  de la Bandeja, con campanita y correo. **El bot no vuelve solo si nadie contesta** (ADR-023); si
  alguien contesta, vuelve tras los minutos de reactivación configurados.
- **Lo mismo pasa** si el bot escribe «te paso con alguien», si un pedido lleva más que el tiempo
  estimado (60 min) y el cliente pregunta, o si el cliente se desvía dos veces al confirmar un pedido.
- **Producto agotado** → «hoy se nos acabó», nunca «no está en la carta».
- **«Para servir»** → mesa libre asignada; si no hay libres, ofrece recoger.
- **Domicilio** → dice el rango; el valor exacto lo confirma el restaurante. **No se suma al total.**
- **Clientes sin número visible** (`CO.…`): el pedido nace sin teléfono; el aviso de «listo» los
  encuentra solo si el pedido lo tomó el asistente.

### Lo que hace Zona Burger que condiciona al bot (no es código)

- **No usa la pantalla de Cocina**: `estado_cocina` siempre nulo. Por eso el estado del pedido se
  dice por tiempo transcurrido, no por etapa.
- **Apagó el control de inventario** (el pan brioche estaba en −321 y escondía la Discordia).
- **El domicilio se le paga al domiciliario**: los ~2.060 pedidos a domicilio tienen
  `valor_domicilio = 0`. No hay historial de precios por zona en la base.
- **El personal contesta desde el celular** (coexistencia) y **crea pedidos a mano** en la caja
  muchas veces sin teléfono; esos pedidos no quedan ligados al chat.
- **Nequi cargado** en «Info para el asistente»: 3236388196.

---

## 4. Cómo auditar (solo lectura, en el VPS)

Los scripts ya están en `/var/www/admin_ws/scripts/` (vienen con el `git pull`). **Nunca `psql`
con la clave**: siempre estos scripts con `node`.

```bash
ssh escalapp@45.63.105.95
cd /var/www/admin_ws
node scripts/auditoria_banderas.js 6 "2026-10-02 20:30"        # resumen + banderas por chat
node scripts/auditoria_transcripciones.js 6 "2026-10-02 20:30" # cada chat completo, con decisiones
node scripts/auditoria_conversacion.js 6 <dígitos del id_externo>  # un chat, a fondo
node scripts/auditoria_domicilio_zona_burger.js 6               # todo lo de domicilio
```

Banderas: `PEDIDO_PERDIDO`, `PROMESA_FALSA`, `NO_ENCONTRADO`, `CONFIRMA_CON`, `SIN_RESPUESTA`. Qué
mirar en las transcripciones: `modelo_pide_persona`, `promesa_de_persona_cumplida`,
`confirmacion_a_persona` (handoffs: ¿alguien contestó?), `cortesia_sin_respuesta` sobre un mensaje
con contenido (ya no debería pasar), y pedidos `por Asistente` vs `por OSCAR/ADRIANA`.

---

## 4-bis. Fotos, stickers y audios en la Bandeja (desplegado 21:39, `cff0782` / admin `d1c0eec`)

Lo que mandan los clientes ya se ve en el hilo de la Bandeja (foto y sticker en línea, audio y
video con reproductor, documento al tocarlo). **No se guarda copia**: al recibir solo se guarda la
referencia en `intelligence.mensaje.crudo.media`, y la ruta
`GET /admin/intelligence/bandeja/conversaciones/:id/mensajes/:idMensaje/archivo` se lo pide a Meta
en el momento y lo transmite. Meta lo conserva **7 días** (después, 410 y la Bandeja lo dice).
Lo recibido **antes** del despliegue no tiene referencia y sigue saliendo como `[image]`.

**Sin probar todavía con una foto real** (no llegó ninguna antes del relevo): sí se comprobó en
producción que la ruta exige sesión (401) y que Meta acepta el token de Zona Burger (un id
inventado → `ARCHIVO_NO_DISPONIBLE`). Con la primera foto que llegue, abrir ese chat en la
Bandeja; si falla, el error queda en `journalctl -u escalapp-api` como `bandeja.archivoDeMensaje`.

## 4-ter. Respuestas desde el celular, ediciones y orden de la Bandeja (desplegado ~22:00, `033fc3a` / admin `54623e3`)

- **Se perdían las respuestas del personal a clientes sin número visible (BSUID)**: el eco llegaba
  sin `to` y se descartaba («un eco del negocio llegó sin destinatario» en el log). Ahora el
  destinatario sale de `to`, de los campos simétricos (`to_user_id`…) o, como último recurso, del
  propio `wamid`, que lo lleva dentro. **Si vuelve a salir ese aviso**, ahora dice qué claves traía
  el eco: con eso se ve el campo real que usa Meta (la documentación no lo dice).
- **Ediciones y borrados** (del cliente o del personal) ya no aparecen como `[edit]`/`[revoke]`:
  actualizan el mensaje original. La Bandeja dice «Editado» o «Mensaje eliminado» (sin el texto).
  No despiertan al bot.
- **Contestar desde el celular marca la conversación como atendida** (antes solo la Bandeja). Se
  corrigieron 15 conversaciones viejas de Zona Burger que ya estaban contestadas (auditoría:
  `bandeja_atendidas_por_celular_retroactivo`).
- ~~Bandeja: en «Todos», las que esperan respuesta van primero~~ — **revertido el mismo día**
  (`afd11f5` / admin `3a237d2`): la lista vuelve a ir solo por fecha y el botón «Esperan
  respuesta» vuelve debajo del buscador. Ver §4-quinquies.

## 4-quater. Ajustes del asistente en su propia ventana (~22:17)

Cuándo vuelve el asistente, tiempo de entrega, valor del domicilio e información para el asistente
ya no están en la cabecera de la Bandeja: botón **«Configuración del asistente»**. El recuadro de
«espera respuesta» se quita al **abrir** la conversación (por navegador) y es índigo. El aviso de
impersonación flota bajo la cabecera y la X lo reduce a una pastilla.

**Fotos: todavía sin probar con una real** — desde el despliegue de las 21:39 ningún cliente mandó
foto, sticker ni audio (hoy llegaron varias, todas antes).

## 4-quinquies. Qué cuenta como «Esperan respuesta» (cierre de la sesión, 2026-10-03 ~00:15)

**Auditoría:** de 16 conversaciones «esperando respuesta», **solo 1 esperaba algo** (una clienta
que mandó su ubicación cuando se la pidieron). Las otras 15 cerraban con «Gracias», «Listo», «Ya
voy», «Otey», «perfecto, ya bajo»… porque **cualquier** mensaje del cliente ponía `atendida_en` en
NULL, también un «gracias».

**Regla nueva** (`b3a14dc`): un mensaje del cliente reabre la espera **solo si no es cortesía**
(`cortesia.leer`: agradecimientos, «ok», «listo», «ya voy/bajo/salgo», «qué pena», reacciones,
stickers). Una pregunta, una dirección, un teléfono, una foto o una ubicación **sí** reabren. Un
recordatorio que enviamos nosotros tampoco reabre (antes sí, porque usaba la misma función).
`asegurarConversacion(…, { reabrirEspera })` lo decide quien llama; el motor lo calcula.

**Limpieza aplicada**: 15 marcadas como atendidas (auditoría `bandeja_espera_limpiada_por_auditoria`);
dos de ellas a mano por la auditoría: `…b52bfd` (el personal sí contestó, pero los ecos se
perdieron antes de `033fc3a`) y `…8d760b` (prueba interna de Salón Demo). Queda 1: `…e49fa8`.

Ojo: el vocabulario de cortesía lo comparte el filtro que evita que el bot conteste cortesías
repetidas, así que «ya bajo» o «qué pena» tampoco despiertan al bot tras un cierre (que es lo que
se quiere). Si un cliente usa una de esas palabras para PEDIR algo, va en una frase con más
palabras y el filtro no la toma por cortesía.

## 4-sexies. Con el local cerrado contesta el flujo, no el modelo (2026-10-03)

**El caso:** Zona Burger cierra a las 22:50; a las 23:02 «Buenas noches, ¿realizas domicilios?» lo
contestó el modelo («Sí, hacemos domicilios. ¿Qué te gustaría pedir?») sin mirar el horario.
Decisión del dueño: **fuera de servicio contesta el flujo automático**, que dice el horario y deja
la carta — y así no se gasta el modelo.

**Cómo:** el flujo de restaurante declara `atiendeSinModelo` al registrarse
(`engine/flujos.js`). Cuando la tabla de enrutado manda un turno al modelo, la escalera
(`manejadorEscalera.js`) le pregunta antes al flujo; si dice que sí, el turno queda en el flujo con
la regla `flujo_sin_modelo`. Dentro del flujo, `fueraDeServicio()` decide y
`avisoFueraDeServicio()` contesta (paso `fuera_de_servicio` en el rastro).

- **Cuenta como cerrado** cualquier estado en que `tomar_pedido` rechazaría el pedido:
  `fuera_de_horario`, `aun_no_abre` (en horario pero sin caja abierta) y `cerrado_sin_horario`.
  ⚠️ Si el personal olvida abrir caja, el bot dirá «todavía no estamos atendiendo» aunque sea hora.
- **No cuenta** si hay un pedido a medias, una confirmación esperando el «sí», o un pedido tomado
  en este chat en las últimas 6 h (quien pidió a las 22:40 y pregunta «¿ya salió?» sigue
  recibiendo respuesta de su pedido).
- **Qué dice:** primer mensaje → la bienvenida de siempre en su versión «cerrado»; a mitad de
  conversación → el estado y la carta sin volver a saludar; si ya se le avisó hace menos de 30 min →
  una sola línea («Seguimos fuera de nuestro horario de atención. Abrimos mañana a las 4:30 PM.
  Apenas abramos te atendemos 🙏»), sin repetir el enlace.
- **Lo que se pierde a sabiendas:** con el local cerrado ya nadie contesta preguntas sueltas
  («¿dónde quedan?», «¿tienen parqueadero?»). Si eso molesta, la salida es pasar esas preguntas al
  modelo con el horario en el prompt — eso sí toca `sistema.v10`, de Juan David.
- **Si leer el horario falla**, se atiende como antes (al modelo).

Pruebas: `__tests__/intelligence/fuera_de_servicio.test.js` (16).

## 5. Pendiente (decidido dejarlo para después)

1. **Comprobantes de pago**: ya se VEN en la Bandeja (§4-bis), pero el bot todavía no avisa a
   nadie cuando llega uno.
2. **Domicilio por comuna**: investigado y viable. Barrios de Pasto en OpenStreetMap (~360, con
   ubicación) + los 12 polígonos de comunas (servicio UNOSAT, capa 2) → cada barrio cae en su
   comuna automáticamente; el 60 % de las direcciones reales se reconocen con un emparejador
   simple. Precios reales conocidos: Alameda (c. 11) $8.000, Palermo (c. 9) $8.000, El Pilar
   (c. 5) $7.000. Falta preguntarle a Zona Burger su tabla y quién cobra (restaurante o domiciliario).
   Detalle de la investigación: el chat de la sesión; atribución obligatoria «© OpenStreetMap contributors».
3. **Ligar pedido ↔ conversación con una columna** (hoy el aviso de «listo» lo infiere del texto
   del bot; los pedidos creados a mano sin teléfono no tienen chat).
4. **Mensaje de la carta sin el código `#P…`**: el de Alejandra llegó sin código y lo atendió el
   modelo en vez del flujo. Sin investigar (¿lo borró al pegar?).
5. ~~El modelo ofrece domicilio con el local cerrado~~ — **arreglado el 2026-10-03** (ver §4-sexies).
6. **Ubicaciones** (`[location]`): hoy no se guardan las coordenadas. Propuesta: guardarlas en
   `crudo` y mostrar en la Bandeja un enlace a Google Maps (justo el único chat que esperaba
   respuesta era una ubicación).
7. **Fotos en la Bandeja sin probar con una real** (§4-bis).

## 6. Tests que ya fallaban (no son de estos cambios)

Con `DB_PORT=5432`: `e2e_agendar`, `reinicio_por_inactividad`, `reportes`,
`whatsapp_embedded_signup` (falta columna `pin_cifrado` en local), `platform/capacidades_restaurante`
(un texto de `agregar_items_pedido`) y `restaurante/auditoria_actor_restaurante` (cierre de caja).
`canal` y `ventana` fallan a veces en la suite completa y pasan solos. Se comprobó con `git stash`
que fallan igual sin los cambios del día.
