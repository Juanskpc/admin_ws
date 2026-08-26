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

> ⚠️ **Y el bloqueo de verdad no es ninguno de los tres.** El asistente **solo sabe agendar citas**:
> las seis capacidades son de `reserva` y el único adaptador es `reserva`. Conectar hoy el número de
> un restaurante le daría un bot que ofrece cortes de cabello. La fontanería del alta multi-inquilino
> solo rinde cuando hay producto que entregar, y los dos clientes activos son restaurantes. **El
> adaptador de restaurante va antes que el Embedded Signup.**

---

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
