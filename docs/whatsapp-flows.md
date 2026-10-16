# WhatsApp Flows — formularios dentro del chat

**Estado:** **construido (2026-10-16), encendido SOLO para Restaurante pregonchos (negocio 12, de prueba)** — ver §0 · **Fecha:** 2026-10-15 ·
**Viene de:** [`ideas-de-innovacion.md`](ideas-de-innovacion.md) (idea 9) ·
**Hermanos:** [`canal-whatsapp.md`](canal-whatsapp.md) · [`barrios-y-veredas.md`](barrios-y-veredas.md) ·
[`whatsapp-costo-mensajes.md`](whatsapp-costo-mensajes.md)

> **En una frase.** Un Flow es una ventanita-formulario **nativa de WhatsApp** que se abre al tocar
> un botón del chat: el cliente llena dirección, barrio, forma de pago y entrega **en una sola
> pantalla**, toca «Enviar» y a nosotros nos llega un JSON con los campos ya separados y
> validados. Para el asistente de restaurante significa **datos completos y sin ambigüedad en un
> solo mensaje** —y el barrio elegido de la lista, o sea **el precio del domicilio correcto**—.

---

## 0. Lo construido (2026-10-16)

Decisión del dueño: llevarlo a producción **solo en Pregonchos**, que es el número de pruebas, para
probarlo con conversaciones reales antes de dárselo a un cliente.

| Pieza | Dónde |
|---|---|
| Interruptor por negocio: el id del Flow publicado (`NULL` = apagado, nace así) | `gener_negocio.formulario_entrega_flow_id` · `npm run migrate:restaurante-formulario-entrega` |
| Crear, publicar y encender / apagar en un negocio | `node scripts/formulario_entrega_whatsapp.js <id> [--aplicar \| --apagar]` |
| El Flow JSON, la opción que lo abre y la lectura de la respuesta | `intelligence/adapters/restaurante/formularioEntrega.js` |
| Una opción canónica puede llevar `formulario` (3.ª evolución aditiva de ADR-017) | `intelligence/core/mensajeCanonico.js` (+ `ENCABEZADO_FORMULARIO`) |
| Enviar (`interactive.type = flow`) y leer `nfm_reply` como texto `📋 Formulario enviado` + `Campo: valor` | `intelligence/channels/whatsapp/adaptador.js` (`renderizar`, `textoDeMensaje`, `crudo.formulario`) |
| Pedido de la carta: el paso de entrega ofrece el botón; la respuesta llena entrega, dirección (+ indicaciones), pago (en la nota) y barrio (búsqueda de siempre) | `intelligence/adapters/restaurante/flujo.js` (`pregunta`, `aplicarFormulario`) |
| Pedido por chat con el modelo: si falta saber cómo lo recibe, la falta (`confirmacion.falta`) ofrece el formulario y el manejador pega el botón a lo que escriba el modelo | `adapters/restaurante/index.js` · `engine/manejadorLlm.js` |
| Pruebas | `__tests__/intelligence/formulario_entrega.test.js` (10) |

Lo que hay que saber:

- **Solo WhatsApp** y solo con la columna llena. Apagado, o en WebChat, todo es como antes (los dos
  botones). La lectura del id falla cerrado: sin columna o sin base, botones.
- **El camino de texto sigue abierto**: el mensaje dice «escríbeme *domicilio* o *recoger*».
- **El pago no tiene columna en el pedido** al tomarlo (se elige al cobrar): va en la nota,
  «Pago: Nequi», que caja y despacho ya leen.
- Si el formulario llega **sin pedido abierto** (en el camino del modelo), el modelo lo lee como
  texto: `Entrega: domicilio / Barrio: … / Pago: …`.
- **Cambiar el formulario = volver a correr el script**: un Flow publicado no se edita; se crea
  otro y el negocio apunta al nuevo.
- Para dárselo a otro negocio con su propia WABA (Embedded Signup): mismo script; toma la WABA y
  el token del negocio de `numero_canal`.

### 0.1 Despliegue y primera prueba real (2026-10-16, madrugada)

| Hora | Qué |
|---|---|
| 00:11 | Respaldo `db_2026-10-16_0011.dump` (+ copia en R2) |
| 00:12 | `75cd732` en el VPS, migración aplicada, servicio reiniciado |
| 00:13 | Flow `2064164927637856` publicado en la WABA de EscalApp y Pregonchos encendido; el borrador de prueba `2371343120337306` borrado; scripts de prueba retirados del VPS |
| 00:14–00:16 | **Nadie contestaba.** No era el código: los dos chats de prueba estaban en `handoff_humano` porque escribieron con el asistente **en pausa** (la pausa pasa a una persona todo chat que escribe; al reanudar, siguen con la persona hasta «Devolver al asistente» en la Bandeja). Se devolvieron desde la Bandeja |
| 00:17 | El modelo preguntó **por su cuenta** «¿Las quieres para recoger, comer aquí o a domicilio?» **sin botón**: el formulario solo se pegaba cuando la capacidad devolvía la falta de entrega |
| 00:22 | `cef2f6c`: si la respuesta final del modelo pregunta cómo lo recibe (`formularioEntrega.preguntaComoLoRecibe`) y el negocio lo tiene encendido, el botón va también (`manejadorLlm` → `formularioParaRespuesta`) |

Pregonchos estaba **fuera de horario** (abre 5:00 AM): el formulario se ve, pero `tomar_pedido`
no toma el pedido con el local cerrado. Para probar de noche hay que abrirle el horario.

### 0.2 Pendiente para el 2026-10-16: suite amplia de pruebas, y después todos los negocios

Decisión del dueño: **se va a encender en todos los negocios**, pero antes una batería amplia
contra los errores que ya se pagaron con el asistente (auditorías de Zona Burger del 10-01 al
10-14). La pregunta de si «afecta mucho»: el formulario **no cambia** lo que el asistente decide
—el pedido sigue pasando por las mismas guardias, el «sí» y el Policy Gate—, pero **sí toca
código común a todos los negocios** aunque esté apagado (`adaptador.renderizar`/`textoDeMensaje`,
`manejadorLlm`, `seguirPedido`), y encendido abre caminos nuevos. Riesgo bajo, no cero. Casos a
cubrir, con conversación completa y no solo funciones:

1. **Guardias que no se pueden saltar** con el formulario: `ENTREGA_SIN_DECIR` (nunca suponer
   recoger), `pregunta_abierta` (un «sí» tras una pregunta no ejecuta), «sí tras escribir el
   cajero», «No veci» es un no, confirmación final obligatoria.
2. **El formulario a destiempo**: respondido **después** de confirmar o con el pedido ya tomado;
   un formulario viejo tocado en un pedido nuevo; respondido dos veces; respondido **sin tarea**
   (va al modelo como texto: ¿llama bien a `tomar_pedido`?).
3. **Mezclas**: el cliente escribe «domicilio» a mano **y** luego manda el formulario; manda el
   formulario con «recoger» tras haber dado una dirección (se borra, comprobar el resumen);
   «Para servir» con y sin mesas libres.
4. **Barrio**: único, repetido (numerado), inexistente, «otro», con tildes/mayúsculas, negocio sin
   barrios (va pegado a la dirección), ciudad entera por comunas.
5. **El regex de `preguntaComoLoRecibe`**: falsos positivos («¿el domicilio a Las Cuadras cuánto
   es o lo recojo?» dicho por el modelo en otro contexto) y negativos (variantes de redacción del
   prompt `sistema.v15`). Medirlo con `scripts/evaluar.js respuestas_restaurante`.
6. **Estados del negocio**: fuera de horario, caja cerrada, sin domiciliario, pausa, handoff.
7. **Coexistencia (Zona Burger)**: el número vive también en la app del celular; comprobar que
   el formulario se envía y que el eco del dueño no se confunde con una respuesta.
8. **Costo**: mensajes por pedido con y sin formulario (hoy 6,9) en las mismas conversaciones.
9. **Despliegue a todos**: correr el script por negocio (cada WABA tiene su Flow; Zona Burger con
   su token de Embedded Signup) y decidir si hace falta un interruptor en Configuración en vez de
   solo el script.

---

## 1. Cómo se ve para el cliente

```
Bot:      Perfecto: 2 Hamburguesas clásicas y 1 Coca-Cola. Para despacharlo
          necesito tus datos de entrega.
          ┌──────────────────────────────┐
          │      📋 Completar datos       │   ← botón del mensaje
          └──────────────────────────────┘

(toca el botón → se abre una hoja encima del chat, sin salir de WhatsApp)

  ╭─────────────── Datos de entrega ───────────────╮
  │ ¿Cómo lo recibes?                              │
  │  (•) A domicilio   ( ) Paso a recoger          │
  │ Barrio            [ Las Cuadras ▾ ]            │  ← lista del catálogo del negocio
  │ Dirección         [ Cra 24 # 18-35 ]           │
  │ Indicaciones      [ Casa esquinera, reja negra]│
  │ ¿Cómo pagas?                                   │
  │  (•) Efectivo  ( ) Nequi  ( ) Transferencia    │
  │ ¿Con cuánto pagas? [ 50.000 ]                  │
  │                                                │
  │            [        Enviar        ]            │
  ╰────────────────────────────────────────────────╯

(en el chat queda una burbuja «Datos enviados» y el bot contesta)

Bot:      Listo. Domicilio a Las Cuadras: $4.000. Total $42.000.
          Llega en 40–60 min. ¿Confirmo el pedido?   [Confirmar] [Cambiar algo]
```

Comparado con hoy: el bot pide lo que falta en una pregunta (`FALTAN_DATOS`), pero el cliente
contesta en texto libre —«en las cuadras por la iglesia, pago en efectivo»— y a veces falta algo,
el barrio no casa con el catálogo o hay que preguntar con cuánto paga. Cada una de esas vueltas es
un mensaje cobrado y un punto donde el modelo puede adivinar mal.

---

## 2. Cómo funciona por dentro

### 2.1 Las piezas

| Pieza | Qué es |
|---|---|
| **Flow JSON** | la definición del formulario: pantallas, campos, botones. Se crea en WhatsApp Manager o por API y se **publica** |
| **Mensaje con el Flow** | un mensaje interactivo de tipo `flow` con un botón (CTA). Lleva un `flow_token` nuestro para saber a qué pedido pertenece la respuesta |
| **Respuesta** | llega al **mismo webhook** de siempre como mensaje `interactive` de tipo `nfm_reply`, con `response_json` (los campos) y el `flow_token` |
| **Data endpoint** (opcional) | un HTTPS nuestro al que WhatsApp llama entre pantallas para pedir datos vivos (p. ej. el precio del barrio elegido). Cifrado con llaves RSA/AES. **Un Flow que no lo usa no lo necesita** |

Componentes disponibles: títulos y textos, `TextInput`, `TextArea`, `Dropdown`,
`RadioButtonsGroup`, `CheckboxGroup`, `DatePicker`, `OptIn`, `Footer` (el botón), `EmbeddedLink`,
condicionales (`If`/`Switch`), y en versiones nuevas selector de fotos y documentos.

Tres acciones al tocar un botón:
- `navigate` — pasa a otra pantalla del mismo Flow, sin hablar con nosotros;
- `data_exchange` — le manda lo llenado al data endpoint y este decide la siguiente pantalla;
- `complete` — cierra el Flow y nos manda la respuesta por el webhook.

### 2.2 Ejemplo de Flow JSON (estático, una pantalla)

Ilustrativo: los nombres exactos de propiedades y la versión hay que confirmarlos contra la
referencia de Meta antes de construir.

```json
{
  "version": "6.0",
  "screens": [
    {
      "id": "DATOS_ENTREGA",
      "title": "Datos de entrega",
      "terminal": true,
      "data": {
        "barrios": {
          "type": "array",
          "items": { "type": "object", "properties": { "id": { "type": "string" }, "title": { "type": "string" } } },
          "__example__": [{ "id": "b_12", "title": "Las Cuadras — $4.000" }]
        }
      },
      "layout": {
        "type": "SingleColumnLayout",
        "children": [
          {
            "type": "RadioButtonsGroup", "name": "entrega", "label": "¿Cómo lo recibes?", "required": true,
            "data-source": [ { "id": "DOMICILIO", "title": "A domicilio" }, { "id": "RECOGER", "title": "Paso a recoger" } ]
          },
          { "type": "Dropdown", "name": "barrio", "label": "Barrio", "data-source": "${data.barrios}" },
          { "type": "TextInput", "name": "direccion", "label": "Dirección", "input-type": "text" },
          { "type": "TextArea", "name": "indicaciones", "label": "Indicaciones (opcional)" },
          {
            "type": "RadioButtonsGroup", "name": "pago", "label": "¿Cómo pagas?", "required": true,
            "data-source": [ { "id": "EFECTIVO", "title": "Efectivo" }, { "id": "NEQUI", "title": "Nequi" }, { "id": "TRANSFERENCIA", "title": "Transferencia" } ]
          },
          { "type": "TextInput", "name": "paga_con", "label": "¿Con cuánto pagas?", "input-type": "number" },
          {
            "type": "Footer", "label": "Enviar",
            "on-click-action": {
              "name": "complete",
              "payload": {
                "entrega": "${form.entrega}", "barrio": "${form.barrio}", "direccion": "${form.direccion}",
                "indicaciones": "${form.indicaciones}", "pago": "${form.pago}", "paga_con": "${form.paga_con}"
              }
            }
          }
        ]
      }
    }
  ]
}
```

La lista de barrios **no va escrita en el JSON**: viaja en el mensaje que abre el Flow
(`flow_action_payload.data`), armada en el momento desde `COALESCE(barrio.valor, zona.valor)`
del negocio. Así un mismo Flow publicado sirve para todos los negocios y los precios siempre son
los de hoy.

### 2.3 Lo que llega al webhook

```json
{
  "type": "interactive",
  "interactive": {
    "type": "nfm_reply",
    "nfm_reply": {
      "name": "flow",
      "response_json": "{\"flow_token\":\"conv_8841_pedido_552\",\"entrega\":\"DOMICILIO\",\"barrio\":\"b_12\",\"direccion\":\"Cra 24 # 18-35\",\"indicaciones\":\"Casa esquinera, reja negra\",\"pago\":\"EFECTIVO\",\"paga_con\":\"50000\"}"
    }
  }
}
```

---

## 3. Dónde encajaría en nuestro código

| Qué | Dónde |
|---|---|
| Entender la respuesta | `intelligence/channels/whatsapp/adaptador.js` — hoy ya traduce `button_reply` y `list_reply`; `nfm_reply` sería un tercer caso que produce un mensaje canónico **estructurado**, no texto |
| Llenar el pedido | el adaptador de restaurante (`intelligence/adapters/restaurante/`): con datos estructurados se rellenan los campos **sin pasar por el modelo** — determinista, gratis y sin adivinar |
| Cuándo mandarlo | en lugar de la pregunta de `FALTAN_DATOS` (`adapters/restaurante/index.js`) cuando lo que falta son los datos de entrega |
| El barrio | `barrios-y-veredas.md`: el `id` del barrio vuelve tal cual, así que el precio del domicilio sale de la base, nunca de lo que el cliente escribió |
| Guardias que siguen valiendo | la confirmación final (F7) y `ENTREGA_SIN_DECIR`: el Flow **llena** datos, no confirma el pedido |

**Siempre con salida de texto.** Si el cliente no abre el formulario y escribe la dirección a mano,
el asistente sigue como hoy. El Flow es un atajo, nunca un muro.

---

## 4. Lo que hay que saber antes de construirlo

1. **Costo.** Meta no cobra aparte por un Flow: es un mensaje más, y dentro de la ventana de 24 h
   es un mensaje de servicio (US$0,0008 en Colombia desde el 2026-10-01, ver
   `whatsapp-costo-mensajes.md`). La respuesta del cliente no la pagamos. Confirmar contra la
   página de precios de Meta.
2. **Ahorro real: medirlo, no suponerlo.** En un domicilio quizá se ahorran 1–2 mensajes. El
   beneficio más seguro es la **precisión** (barrio del catálogo, forma de pago y cambio desde el
   principio), no el número de mensajes.
3. **Un Flow vive en una cuenta de WhatsApp (WABA).** Con Embedded Signup cada cliente tiene la
   suya (Zona Burger), así que el Flow hay que **crearlo y publicarlo en cada WABA** por API.
4. **Revisión de Meta.** Los Flows se publican y pueden requerir revisión; un Flow publicado no se
   edita, se clona.
5. **Dónde se ve.** Hay que comprobar cómo se comporta en WhatsApp Web y de escritorio y en
   versiones viejas de la app. La salida de texto cubre el resto.
6. **Límites del desplegable.** Ver cuántas opciones admite un `Dropdown`: un negocio con 300
   barrios no cabe en una lista; ahí el Flow pide **primero la comuna** y después el barrio (dos
   pantallas, o el data endpoint).
7. **Títulos de campo: máximo 20 caracteres, y sin «(opcional)».** Comprobado en la prueba real
   del 2026-10-15 (§6): Meta acepta el JSON sin quejarse, pero en el celular el modo borrador pinta
   un error rojo por cada título largo. Y WhatsApp **añade solo** «(Opcional)» a los campos no
   obligatorios, así que escribirlo en el título lo duplica. Lo explicativo va en `helper-text`.
8. **Sin data endpoint al principio.** Todo lo que necesita el Flow de entrega se puede mandar al
   abrirlo. El endpoint (con su cifrado) se deja para cuando haga falta algo vivo entre pantallas.

## 5. Otros usos, después del domicilio

- **Reserva:** elegir servicio, profesional y fecha (`DatePicker`) en un formulario.
- **Registro del cliente nuevo** con aceptación de datos (`OptIn`) para la tarjeta de sellos
  ([`fidelizacion-sellos.md`](fidelizacion-sellos.md)).
- **Encuesta de satisfacción** después de la entrega (una pantalla, tres toques).

## 6. Prueba real en el celular (2026-10-15)

Antes de decidir nada se mandó el formulario de verdad, desde el número de Restaurante pregonchos
(negocio 12, de prueba), sin tocar el código del producto: un script suelto creó el Flow **en
borrador** en la WABA de `WHATSAPP_WABA_ID` (alta manual: `numero_canal.waba_id` está vacío para
ese número) y lo envió con `mode: "draft"`, que no necesita publicarlo ni revisión de Meta.

- Meta aceptó el JSON a la primera (`validation_errors: []`), pero el celular mostró los dos
  errores del punto 7 del §4: el validador de la subida **no** revisa el largo de los títulos.
- En borrador sale el aviso «This flow is only for testing»; un cliente no lo vería con el Flow
  publicado.
- El botón «Enviar» queda gris hasta llenar los campos obligatorios: es el comportamiento esperado.
- La respuesta llega como `nfm_reply`, que hoy `adaptador.js` traduce a texto vacío: por eso se
  pausó el asistente de Pregonchos durante la prueba.
- **Comprobado en el registro del servidor:** las dos respuestas enviadas (23:48 y 23:53) llegaron
  al webhook y `mensajeCanonico` las rechazó con `TEXTO_VACIO` («Un mensaje entrante sin texto no
  es un mensaje»). No se rompió nada ni el bot contestó, pero **los datos se pierden**: no quedan en
  `intelligence.mensaje` ni en el registro, y `crudo` no guarda el bloque `interactive`. Construir
  esto empieza exactamente ahí: un caso `nfm_reply` en `textoDeMensaje`/`crudo` del adaptador.

### 6.1 Segunda versión, con los ajustes del dueño (mismo día)

Pedidos tras ver la primera en el celular, y enviados así en borrador:

- **Los campos del domicilio solo aparecen al elegir «A domicilio».** Componente `If` con
  `condition: "${form.entrega} == 'DOMICILIO'"` (Flow JSON ≥ 4.0). Meta lo aceptó sin errores.
- **Barrio = un campo de texto obligatorio, sin lista.** Razón del dueño: **la gente no sabe a qué
  comuna pertenece su barrio** (ni él lo sabía hasta montar `barrios-y-veredas.md`), así que un
  formulario que pida primero la comuna la pierde. El texto se resuelve después con nuestra lógica
  de barrios (la misma que ya desambigua nombres repetidos) y, si no casa o hay varios, el bot
  pregunta en el chat.
- **Fuera «¿Con cuánto pagas?».** Queda solo la forma de pago.
- El mensaje que abre el formulario lleva el resumen del pedido, como lo escribiría el bot, sin
  cabecera ni pie de prueba.

### 6.2 ¿Buscador de barrio dentro del formulario?

WhatsApp **no tiene** un campo que busque mientras se escribe (la referencia de componentes no
lista ninguno). Tres caminos, de menos a más trabajo:

| | Cómo | Trabajo |
|---|---|---|
| **A. Texto + nuestra lógica después** (la 2.ª versión) | se escribe el barrio; al recibirlo lo buscamos; si hay duda, el bot pregunta en el chat | ninguno extra |
| **B. Buscar y elegir en dos pantallas** | pantalla 1: escribe «cuadras» y toca *Buscar* → nuestro servidor (data endpoint) devuelve los barrios que se parecen, con su precio → pantalla 2: los elige de una lista corta | data endpoint cifrado |
| **C. Lista con todos los barrios A–Z** | `Dropdown` sin pedir comuna, máx. 200 opciones | poco, pero no cabe en ciudades grandes; si WhatsApp pone buscador en listas largas **no está documentado** — se puede probar en borrador |

Recomendado: **A para empezar**, B cuando se construya de verdad; B es el buscador real y evita que
el bot tenga que preguntar después.

## 7. Fuentes

- [Meta — referencia de Flow JSON](https://developers.facebook.com/docs/whatsapp/flows/reference/flowjson) · [Meta — recibir la respuesta](https://developers.secure.facebook.com/docs/whatsapp/flows/gettingstarted/receiveflowresponse)
- [Connectly — data endpoints](https://docs.connectly.ai/messaging/whatsapp-flow-endpoints.md) · [Messangi — webhook de respuestas](https://docs.messangi.com/docs/webhook-whatsapp-flow-responses)
- Precio: [Whautomate](https://whautomate.com/whatsapp-flows) · [Omnichat (cambio 2026-10-01)](https://blog.omnichat.ai/whatsapp-business-api-service-messages-pricing/)
- [EZContact — guía de Flows](https://ezcontact.ai/es/blog/whatsapp-flows-guia-completa/)
