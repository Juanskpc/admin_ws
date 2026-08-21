# El canal de WhatsApp: qué está hecho, qué falta y cómo se conecta

**Fase:** F8-A · **Gobierna:** [ADR-016](adr/ADR-016-webchat-hostil.md), [ADR-017](adr/ADR-017-channel-gateway.md) · **Fecha:** 2026-08-19

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
| **F8-B** | Las reglas del canal: ventana de 24 h y plantillas, multimedia, recordatorios proactivos | ⬜ |
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

## Cómo se prueba hoy, sin cuenta de Meta

```bash
DB_PORT=5432 DB_PASS=... LLM_HABILITADO=false node scripts/whatsapp_e2e.js
```

Levanta un webhook y un «Meta» de mentira en puertos efímeros y manda una conversación entera por
ellos. Lo único falso es Meta: la firma, el cuerpo crudo, el adaptador, el motor, la FSM, el Policy
Gate, la capacidad, el Ledger, el entregador y el renderizado son los de producción. Comprueba de una
pasada: menú con lista y precios, botones donde toca, firma inválida → 403, número ajeno descartado,
el aviso de los 14 días, y `STOP` → conversación bloqueada con cero mensajes después.

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
5. **Encender `INTELLIGENCE_HTTP_ENABLED=true` en producción con cuidado**: eso enciende también el
   WebChat, que **sigue sin autenticar** (decisión abierta 9). Antes de encenderlo hay que decidir
   qué se hace con esa superficie — lo suyo es una clave pública por negocio, o dejarla fuera.
6. Probar con el número del propio dueño antes que con un cliente.

**Lo que NO hay que hacer todavía:** poner una clave de modelo en producción a la vez que se enciende
el HTTP, por lo mismo que dice `.env.example`. Un canal abierto con el Nivel 4 encendido es una
factura ajena.

---

## Lo que F8-B debe traer

| Qué | Por qué no está en F8-A |
|---|---|
| **Ventana de 24 h y plantillas** | Es la regla de negocio más restrictiva del sistema y no se puede verificar sin conversaciones reales que envejezcan. Un recordatorio de cita **es** una plantilla: hay que diseñarlo así, no descubrirlo |
| **Recordatorios proactivos** | Aquí se cobra el dividendo del outbox de F1. Necesitan la ventana y las plantillas |
| **Multimedia (visión)** | Leer un comprobante de pago. Hoy una foto entra marcada como `[image]` y el bot repregunta, que es honesto pero no es el producto |
| **Correlacionar acuses** | Un `status: failed` de Meta trae el `wamid` de *nuestro* mensaje, y para atarlo hay que haberlo guardado al enviar: una columna en una tabla particionada |
| **Desbloquear una baja desde la Consola** | Hoy un `STOP` por error necesita SQL |
| **Backoff en el entregador** | `gateway.js` ya lo tiene anotado: cuando Meta empiece a devolver 429 de verdad, la columna `proximo_intento_en` es lo primero que hará falta |
| **La tabla de números** | El segundo inquilino, y con él la decisión sobre dónde viven los tokens |
