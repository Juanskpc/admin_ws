# Embedded Signup (F8-D) — implementado y probado en producción

> Estado: **implementado, probado en producción y con autoservicio completo**, 2026-09-19. Nació
> como borrador el 2026-09-18, el mismo día en que se aprobó el App Review (`meta-app-review.md`).
> El código se escribió al día siguiente (capas 1-8 del plan: migración, cifrado, cliente de la
> Graph API, servicio, endpoint, token por negocio, pantalla del panel), **el 2026-09-19 se hizo la
> primera conexión real de punta a punta** contra la cuenta de Meta de verdad (§9), y ese mismo día
> se cerraron los dos cabos sueltos que dejó (§9.3) y se agregó el botón de desconectar (§9.4). Lo
> único que sigue sin hacerse es conectar a un cliente real — ya no es una cuestión de código.

## 0. Qué dispara esto y qué NO resuelve solo

El 2026-09-17 Meta aprobó los tres permisos (`whatsapp_business_messaging`,
`whatsapp_business_management`, `public_profile`) y la Verificación del Acceso (Tech Provider) ya
aparece `Verificado` en el panel. Eso levanta el techo de clientes (10 nuevos cada 7 días, 200 con
Access Verification hecha) pero **no** cambia cómo se conecta un número hoy: sigue siendo alta
manual, un solo token global para toda la WABA (`intelligence/channels/whatsapp/numeros.js`), y
`platform.numero_canal` traduciendo `phone_number_id → id_negocio`.

Embedded Signup es lo que permite que **el cliente conecte su propio número desde un botón**, sin
que nosotros toquemos WhatsApp Manager por él. Eso implica que cada cliente trae su propia WABA y
su propio token — el cambio que el propio código ya anticipa (ver §2).

## 1. Configuración en Meta — checklist manual, esto no se automatiza

Esto se hace a mano en developers.facebook.com, dentro de la app **Escalapp**, y no hay atajo de
API para ello:

1. **Facebook Login for Business** → crear una configuración de tipo *WhatsApp Embedded Signup* y
   guardar el **config ID** que genera (hace falta en el SDK de JS del paso 3).
2. En **Login settings** de esa configuración, activar: Client OAuth Login, Web OAuth Login,
   Enforce HTTPS, Embedded Browser OAuth Login, Login with the JavaScript SDK, y **Strict Mode**.
3. **Allowed Domains for the JavaScript SDK**: `escalapp.cloud` (y el dominio de desarrollo si se
   prueba desde fuera de localhost).
4. **Valid OAuth Redirect URIs**: la URL exacta donde vive el botón de conexión en el admin
   (HTTPS, sin comodines — Meta los rechaza).
5. Confirmar que la app sigue en modo **Live** (ya lo está) y que el usuario que prueba el flujo
   tiene un rol en la app (admin, developer o tester) — si no, el SDK devuelve un error genérico
   que no dice por qué.

Nada de esto se puede dejar «para después de escribir el código»: el `config ID` del paso 1 es un
parámetro obligatorio del SDK, así que sin él no hay nada que probar de punta a punta.

## 2. Dónde vive el secreto — la decisión ya estaba tomada, antes de que hiciera falta

`migrations/migrate_platform_numeros_canal.js` (2026-08-29) ya dejó esto escrito cuando creó la
tabla: *"el día que se haga Embedded Signup —cada cliente con su propia WABA— eso cambia, y
entonces hará falta una columna cifrada aquí. No antes: [ADR-013] pide no construir para un caso
que todavía no existe."*

O sea que la pregunta "¿tabla nueva o columnas en `platform.numero_canal`?" ya estaba contestada
por el propio código: **columnas nuevas en `platform.numero_canal`**, no una tabla aparte. Tiene
sentido además porque el secreto pertenece exactamente a la misma fila que ya identifica
`canal + id_externo + id_negocio` — separarlo en otra tabla solo movería el problema de sincronizar
dos filas en vez de una.

Lo que **no** está decidido, y este documento no lo decide, es el mecanismo de cifrado: si la
llave vive en una variable de entorno (`AES-256-GCM` con `WHATSAPP_TOKEN_KEY`, análogo a como se
firma el webhook hoy) o en un KMS gestionado. La tabla `fe_configuracion` de facturación electrónica
iba a resolver el mismo problema para Factus y **tampoco existe todavía** — no hay hoy en el repo
ningún helper genérico de "credencial cifrada por negocio" del que copiar. Cuando se implemente de
verdad, conviene que ambos (canal y facturación) usen el mismo helper en `app_core/helpers/`, para
no acabar con dos formas de cifrar secretos por negocio.

## 3. El endpoint de canje `code` → token

**Contrato propuesto** (sin implementar):

```
POST /admin/canales/whatsapp/embedded-signup/canjear
Authorization: Bearer <jwt del admin del negocio>
Body: { "code": "<code que devuelve el SDK de JS>" }

200 → { success: true, data: { id_externo, numero_e164, waba_id } }
409 → CANAL_YA_CONECTADO      (el negocio ya tiene un número activo — el único parcial lo impide)
502 → META_CANJE_FALLIDO      (Meta rechazó el code o ya caducó)
```

Vive en `app_admin_api` (no en `intelligence/`, que hoy no expone rutas propias) porque quien
dispara el flujo es el admin del negocio desde la Consola — el mismo patrón de
`ssoController.js` / `generarCodigoAcceso` / `canjearCodigo` que ya existe para el SSO entre
verticales: recibir algo de corta vida, canjearlo por el servidor, nunca en el navegador.

**La regla que no se puede relajar: el `code` caduca en 30 segundos.** El endpoint tiene que
recibirlo y canjearlo en la misma petición — no encolarlo, no guardarlo para procesar después. Si
el canje con Meta falla, la respuesta se lo dice al frontend de inmediato para que el admin repita
el flujo desde el botón (un `code` nuevo), no reintente con el mismo.

El servicio detrás del controlador:
1. Canjea el `code` por un token de acceso de corta vida (llamada a Meta con `client_id` +
   `client_secret` + `code`).
2. Con ese token, resuelve el `waba_id` y el `phone_number_id` del número recién conectado
   (`GET /debug_token` o el equivalente de Embedded Signup v4 — revisar el contrato exacto de v4
   antes de implementar, que es la versión obligatoria desde el 15 de octubre de 2026).
3. Suscribe la app a esa WABA (`POST /{waba_id}/subscribed_apps`).
4. Inserta o actualiza la fila en `platform.numero_canal` para ese negocio, cifrando el token de
   larga duración en la columna nueva de §2.

## 4. El webhook `account_update`

Hoy solo hay un webhook (`GET/POST /webhook` en `intelligence/channels/whatsapp/`, verificado con
`WHATSAPP_APP_SECRET`). `account_update` es un tipo de evento distinto dentro del mismo objeto de
suscripción de Meta — no una URL nueva, un `case` nuevo dentro del mismo handler, para reaccionar
si el cliente desconecta su número desde su lado (revocar el token guardado, marcar la fila como
`estado='I'`).

## 5. Qué cambia en `numeros.js` / `config.js`, y qué no

- **No cambia**: `resolverNegocio()` sigue siendo síncrona, sigue leyendo de la caché en memoria,
  sigue cayendo al `.env` si la tabla está vacía. El contrato con `interpretarWebhook()` (función
  pura) no se toca.
- **Cambia**: hoy `entregar()` usa un único `WHATSAPP_TOKEN` de entorno para cualquier negocio.
  Con Embedded Signup convive un período de transición: negocios de alta manual (token global,
  ninguna fila en la columna cifrada) y negocios recién conectados (token propio, columna cifrada
  con valor). `numeros.js` tiene que decidir, por fila, cuál usar — el token de la fila si existe,
  el global si no. Es un cambio en `porNegocio` (hoy solo guarda `idExterno` y `numeroE164`; hace
  falta que también cargue si tiene token propio) y en quien llama a la Cloud API, que hoy asume un
  solo token para todo el proceso.

## 6. SDK de JavaScript en el admin

Vive en `admin_app-v21`, en la pantalla donde el admin del negocio gestiona su canal de WhatsApp
(hoy no existe esa pantalla — hay que crearla). El SDK de Facebook se carga una vez, se inicializa
con el `config ID` de §1, y el manejador del evento `FB.Event.subscribe('embedded_signup', ...)`
recibe el `code` y lo manda de inmediato al endpoint de §3 — nunca lo guarda en el cliente ni lo
deja esperando a que el usuario haga otra cosa, por la regla de los 30 segundos.

## 7. Borrador de migración

`migrations/migrate_embedded_signup.js` — **archivo de borrador, no registrado en
`package.json`, no corrido contra ninguna base**. Añade a `platform.numero_canal` las columnas
que le faltan para dejar de depender del token global: token cifrado, `waba_id`, `business_id` y
de dónde salió el número (`origen`: `'manual'` o `'embedded_signup'`, para saber sin ambigüedad
cuáles siguen usando el token compartido). Revisar antes de correrla en cualquier base, incluida
la compartida.

## 8. Bloqueado por decisiones de negocio, no por código

Aunque el código de arriba se termine, encender esto en producción no depende solo de eso. Tres
decisiones siguen abiertas y las marcó `meta-app-review.md` §5:

1. ~~**Quién paga la factura de Meta.**~~ **Resuelto y medido el 2026-09-19 — ver §9.1.** Con
   Embedded Signup el cliente pone su propio método de pago en una cuenta y una WABA que Meta crea
   **separadas** de la de EscalApp — no hay ningún momento del flujo en que se nos pida tarjeta a
   nosotros, y no hay ningún camino por el que ese costo se mezcle con el de otro negocio. Dejó de
   ser una decisión de negocio abierta.
2. **El techo de clientes nuevos.** 10 cada 7 días hoy, sube a 200 con Access Verification — que
   ya está hecha según el panel de Meta (2026-09-17). Con Embedded Signup en producción, este techo
   empieza a importar de verdad.
3. **El número del cliente sigue sin poder estar ya en uso en la app de WhatsApp normal** — eso no
   lo resuelve Embedded Signup, solo lo hace más visible porque el cliente lo intenta él mismo, sin
   que un humano de nuestro lado lo detecte antes.

Ver [[project-escala-numeros-ads]] y [[project-f8c-multinumero]] en la memoria del proyecto para el
hilo completo de esta conversación.

---

## 9. F8-D EN PRODUCCIÓN — primera conexión real (2026-09-19)

El código de las capas 1-8 se escribió, se desplegó y **se probó de punta a punta contra la cuenta
de Meta de verdad**, no contra un doble: número `3172782715`, negocio de prueba "Salón Demo
EscalApp" (`id_negocio` 10, no confundir con el `16`, que es la clienta real D'Alex Barbería — los
dos comparten nombre por casualidad, se verificó por NIT/teléfono antes de tocar nada). La fila
quedó en `platform.numero_canal` con `origen='embedded_signup'`, token cifrado de 500 caracteres, y
se desconectó después con `canalEmbeddedSignup.desconectar()` para dejar todo limpio.

### 9.1 La pregunta que llevaba semanas abierta: ¿quién paga?

**Contestada con evidencia, no con documentación de terceros.** El diálogo de Embedded Signup se
recorrió pantalla por pantalla hasta el final, y en ningún momento pidió una tarjeta **a nosotros**:

1. Pantalla de consentimiento (términos, qué va a poder hacer Escalapp) — sin pago.
2. Número de teléfono (elegir uno o crear uno) — sin pago.
3. Selección de activos a compartir (Portfolio + WABA, "crear uno nuevo" porque el número no
   tenía nada) — sin pago.
4. Datos del negocio (nombre, correo, categoría, país, franja horaria) — sin pago.
5. Pantalla final, **"Tu cuenta está conectada a Escalapp"**, con dos botones al mismo nivel:
   **"Añadir método de pago"** y **"Finalizar"**. El pago es una oferta, no un requisito — se
   puede terminar la conexión sin tocarlo.

Y lo más importante: cuando se exploró qué había detrás de "Añadir método de pago", la pantalla de
facturación que apareció era de **"Salón Demo EscalApp"** — la empresa que el propio flujo acababa
de crear, con su saldo en cero, sin ningún método de pago, y con la divisa por defecto en
**Dírham de los Emiratos Árabes** (la prueba de que es una cuenta nueva, sin nada heredado de nuestro
portafolio real, que por supuesto factura en pesos colombianos). Es decir: **el activo que se crea
al conectar un número es una empresa y una WABA separadas de la de EscalApp**, administradas por
quien hizo el registro (en la prueba, nosotros mismos, jugando el papel del cliente) — nunca
absorbidas dentro del portafolio `1115123864174893`.

Esto confirma, con evidencia de primera mano, lo que ya habían dicho tres fuentes de terceros
independientes (Telnyx, Whautomate, Wuseller): como **Tech Provider**, el cliente paga con su
propia tarjeta, en su propia cuenta — nunca la nuestra. La frase de "los socios de soluciones deben
usar su línea de crédito" que aparecía en el asistente de "Hazte socio" del panel de Meta era
boilerplate genérico para varios niveles de socio a la vez; no aplica a Tech Provider.

**Lo que queda sin verificar**: en toda la prueba nunca se envió un mensaje real desde el número
recién conectado. Es posible — y coherente con el patrón ya visto en `canal-whatsapp.md` con el
número original de EscalApp — que el pago solo se exija más adelante, al primer mensaje que lo
requiera (una plantilla, un mensaje iniciado por el negocio), no durante la conexión. Confirmarlo
necesita mandar un mensaje de verdad desde una cuenta conectada por Embedded Signup, cosa que no se
ha hecho todavía.

### 9.2 Un número "reciclado" se pudo usar sin problema

El número de prueba había dado antes un error de "ya está activo" al intentar registrarlo — sin que
quien lo tenía en el celular recordara haberlo activado nunca. Coincide con el patrón conocido de
números reciclados: un operador reasigna una SIM y la cuenta de WhatsApp de quien la tuvo antes
sigue viva hasta que alguien la reclama. Como quien hacía la prueba sí tenía la SIM en la mano,
Meta pudo mandarle el código de verificación por SMS, y verificarlo **resetea** la cuenta anterior
(sin importar de quién fuera) y deja el número libre para la cuenta nueva. No hizo falta ningún
paso adicional ni contactar a Meta.

### 9.3 Los dos cabos sueltos que dejó la prueba — arreglados el mismo día

- ~~**`numero_e164` quedó vacío**~~ **Arreglado.** Se confirmó por búsqueda contra la documentación
  de Meta: el evento `WA_EMBEDDED_SIGNUP`/`FINISH` **nunca** trae `display_phone_number` — no fue
  una particularidad de esta prueba. `embeddedSignupApi.js` ahora tiene `resolverNumero()`, que lo
  pide aparte del lado del servidor (`GET /{phone_number_id}?fields=display_phone_number`) con el
  mismo `accessToken`. Es cosmético — si falla, `conectar()` sigue con lo que haya, nunca se aborta
  la conexión por esto.
- ~~**`waba_id` y `business_id` salieron idénticos**~~ **Arreglado, y era un bug de verdad, no una
  coincidencia inofensiva.** `resolverWaba()` sacaba `businessId` del primer `target_id` de
  `granular_scopes` sin fijarse en el `scope` — daba el mismo valor que `wabaId` casi siempre,
  porque casi siempre solo hay una entrada. Confirmado por búsqueda: el Business Manager y la WABA
  son conceptos distintos en Meta, y `debug_token` no expone el `business_id` con su propio
  `scope`. La fuente correcta es el propio evento `WA_EMBEDDED_SIGNUP`/`FINISH`, que sí lo trae —
  ahora `conectar()` recibe `businessId` como parámetro (del panel, igual que `phoneNumberId`) en
  vez de inventarlo. No es un dato de seguridad: el `wabaId` que de verdad importa lo sigue
  verificando `resolverWaba()` contra el token, nunca contra lo que diga el navegador.

### 9.4 El botón de "Desconectar" — ya existe

Ya no hace falta el script de abajo para lo normal: `GET/POST .../canal-whatsapp/desconectar` deja
que el propio negocio se desconecte desde el panel (self-service, solo para `origen =
'embedded_signup'` — sobre un negocio de alta manual responde 409, no hace nada). Usa el mismo
`canalEmbeddedSignup.desconectar()` de siempre.

Lo de abajo sigue sirviendo para casos que el botón no cubre — por ejemplo, limpiar sin pasar por
el panel, o cuando `desconectar()` devuelve `{desconectado: false}` y hay que investigar por qué:

```bash
cd /var/www/admin_ws
node -e "
require('dotenv').config();
const canal = require('./app_core/whatsapp/canalEmbeddedSignup');
canal.desconectar({ idNegocio: <id>, motivo: '<por qué>' })
  .then(() => canal.obtenerEstado({ idNegocio: <id> }))
  .then((e) => console.log(e));
"
sudo systemctl restart escalapp-api   # limpia la caché en memoria de numeros.js
```

Usa el mismo servicio que usaría el webhook de desconexión automática — no es un `UPDATE` a mano,
así que deja el token realmente borrado y el estado consistente.
