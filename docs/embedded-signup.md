# Embedded Signup (F8-D) — terreno preparado, sin implementar

> Estado: **borrador de diseño**, 2026-09-18. Nace el mismo día en que se aprobó el App Review
> (`meta-app-review.md`). Aprobar no conecta a ningún cliente todavía — sigue faltando código, y
> este documento es el paso previo a escribirlo, siguiendo la misma costumbre que
> `facturacion-electronica.md`: documento antes que migración.

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

1. **Quién paga la factura de Meta.** Con Embedded Signup el cliente pone su propio método de pago
   y ve su propia factura de Meta — hoy la pagamos nosotros y ese costo (hoy bajo, con mensajes de
   servicio gratis hasta el 1 de octubre de 2026) es margen nuestro. `ESTADO-Y-CONTINUACION.md`
   §4-0.3 la marca como *"a tomar ANTES de gastar en anuncios"*, y es la más urgente: sin resolver
   esto no tiene sentido poner el botón de conexión frente a un cliente real, aunque el código ya
   funcione.
2. **El techo de clientes nuevos.** 10 cada 7 días hoy, sube a 200 con Access Verification — que
   ya está hecha según el panel de Meta (2026-09-17). Con Embedded Signup en producción, este techo
   empieza a importar de verdad.
3. **El número del cliente sigue sin poder estar ya en uso en la app de WhatsApp normal** — eso no
   lo resuelve Embedded Signup, solo lo hace más visible porque el cliente lo intenta él mismo, sin
   que un humano de nuestro lado lo detecte antes.

Ver [[project-escala-numeros-ads]] y [[project-f8c-multinumero]] en la memoria del proyecto para el
hilo completo de esta conversación.
