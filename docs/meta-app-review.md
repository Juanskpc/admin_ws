# El App Review de Meta: qué se revisa exactamente, y qué nos falta

**Fecha:** 2026-09-04 · **Objetivo:** pasar el App Review de `whatsapp_business_messaging` y
`whatsapp_business_management` en **acceso avanzado**, que es lo único que abre **Embedded Signup**
—que cada cliente conecte su propio número desde la Consola— y quita el techo de 20 números.

> **Esto NO es lo que ya tenemos.** Hoy producción funciona con **acceso estándar**: un token de
> usuario de sistema sobre **nuestra propia** WABA. El acceso avanzado solo hace falta para tocar
> los activos de **otras** empresas. Consecuencia práctica y tranquilizadora: **enviar la app a
> revisión no puede romper lo que está corriendo**, y un rechazo tampoco. Lo que hay hoy no
> depende de este trámite.

---

## 1. Lo que Meta revisa de verdad (según sus propios documentos)

Hay **tres** trámites distintos que la gente confunde en uno solo. Van en este orden y cada uno
bloquea al siguiente:

| # | Trámite | Qué mira Meta | Plazo | Nuestro estado |
|---|---|---|---|---|
| 1 | **Verificación de negocio** | Que la empresa existe y es tuya | horas–semanas | ✅ **APROBADA 2026-08-29** |
| 2 | **App Review** (acceso avanzado) | Descripción escrita + **un video por permiso** | ~1–20 días | ⬜ **sin enviar** |
| 3 | **Access Verification** | Que el negocio es de verdad un *Tech Provider* | ~5 días hábiles | ⬜ posterior al 2 |

Y antes del 2 hay un paso de configuración que no es revisión pero que la bloquea: **hacerse
Proveedor de Tecnología** (*WhatsApp → Quickstart → Become a Tech Provider*), que es leer y aceptar
los Términos de Proveedor de Tecnología y elegir **Independent Tech Provider**.

### Qué pide el App Review, con las palabras de Meta

Para cada uno de los dos permisos hacen falta **dos cosas separadas**, y falta una y se rechaza:

**`whatsapp_business_management`**
> *«Explain how you will use this permission to access the business assets of clients who you have
> onboarded onto the platform.»*
> Video: **crear una plantilla de mensaje** — dentro de nuestra app **o en WhatsApp Manager**.

**`whatsapp_business_messaging`**
> *«Explain what messaging functionality your app offers to clients who you have onboarded onto the
> platform, and how they perform those functions.»*
> Video: la app **enviando un mensaje** a un número de WhatsApp **y el mensaje llegando** al
> cliente de WhatsApp.

**Reglas de forma que Meta dice explícitamente:**

- **Un video por permiso.** *«Do not submit a video that includes multiple permissions.»*
- **Descripción Y video.** Un video sin texto se rechaza aunque el video sea perfecto.
- **Enviar de verdad.** Una solicitud que se queda en borrador no la mira nadie.
- La app tiene que estar en modo **Live**, no en desarrollo.

### Las causas de rechazo que nos aplican a nosotros

De la guía de screencast de 2026, filtradas por las que este producto puede pisar:

| Causa | Nos aplica |
|---|---|
| **Interfaz en un idioma que no es inglés, sin subtítulos** | 🔴 **Sí.** Toda la Consola está en español. Hay que poner rótulos en inglés sobre los momentos clave |
| Empezar el video ya con la sesión iniciada | 🟡 Fácil de evitar: grabar desde el login |
| Baja resolución, cursor invisible, sin anotaciones | 🟡 Evitable |
| Pedir permisos que no se usan | 🟢 No: pedimos exactamente los dos que usamos |
| El revisor no puede reproducir el flujo | 🟡 Se resuelve dándole **usuario y clave de prueba** en producción |
| Trademarks de Meta en el nombre o el icono | 🟢 No: la app se llama `Escalapp` |

---

## 2. Comparación: lo que tenemos contra lo que piden

Verificado el 2026-09-04 por SSH contra la API de Meta (`whatsapp_salud.js`,
`whatsapp_diagnostico.js`) y con `curl` contra el sitio público. Lo que dice **⬜ verificar** es lo
que **no se puede leer con un token de app** y hay que mirar en el panel.

### Lo que ya está y sirve tal cual

| Requisito | Lo que tenemos | Cómo se comprobó |
|---|---|---|
| Negocio verificado | ✅ `BUSINESS 1115123864174893: AVAILABLE` | `whatsapp_salud.js` |
| Revisión de la WABA | ✅ `APPROVED` | íd. |
| Método de pago sin bloqueo | ✅ `AVAILABLE` global (ya no sale el `141006`) | íd. |
| App con producto WhatsApp y suscrita a la WABA | ✅ `Escalapp` `1552342763052863` | `whatsapp_diagnostico.js` §3 |
| Token permanente con los **dos** permisos | ✅ `whatsapp_business_messaging` + `whatsapp_business_management` | íd. §1 |
| Número operando | ✅ `+57 315 2812484` · CONNECTED · VERIFIED · GREEN | íd. §2 y §5 |
| **Una plantilla creada y aprobada** | ✅ `recordatorio_cita` [es] APPROVED UTILITY | íd. §4 — *esto es literalmente el video 2* |
| **Envío y recepción reales** | ✅ 160+ salientes entregados, 0 fallos | producción, agosto |
| Política de privacidad pública | ✅ `escalapp.cloud/admin/privacidad` · 200 · 34 KB | `curl` |
| Términos públicos | ✅ `escalapp.cloud/admin/terminos` · 200 · 38 KB | `curl` |
| **Instrucciones de eliminación de datos** | ✅ `escalapp.cloud/admin/eliminacion-datos` · 200 · 31 KB | `curl` |
| Nombre sin marcas de Meta | ✅ `Escalapp` | API |

**Las tres páginas legales están vigentes en v1.0, con los datos del titular y sin el cartel de
borrador.** Eso era lo que faltaba y ya está: se desplegó el 2026-09-04.

### Lo que falta — ocho casillas del panel

Ninguna es código. Están en *App Dashboard → Settings → Basic* salvo donde se diga:

| # | Casilla | Por qué importa |
|---|---|---|
| 1 | **Privacy Policy URL** | El revisor la abre. Va `https://escalapp.cloud/admin/privacidad` |
| 2 | **Terms of Service URL** | `https://escalapp.cloud/admin/terminos` |
| 3 | **User Data Deletion** → *Data Deletion Instructions URL* | Campo **distinto** del de privacidad. Va `https://escalapp.cloud/admin/eliminacion-datos` |
| 4 | **App Icon** (1024×1024) | Sin icono no se puede enviar a revisión. Sin logos de Meta |
| 5 | **Category** de la app | Requisito explícito del checklist de Tech Provider |
| 6 | **App Mode = Live** | En desarrollo, la revisión no procede |
| 7 | **2FA activo** en el portafolio de negocio | Requisito del programa de Tech Provider |
| 8 | **Become a Tech Provider** (*WhatsApp → Quickstart*) | Aceptar términos + *Independent Tech Provider* |

> ⚠️ **La API no confirma las tres primeras.** Un token de app (`APP_ID|APP_SECRET`) devuelve
> `name`, `icon_url` e `id`, y **calla** en `privacy_policy_url`, `terms_of_service_url`,
> `category` y `user_support_email` — callar no distingue «vacío» de «no puedo verlo». Son campos
> de administrador: se miran en el panel, no desde aquí.

### Lo que hay que producir (y no existe todavía)

| Qué | Estado | Nota |
|---|---|---|
| **Video 1** — messaging | ⬜ | Grabar. El material real ya existe |
| **Video 2** — management | ⬜ | Crear una plantilla en WhatsApp Manager, grabando. **Crea `pedido_listo`**: hace falta de todos modos (ver abajo) |
| **Descripción 1 y 2** en inglés | ⬜ | Borradores listos abajo, §4 |
| **Usuario de prueba** para el revisor | ⬜ | Un login de la Consola de producción, con datos de demostración |
| **Notas para el revisor** | ⬜ | Una frase, §4 |

---

## 3. Los dos videos, con guion

Ambos se pueden grabar **hoy**, con lo que ya está en producción. **Sin escribir una línea de
código**: el permiso `whatsapp_business_management` se puede demostrar en **WhatsApp Manager**, así
que no hace falta construir una pantalla de plantillas en la Consola.

### Video 1 — `whatsapp_business_messaging`

1. Empezar **con la sesión cerrada** en `escalapp.cloud/admin`.
2. Iniciar sesión (rótulo en inglés: *«Business owner logs into EscalApp»*).
3. Abrir **la Bandeja** (`/admin/bandeja`) y una conversación real
   (*«Inbox: conversations of this business's end customers»*).
4. **Escribir y enviar** un mensaje desde la app (*«The business replies from our app…»*).
5. **Cortar al teléfono**: el mensaje llegando a WhatsApp (*«…and it arrives on WhatsApp»*).
6. Contestar desde el teléfono y mostrar que **entra** en la Bandeja (*«…and inbound messages are
   received via webhook»*).

### Video 2 — `whatsapp_business_management`

1. Igual: empezar desde el login (cuesta 10 segundos y quita una causa de rechazo).
2. Entrar a **WhatsApp Manager → Message templates → Create template**.
3. Crear una plantilla `UTILITY` en español — la de recordatorio de cita sirve de modelo.
4. Enviarla y mostrar que queda **en revisión / aprobada**.

**Reglas para los dos:** cursor visible, sin audio, alta resolución, **rótulos en inglés** sobre
cada paso (la interfaz es española: sin rótulos, rechazo), y **un permiso por video**.

> **2026-09-07 — el video 2 dejó de ser un trámite y pasó a ser trabajo real que hacía falta.**
> El despacho tiene desde ese día un botón que le avisa al cliente que su pedido está listo para
> recoger, y ese aviso **es** una plantilla: `pedido_listo` [es] `UTILITY`, ya escrita en
> `intelligence/core/plantillas.js` y con sus pruebas. **Falta crearla en WhatsApp Manager**, con
> nombre, idioma y texto idénticos.
>
> O sea que grabar el video 2 y desbloquear la función son **la misma tarea**. Y de paso mejora el
> video 1: en vez de solo contestar a mano desde la Bandeja, se puede enseñar la app mandando una
> plantilla de verdad y llegando al teléfono, que es exactamente lo que Meta quiere ver. Detalle en
> [`asistente-restaurante.md`](asistente-restaurante.md) §«El botón "avisar que está listo"».

---

## 4. Textos listos para pegar

### Descripción de `whatsapp_business_messaging`

> EscalApp is a multi-tenant SaaS used by small businesses in Colombia (restaurants, salons,
> parking lots, gyms, appointment-based services). Each onboarded business uses our platform to
> talk to its own end customers on WhatsApp.
>
> With `whatsapp_business_messaging` our app: (1) receives inbound messages through webhooks on the
> business phone number the customer onboarded; (2) sends replies inside the 24-hour customer
> service window — an assistant that books appointments and takes restaurant orders; (3) sends
> UTILITY template messages such as appointment reminders outside that window; and (4) marks
> messages as read.
>
> Every outbound message is sent from the phone number of the business that owns the conversation,
> and a human agent of that business can take over any conversation at any time from our inbox
> screen. We never send from a phone number that does not belong to the business that owns the
> conversation.

### Descripción de `whatsapp_business_management`

> After a business customer completes Embedded Signup and grants us access to their WhatsApp
> Business Account, EscalApp uses `whatsapp_business_management` to: (1) read the WABA and the
> business phone numbers they granted, so we can map each `phone_number_id` to their account in our
> platform; (2) subscribe our app to their WABA so their messages reach our webhook; (3) register
> their business phone number with the Cloud API; and (4) create and read the message templates
> their notifications need — for example a UTILITY appointment-reminder template.
>
> We only access assets that a business explicitly granted through Embedded Signup, one business at
> a time, and we never access assets of any other business.

### Notas para el revisor

> We are applying to become a WhatsApp Tech Provider. We submit one separate screencast for
> `whatsapp_business_messaging` and one for `whatsapp_business_management`. Our product UI is in
> Spanish; every relevant step is annotated in English in the videos. Test credentials for our
> admin console: <usuario> / <clave> at https://escalapp.cloud/admin.

---

## 5. Lo que viene DESPUÉS de aprobar, y conviene saber antes

Aprobar el App Review **no conecta a ningún cliente todavía**. Falta Access Verification (~5 días
hábiles) y falta código:

- **Facebook Login for Business**: crear una configuración de *WhatsApp Embedded Signup*, guardar
  el **config ID**, y en *Login settings* activar Client OAuth, Web OAuth, HTTPS, Embedded Browser
  OAuth, Strict Mode y login con el SDK de JavaScript. `escalapp.cloud` en **Allowed domains** y en
  **Valid OAuth redirect URIs** (HTTPS, sin comodines).
- **SDK de JavaScript** en la Consola + el manejador del evento de cierre del flujo.
- **Un endpoint en el backend** que cambie el `code` por el **business token** del cliente. ⚠️ **El
  código caduca en 30 segundos**: hay que mandarlo al servidor en cuanto llega, no al final.
- Suscribir la app a **la WABA del cliente**, registrar su número, y suscribirse al webhook
  **`account_update`**.
- **Implementar la v4 directamente. La v2 de Embedded Signup se apaga el 15 de octubre de 2026.**

Y tres consecuencias de negocio que no son técnicas:

1. **Como Tech Provider, el cliente pone su propio método de pago** y ve su factura de Meta. Hoy la
   pagamos nosotros y el margen es nuestro. Es la decisión que §4-0.3 de
   [`ESTADO-Y-CONTINUACION.md`](ESTADO-Y-CONTINUACION.md) marca como *«a tomar ANTES de gastar en
   anuncios»* — y enviar la revisión no la toma: pasar el trámite no obliga a usar Embedded Signup.
2. **El techo nuevo son 10 clientes nuevos cada 7 días**, y sube a **200** cuando estén hechos App
   Review **y** Access Verification. Por encima de 200 hay que pedir ser Meta Business Partner.
3. El número del cliente sigue sin poder estar en uso en la app de WhatsApp, igual que hoy.

---

## 6. Lo que NO hace falta, aunque lo parezca

- **No hay que construir la pantalla de plantillas** para pasar la revisión: WhatsApp Manager vale.
- **No hay que tener Embedded Signup implementado** para enviar la revisión. Se pide el permiso
  describiendo el uso previsto; el código va después.
- **No hay que crear una app nueva.** El consejo de «no reutilices apps» que circula viene de guías
  de intermediarios (Twilio), donde la app queda atada a su solución. La nuestra ya tiene el
  producto WhatsApp, está ligada al portafolio verificado y usa acceso estándar sobre nuestra
  propia WABA: pedir avanzado **añade**, no sustituye.
- **No hay que tocar producción.** Todo el trámite ocurre en el panel de Meta.

## Fuentes (consultadas el 2026-09-04)

- [Become a Tech Provider](https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/get-started-for-tech-providers)
- [App Review para proveedores de WhatsApp](https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/app-review)
- [Embedded Signup — visión general](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/overview/)
- [Embedded Signup — implementación](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/implementation)
- [Onboarding de clientes](https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users/)
- Guías de terceros para las causas de rechazo y los plazos reales:
  [screencast 2026](https://singhamandeep.com/meta-app-review-screencast-why-your-demo-video-gets-rejected-2026/) ·
  [Twilio Tech Provider](https://www.twilio.com/docs/whatsapp/isv/tech-provider-program/integration-guide)
