# El canal de WhatsApp: qué está hecho, qué falta y cómo se conecta

**Fase:** F8-A + F8-B · **Gobierna:** [ADR-016](adr/ADR-016-webchat-hostil.md), [ADR-017](adr/ADR-017-channel-gateway.md) · **Fecha:** 2026-08-19 (F8-A) · 2026-08-20 (F8-B)

## Por qué F8 está partida en tres

F8 es la fase que hace comercial al producto, y tiene un prerequisito que **no depende del código**:
la verificación de negocio en Meta. El master-plan lo dice sin adornos — *«la dependencia de Meta es
externa y con semanas de plazo […] es el riesgo de calendario más grande del plan y el único que no
controlamos»*.

Esperar a tener la cuenta para empezar habría dejado la fase entera bloqueada por un trámite. Así que
se partió por donde se puede verificar, igual que F5 se partió en cinco por donde era irreversible:

| | Qué | Estado |
|---|---|---|
| **F8-A** | El canal: firma, webhook, traducción de entrada y salida, opt-out | ✅ **Hecha en local (2026-08-19)** |
| **F8-B** | Las reglas del canal: ventana de 24 h, plantillas, recordatorios, backoff y acuses | ✅ **Hecha en local (2026-08-20)** |
| **F8-C** | Conectar el número de verdad → **HITO: MVP COMERCIAL** | ⬜ bloqueada por Meta |

Lo que separa A de B no es tamaño: es que **A se puede probar sin Meta y B casi no**. Una plantilla
hay que registrarla y que la aprueben; la ventana de 24 h solo se puede comprobar de verdad con una
conversación real que envejezca.

---

## Lo que hace F8-A

```
Meta ──POST── /intelligence/whatsapp/webhook
                │
                │ 1. cuerpo CRUDO (rama de parseo antes del parser global de app.js)
                │ 2. firma HMAC-SHA256 con el App Secret  → si falla, 403 y nada más
                │ 3. responde 200 SIN la respuesta del bot → Meta corta a los 10 s
                ▼
        adaptador (channels/whatsapp)
                │  traduce a Mensaje Canónico  → motor.recibir()
                │
                ▼
        motor → escalera → FSM o Nivel 4 → capacidades → Ledger
                │
                ▼
        intelligence.mensaje (saliente, pendiente)
                │
        Channel Gateway ──► adaptador.entregar() ──► Cloud API ──► Meta
```

### Los cinco archivos, y qué decide cada uno

| Archivo | Qué decide |
|---|---|
| `config.js` | Traduce `phone_number_id` → `id_negocio`. **Una costura, no una tabla**: hoy lee variables de entorno |
| `firma.js` | Si el webhook es de Meta. HMAC-SHA256 del cuerpo crudo, comparación en tiempo constante |
| `adaptador.js` | Todo lo que sabe qué es un `wamid`, un botón o un eco. El `ChannelPort` de ADR-017 |
| `api.js` | El único sitio del proyecto que le habla a Meta. Aislado porque es lo que **no** se puede verificar sin cuenta |
| `rutas.js` | Las dos rutas: el saludo `GET` de suscripción y la ingesta `POST` |

Y fuera del canal, dos piezas que son de todos:

- `engine/optout.js` — `STOP`/`BAJA`, por encima de la tabla de enrutado.
- `core/mensajeCanonico.js` — una opción ahora es `{ id, etiqueta, detalle? }`.

---

## Las cuatro decisiones que no eran obvias

### 1. La firma es *la* autenticación de este canal, no una capa más

El WebChat no está autenticado y se acepta a sabiendas: está apagado y su peor daño posible es
escribirle al asistente de un negocio. WhatsApp es otra cosa — la URL del webhook es pública, y sin
verificar la firma **cualquiera puede POSTear un mensaje que el sistema atribuirá a un cliente real**.
Con F7 encima, ese mensaje puede acabar en una confirmación de cancelación.

De ahí tres reglas que no se negocian: HMAC sobre el **cuerpo crudo** (reserializar el JSON produce
otros bytes y la firma no casa — es la trampa que obligó a mover una rama de parseo delante del
parser global de `app.js`), comparación en **tiempo constante**, y **sin App Secret no se acepta
nada**. Ese último es el modo de fallo que convierte una configuración a medias en un endpoint
abierto.

### 2. El eco del dueño no es un mensaje del cliente

Con la coexistencia, el dueño contesta desde su móvil de siempre y Meta nos lo cuenta por
`smb_message_echoes`. Tratarlo como entrada del cliente le metería al motor las palabras del negocio
como si fueran de quien pregunta.

Lo que hace F8-A es mejor que ignorarlo: **si el dueño contestó, el bot se calla.** La conversación
pasa a `handoff_humano`, que ya significa exactamente eso desde F5-A y que el motor ya trata como no
procesable. Ni estado nuevo, ni migración — la decisión de §6.13 («el bot no vuelve») se cumple sola.

### 3. La baja es silencio, y es irrevocable por el cliente

`STOP`/`BAJA` se atiende **antes** de la tabla de enrutado. No es una fila más: la tabla decide qué
peldaño resuelve un turno —es una política de costo— y aquí no hay peldaño que elegir. Ponerla como
fila implicaría que algún día otra fila podría ganarle.

Y no se contesta nada. Se valoró un «listo, te damos de baja»: ninguna jurisdicción lo exige, y
mandarlo obliga a abrir una excepción en el entregador para dejar salir *un* mensaje de una
conversación ya bloqueada — la clase de excepción que un día se usa para otra cosa.

**Consecuencia que hay que conocer:** al quedar `bloqueada`, escribir de nuevo no la reactiva. Un
cliente que puso `STOP` por error **no puede volver por su cuenta**; hace falta un humano, y darle
ese botón a la Consola es F8-B. Es fallar cerrado en una obligación legal, a propósito.

⚠️ **`CANCELAR` no está en la lista de bajas y no puede estar.** En Nivel 1 esa palabra significa
«sal de este flujo» y en F7 «no ejecutes la mutación que estás confirmando». Si además diera de baja
para siempre, salir de un menú tendría consecuencias irreversibles.

### 4. `detalle`: el precio no puede morir en un recorte de 20 caracteres

El recorrido de punta a punta destapó un problema de producto que ninguna prueba unitaria iba a
ver: los botones nativos de WhatsApp recortan el título a **20 caracteres**, así que el menú de
servicios llegaba como «Corte de cabello (3…» y «Tinte (90 min) — $1…». Desaparecía justo el precio,
que es por lo que el cliente escribió.

El arreglo es la evolución **aditiva** que ADR-017 permite: una opción es ahora
`{ id, etiqueta, detalle? }`. La FSM manda el nombre en `etiqueta` y «30 min — $35.000» en `detalle`,
y cada canal decide — el chip del WebChat los pinta juntos como siempre, y WhatsApp usa una **lista**
con el detalle en la descripción de cada fila (72 caracteres). La regla del adaptador: **si hay
`detalle`, lista, aunque quepan en botones**; el botón es más cómodo pero no tiene dónde poner el
precio.

---

## Cómo se renderiza una respuesta

| Opciones del núcleo | Qué manda a Meta | Por qué |
|---|---|---|
| ninguna | `text` | Sin `preview_url`: un enlace del bot no debe abrir una tarjeta que nadie revisó |
| 1–3, sin `detalle` | botones de respuesta | La mejor forma del canal: un toque, sin escribir |
| cualquiera con `detalle` | lista con descripción | El detalle es el precio o la duración; un botón no tiene dónde ponerlo |
| 4–10 | lista | Cabe más y sigue siendo un toque |
| más de 10 | texto enumerado | Degradación con gracia: se pierde el botón, **no la elección** |

Los recortes (20 en botones, 24 en filas, 72 en descripciones) son de Meta: un título más largo hace
que la API **rechace el mensaje entero**, así que recortar es lo que evita dejar al cliente sin
respuesta por un nombre de servicio largo.

---

## Los límites del canal, confirmados en la fuente (2026-08-19)

Todo esto salió de la documentación de Meta, no de blogs de proveedores — que era una deuda anotada:

| Dato | Valor |
|---|---|
| Firma | `X-Hub-Signature-256: sha256=…`, HMAC-SHA256 del cuerpo crudo |
| Plazo de respuesta del webhook | **10 segundos**, luego reintenta |
| Botones | 3, título ≤ 20 caracteres |
| Listas | 10 filas, título ≤ 24, descripción ≤ 72 |
| **Desconexión por inactividad** | `PRIMARY_INACTIVITY` ≈ **14 días** sin abrir la app (companion: 30) |
| Aviso de desconexión | webhook `account_update`, evento `PARTNER_REMOVED`, con `disconnection_info.reason` |
| Coexistencia | app ≥ **2.24.17**, alta por **Embedded Signup**, **20 mensajes/s**, historial a sincronizar en 24 h (180 días hacia atrás) |

**Los 14 días eran ciertos**, y eso cambia el diseño en algo concreto: no hay que adivinarlo, Meta lo
avisa. El adaptador trata `PARTNER_REMOVED` como lo que es —el canal se apagó— y lo grita por consola
y en la auditoría, porque un número desconectado **parece** un sistema que funciona: el backend
arranca, la app va, y lo único que pasa es que nadie recibe respuesta.

---

## F8-B — las reglas del canal (2026-08-20)

| Qué | Estado |
|---|---|
| **Ventana de 24 h y plantillas** | ✅ `ventana.js` + `core/plantillas.js` |
| **Recordatorios proactivos** | ✅ `intelligence/recordatorios/` + el programador de `reserva` |
| **Correlacionar acuses** | ✅ el `wamid` se guarda al entregar; un `status: failed` marca la fila |
| **Backoff en el entregador** | ✅ `mensaje.proximo_intento_en`, y el gateway ya distingue «no insistas» |
| **Multimedia (visión)** | ⬜ **fuera de F8-B, y decidido**: exige descargar el medio de Meta y un modelo con visión. No se puede verificar sin cuenta, que es justo el criterio con el que se partió la fase |
| **Desbloquear una baja desde la Consola** | ⬜ hoy un `STOP` por error sigue necesitando un `UPDATE` a mano |
| **La tabla de números** | ⬜ el segundo inquilino, y con él dónde viven los *access token* |

### La ventana: dónde vive y de qué reloj se cuenta

ADR-017 no deja margen — «las particularidades de cada canal (**la ventana de 24 h de WhatsApp**…)
viven en su adaptador, no en el núcleo»—, así que está en `channels/whatsapp/ventana.js` y el motor
no se enteró. El WebChat no tiene ventana; la voz tampoco.

**No hay columna nueva para esto**, y la tentación era grande: `conversacion.ventana_abierta_hasta`,
mantenida al recibir. Se descartó porque el dato ya existe —el último entrante está en
`intelligence.mensaje`— y una columna derivada es una segunda fuente de verdad que se desincroniza
en silencio. Lo que sí hacía falta era que la consulta no barriera quince particiones: se acota por
`creado_en`, que es la **clave de partición**, aunque el dato que se lee sea `enviado_en`.

`conversacion.ultimo_mensaje_en` tampoco servía, aunque hoy se parezca: lo escribe
`asegurarConversacion` con `now()` —nuestro reloj— y lo refresca también un **duplicado**, así que
un reintento del webhook de un mensaje viejo alargaría la ventana. La cuenta se lleva con el sello
de Meta y, ante la duda, se toma el **menor** de los dos instantes: nunca afirmar que la ventana
está más abierta de lo que Meta la ve, porque ése es el error que acaba en un envío rechazado.

### Qué pasa cuando la ventana está cerrada

Un texto libre **no sale, y no se reintenta**. Se comprueba antes de llamar a Meta por dos razones
que no son de estilo: el 400 de Meta llega después de haber gastado la llamada y sin decir a qué
conversación culpar, y sobre todo **la ventana no se reabre esperando** — insistir cinco veces es
tirar cinco llamadas y retrasar el *dead letter*.

Que salte casi nunca es lo esperado: una respuesta existe porque alguien acaba de escribir. Salta
cuando el bot tarda más de un día en contestar —que es un fallo de otra cosa— y cuando alguien
intenta **iniciar** una conversación sin plantilla, que es el error que esta comprobación existe
para hacer visible en vez de dejarlo en un silencio.

### El recordatorio se decide al enviarlo, no al programarlo

Es la decisión de diseño de la fase, y quita la mitad del código que parecía necesario. Lo obvio era
escuchar `cita.cancelada` y `cita.reagendada` para borrar o mover el recordatorio. En vez de eso, el
recordatorio **relee la cita cuando le toca salir**:

- si ya no existe, o está cancelada, o ya pasó → se cancela;
- si se movió → se reprograma solo, con la hora de ahora;
- si sigue en pie → sale, con los datos frescos.

Eso es correcto **aunque el evento se pierda**, aunque alguien cancele con un `UPDATE` desde el
panel, y aunque la cita se mueva dos veces en un minuto. La cadena de eventos solo es correcta si
nadie se salta ningún eslabón nunca. Y es además lo que ADR-013 manda hacer con los eventos
delgados: «un consumidor que necesite detalle lo pide releyendo».

Consecuencia práctica: **`cita.creada.v1` es el único evento que hizo falta**, y es el primero de
todo el proyecto con productor y consumidor vivos. El outbox de F1 llevaba desde entonces
transportando un catálogo vacío, a propósito.

```
reserva crea una cita ──emitir()──► platform.outbox      (misma transacción, ADR-012)
                                          │
                                     outboxRelay
                                          ▼
                      adapters/reserva/recordatorios.js   (lo único que sabe leer una cita)
                                          │ programar()
                                          ▼
                               intelligence.recordatorio   (una promesa de futuro)
                                          │ al vencer: relee y decide
                                          ▼
                        intelligence.mensaje (saliente, con plantilla)
                                          │
                                   Channel Gateway ──► WhatsApp
```

Dos detalles que no se ven en el dibujo y muerden:

- **El número se guarda sin el `+`.** El `id_externo` de una conversación de WhatsApp es el `from`
  del webhook (`573001234567`). Guardar `+573001234567` abriría una **segunda** conversación para la
  misma persona —la clave única es `(negocio, canal, id_externo)`— y el recordatorio saldría por un
  hilo distinto del que la persona tiene abierto.
- **Si la conversación está `bloqueada`, ni se crea el mensaje.** El filtro del entregador ya
  impedía entregarlo, pero para entonces la fila existiría y se quedaría pendiente hasta caducar,
  ensuciando la cola y el Ledger con algo que no iba a ocurrir.

### La plantilla es un contrato con Meta, y por eso duele

`core/plantillas.js` es el catálogo, y es **código** por lo mismo que el de capacidades: el texto
aprobado y sus parámetros son parte del programa, no configuración de un inquilino. Vive en el
núcleo y no en el canal porque una plantilla, en abstracto, es «un mensaje con huecos» y eso lo
entiende cualquier canal — el WebChat recibe el texto ya compuesto. Si viviera en
`channels/whatsapp/`, el núcleo tendría que importar de un canal para programar un recordatorio.

⚠️ **`nombre`, `idioma` y el texto tienen que coincidir con lo registrado en Meta**, palabra por
palabra, y los parámetros van **posicionales** en el orden del catálogo. Cambiar aquí una coma sin
volver a pasar por Meta no rompe nada visible: el envío sale con el texto **aprobado**, y lo que se
lea en el Ledger deja de ser lo que recibió el cliente. Registrar `recordatorio_cita` (categoría
UTILITY) es parte de la lista de F8-C.

### Lo que se guarda de un envío, y lo que no

El `wamid` que devuelve Meta al aceptar se guarda en `mensaje.id_externo`. Sin él, el acuse que
llega después no se puede atar a ninguna fila nuestra — y ese caso importa: **Meta acepta el envío
con un 200 y avisa luego de que no llegó**. Sin correlacionar, un mensaje que nadie recibió se ve en
el Ledger exactamente igual que uno que sí.

`sent`, `delivered` y `read` **no** se guardan, y es una decisión: son tres escrituras por mensaje
en una tabla particionada de alto volumen a cambio de un dato que hoy no responde ninguna pregunta.

### El backoff, que era una nota desde F5-C

`gateway.js` llevaba escrito desde entonces que el backoff no compraba nada mientras el único canal
fuera local. Con Meta devolviendo 429 sí compra: sin espera, los cinco intentos se consumen en cinco
segundos y el mensaje acaba en *dead letter* antes de que Meta haya dejado de limitarnos. La curva
es la misma que la del outbox —`2^intentos`, acotada— a propósito: dos curvas distintas solo obligan
a recordar cuál es cuál.

Y de paso, el gateway aprendió a distinguir **«vuelve a intentarlo»** de **«no insistas»**: `api.js`
marcaba sus errores con `reintentable` desde F8-A y nadie lo miraba.

---

## Cómo se prueba hoy, sin cuenta de Meta

```bash
DB_PORT=5432 DB_PASS=... LLM_HABILITADO=false node scripts/whatsapp_e2e.js
```

Levanta un webhook y un «Meta» de mentira en puertos efímeros y manda una conversación entera por
ellos. Lo único falso es Meta: la firma, el cuerpo crudo, el adaptador, el motor, la FSM, el Policy
Gate, la capacidad, el Ledger, el entregador y el renderizado son los de producción. Comprueba de una
pasada: menú con lista y precios, botones donde toca, firma inválida → 403, número ajeno descartado,
el aviso de los 14 días, y `STOP` → conversación bloqueada con cero mensajes después.

Desde F8-B recorre además lo que **solo se puede ver con el tiempo pasado**, envejeciendo la
conversación a mano en vez de esperar un día: la ventana cerrada, un texto libre que muere en el
primer intento sin llegar a Meta, y el recordatorio saliendo **como plantilla** por esa misma
conversación cerrada. Es el criterio de aceptación 2 del master-plan —«un recordatorio se entrega
fuera de la ventana de 24 h vía plantilla»— comprobado sin cuenta.

Es el equivalente, para un webhook, de la lección que este proyecto ya pagó tres veces: **un
entregable no está verificado hasta que alguien lo abre.** Aquí no hay pantalla, así que esto es lo
que hay que correr — y correrlo es lo que destapó el problema de los 20 caracteres.

La suite automática (`__tests__/intelligence/whatsapp.test.js`, 30 casos) cubre la firma con cargas
firmadas de verdad, la traducción de cada tipo de entrada y el renderizado; `optout.test.js` (15)
cubre la baja, incluida la regla en SQL que impide entregar a una conversación bloqueada.

---

## Cuando exista la cuenta: la lista de F8-C

1. **Verificación de negocio en Meta** aprobada, y la app creada.
2. Poner las cinco variables (`.env.example` las explica). Al arrancar, el log dice si falta alguna.
3. Suscribir el webhook a `https://api.escalapp.cloud/intelligence/whatsapp/webhook` con el
   `WHATSAPP_VERIFY_TOKEN`. Debe devolver el challenge en texto plano.
4. Suscribir los campos: `messages` y —si es coexistencia— `smb_message_echoes` y `account_update`.
   `messages` incluye los acuses (`statuses`), que desde F8-B sí se usan.
4-bis. **Registrar la plantilla `recordatorio_cita`** (categoría UTILITY) con el texto exacto de
   `intelligence/core/plantillas.js` y esperar la aprobación. Sin ella no sale ni un recordatorio, y
   es el único paso de esta lista que **también tiene plazo de espera**.
5. **Encender `INTELLIGENCE_HTTP_ENABLED=true` en producción con cuidado**: eso enciende también el
   WebChat, que **sigue sin autenticar** (decisión abierta 9). Antes de encenderlo hay que decidir
   qué se hace con esa superficie — lo suyo es una clave pública por negocio, o dejarla fuera.
6. Probar con el número del propio dueño antes que con un cliente.

**Lo que NO hay que hacer todavía:** poner una clave de modelo en producción a la vez que se enciende
el HTTP, por lo mismo que dice `.env.example`. Un canal abierto con el Nivel 4 encendido es una
factura ajena.

---
