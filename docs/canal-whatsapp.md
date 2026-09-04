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
ese botón a la Consola es F8-B — y ya existe: pide un motivo y queda auditado con el id del super
admin que lo pulsó. Es fallar cerrado en una obligación legal, a propósito.

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
| **Desbloquear una baja desde la Consola** | ✅ la **única** escritura de la Consola: motivo obligatorio y auditada |
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

### Deshacer una baja: la única escritura de la Consola

La Consola nació de solo lectura y casi lo sigue siendo. La excepción es el botón de deshacer una
baja, y no es una grieta: un `STOP` es **irrevocable por el cliente** a propósito, así que escribir
de nuevo no reactiva nada y hace falta un humano. Sin el botón, deshacer una baja puesta por error
es un `UPDATE` a mano en producción.

Por eso pide **motivo** y queda **auditado con el id del super admin**: volver a escribirle a
alguien que pidió que no le escribieran es exactamente lo que hay que poder justificar después. Un
botón sin rastro sería peor que no tenerlo. Y es deliberadamente estrecho — solo actúa sobre una
conversación `bloqueada`, no es un cambiador de estados de propósito general.

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

## Lo que se aprendió intentando el sandbox (2026-08-21)

Se intentó levantar el **número de prueba** de Meta para verificar `api.js` sin cuenta real. **No se
consiguió**, y el intento dejó cuatro hechos que cambian la lista de F8-C.

**El sandbox no arrancó, y el motivo está a la vista.** En la app `1552342763052863` el paso «Solicita
un número de prueba» nunca se completa: el botón recarga la página y no provisiona nada, con y sin
los escudos del navegador. De ahí sale todo lo demás —el desplegable vacío, la WABA que no se puede
leer, el token con permisos y **cero activos concedidos**—. Se descartó por medición, no por
sospecha: `debug_token` devuelve `granular_scopes` sin un solo `target_id`.

⚠️ **En Meta, tener el permiso no es tener el activo.** Un token **de usuario** con
`whatsapp_business_management` y ningún activo concedido parece correcto en todas las pantallas y no
puede leer una sola WABA. `scripts/whatsapp_diagnostico.js` lo comprueba en el bloque 1 — es lo
primero que hay que mirar cuando la Cloud API diga «does not exist or you do not have permission».

> **Matiz que costó un susto (2026-08-22):** eso **solo vale para tokens de usuario**. Un
> `SYSTEM_USER` saca su acceso de los activos asignados al usuario del sistema y trae
> `granular_scopes` **vacío siempre**; el diagnóstico lo daba por roto cuando el token estaba
> perfecto. Corregido: para un usuario del sistema la prueba real es el **bloque 2** — si lista los
> números de la WABA, tiene el activo. Lo mismo engaña en el panel: *Activos asignados* dice «No se
> han asignado activos» porque ahí solo salen páginas y perfiles de Instagram, no apps ni cuentas de
> WhatsApp.

**Y hay tres requisitos que no estaban en la lista:**

| Hallazgo | Consecuencia |
|---|---|
| **La verificación de negocio NO es requisito para empezar** | Un portafolio sin verificar puede conectar un número real y enviar a **250 destinatarios únicos por cada 24 h**. Verificar sube a 1.000 y abre la progresión de niveles. Con **un** cliente, 250 sobra |
| **Hace falta un método de pago** para los mensajes iniciados por la empresa | Son **los recordatorios de F8-B**. Sin tarjeta en la cuenta no sale ni uno, esté verificado el negocio o no |
| **Con la app sin publicar solo llegan webhooks de prueba** del propio panel | «No se entregará ningún dato de producción […] a menos que esta se haya publicado». Publicar la app es parte de encender el canal, no un trámite posterior |
| **Sin verificar: máximo 2 números por empresa** (20 al verificar) | Un número es **un `id_negocio`** (`channels/whatsapp/config.js`). O sea: **sin verificación de negocio el canal da para 2 inquilinos**, no más. Es el techo real de F8-C, no los 250 destinatarios |

**Lo que esto cambia en el plan:** el camino crítico **no** es la verificación de negocio —que se
había tratado como el bloqueo de semanas—, es **conseguir un número de teléfono y conectarlo**. La
verificación pasa a ser lo que hace falta el día que 250 destinatarios diarios se queden cortos.

> Las cifras de 250/1.000 vienen de documentación de terceros, no de la fuente de Meta. Antes de
> apoyar una decisión comercial en ellas, confirmarlas en la documentación oficial.

---

## La cuenta de Meta: estado real al 2026-08-24 (EL CANAL YA ESTA VIVO)

**La cuenta existe y el número está conectado.** Estos identificadores no son secretos —son ids
públicos de la Cloud API— y se dejan escritos aquí para no volver a buscarlos por el panel:

| Qué | Valor |
|---|---|
| App | `1552342763052863` (*Escalapp*) |
| Portafolio empresarial | `1115123864174893` |
| **WABA** (cuenta de WhatsApp Business) | `4199925320246584` |
| Número del canal | `+57 315 281 2484` → en el `.env` sin `+`: `573152812484` |
| **`WHATSAPP_PHONE_NUMBER_ID`** | **`1297624263436786`** |
| Nombre visible | `Escalapp` — **en revisión por Meta** («Pendiente») |

**Hecho:** método de pago cargado (✓ verde en el panel), número registrado y verificado, PIN de
6 dígitos definido. El **número de prueba del sandbox nunca se consiguió** y se abandonó — ver la
sección anterior; no hace falta para nada de lo que sigue.

**APROBADA (comprobado el 2026-08-24):** la plantilla **`recordatorio_cita`** —enviada a revisión
el 2026-08-22, categoría *Servicio* (así llama Meta a UTILITY en español), idioma **Spanish
(`es`)**— está **`APPROVED`**. Con ella cae el **único paso de F8-C con plazo de espera ajeno**.

El miedo a las **variables adyacentes** (`{{3}} {{4}}` separadas solo por un espacio, la causa de
rechazo más probable) **no se materializó**: Meta la aprobó tal cual. Y se comprobó lo que de verdad
importa, que no es el estado sino el texto: se leyó el `BODY` aprobado desde la Graph API
(`GET /{WABA}/message_templates`) y es **idéntico carácter por carácter** al de
`intelligence/core/plantillas.js`. Eso es lo que mantiene honesto al Ledger — si divergieran, el
cliente recibiría el texto de Meta y la Consola mostraría el del código.

> **Regla que sigue vigente:** cualquier cambio futuro en ese texto se hace **en Meta y en
> `plantillas.js` a la vez**, y vuelve a pasar por revisión. Cambiar solo el código no rompe nada
> visible —el envío sale con el texto aprobado— y por eso es peligroso: rompe el Ledger en silencio.

**El detalle de puntuación era una falsa alarma.** La preocupación era que, con el punto tras
`{{4}}`, un `cuando` como «mañana a las 3:00 p. m.» hiciera leer «p. m..». No puede pasar: quien
compone ese parámetro es `comoSeDice()` en `adapters/reserva/recordatorios.js`, que formatea en
**24 horas** (`el lunes 25 de agosto a las 15:30`) y nunca emite «p. m.». El «3:00 p. m.» del ejemplo
es solo la muestra que se le dio a Meta para la revisión, no lo que envía el código.

**Estado del número, en la propia API (diagnóstico del 2026-08-24):** `+57 315 2812484`,
verificación `VERIFIED`, nombre visible `Escalapp` en estado **`PENDING`** (Meta aún revisa el
nombre; no impide enviar). **Ninguna app suscrita a la WABA** — o sea, hoy **no llegaría un solo
webhook** aunque el envío funcionara. Es el punto 4 de la lista.

**Pendiente, en este orden:**

1. ✅ **La decisión del WebChat: resuelta el 2026-08-22.** Ver la sección siguiente. Ya se puede
   encender `INTELLIGENCE_HTTP_ENABLED=true` en producción sin abrir el WebChat.
2. **Desplegar el backend** con `INTELLIGENCE_HTTP_ENABLED=true` y **sin**
   `INTELLIGENCE_WEBCHAT_ENABLED`. La URL del webhook será
   `https://api.escalapp.cloud/intelligence/whatsapp/webhook`.
3. **Configurar el webhook en el panel** (URL + `WHATSAPP_VERIFY_TOKEN`) y suscribir los campos
   `messages` —que incluye los acuses— y, si hay coexistencia, `smb_message_echoes` y
   `account_update`.
4. **Suscribir la app a la WABA.** El diagnóstico lo canta: *«NINGUNA app suscrita — los webhooks no
   llegarán aunque el envío funcione»*. Se arregla con
   `POST /v21.0/4199925320246584/subscribed_apps`, y **después** de tener la URL: suscribir sin
   endpoint no sirve de nada.
5. **Publicar la app** — sin esto el webhook solo recibe las pruebas del panel.

---

## Cómo se resolvió la decisión abierta 9: dos interruptores, no uno

**El problema, en una frase:** una sola bandera montaba dos superficies con riesgos opuestos. El
**webhook de WhatsApp** va autenticado por la firma HMAC de Meta; el **WebChat** no está autenticado
en absoluto. Conectar el número obligaba a encender `INTELLIGENCE_HTTP_ENABLED`, y con él se
encendía el WebChat de rebote — la decisión abierta 9 convertida en efecto colateral de otra cosa.

**La solución es lo mínimo que quita el acoplamiento**, y deliberadamente no inventa autenticación
que nadie ha diseñado:

| Variable | Qué monta | En producción |
|---|---|---|
| `INTELLIGENCE_HTTP_ENABLED` | La superficie HTTP: **el webhook de WhatsApp** | `true` |
| `INTELLIGENCE_WEBCHAT_ENABLED` | **Solo** el WebChat: widget, ingesta, sondeo y simulador | **sin poner** |

Apagado, el WebChat **no responde 403: no existe la ruta.** Tampoco el widget estático ni el
**simulador de fallos**, que es la peor de las tres — deja inyectar duplicados y retrasos en la
sesión de cualquiera.

**Comprobado levantando el servidor de verdad**, no razonando sobre el código:

| Config | `…/whatsapp/webhook` | `…/webchat/mensajes` |
|---|---|---|
| HTTP on, WebChat off (**producción**) | `403` (existe, rechaza sin firma) | **`404`** |
| ambos on (**desarrollo**) | `403` | `403` (existe, lo para la feature) |

Y se corrigió un log que mentía: al arrancar anunciaba *«Widget de pruebas en /intelligence/webchat/»*
incluso cuando no estaba montado. Ahora dice **«WebChat NO montado»**, y cuando sí lo está avisa en
mayúsculas de que va **sin autenticar**. Un log que miente sobre qué tienes expuesto es justo el que
no te puedes permitir.

**Lo que esto NO resuelve, y sigue pendiente:** la clave pública por negocio, los orígenes permitidos
y el límite por sesión. El WebChat sigue sin poder ser producto — pero ya no bloquea a WhatsApp, que
era el problema real.

**Token permanente: hecho (2026-08-22).** Usuario del sistema `escalapp-api` (id `61593334663332`,
acceso de Admin) con la app y la WABA asignadas; token `SYSTEM_USER` **sin caducidad** y con los dos
permisos de WhatsApp. Verificado con `scripts/whatsapp_diagnostico.js`: lista la WABA, su número y
las plantillas — justo lo que el token del sandbox nunca pudo.

**Decisión abierta y bloqueante: `WHATSAPP_NEGOCIO_ID`.** Nadie ha dicho todavía **a qué
`id_negocio` pertenece este número**. No se puede deducir del panel y equivocarse significa escribir
en la conversación de otro inquilino — que es exactamente la fuga que cerró F2.

⚠️ **Comprobar la configuración de pagos.** En el WhatsApp Manager, bajo *Configuraciones de pagos*,
aparece una entrada llamada **«India»**. No se tocó y no se sabe si es una sección que Meta muestra
siempre o si la tarjeta quedó asociada a la región equivocada. Confirmar antes del primer envío
facturado.

---

## La lista de F8-C, de principio a fin

*(Se llamaba «Cuando exista la cuenta». La cuenta ya existe desde el 2026-08-22 — se deja la lista
entera porque documenta el camino completo, con lo hecho marcado.)*

1. ✅ **Un número de teléfono para el bot** que no esté usándose en WhatsApp (o que se pueda migrar), y
   **un método de pago** en la cuenta. La **verificación de negocio no hace falta para esto** — solo
   para pasar de 250 destinatarios únicos cada 24 h **y de 2 números (= 2 inquilinos)**.
1-bis. **Publicar la app.** Sin publicar, el webhook solo recibe las pruebas del propio panel.
2. Poner las cinco variables (`.env.example` las explica). Al arrancar, el log dice si falta alguna.
   Ya se conoce `WHATSAPP_PHONE_NUMBER_ID`; falta el App Secret, el verify token (lo eliges tú), el
   token permanente y **decidir `WHATSAPP_NEGOCIO_ID`**.
3. Suscribir el webhook a `https://api.escalapp.cloud/intelligence/whatsapp/webhook` con el
   `WHATSAPP_VERIFY_TOKEN`. Debe devolver el challenge en texto plano.
4. Suscribir los campos: `messages` y —si es coexistencia— `smb_message_echoes` y `account_update`.
   `messages` incluye los acuses (`statuses`), que desde F8-B sí se usan.
4-bis. ✅ **Plantilla `recordatorio_cita` registrada y APROBADA** (2026-08-24, UTILITY, `es`), con el
   texto exacto de `intelligence/core/plantillas.js`. Era el único paso de esta lista con **plazo de
   espera ajeno**; ya no lo hay.
5. **Encender `INTELLIGENCE_HTTP_ENABLED=true` en producción, y NO `INTELLIGENCE_WEBCHAT_ENABLED`.**
   Desde el 2026-08-22 son dos interruptores separados justo para esto: el webhook se enciende sin
   abrir el WebChat, que sigue sin autenticar. Ver «Cómo se resolvió la decisión abierta 9».
6. Probar con el número del propio dueño antes que con un cliente.

**Lo que NO hay que hacer todavía:** poner una clave de modelo en producción a la vez que se enciende
el HTTP, por lo mismo que dice `.env.example`. Un canal abierto con el Nivel 4 encendido es una
factura ajena.

---

---

## F8-C TERMINADA — el canal en producción (2026-08-24)

**El asistente atiende por WhatsApp en producción.** Dos personas conversaron con él desde sus
teléfonos, agendó dos citas reales y no costó un centavo. Lo que sigue es el registro de cómo se
llegó ahí y, sobre todo, de **las tres trampas que costaron la tarde**, porque ninguna daba error.

### Lo que quedó encendido

| Pieza | Valor |
|---|---|
| Número | `+57 315 281 2484` → `platform_type: CLOUD_API`, `status: CONNECTED`, caudal `STANDARD` |
| Negocio | `WHATSAPP_NEGOCIO_ID=10` — **Salón Demo EscalApp**, no un cliente real |
| Escalera | Nivel 1 determinista + `openai/gpt-5.6-terra` montado |
| WebChat | **apagado** (`INTELLIGENCE_WEBCHAT_ENABLED` sin poner) — sigue sin autenticar |
| Frontends | `escalapp.cloud/reserva/` (nueva) y la Consola en `/admin/admin/intelligence` |

### Trampa 1: «número verificado» y «número registrado» son cosas distintas

El primer envío falló con **`133010 — Account not registered`**, y el teléfono de un humano decía
*«Este número de teléfono no está en WhatsApp»*. Las dos cosas eran el mismo problema.

Este documento afirmaba desde el 2026-08-22 que el número estaba «registrado y verificado». Era
media verdad, y la mitad que faltaba es la que importa:

| Paso | Qué es | Campo que lo delata |
|---|---|---|
| **Verificar** | Demostrar que el número es tuyo (código por SMS) | `code_verification_status: VERIFIED` |
| **Registrar** | Darlo de alta **en la Cloud API** con el PIN de 6 dígitos | `platform_type`, `status` |

Estaba verificado y **no registrado**: `platform_type: NOT_APPLICABLE`, `status: PENDING`. Se
arregla con una llamada, y sin ella **nada funciona aunque todo lo demás esté perfecto**:

```
POST /v21.0/{phone_number_id}/register
{ "messaging_product": "whatsapp", "pin": "<los 6 dígitos>" }
```

Después: `platform_type: CLOUD_API`, `status: CONNECTED`, `throughput: STANDARD`.

> **Cómo comprobarlo sin adivinar:**
> `GET /v21.0/{phone_number_id}?fields=platform_type,status,code_verification_status,name_status`.
> Si `platform_type` no dice `CLOUD_API`, el número no está operativo, punto.

De paso se corrigió otra lectura equivocada: el `status: PENDING` que este documento atribuía al
**nombre en revisión** no era eso. El nombre estaba aprobado (`name_status:
AVAILABLE_WITHOUT_REVIEW`); el `PENDING` era la conexión.

### Trampa 2: un `=` de más en el App Secret

Al pegar el secreto en el `.env` quedó `WHATSAPP_APP_SECRET==5c0…f92` — **33 caracteres, empezando
por `=`**. dotenv lo carga tal cual, el backend arranca sin quejarse y el canal dice «listo».

Lo que se rompe está fuera de la vista: el App Secret es lo que valida la firma HMAC de Meta, así
que **todos los webhooks entrantes se habrían rechazado con 403**. Un secreto mal copiado no da
error al arrancar; da silencio cuando llega el primer mensaje.

Se cazó porque el token de app (`{app_id}|{app_secret}`) devolvía `190 — Invalid OAuth access token
signature` al consultar las suscripciones. **Esa llamada es el test del App Secret** y no cuesta
nada:

```
GET /v21.0/{app_id}/subscriptions?access_token={app_id}|{app_secret}
```

Comprobación rápida del valor: **32 caracteres, hexadecimal en minúsculas**. Cualquier otra cosa es
un error de copiado.

### Trampa 3: la URL suscrita, y cero campos

Con el secreto arreglado, la consulta anterior devolvió esto:

```json
{ "object": "whatsapp_business_account",
  "callback_url": "https://api.escalapp.cloud/intelligence/whatsapp/webhook",
  "active": true }
```

**Sin `fields`.** La URL estaba registrada, verificada y activa — Meta tenía dónde entregar y nada
que entregar. Por eso el webhook no recibía absolutamente nada: ni un 403, ni una petición
rechazada. Silencio.

Es la sección de campos que el panel nuevo de Meta esconde: tras «Verificar y guardar» el asistente
redirige a *Personaliza el caso de uso → Permisos y funciones*, que no tiene nada que ver, y el
paso de suscribir `messages` se queda sin hacer. Por API:

```
POST /v21.0/{app_id}/subscriptions
  object=whatsapp_business_account
  callback_url=...   verify_token=...   fields=messages
  access_token={app_id}|{app_secret}
```

> **Las tres trampas comparten forma:** todo parecía correcto. El servicio arrancaba, el canal
> decía «listo», el diagnóstico daba verde en lo suyo y el panel de Meta mostraba el webhook
> guardado. **Lo único que fallaba es que no pasaba nada.** Por eso el orden de diagnóstico
> correcto es de fuera hacia dentro: ¿está el número en `CLOUD_API`? ¿responde la API al token de
> app? ¿hay `fields`? ¿llega algo al log? Cada pregunta descarta una capa.

### Detalles menores que también costaron minutos

- **`hello_world` no se puede enviar desde un número propio** — `131058: Hello World templates can
  only be sent from the Public Test Numbers`. Para abrir un hilo desde el negocio hay que usar una
  plantilla propia aprobada. Al final no hizo falta: en cuanto el número quedó `CONNECTED`, los
  teléfonos lo encontraron solos.
- **`subscribed_apps` de la WABA y `subscriptions` de la app son dos cosas distintas**, y hacen
  falta las dos. La primera dice «esta app atiende a esta cuenta»; la segunda, «y quiero estos
  campos».

### La primera conversación real

| Medida | Valor |
|---|---|
| Conversaciones | **2** — una por teléfono, clave `(negocio, canal, id_externo)` |
| Mensajes | 36 |
| Turnos | 36, **todos `determinista`**, todos `resuelto` |
| Capacidades | 8 `consultar_disponibilidad`, 6 `proponer_turno`, 5 `consultar_servicios`, 4 `reservar_turno` — todas `ok` |
| Citas creadas | 2, reales, en la agenda del salón |
| Filas en `intelligence.costo` | **0** |

**Ni una llamada al modelo.** El Nivel 4 estaba montado y disponible; la escalera de ADR-018 no
necesitó subir porque el Nivel 1 resolvió la conversación entera — que es exactamente para lo que se
diseñó. Agendar siguiendo el guion es lo que sabe hacer gratis. **El primer bot en producción costó
cero.**

> Anotado para cuando se investigue: hay **4 `reservar_turno` en `ok` y solo 2 citas**. Puede ser
> idempotencia (misma clave, misma cita devuelta) o invocaciones en dry-run contadas como ok. No se
> persiguió.

### Un susto que resultó ser el sistema funcionando

Tras sembrar el catálogo, un servicio de 180 minutos no ofrecía huecos el martes por la mañana pese
a que la profesional trabajaba de 09:00 a 13:00. Parecía un fallo del motor de disponibilidad.

No lo era: **el bot había agendado dos citas de verdad** durante la prueba (09:30–10:00 y
12:00–12:30), que parten esa mañana en trozos de 30, 120 y 30 minutos. Ninguno admite 180. El motor
estaba respetando reservas reales.

Vale la pena dejarlo escrito porque es un patrón: en un entorno con datos vivos, **una
disponibilidad «que falta» es casi siempre una cita que existe**. Antes de sospechar del cálculo,
mirar `reserva_cita` y `reserva_hold`.

### Cómo funciona el cobro de Meta (medido, no recordado)

Las primeras 28 entregas salieron **gratis**, y el panel explica por qué: categoría *Servicio de
atención al cliente gratuito*, cargos `$0,00`.

El cobro es **por mensaje y por categoría**, no por tiempo ni con una cuota diaria:

| Categoría | Cuándo | Coste |
|---|---|---|
| **Servicio** | El cliente escribe primero; el negocio responde dentro de las 24 h | **Gratis** |
| **Utilidad** | Plantillas que inicia el negocio: confirmaciones, **recordatorios** | Se cobra |
| **Marketing** | Promociones | Se cobra (la más cara) |
| **Autenticación** | Códigos de un solo uso | Se cobra |
| **Punto de entrada gratuito** | Conversación nacida de anuncio de clic a WhatsApp o botón de página | Gratis 72 h |

**Lo que esto significa para el producto:** casi todo lo que hace el asistente es *Servicio* y por
tanto gratis. Lo que se paga es **`recordatorio_cita`, que es UTILITY**. Un salón con 200 citas al
mes paga 200 recordatorios y nada más — es un coste **por cita agendada**, no por conversación.

Las tarifas concretas varían por país y Meta las cambia: la fuente es
<https://developers.facebook.com/docs/whatsapp/pricing> y el propio panel, en *Límites de mensajes*.
**No copiar cifras aquí**, envejecen mal.

Paneles útiles (con `business_id=1115123864174893`):
- Consumo y coste: <https://business.facebook.com/wa/manage/insights/>
- Métodos de pago y facturas: <https://business.facebook.com/billing_hub/accounts>

### ⚠️ El 1 de octubre de 2026 la categoría *Servicio* deja de ser gratis

Detectado el **2026-09-02** al calcular los precios de los planes. Meta empieza a cobrar **los
mensajes de servicio salientes**, o sea justo la categoría en la que cae casi todo lo que hace el
asistente. La tabla de arriba sigue siendo correcta en su estructura; lo que cambia es que la fila
«Servicio → Gratis» **tiene fecha de caducidad**.

Tres consecuencias que conviene tener claras antes de que llegue:

1. **El costo pasa de ~$0 a una cifra que hoy no sabemos.** Y no depende de cuántas conversaciones
   hay, sino de **cuántos mensajes emite el bot en cada una**.
2. **La verbosidad del asistente se vuelve una línea de costo.** Contestar en tres burbujas cortas
   cuesta el triple que contestar en una. Hasta ahora eso era una decisión de estilo; desde octubre
   es una decisión de dinero, y afecta a cómo se redactan las respuestas del motor.
3. **Los recordatorios no cambian:** `recordatorio_cita` es *Utility* y ya se cobraba.

**Lo que hay que hacer antes de la fecha, y no después:** medir cuántos mensajes salientes genera
cada negocio al mes. El dato está en el panel de *Insights* de Meta y, con más detalle, en el Ledger
de Intelligence. Sin esa medición, el costo del módulo de WhatsApp en
[`precios-y-planes.md`](precios-y-planes.md) es una suposición.

⚠️ **Confirmar en el propio panel de Meta antes de actuar.** Esto salió de fuentes de integradores
de agosto de 2026, no del panel; y las cifras y fechas de Meta cambian.

---

## Dar de alta el número de un CLIENTE (pendiente, y no es un botón)

El alta que se hizo hoy fue la del **dueño**: crear la app, conectar un número propio, registrarlo
con PIN. Para que un inquilino traiga *su* número desde la app de EscalApp, Meta tiene otro camino
—**Embedded Signup**—, y son tres frentes, no uno:

**1. En Meta.** Hacerse **Proveedor de tecnología** (*Hazte socio → Hacerte proveedor de
tecnología*) y pasar la **verificación de negocio**. Sin verificar, el techo son **2 números = 2
inquilinos**; ese techo, y no el de 250 destinatarios únicos cada 24 h, es el que muerde al llegar
el tercer cliente.

**2. En el código.** Hoy la traducción número → negocio vive en variables de entorno: un número, un
negocio, cableado en `intelligence/channels/whatsapp/config.js`. Hace falta una tabla de números y
—lo delicado— **decidir dónde viven los tokens de cada inquilino**, que pasan a ser secretos de
terceros bajo nuestra custodia. Eso no se improvisa: **merece su propio ADR**.

**3. En la app.** El botón de Embedded Signup en la Consola y la máquina de estados del alta, con
más ramas de las que parece: número ya en uso, verificación pendiente, cliente que abandona a medias.

> ⚠️ **Esto se escribió cuando el asistente solo sabía agendar citas**, y decía que el bloqueo de
> verdad era ése: conectar el número de un restaurante le habría dado un bot que ofrece cortes de
> cabello. **Resuelto el 2026-08-24/25**: el adaptador de restaurante existe y está en producción.
>
> **Y el camino de arriba no es el único.** Lo de abajo —medido contra la API el 2026-08-27— es una
> vía mucho más corta para los primeros clientes, que **no necesita Embedded Signup ni ser
> Proveedor de tecnología**.

---

---

## Abrir el servicio a los primeros clientes (medido el 2026-08-27)

El dueño quiere dar la app a unos conocidos para que la rompan. Antes de planear nada se le
preguntó a Meta el estado real, en vez de fiarse de lo escrito aquí — y había dos sorpresas.

### Lo que dice la API, no el doc

| Qué | Estado |
|---|---|
| Número `+57 315 2812484` | `CONNECTED` · `VERIFIED` · calidad **GREEN** |
| Nombre visible `Escalapp` | **`AVAILABLE_WITHOUT_REVIEW`** (el 24 estaba `PENDING`) |
| App suscrita a la WABA | sí, `1552342763052863` |
| `account_review_status` de la WABA | **`APPROVED`** |
| Plantilla `recordatorio_cita` | **`APPROVED`** (`UTILITY`, `es`) |
| Límite de mensajería | **`TIER_250`** — 250 conversaciones iniciadas por el negocio cada 24 h |
| Mensajes salientes en producción | **160, todos entregados, cero fallos** |

```bash
# El comando que lo dice todo de una vez. health_status es el campo que importa.
curl -s "https://graph.facebook.com/v21.0/<WABA_ID>?fields=name,account_review_status,health_status" \
  -H "Authorization: Bearer $WHATSAPP_TOKEN"
```

### Los dos bloqueos, y Meta los nombra

`health_status` no obliga a adivinar: da entidad, código y solución.

| Entidad | `can_send_message` | Error |
|---|---|---|
| **WABA** | **`BLOCKED`** | `141006` — *There is an error with the payment method. This will block business initiated conversations.* |
| **Negocio** | **`LIMITED`** | `141010` — *The Business has not passed business verification.* |
| App | `AVAILABLE` | — |

**1. El método de pago está fallando.** El 2026-08-24 se anotó aquí que estaba cargado y en verde;
ya no lo está. **Todavía no ha roto nada** —160 salientes, 0 fallos— porque el bot solo
**responde**, y responder dentro de la ventana de 24 h no es una conversación iniciada por el
negocio. Morderá en cuanto salga el primer `recordatorio_cita`, o cualquier plantilla. Se arregla
en el panel (*Business Settings → Billing & Payments*), no en el código.

> **La forma vuelve a repetirse:** un sistema que parece sano porque el camino que se usa a diario
> no toca la parte rota. Es la misma trampa del número desconectado por inactividad.

**2. La verificación de negocio no está pasada.** Es la que pone el techo: **sin verificar, 2
números → 2 inquilinos**. Ese techo, y no el de 250 destinatarios, es el que muerde al tercer
conocido.

### El hallazgo que acorta el trabajo

El plan que había escrito —Embedded Signup, Proveedor de tecnología, custodia de tokens de
terceros, un ADR— es el **producto final**, y para tres o cuatro conocidos es la ruta larga.

Para los primeros clientes hay otra: **dar de alta sus números a mano, dentro de la WABA que ya
existe.** Y eso cambia lo más delicado de todo el asunto:

> **Con los números bajo TU WABA no hay tokens de terceros que custodiar.** El token de la Cloud
> API va contra la **app + la WABA**, no contra un número: el mismo `WHATSAPP_TOKEN` envía desde
> cualquier número de esa WABA, cambiando el `phone_number_id` de la URL. El `APP_SECRET` y el
> `VERIFY_TOKEN` también son de app, o sea compartidos. **Desaparece la decisión que pedía un ADR**
> —porque los secretos siguen siendo nuestros, no de un tercero— y con ella la mitad del trabajo.
>
> ⚠ Confirmarlo con el segundo número en la mano, que es cuando se puede probar de verdad.

La contrapartida honesta: los números son de **tu** WABA, no del cliente. Si un cliente se va,
llevárselo es una migración, no un botón. Para conocidos que están probando, es un precio
razonable; para vender en serio, es cuando toca Embedded Signup.

### Lo que hay que hacer, en orden

**En Meta** (no es código, y va primero porque tiene esperas ajenas):

1. **Arreglar el método de pago.** Desbloquea las plantillas y los recordatorios.
2. **Pasar la verificación de negocio.** Sube el techo de 2 números. Pide documentos del negocio y
   la revisa una persona: **empezar por aquí**, porque es lo único que no depende de nosotros.
3. Por cada cliente: **añadir su número a la WABA** y verificarlo con su PIN. El número **no puede
   estar ya en WhatsApp** — si lo está, hay que borrarlo de la app de WhatsApp primero, y eso le
   borra el historial: **avísale antes, no después**.

**En el código** — ✅ **HECHO el 2026-08-29** (fue más pequeño de lo que parecía, porque la
costura ya estaba puesta):

> **Lo que costó pensar, y no escribir.** `interpretarWebhook()` es una **función pura** y sus
> pruebas la ejercitan con cargas reales de Meta sin levantar base ni red. Si la traducción número
> → negocio se hubiera vuelto una consulta, esa función pasaba a ser asíncrona y a tocar la base:
> se perdía la mitad del canal que hoy se puede verificar de verdad. Por eso la tabla se lee
> **antes**, en `recibirWebhook()` —que ya es asíncrono— y `resolverNegocio()` sigue siendo una
> lectura de memoria. La caché de `numeros.js` no es una optimización: es lo que mantiene la
> costura donde estaba.
>
> **Y la decisión que llevaba meses abierta en el log de arranque** —«dónde viven los secretos»—
> está tomada: **el token sigue global**. Un token de usuario de sistema cubre **la WABA entera**,
> no un número; mientras todos los números cuelguen de nuestra WABA, el mismo token sirve para
> todos y lo único que cambia es el `phone_number_id`. Guardar un token por negocio sería guardar
> el mismo secreto N veces, con N sitios desde los que filtrarse y N que rotar. Con *Embedded
> Signup* eso cambia; hasta entonces, no.
>
> **Las variables de entorno no desaparecen**: son el respaldo cuando la tabla está vacía. Eso hace
> que el cambio **no tenga corte** —un despliegue sin migrar sigue funcionando— y que un entorno de
> desarrollo apunte un número sin tocar la base. Cuando hay filas, mandan las filas.
>
> **Un negocio, un número activo.** Lo impone un índice único parcial, y no es una limitación de la
> tabla: es que `entregar()` tiene que poder responder **desde cuál**, y con dos la respuesta sería
> ambigua. El día que un negocio necesite dos, la conversación tendrá que recordar por cuál entró —
> otro cambio, y más grande.

4. ~~Una tabla de números~~ ✅ **`platform.numero_canal`** (`npm run migrate:platform-numeros-canal`).
   Siembra sola el par que haya en el `.env`, así que producción no tiene corte.
5. ~~`resolverNegocio(phoneNumberId)` pasa a consultarla~~ ✅ Delega en
   [`channels/whatsapp/numeros.js`](../intelligence/channels/whatsapp/numeros.js) y **sigue siendo
   síncrona**. Sigue devolviendo `null` para lo que no es nuestro: la propiedad de F2 tiene su
   propia prueba para que meter la tabla no la aflojara.
6. ~~`entregar()` debe enviar DESDE el número del negocio dueño~~ ✅ Hecho, y con la prueba del
   incidente del 2026-08-28. **Un negocio sin número no envía «por el que haya»**: falla con
   `WHATSAPP_NEGOCIO_SIN_NUMERO` y no reintenta. Mandar desde el número equivocado es peor que no
   mandar.
7. ~~`estado()` deja de decir «un solo número»~~ ✅ Lista los que hay y **de dónde salieron**
   (tabla o entorno), que es el dato que hace falta cuando algo no cuadra.

**Por cada negocio que se conecte** — el runbook ya existe en
[`asistente-restaurante.md`](asistente-restaurante.md): plan Avanzado (donde vive `asistente_ia`),
habilitar sus capacidades, que tenga carta, y `url_whatsapp` para el botón del menú digital.

### La verificación de negocio, paso a paso (iniciada el 2026-08-27)

Es lo primero de la lista porque **la revisa una persona en Meta** y no depende de nosotros. Todo
lo demás se puede hacer mientras tanto.

> ⚠️ **Esto no se puede hacer ni consultar desde la API con el token que hay.** Es un
> `SYSTEM_USER` con `whatsapp_business_management`, `whatsapp_business_messaging` y
> `public_profile` — sin `business_management`. Comprobado el 2026-08-27:
> `GET /{business-id}?fields=verification_status` responde `(#200) Requires business_management`.
> Si se quiere poder mirar el estado desde el servidor, hay que **añadir ese permiso al usuario
> de sistema**; no hace falta para verificar, solo para no tener que entrar al panel a mirar.
>
> Lo que sí se ve sin ese permiso, y es suficiente para saber si pasó, es el `health_status` de la
> WABA: mientras no esté verificado dice `141010` sobre la entidad `BUSINESS`.

#### Lo único que de verdad decide el resultado

La verificación no evalúa el producto ni la app. Comprueba **una sola cosa**: que existe una
empresa real con ese nombre y que quien la solicita puede demostrarlo. Se rechaza casi siempre por
incoherencias aburridas, no por sospecha:

1. **El nombre legal tiene que coincidir con el del documento, carácter por carácter.** El
   portafolio se llama **`Escalapp`**. Si la empresa registrada es, por ejemplo, `ESCALAPP S.A.S.`,
   hay que **poner el nombre legal completo** en el portafolio antes de enviar. Un nombre comercial
   distinto del legal es la causa de rechazo número uno, y se arregla en dos minutos **antes** de
   enviar y en una semana después.
2. **Documento que pruebe la existencia de la empresa.** En Colombia, el **certificado de
   existencia y representación legal de la Cámara de Comercio** (reciente, no de hace tres años) y
   el **RUT**. Meta acepta también facturas de servicios o extractos bancarios a nombre de la
   empresa como prueba de dirección.
3. **La dirección y el teléfono del portafolio tienen que coincidir** con los del documento. Si el
   documento dice una dirección y el portafolio otra, es rechazo.
4. **Un dominio y un correo del dominio ayudan mucho.** `escalapp.cloud` ya existe y es nuestro:
   conviene declararlo en el portafolio y, si se puede, dar un correo `@escalapp.cloud` en vez de
   uno de Gmail. No es obligatorio, pero es la diferencia entre «revisión rápida» y «nos piden más
   papeles».

> ### La pregunta que hay que contestar antes de empezar
>
> **¿Existe una persona jurídica llamada Escalapp, registrada y con papeles?**
>
> - **Sí** → se pone el nombre legal exacto en el portafolio, se suben los documentos y a esperar.
> - **No, todavía es solo una marca** → entonces esto no es un trámite de una tarde. Meta verifica
>   **empresas**, y sin registro mercantil no hay documento que subir. Habría que registrarla, o
>   verificar con otra entidad legal que sí exista.
>
> **Es la decisión que bloquea todo lo demás, y no es técnica.** Conviene resolverla antes de
> tocar el panel: enviar una solicitud incompleta cuesta el tiempo de revisión **y** el de volver
> a enviarla.

#### RESUELTA el 2026-08-28: la empresa existe, y es **persona natural**

Sí hay empresa registrada. Una matrícula mercantil de ~2023 se renovó y se le cambió la razón
social a **`ESCALAPP`** (en mayúsculas: así la inscribió la Cámara de Comercio). Está a nombre
del titular, **no es una sociedad**.

Eso desbloquea el trámite, pero **cambia qué va en cada casilla**, y el documento solo
contemplaba el caso de sociedad. Las diferencias, que son la diferencia entre aprobado y
rechazado:

| | Sociedad (S.A.S.) | **Persona natural (nuestro caso)** |
|---|---|---|
| Documento a pedir | Certificado de **existencia y representación legal** | **Certificado de matrícula mercantil** — el otro no existe para persona natural |
| Nombre legal | La razón social (`ESCALAPP S.A.S.`) | **El nombre del titular**, tal cual la cédula |
| Nombre comercial | Suele coincidir | **`ESCALAPP`**, que es el *establecimiento de comercio* |
| NIT | El de la sociedad | La **cédula + dígito de verificación** |

⚠️ **El certificado que se sube tiene que mostrar el nombre `ESCALAPP`.** Con solo la matrícula
personal, Meta ve un nombre propio y no tiene cómo saber por qué el WhatsApp se llama Escalapp.
Hay que pedir el que incluye el **establecimiento de comercio**. Ese papel es el que ata la
persona a la marca.

En el portafolio hay **dos campos distintos** y se confunden: *«Nombre de la empresa»* (el
visible, se queda en `Escalapp`) y *«Nombre legal de la empresa»* (el que se compara con el
documento). La verificación lee el segundo.

Dos detalles del formulario de facturación, que es otro sitio donde se pide lo mismo:

- La casilla **«Estoy sujeto al Registro Único Tributario»** no pregunta si tienes RUT —todo el
  que tiene NIT lo tiene—. Pregunta si eres **responsable de IVA**. Se decide mirando la
  **casilla 53 del RUT**: código **49** = no responsable → **dejarla sin marcar** (Meta cobra el
  19% y ya está); código **48** = responsable → marcarla y declararlo tú. Marcarla sin serlo es
  declararle a Meta —y de ahí a la DIAN— una condición que no se cumple.
- El *«(EIN)»* de la casilla de identificación fiscal es un descuido de traducción: es el **NIT**.

#### ✅ APROBADA el 2026-08-29 — enviada y aprobada el mismo día, sin un solo documento

El trámite entero salió por la rama corta: **Meta cruzó los datos con el registro mercantil
colombiano, encontró el establecimiento y lo dio por bueno sin pedir papeles.** La pantalla de
documentos nunca apareció; en su lugar salió una lista de establecimientos coincidentes, se
seleccionó el correcto y quedó «En revisión».

**Y se aprobó en horas, el mismo día.** El runbook decía «de un par de días a dos semanas» — eso
vale para la rama con documentos, donde lee una persona. Con coincidencia automática en el registro
no hay nadie que leer: por la mañana `health_status` daba `141010` sobre `BUSINESS` y por la tarde
las tres entidades estaban en `AVAILABLE`. **La lección práctica: cuando los nombres cuadran
exactamente con el registro, esto no es un trámite de dos semanas.**

Eso solo ocurre si lo escrito coincide con el registro. El certificado y el RUT hay que tenerlos
a mano igual —si no hay coincidencia, el formulario los pide—, pero **no son el camino por
defecto**.

El recorrido real, pantalla por pantalla:

| Pantalla | Qué se puso |
|---|---|
| Caso de uso | **WhatsApp Business** (había opción; la que venía por defecto era *«La aplicación requiere acceso a permisos en Meta for Developers»*) |
| Tipo de empresa | **Sociedad unipersonal** — traducción de *sole proprietorship*. Es la que describe a la persona natural con establecimiento de comercio: *«propiedad de una persona… que utiliza un nombre diferente a efectos comerciales (DBA)»* |
| Nombre de la empresa | `NICOLAS PANTOJA PAEZ` |
| **Nombre alternativo** | `ESCALAPP` — dice *opcional* y **no lo es**: es el DBA, lo que ata la persona a la marca |
| Teléfono | `3114682492` — el personal, **no** el del bot |
| Sitio web | `https://escalapp.cloud/` |

⚠️ **«Empresa privada» habría sido el error caro.** Suena a la opción correcta, pero es para
sociedades (S.A.S., SRL) y lleva a un flujo que pide el **certificado de existencia y
representación legal** — un papel que para persona natural no existe.

Un detalle que ayudó y no estaba planeado: la landing publica el mismo teléfono que se escribió
en el formulario, así que el revisor encuentra coherencia entre el papel, el portafolio y el
sitio.

```
https://escalapp.cloud/  →  200  ·  "EscalApp — Centraliza y escala tu negocio"
teléfono en la página:   3114682492   ← el mismo del formulario
```

**Mientras esté «En revisión»: no tocar el DNS ni los datos legales del portafolio.** Un cambio a
media revisión reinicia la cola.

#### Dónde se hace

En **Meta Business Suite → Configuración del negocio → Centro de seguridad** (el nombre exacto del
menú cambia cada pocos meses; lo que se busca es *«Verificación del negocio»* / *«Business
verification»*). Desde ahí: iniciar verificación, elegir el país, escribir los datos legales,
subir los documentos y confirmar por correo o teléfono.

**La revisión suele tardar de un par de días a dos semanas.** Meta avisa por correo, y aquí se ve
sin entrar al panel:

```bash
# Mientras salga 141010 sobre BUSINESS, no ha pasado.
curl -s "https://graph.facebook.com/v21.0/4199925320246584?fields=health_status" \
  -H "Authorization: Bearer $WHATSAPP_TOKEN"
```

#### Qué se desbloquea cuando pase

- El techo de **2 números** sube, que es lo único que impide conectar al tercer conocido.
- La entidad `BUSINESS` deja de estar `LIMITED` en `health_status`.
- Y queda pendiente **aparte**: el `141006` del método de pago, que es otra cosa y se arregla en
  *Billing & Payments*. **Verificar el negocio no lo arregla.**

### Lo que NO hace falta para esto

- **Embedded Signup** y ser **Proveedor de tecnología**: son para que el cliente conecte su número
  **solo**, desde un botón. Con alta manual, no.
- **Publicar la app**: hace falta para pedir permisos **en nombre de otros negocios**, que es
  justamente Embedded Signup. Con la WABA propia y un token permanente, no.
- **El número de prueba del sandbox**: se abandonó el 2026-08-21 y sigue sin hacer falta.

### Segundo administrador del portafolio (2026-08-29)

**Por qué se hace, y no es burocracia:** hasta hoy el único acceso al canal era **la cuenta
personal de Facebook del titular**. Si esa cuenta se bloquea un fin de semana —y Facebook bloquea
cuentas personales sin avisar y sin plazo—, el bot del cliente sigue contestando, pero **nadie
puede tocar nada**: ni rotar el token, ni mirar el estado, ni conectar un número. No hay soporte
al que llamar. Un segundo administrador es el único seguro que existe contra eso.

**El acceso lo concede quien ya es admin.** El otro dev no puede pedir entrar ni registrarse por
su cuenta: se le invita desde
`business.facebook.com/settings/people?business_id=1115123864174893` → *Agregar personas*.
Solo necesita **su Facebook personal de siempre** — no tiene que crear nada.

⚠️ **Que NO cree un portafolio de negocio propio.** Meta se lo ofrece con un botón grande en
cuanto entra. Si lo hace, quedan dos portafolios paralelos, el número sigue colgando del primero,
y hay que deshacerlo a mano.

**El orden importa:** primero él activa el **2FA** en su Facebook
(`accountscenter.facebook.com/password_and_security`), luego se le invita, luego acepta. El
portafolio puede exigir 2FA a los administradores, y entonces la invitación se le queda atascada
al aceptar sin decirle por qué.

#### Las tres cosas que sorprenden en el diálogo de activos

1. **El rol del portafolio, por sí solo, no da acceso a nada.** Hay que asignar los activos uno
   por uno en el paso *Asignar activos*. Si se olvida, él entra y ve el portafolio **vacío**:
   parece que algo se rompió, y solo falta ese paso.
2. **El número de teléfono NO es un activo aparte.** Los tipos que ofrece el diálogo son solo
   *Aplicaciones*, *Píxeles* y *Cuentas de WhatsApp*. El `+57 315 281 2484` va **dentro** de la
   cuenta de WhatsApp (`Escalapp`, `4199925320246584`): asignando esa, el número queda incluido.
3. **La aplicación no se puede asignar todavía.** Sale *«Developer account needed — esta persona
   se debe registrar como desarrollador de Facebook»*. Se arregla en dos minutos —él entra a
   `developers.facebook.com`, *Empezar*, acepta condiciones y confirma correo o teléfono— y luego
   se vuelve a esta pantalla. **No hace falta para administrar el canal**: la app
   (`1552342763052863`) es para tocar tokens y configuración de la API.

#### Esto NO se puede comprobar desde la API

Comprobado el 2026-08-29 contra `GET /1115123864174893/business_users`:

```
{"error":{"message":"(#200) Requires business_management permission to manage the object", ...}}
```

Es el mismo muro que con `verification_status`: el token es de usuario de sistema y no tiene
`business_management`. La única forma de saber si aceptó es la lista de *Personas* del panel —
mientras no acepte aparece como **Pendiente**. Las invitaciones caducan a los pocos días y se
reenvían desde ahí mismo.

**Estado:** invitación enviada el 2026-08-29 con control total del portafolio y de la cuenta de
WhatsApp. Pendiente de que acepte. La app queda sin asignar hasta que se registre como
desarrollador.


## El primer recordatorio que llegó de verdad (2026-08-28)

Hasta esta noche `intelligence.recordatorio` estaba **vacía en producción**: la maquinaria de F8-B
llevaba desde el 20 de agosto construida, probada y **sin haber entregado un solo mensaje**. Se
ejercitó de punta a punta y funcionó, pero solo al segundo intento. Lo que costó llegar ahí es lo
que vale la pena escribir.

### Cómo se fuerza un recordatorio (y cómo NO)

**No sirve adelantar `enviar_en`.** Es lo primero que uno intenta y el diseño lo rechaza: al
vencer, el recordatorio **relee la cita**, recalcula `inicio − 24 h`, ve que lo correcto sigue
siendo mañana y **reprograma la fila**:

```
estado=pendiente  intentos=1  motivo="reprogramado al releer"
```

Es la decisión de `recordatorios/index.js` haciendo exactamente lo que promete —el recordatorio no
se fía de lo programado, se fía de la cita— y la razón por la que no hizo falta escuchar
`cita.cancelada`. Verificada en producción, en contra de quien la quería saltar.

**Lo que sí funciona:** mover la **cita** a menos de 24 h vista y vencer `enviar_en` en la misma
transacción. Entonces el revisor calcula un `enviarEn` ya pasado y envía.

### El fallo que solo se vio enviando: `131042`

El primer envío devolvió `wamid` y el Ledger lo marcó `estado_entrega = entregado`. **No llegó
nada.** El motivo estaba en `auditoria.audit_evento`:

```
accion: entrega_fallida
error 131042 — "Business eligibility payment issue"
"Message failed to send because there were one or more errors related to your payment method."
```

> ### ⚠️ `health_status` no sirve para saber si el pago funciona
>
> Minutos antes, `scripts/whatsapp_salud.js` daba la WABA **`AVAILABLE`**, sin rastro del
> `141006`, y `account_review_status = APPROVED`. Y aun así el envío falló por método de pago.
> **La única prueba fiable es enviar un mensaje real y leer la auditoría.** El panel tampoco
> avisaba: decía que el método de pago estaba correcto.
>
> Corolario para el runbook: *«el pago está arreglado»* no es una observación del panel ni del
> `health_status`. Es un envío que llegó.

Arreglado el pago, el segundo envío entregó. La firma de un envío bueno frente a uno malo, sin
mirar el teléfono:

| | Envío fallido | Envío entregado |
|---|---|---|
| Webhooks de estado recibidos | **1** (el `failed`, en 9 s) | **4** (`sent`/`delivered`/`read`) |
| Filas en `audit_evento` | 1 × `entrega_fallida` | ninguna |

### Dos trampas de lectura del Ledger

1. **`mensaje.id_externo` es el `wamid`, NO el teléfono.** El número va codificado en base64
   dentro (`HBgM` + base64 del número). Comparar `id_externo` con un teléfono da siempre `false`,
   y de ahí a concluir que un mensaje «no llegó» hay un paso. Pasó dos veces la misma noche.
2. **`estado_entrega = 'entregado'` significa «Meta aceptó el envío», no «llegó al teléfono».** La
   entrega real solo se sabe por el acuse posterior, y **solo se guardan los `failed`** —a
   propósito, para no escribir tres veces por mensaje—. O sea: *ausencia de acuse* es la señal de
   que fue bien.

### ~~⚠️ Bug abierto~~ ARREGLADO el 2026-08-29: el acuse fallido y el saliente de otro negocio

`repositorio.marcarAcuseDelCanal()` busca la fila con `WHERE id_negocio = :idNegocio`, y ese
`idNegocio` sale de `resolverNegocio(phone_number_id)` — el negocio **atado al número**. Si el
mensaje saliente es de otro negocio (aquí: recordatorio del 10 saliendo por el número del 12), no
casa y **el Ledger se queda diciendo `entregado` un mensaje que Meta rechazó**.

La auditoría sí lo registró —por eso se pudo diagnosticar—, pero el Ledger miente.

**El arreglo es quitar el filtro por negocio: el `wamid` ya es único global.** Es de una línea, y
hace falta antes de F8-C, donde varios negocios comparten adaptador.

**Hecho el 2026-08-29.** Se quitó el `AND id_negocio` de `marcarAcuseDelCanal()` y el parámetro
sobrante en la llamada. Lo que costó más que el arreglo fue la prueba, y es la parte que importa:
`ventana.test.js` ahora entrega un saliente y le manda el acuse **resuelto como otro negocio**.
Comprobada rompiéndola —con el filtro puesto la prueba falla con `Expected: "fallido" / Received:
"entregado"`, que es literalmente el Ledger mintiendo—. Suite completa: **662/662**.

### Y el cruce entre verticales, en vivo

Con `WHATSAPP_NEGOCIO_ID=12`, un recordatorio del negocio 10 **sale igual** —la salida no consulta
`resolverNegocio()`, solo la entrada—. Pero la respuesta del cliente entra como negocio 12. Ocurrió
literalmente: al recordatorio de una cita de peluquería se contestó *«No puedo ir»* y respondió el
asistente del **restaurante**: *«No pasa nada, podemos enviártelo a domicilio. ¿Qué te gustaría
pedir?»*.

No es un fallo: es el techo de **un número = un negocio**, y es el argumento concreto del punto 6
de F8-C — que `entregar()` mande desde el número del negocio dueño de la conversación.

## Un mensaje sin remitente, y un lote entero perdido (2026-08-26)

Un familiar del dueño escribió «Buenas tardes» al número del negocio y **no recibió nada**. El
mensaje salió con doble check: Meta lo tenía. En el Ledger no había ni conversación ni ingesta,
como si nunca hubiera existido.

En el log, una sola línea, a la hora exacta:

```
[whatsapp] fallo procesando el webhook: El mensaje canónico necesita saber quién habla
```

El webhook **sí** llegó. Lo rechazamos nosotros.

### Qué estaba mal, y cuál de las dos cosas era la grave

**1. Se leía solo `mensaje.from`.** Ese mensaje llegó sin ese campo. Meta manda el número de quien
escribe **también** en `contacts[].wa_id`, dentro del mismo cambio del webhook — es el mismo dato
por otra puerta, y usarlo de respaldo no adivina nada.

**2. Un elemento malo abortaba el lote entero.** Esta es la de verdad. `recibirWebhook` era una
fila de bucles sin red: el primer `throw` se llevaba todo lo que venía detrás — los demás mensajes,
los acuses, los avisos de la cuenta.

Y no hay reintento posible: **a Meta ya se le contestó 200 antes de procesar** (son sus 10
segundos). Lo que se pierde ahí no vuelve. El aislamiento por elemento no es prolijidad: es lo
único que decide si un cliente recibe respuesta.

> Es la misma forma del fallo del Ledger de esta misma semana: **una pieza secundaria matando la
> principal**. Allí el rastro de un error tumbaba la conversación que estaba contando; aquí la
> validación de un mensaje tumbaba los mensajes de al lado.

### Lo que hay ahora

- El remitente sale de `from` y, si no viene, de `contacts[].wa_id`.
- Si no hay ninguno de los dos, el mensaje **se aparta** y se registra su **forma** —tipo, claves
  presentes, `wamid`— y nunca su contenido: eso acaba en un log, y lo que escribió una persona no
  tiene por qué acabar ahí. Con eso, un caso nuevo se diagnostica sin tener que reproducirlo.
- Cada mensaje, eco, aviso y acuse se procesa **por su cuenta**. Un fallo se registra con su
  `wamid` y los demás siguen. El resumen devuelve `fallos` y `sinRemitente`.

Las cuatro pruebas se comprobaron quitando las dos protecciones: sin ellas, fallan.

### Lo que había detrás: WhatsApp cambió la identidad (BSUID)

El diagnóstico de arriba dio el dato a la primera. El segundo intento dejó esto en el log:

```
[whatsapp] mensaje SIN REMITENTE, se aparta:
{"tipo":"text","claves":["from_user_id","id","text","timestamp","type"],
 "claves_del_cambio":["contacts","messages","messaging_product","metadata"], "wamid":"…"}
```

`from_user_id`, no `from`. Y el `wamid`, en base64, llevaba dentro `CO.1112947687726965`.

Eso es un **Business-Scoped User ID**: la identidad que Meta da a quien escribe a un negocio
**sin enseñar su número de teléfono**. Formato: indicativo de país, un punto, dígitos.

No es una rareza ni un caso de borde:

- Desde el **31 de marzo de 2026** Meta manda el BSUID en `messages[].from_user_id` y
  `contacts[].user_id` **en todos los mensajes**, tenga o no el usuario un nombre de usuario.
- Desde **junio de 2026**, con los nombres de usuario (`@alguien`), un cliente puede escribirle a
  un negocio sin compartir su número. Ahí el webhook llega **sin `from` y sin `wa_id`**: el BSUID
  es lo único que hay.

O sea: **el estado normal de un cliente nuevo que llega por su nombre de usuario**, y va a ser
cada vez más frecuente.

### Las dos mitades del arreglo

**Leerlo.** El remitente se busca en este orden: `from` → `contacts[].wa_id` → `from_user_id` →
`contacts[].user_id`. El teléfono va primero **a propósito**: es lo que identifica a la persona en
el resto de la plataforma (`persona_negocio`), lo que prueba la pertenencia de una cita o un
pedido, y la clave de las conversaciones que ya existen. Con el BSUID delante, un cliente conocido
estrenaría conversación y perdería su historia.

**Contestarle.** A un BSUID **se le escribe con `recipient`, no con `to`** — y si van los dos,
Meta le da precedencia a `to`. Equivocarse ahí no es «casi correcto»: es un envío que Meta acepta
y que no llega a nadie.

### Lo que un cliente sin teléfono NO puede hacer, y por qué está bien

Sin número probado, `principal.telefono_verificado` es `null` y las comprobaciones de pertenencia
**fallan cerradas**: no puede consultar el estado de un pedido ni cancelar una cita por código. Es
la decisión correcta —el id opaco no prueba que el pedido sea suyo— y es la que ya estaba escrita
desde F2. Lo que no podía pasar, y no pasa, es que `CO.111…` se colara como si fuera su móvil:
`normalizarTelefono` lo rechaza.

> ⚠️ **Pendiente de producto, no de código:** `tomar_pedido` guarda como teléfono de contacto el
> que probó el canal. Para un cliente que llega por BSUID eso es `null`, así que **el restaurante
> recibe un domicilio sin un número al que llamar**. La columna lo admite, o sea que no falla:
> sale mal en la puerta del cliente. Lo natural es que el flujo pida el teléfono **solo cuando el
> canal no probó ninguno** —un paso más para quien llega sin número, ninguno para los demás— y que
> ese teléfono se guarde como dato de contacto, nunca como prueba de identidad. Está sin hacer.
