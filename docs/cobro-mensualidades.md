# Cobro de mensualidades: cómo nos pagan a NOSOTROS

**Estado:** propuesta de diseño · **no hay pasarela contratada todavía** · **Fecha:** 2026-09-08
· **Relacionado:** [`precios-y-planes.md`](precios-y-planes.md) §5 ·
[`obligaciones-escalapp.md`](obligaciones-escalapp.md) §1–§3 ·
[ADR-012](adr/ADR-012-outbox.md) · [`facturacion-electronica.md`](facturacion-electronica.md)

> `precios-y-planes.md` §5 dejó esto escrito: *«Cómo se cobra. Hoy no hay pasarela ni débito
> automático»*. Este documento cierra esa línea. Aparece ahora porque hay un cliente de **Chile** a
> punto de entrar, y un cliente fuera de Colombia rompe el único método de cobro que existe hoy —
> una transferencia a Bancolombia.

---

## 0. El problema en una frase

Cobrar **$27.999–$119.999 COP al mes** (y pronto su equivalente en Chile) de forma automática,
recurrente y conciliable, con **dos pasarelas** entre las que el inquilino elige, sabiendo que el
ticket es tan pequeño que **la comisión fija pesa más que el porcentaje**.

---

## 1. Cinco restricciones que ya fijan el diseño

Antes de comparar pasarelas conviene ver qué está descartado de entrada. Cuatro de las cinco no son
técnicas.

### 1.1 Stripe no es una opción

**Stripe no admite empresas constituidas en Colombia ni en Chile** (verificado 2026-09-08). La única
vía es una LLC en EE. UU. vía Stripe Atlas, y eso choca de frente con
[`obligaciones-escalapp.md`](obligaciones-escalapp.md) §1: EscalApp es **persona jurídica
colombiana y está obligada a facturar electrónicamente cada mensualidad**. Cobrar por una entidad
gringa y facturar por la colombiana es una incongruencia que hay que explicarle a la DIAN, no un
atajo. Descartado.

### 1.2 Cobrar «local» en Chile es imposible sin sociedad chilena

Transbank (Webpay/Oneclick), Flow y Khipu **exigen RUT chileno**. Sin una sociedad en Chile no hay
Webpay propio. Lo mismo con Mercado Pago: las cuentas son **por país**, una cuenta MP Colombia no
cobra localmente en Chile.

> Esto deja una sola forma de cobrarle local a un chileno sin abrir empresa allá: un **agregador
> transfronterizo** que sea el que tiene la entidad local. Ahí es donde entra dLocal.

### 1.3 El ticket es diminuto: manda el fijo, no el porcentaje

Sobre $27.999, un fijo de $700 + IVA **es 3 puntos porcentuales**. Cualquier comparación que mire
solo el «2,65% vs 3,49%» está mirando la mitad barata de la cuenta (§2).

### 1.4 El cliente que retiene en la fuente NO se puede debitar

[`obligaciones-escalapp.md`](obligaciones-escalapp.md) §3 ya lo anticipó: un cliente **persona
jurídica** practica retención en la fuente (y quizá ReteICA) — *facturamos $59.999 y consignan
menos*. Un débito automático cobra **el 100%**, así que:

> **Un retenedor cobrado por pasarela paga de más y queda con un saldo a favor que nadie pidió.**

Por eso el **modo manual (transferencia + factura) no es el caso degradado: es un modo de primera
clase y permanente** para clientes empresa. Hoy además es el *único* modo que existe, así que
formalizarlo es la primera fase (§6).

### 1.5 Cada cobro exitoso debe terminar en una factura nuestra

No es opcional ni futuro: una persona jurídica está obligada a facturar siempre. El modelo de datos
tiene que dejar el hueco para el número de factura y el CUFE desde el día uno, aunque durante meses
se llene a mano.

---

## 2. Las pasarelas, con los números

Comisiones consultadas el **2026-09-08** en fuentes públicas (§8). **Confirmar en el contrato antes
de integrar**: son tarifas de lista y algunas se negocian.

### 2.1 Costo real de cobrar el Plan Básico ($27.999 COP)

| Pasarela | Tarifa de lista | Comisión | Neto | **Costo efectivo** |
|---|---|---|---|---|
| **Wompi** (Bancolombia) | 2,65% + $700 **+ IVA** | $1.716 | $26.283 | **6,1%** |
| **dLocal Go** (CO) | 1,99% + USD 0,20 | ~$1.357¹ | ~$26.642 | **~4,9%** |
| Mercado Pago CO | 3,49%–3,99% + IVA (+ fijo según método) | ~$1.160–$1.800 | — | **4,1%–6,4%** |
| Merchant of Record (Paddle/Lemon Squeezy) | ~5% + USD 0,50 | ~$3.400 | — | **~12%** |
| **Transferencia manual** | $0 | $0 | $27.999 | **0%** (+ trabajo humano) |

¹ USD 0,20 a ~$4.000/USD. dLocal factura desde el exterior: **no cobra IVA colombiano**, pero eso
abre una pregunta tributaria propia (§7).

**Lecturas que importan:**

- La tarifa de Wompi es **la misma para tarjeta, PSE, Nequi, botón Bancolombia y efectivo**. Eso
  simplifica muchísimo: no hay que enrutar por método para optimizar costo.
- Un MoR (Paddle) resolvería impuestos globales, pero **cobra el doble y no nos exime de facturar
  en Colombia**. Para tickets de USD 7 es el peor de los mundos. Descartado.
- **El costo efectivo real ronda el 5–6%.** Sobre el margen del Plan Básico ($26.999 según
  `precios-y-planes.md` §3) se lleva ~$1.700/mes por cliente: no es dramático, pero **sí borra el
  presupuesto de infraestructura de ese cliente ($1.000)**.

### 2.2 Costo de cobrarle al cliente de Chile

| Vía | Tarifa | Nota |
|---|---|---|
| **dLocal Go (CL)** | **2,99%**, sin fijo | Cobra con medios locales chilenos; nosotros seguimos siendo una empresa colombiana |
| Transbank / Flow directo | 2,89% + IVA | **Bloqueado**: exige RUT chileno |
| Mercado Pago CL | 3,19% + IVA | **Bloqueado**: exige cuenta MP chilena |
| Tarjeta internacional vía Wompi | 2,65% + $700 + IVA | Funciona, pero el chileno paga en COP con recargo FX de *su* banco y alta tasa de rechazo |
| Transferencia internacional | Comisión bancaria fija (USD 15–30) | Inviable para un ticket de USD 10–15 |

> **Chile solo tiene una respuesta razonable: dLocal Go.** No es preferencia, es la única que cobra
> local sin sociedad chilena.

⚠️ **Trampa de liquidación:** dLocal cobra **USD 1 por retiro inferior a USD 10**. Un cobro suelto
de un plan Básico anda justo en ese borde. **Regla: no retirar por cobro; acumular y retirar una vez
al mes.**

### 2.3 Veredicto

| Rol | Pasarela | Por qué |
|---|---|---|
| **Global / fuera de Colombia** | **dLocal Go** | Una sola integración cubre CO, CL y 13 países más, con medios locales de cada uno; suscripciones nativas; sin cuota mensual; liquida en la moneda del país de la empresa |
| **Local Colombia** | **Wompi** | PSE + Nequi + botón Bancolombia = los medios que el tendero colombiano *sí* usa; sello Bancolombia (confianza); liquidación local rápida; tarifa única por método |
| **Empresas / retenedores** | **Manual** | Obligatorio por §1.4, no por comodidad |

Las dos primeras conviven detrás de **un adaptador** y el inquilino elige (§3.4). No compiten: se
complementan por país y por medio de pago.

### 2.4 ¿Descuento por pago anual? El cálculo honesto

Es la palanca obvia contra el fijo, pero hay que hacer la cuenta antes de venderla:

| | 12 cobros mensuales | 1 cobro anual |
|---|---|---|
| Comisión Wompi total/año | **$20.592** | **$9.663** |
| Ahorro en comisiones | — | **$10.929** |
| Costo de regalar 1 mes | — | **$27.999** |

> **El descuento anual NO se paga con el ahorro de comisiones.** Se justifica por flujo de caja y
> por retención (un cliente anual no churnea en marzo), y esa es una decisión comercial, no
> financiera. Si se hace, **un 10% (~$33.600 de descuento) ya es agresivo**; regalar dos meses es
> regalar dinero.

---

## 3. Arquitectura

### 3.1 Principio rector: el período de servicio es NUESTRO

La pasarela dice si un pago entró. **Quién tiene plan activo y hasta cuándo lo decide nuestra base
de datos**, como hoy (`general.gener_negocio_plan` + `planHelper`). No se delega el ciclo de vida de
la suscripción a Wompi ni a dLocal, aunque ambos ofrezcan «planes»:

- Hay un tercer modo (manual) que ninguna pasarela conoce.
- Un cliente puede **cambiar de pasarela** sin perder su historia.
- `planGuard` → `/sin-plan` ya funciona contra nuestra tabla; nada de eso se toca.

Las pasarelas quedan reducidas a lo que son: **un cobrador de un monto contra un token**.

### 3.2 Modelo de datos — esquema nuevo `cobranza`

Contexto acotado propio, separado de `general` (que es identidad y tenancy). Todas las tablas con
guardas `IF NOT EXISTS` en una sola transacción, script `migrate:cobranza`.

| Tabla | Qué guarda | Notas |
|---|---|---|
| `cob_pasarela` | Catálogo: `wompi`, `dlocal`, `manual`; estado, países y monedas que soporta | Semilla; permite apagar una pasarela sin desplegar |
| `cob_precio_plan` | `id_plan` × `moneda` → precio | **Precios fijos por moneda, nunca FX en vivo** (§3.6) |
| `cob_suscripcion` | 1 por negocio: plan, ciclo (`mensual`/`anual`), moneda, pasarela, método de pago, estado, `proximo_cobro`, `dia_cobro`, `reintentos`, `es_retenedor` | El puente hacia `gener_negocio_plan` |
| `cob_metodo_pago` | Token de la fuente de pago: pasarela, `token_externo`, marca, últimos 4, vencimiento | **Nunca el PAN** (§5) |
| `cob_factura` | Un período: fechas, subtotal, impuestos, total, moneda, estado, `referencia` idempotente, `comision_pasarela`, `neto_recibido`, `retencion_declarada`, `numero_factura` + `cufe` | El hueco de FE de §1.5 |
| `cob_transaccion` | Cada intento contra la pasarela: request/response, código, mensaje | Depuración y disputas |
| `cob_evento_webhook` | Evento crudo recibido, firma verificada, `id_evento_externo` único, `procesado_en` | La clave de la idempotencia |

**Auditoría** (regla fija de `CLAUDE.md`): `trg_audit` en `cob_suscripcion` y `cob_factura` — llevan
dinero y estado. **No** en `cob_transaccion` ni `cob_evento_webhook`: alta rotación y bajo valor.

**Referencia idempotente:** `EA-<id_negocio>-<AAAAMM>` (p. ej. `EA-6-202610`). Es única en
`cob_factura` y viaja como referencia a la pasarela. Un reintento del cron **no puede** generar un
segundo cobro del mismo mes ni aunque el proceso muera a mitad.

### 3.3 Estados y cobranza morosa (*dunning*)

```
trial → activa → en_gracia → suspendida → cancelada
          ↑__________|
```

| Día | Qué pasa |
|---|---|
| 0 | Cobro. Si entra → `activa`, se extiende `gener_negocio_plan.fecha_fin` |
| 0 | Si falla → `en_gracia`. **El servicio sigue funcionando.** Correo + notificación interna |
| +3, +6 | Reintento automático |
| +8 | `suspendida` → sin plan activo → `planGuard` manda a `/sin-plan` |
| — | El login **nunca** se bloquea (regla existente); `/sin-plan` deja de ser un callejón sin salida y pasa a ser la pantalla de pago |

Excepciones duras: **`id_negocio = 6` nunca se suspende** (regla fija) y toda suscripción `manual`
queda fuera del dunning automático.

Los avisos reutilizan lo que ya existe: `planVencimientoScheduler` + `notificacionService` +
`gener_aviso_plan_enviado`. **No se construye un segundo sistema de correos.**

### 3.4 El adaptador (lo que hace que «el usuario elija» sea barato)

`app_core/cobranza/adapters/{wompi,dlocal,manual}.js`, todos con la misma superficie:

```js
{
  tokenizarMetodo(datos),                    // devuelve token_externo, nunca toca el PAN
  cobrar({ referencia, monto, moneda, token }),
  consultarTransaccion(idExterno),           // respaldo para PSE (asíncrono)
  verificarFirmaWebhook(req),                // → evento normalizado o error tipado
}
```

El adaptador `manual` implementa la misma interfaz y no llama a nadie: `cobrar()` deja la factura en
`pendiente` y espera que un super-admin la marque pagada. Que sea un adaptador y no un `if` es lo
que evita que el modo manual se convierta en una excepción regada por todo el servicio.

El servicio de cobranza **solo conoce la interfaz**; añadir una tercera pasarela mañana es un
archivo nuevo y una fila en `cob_pasarela`.

### 3.5 Webhooks: la parte donde se pierde plata si se hace mal

`POST /admin/cobranza/webhook/:pasarela` — **público** (sin `verificarToken`), montado **antes del
rate limiter** o con límite propio holgado (el limiter global de 200/15min tumbaría una ráfaga de
reintentos de la pasarela).

1. **Verificar la firma** (Wompi: `WOMPI_EVENTS_SECRET`; dLocal: firma HMAC). Firma inválida → 401 y
   se registra. Sin esto, cualquiera activa planes gratis con un `curl`.
2. Persistir crudo en `cob_evento_webhook` con `id_evento_externo` **único** → responder **200 en
   milisegundos**. Una pasarela que no recibe 200 rápido reintenta y duplica.
3. Procesar aparte (outbox, [ADR-012](adr/ADR-012-outbox.md)): entrega **al menos una vez**, así que
   el consumidor **debe** ser idempotente. Ya está escrito así en `outboxRelay.js`.
4. **Respaldo por consulta:** PSE es asíncrono y los webhooks se pierden. El cron repregunta por
   toda transacción `pendiente` con más de 30 minutos. **La conciliación no puede depender solo del
   webhook.**

### 3.6 Multi-moneda sin sorpresas

`gener_plan.precio` es un `DECIMAL` en COP y llega **como string** en runtime (coercer con
`Number()`, gotcha ya conocido). Para Chile:

- Precios **fijados a mano por moneda** en `cob_precio_plan` (COP 27.999 · CLP 9.900 · USD 7,90 —
  cifras de ejemplo, la comercial la decide el dueño).
- **Nunca convertir con la tasa del día.** Un precio que se mueve cada mes con el dólar es una
  factura impredecible: exactamente lo que `precios-y-planes.md` §3 dice que odia un negocio
  pequeño.
- La suscripción congela su moneda al crearse. Cambiar de moneda = suscripción nueva.

---

## 4. Qué se toca en cada capa

Regla de workflow del proyecto: **las tres capas juntas**.

### Backend (`admin_ws`)

- `migrations/migrate_cobranza.js` — SQL crudo, transacción única, `IF NOT EXISTS`,
  `information_schema` antes de cualquier `ALTER`, triggers `trg_audit` incluidos. Script
  `migrate:cobranza` en `package.json`.
- `app_core/models/cobranza.*.js` (7 modelos) · `app_core/dao/cobranzaDao.js` (precondiciones con
  errores tipados) · `app_core/cobranza/` (adaptadores + firma de webhooks).
- `app_admin_api/services/cobranzaService.js` — errores de dominio tipados (`.code` +
  `.statusCode`), `{ transaction }` a los DAOs, `setAuditNegocio()` porque conoce el tenant.
- `app_admin_api/services/cobranzaScheduler.js` — `node-cron`, 08:15 `America/Bogota` (después del
  scheduler de vencimientos, no a la misma hora).
- `app_admin_api/controllers/cobranzaController.js` + rutas con `express-validator` inline.

**Endpoints:**

| Método | Ruta | Quién |
|---|---|---|
| `GET` | `/admin/cobranza/mi-suscripcion` | Dueño del negocio |
| `POST` | `/admin/cobranza/checkout` | Dueño — elige pasarela + ciclo, devuelve config del widget |
| `POST`/`DELETE` | `/admin/cobranza/metodo-pago[/:id]` | Dueño |
| `GET` | `/admin/cobranza/facturas` | Dueño |
| `GET` | `/admin/cobranza/suscripciones` | `requireSuperAdmin` — cartera |
| `POST` | `/admin/cobranza/facturas/:id/marcar-pagada` | `requireSuperAdmin` — pago manual, admite retención |
| `POST` | `/admin/cobranza/suscripciones/:id/cobrar` | `requireSuperAdmin` — reintento manual |
| `POST` | `/admin/cobranza/webhook/:pasarela` | **Público, firmado** |

> Ojo con el precedente de seguridad: `PATCH /negocios/:id/plan` **hoy sí** tiene
> `requireSuperAdmin`. Las rutas de cobranza deben nacer igual: si el propio inquilino pudiera
> tocar su suscripción, se regala el producto.

### `admin_app_v21` (consola super-admin)

Vista **Cobranza**: cartera del mes, morosos, ingreso facturado vs. **neto recibido** (la diferencia
son comisiones + retenciones, y es justo lo que descuadra la conciliación según
`obligaciones-escalapp.md` §3), botón de marcar pagada y de reintentar.

### `negocio_app` (inquilino)

- **Configuración → Suscripción:** plan, próximo cobro, método guardado, historial de facturas,
  selector de pasarela **filtrado por país del negocio** (un chileno no ve PSE).
- **`/sin-plan` deja de ser un muro** y pasa a ser la pantalla de reactivación con el botón de pago.
- Signals + `computed()`, sin NgRx, tokens `--color-*` con `color-mix`. El selector de pasarela usa
  `[selected]` por opción si se hace con `<select>` (gotcha conocido).

---

## 5. Seguridad y PCI

- **Nunca pasa un PAN por nuestro backend.** Widget/checkout alojado de la pasarela → recibimos un
  token. Eso mantiene el alcance PCI en **SAQ-A**, que es el único realista para un equipo de dos.
- Llaves en `.env`, jamás en base de datos ni en el front: `WOMPI_PUB_KEY`, `WOMPI_PRV_KEY`,
  `WOMPI_EVENTS_SECRET`, `WOMPI_INTEGRITY_SECRET`, `DLOCAL_API_KEY`, `DLOCAL_SECRET`. Sandbox vs.
  producción por `NODE_ENV` — y **el `.env` local jamás con llaves de producción**, mismo criterio
  que la BD.
- Toda respuesta de pasarela se registra en `cob_transaccion` **sin datos sensibles**.
- El monto **siempre se recalcula en el servidor** desde `cob_precio_plan`. Nunca se confía en un
  monto que venga del cliente.

---

## 6. Fases

| Fase | Qué | Por qué en ese orden |
|---|---|---|
| **F0 — Cobro manual formalizado** ✅ **implementada 2026-09-08** | Esquema `cobranza`, facturas, estados, vista super-admin. **Sin pasarela.** | Hoy *todos* los clientes son manuales y seguirán siéndolo los retenedores. Además le sirve **ya** al cliente chileno con un link/transferencia mientras se abre la cuenta |
| **F1 — dLocal Go** 🟡 **código listo 2026-09-08, falta cuenta** | Adaptador, webhooks, cron de cobro | Es **la que desbloquea Chile**, y de paso sirve en Colombia |
| **F2 — Wompi** 🟡 **código listo 2026-09-08, falta cuenta** | Segundo adaptador + selector en el front | Mejora conversión y costo en Colombia (PSE/Nequi), pero no bloquea a nadie |
| **F3 — Refinamiento** | Dunning completo, ciclo anual, portal de facturas, conciliación de comisiones | Se hace cuando haya suficientes clientes para que duela a mano |

F0 no es relleno: **es el 70% del modelo de datos y el 100% de la máquina de estados.** F1 y F2 solo
enchufan adaptadores.

### Qué quedó construido en F0 (2026-09-08)

| Capa | Archivos |
|---|---|
| Migración | `migrations/migrate_cobranza.js` · script `npm run migrate:cobranza` |
| Modelos | `app_core/models/cobranza.cob_*.js` (7) |
| Adaptadores | `app_core/cobranza/index.js` (el contrato) + `adapters/manual.js` |
| Datos | `app_core/dao/cobranzaDao.js` |
| Negocio | `app_admin_api/services/cobranzaService.js` |
| HTTP | `app_admin_api/controllers/cobranzaController.js` + rutas `/admin/cobranza/*` |
| Consola | `admin_app_v21` → `/admin/cobranza` (cartera, detalle, pago manual) |
| Pruebas | `__tests__/cobranza/periodos.test.js` — 13 casos, sin base de datos |

### Y lo que se añadió el mismo día (F1/F2, a falta de credenciales)

| Capa | Archivos |
|---|---|
| Adaptadores | `app_core/cobranza/adapters/dlocal.js` · `wompi.js` |
| Webhooks | `app_admin_api/webhooks/cobranzaWebhook.js` (cuerpo crudo, antes del parser y del rate limiter en `app.js`) + `services/cobranzaWebhookService.js` |
| Cobro automático | `app_admin_api/services/cobranzaScheduler.js` — cron 08:15, **apagado** por `COBRANZA_AUTO_ENABLED` |
| HTTP | `POST /admin/cobranza/facturas/:id/cobrar` + `POST /admin/cobranza/webhook/:pasarela` |
| Consola | Botón «Cobrar por *pasarela*» y link de pago para el cliente |
| Pruebas | `__tests__/cobranza/firmas.test.js` — 15 casos de verificación de firma, sin credenciales |
| Entorno | `.env.example` documenta las 9 variables nuevas |

**Verificado de punta a punta contra `escalapp_dev`** (2026-09-08): notificación firmada → HTTP
200 y evento guardado con `firma_valida = true`; sin firma → 401; repetida → descartada por el
UNIQUE; pasarela inexistente → 404. El procesamiento llamó a la API de dLocal y registró su
respuesta real (`403 Invalid Credentials`, con llaves de mentira), que es justo lo que debía pasar.

**Lo que falta para cobrar de verdad**, en este orden:

1. Abrir la cuenta de dLocal Go y poner `DLOCAL_API_KEY` / `DLOCAL_SECRET_KEY` en el `.env`.
2. Un cobro completo en **sandbox** — el código está escrito contra la documentación, no contra
   la API real, y esa diferencia se paga con dinero de clientes.
3. `UPDATE cobranza.cob_pasarela SET estado = 'A' WHERE codigo = 'dlocal';` — activar es una
   decisión aparte de configurar (§ el registro de adaptadores).
4. `APP_PUBLIC_URL` correcto. Si esa URL está mal, los pagos entran y nadie se entera.
   ⚠️ **En dLocal NO hay que registrar el webhook en su panel** —esa pantalla no existe—: el
   `notification_url` viaja dentro de cada cobro. Wompi sí lo exige registrado.

### dLocal Go probado de punta a punta (2026-09-15)

Sandbox real, con cuenta propia (`dashboard-sbx.dlocalgo.com`, que es un **registro aparte** del
panel de producción: no es un interruptor como en Wompi). Pago completo de la factura `EA-5-202609`
de Spa Aurora: checkout → webhook firmado (`dlocal:DP-259389`, `firma_valida = true`) → factura
**pagada** → plan extendido del 12 de septiembre al **12 de octubre**, anclado al vencimiento y no
a la fecha de pago. La API respondió al primer intento en CLP/CL y COP/CO.

Tres cosas que salieron de probarlo, y que el código escrito «contra la documentación» no tenía:

1. **`order_id` debe ser único por comercio.** Reusar la referencia devuelve `400 Order id is
   duplicated`, y el efecto es peor que el error: un cliente que abre el checkout y no termina de
   pagar **deja su factura impagable para siempre**. Ahora lleva sufijo por intento, igual que
   Wompi, y el webhook ya recortaba hasta la referencia base.
2. **dLocal no devuelve identificador al volver.** Wompi vuelve con `?id=<transacción>`; dLocal no
   vuelve con nada. El frontend guarda el `idExterno` en `sessionStorage` antes de salir al
   checkout y con eso confirma la vuelta (`core/utils/pasarelas.ts`).
3. **Liquida en COP aunque cobre en CLP** (`balance_currency: "COP"`). El cliente chileno paga en
   su moneda y el dinero entra en pesos colombianos: no hace falta cuenta en Chile.

Pendiente antes de cobrarle a alguien de verdad: **no hay precio en CLP** en `cob_precio_plan`, así
que `getPrecio` lanzaría `PRECIO_NO_CONFIGURADO` para el único negocio de Chile (id 16, D'ALEX
BARBERIA), cuya suscripción además sigue en `manual`/COP. Y ojo al cambiarla: **las facturas ya
emitidas conservan la pasarela con la que nacieron** (`cobrarFactura` lee `factura.pasarela`), así
que hay que actualizar también las pendientes.

### A dónde vuelve el cliente después de pagar (2026-09-16)

Antes toda vuelta caía en `COBRANZA_SUCCESS_URL` —una URL global— y eso sacaba de la sesión al
administrador que pagaba desde «Mis pagos»: acababa en el portal público. Ahora la URL de retorno
**la decide el backend según de dónde salió el pago** (`urlRetornoDe(origen)`), y se la pasa al
adaptador como `urlRetorno`:

| Origen | Vuelve a |
|---|---|
| Portal público `/pagar` | `APP_FRONTEND_URL/pagar` |
| «Mis pagos» (con sesión) | `APP_FRONTEND_URL/admin/mis-pagos` |

`APP_FRONTEND_URL` incluye el baseHref: en producción vale `https://escalapp.cloud/admin`, porque
Caddy monta la consola con `handle_path /admin/*` (que **recorta** el prefijo). De ahí que «Mis
pagos» quede en `…/admin/admin/mis-pagos`: parece un error y no lo es, es la URL que resuelve.

**La URL de retorno nunca llega del navegador**, solo del servidor: aceptarla del cliente sería un
redirect abierto —cualquiera haría que la pasarela devolviera a su sitio con aspecto del nuestro—.

### Portal de pagos del cliente (2026-09-13)

Dos puertas al mismo backend:

| | Con sesión | Sin sesión |
|---|---|---|
| Ruta | `admin_app_v21` → `/admin/mis-pagos` (rol `ADMINISTRADOR`) | `admin_app_v21` → `/pagar` |
| API | `GET /admin/cobranza/mis-cobros` · `POST /admin/cobranza/facturas/:id/pagar` | `POST /admin/publico/cobranza/consultar` · `POST /admin/publico/cobranza/pagar` |
| Identifica | El token | El número de identificación del administrador |
| Nombre del negocio | Completo | Enmascarado (`Bar***** Don Nic*`) |

**Las reglas del portal público, y por qué cada una:**

1. **Solo el rol `ADMINISTRADOR` del negocio.** Estar en `gener_negocio_usuario` no basta: un
   cajero también está, y no debe ver la deuda ni pagarla.
2. **Pagar nunca debita una tarjeta guardada** (`cobrarFactura(id, { usarMetodoGuardado: false })`).
   Siempre abre checkout. Si no, saberse la cédula de un cliente bastaría para cargarle un cobro.
3. **Misma respuesta exista o no la cédula** (una lista, quizá vacía): no se confirma quién es
   cliente. Y una factura ajena responde lo mismo que una inexistente.
4. **POST, no GET**: la cédula no acaba en los logs de Caddy ni en el historial del navegador.
5. **Límite propio de 20 consultas / 15 min por IP.** El limitador global está apagado por defecto;
   sin este, cualquiera recorre cédulas a la velocidad de su red. Funciona detrás de Caddy porque
   `app.js` ya tiene `trust proxy = 1`.
6. **Auditoría con la cédula recortada** (`***0003`) y registrada **después** de iniciar el pago,
   con su desenlace.

**Wompi abre Web Checkout** (`checkout.wompi.co/p/?...` firmado con el secreto de integridad) cuando
no hay tarjeta guardada. Cada link lleva sufijo (`EA-4-202609-lx3k9a`) porque Wompi exige referencia
única por transacción; el webhook recorta hasta la referencia base.

**Verificado contra `escalapp_dev`** con usuarios reales: el admin de la Barbería ve su factura
enmascarada; una cédula inexistente y un usuario sin rol de administrador reciben `[]`; pagar una
factura ajena → 404; pasarela inactiva → 409; cédula de 2 dígitos → 422; la consulta 21 → 429.

### Wompi en marcha (2026-09-14)

La cuenta de Wompi quedó creada. Tres cambios salieron de prepararla para probar:

1. **Confirmación al volver del checkout.** Wompi devuelve al cliente con `?id=<transacción>`.
   `/pagar` manda ese id a `POST /admin/publico/cobranza/confirmar` y el backend **le pregunta a
   Wompi el estado con la llave privada**: del navegador solo se toma el id. Recorre el mismo
   `procesarEvento` que el webhook, así que no hay una segunda lógica de pago. Hace falta porque
   el webhook no llega a `localhost` y en producción puede perderse. Wompi desaconseja *creerle*
   a la redirección; esto no lo hace.
2. **Monto y moneda tienen que coincidir** con la factura antes de aplicar un pago. La firma de
   integridad ya lo impide en el checkout; esta es la segunda llave por si el secreto se
   configura mal.
3. **Un rechazo en el checkout ya no cuenta para la morosidad.** Antes sí, y con la confirmación
   por retorno **recargar tres veces la página de un pago rechazado suspendía al cliente**. Los
   rechazos que sí son morosidad —los del cobro automático con tarjeta guardada— se cuentan en
   `cobrarFactura`, donde ocurren.
4. **El ambiente de Wompi lo deciden las llaves, no `NODE_ENV`, y fuera de producción se rechazan
   las llaves de producción.** El checkout usa la misma URL para los dos ambientes y elige por la
   llave pública: con `pub_prod_` en un `.env` local, un «pago de prueba» cobraba dinero real
   mientras el backend consultaba el sandbox y no lo confirmaba. Pasó con las llaves recién sacadas
   del panel. Para usar producción desde local hace falta `WOMPI_PERMITIR_PRODUCCION_LOCAL=true`.
5. **El primer cobro de un negocio es la renovación de su plan**: arranca el día siguiente a
   `fecha_fin`. Antes arrancaba hoy y facturaba un período ya cubierto — al pagarlo el plan no se
   extendía ni un día. Si el plan venció o no tiene fecha de fin, arranca hoy.
6. **Un plan sin fecha de fin sigue sin ella al pagar.** `extenderPlan` le imponía la fecha del
   período pagado, lo que ponía fecha de corte al cliente que no se bloquea nunca (`id_negocio=6`).

**Probar en sandbox (sin dinero real):**

| Paso | Qué |
|---|---|
| 1 | Panel de Wompi → llaves de **pruebas** (`pub_test_`, `prv_test_`, `test_integrity_`, `test_events_`) en el `.env` de `admin_ws` |
| 2 | Reiniciar el backend. Si Wompi no aparece, la consola dice por qué (llaves de producción, mezcladas…) |
| 3 | Pagar el cobro pendiente desde `/pagar` o `/admin/mis-pagos` con los datos de prueba de abajo |
| 4 | Copiar el **id de la transacción** de la pantalla de resultado de Wompi y pegarlo en **Cobranza → Verificar pago** |

El paso 4 existe porque en local no hay forma automática de enterarse del pago: el webhook no llega a
`localhost` y **Wompi rechaza con un 403 cualquier `redirect-url` que no sea `https`** (probado el
2026-09-15: la misma URL da 200 con `https` o sin retorno, y 403 con `http://localhost`). Por eso
el adaptador solo manda el retorno si es `https`.

Datos de prueba de Wompi: tarjeta `4242 4242 4242 4242` aprueba y `4111 1111 1111 1111` rechaza
(cualquier fecha futura y CVC de 3 dígitos); Nequi `3991111111` aprueba y `3992222222` rechaza; en
PSE el sandbox muestra un banco que aprueba y otro que rechaza.

**En producción** cambian tres cosas: llaves `pub_prod_…` en el `.env` del VPS, la URL de eventos
registrada en el panel de Wompi apuntando a `https://api.escalapp.cloud/admin/cobranza/webhook/wompi`,
y `COBRANZA_SUCCESS_URL=https://escalapp.cloud/pagar`. Allí la confirmación es automática por las
dos vías (webhook y vuelta con `?id=`); «Verificar pago» queda para el cliente cuyo webhook se perdió.

### Cobro automático y solo Wompi (2026-09-15)

Decisión del dueño: no generar cobros a mano y no aceptar transferencias —ambas cosas obligaban a
vigilar extractos, confirmar pagos y correr fechas de vigencia.

**Generación automática** — `cobranzaService.generarCobrosPorVencer`, llamada por la verificación
diaria de vencimientos (`notificacionService`, 08:00 Bogotá) **antes** del aviso de 5 días, así el
correo llega con algo que pagar. Entran los negocios activos cuyo plan de mayor cobertura vence
entre hace 30 días y dentro de 5, que no deban ya un cobro pendiente. Los que no tenían suscripción
de cobro la estrenan ahí (sin esto, ningún negocio registrado después de F0 recibía cobro), y la
suscripción se pone al día con el plan vigente si se cambió en Negocios. Un plan sin fecha de fin no
vence y no se cobra.

**El período es la renovación**: arranca en lo más tardío entre el día siguiente a la última factura
y el día siguiente al vencimiento del plan (u hoy, si ya venció). La guarda contra duplicados solo
mira cobros **pendientes**: sobre cualquier estado bloqueaba la renovación, porque la factura pagada
cubre justo hasta el vencimiento.

**El correo de vencimiento** cambió su botón «Ver mi plan» por **«Pagar mi mensualidad» → `/pagar`**.

**Solo Wompi** — `npm run migrate:cobranza-solo-wompi`: `manual` a estado 'I' (no se borra: las
facturas viejas la referencian y el super admin conserva «Registrar pago» para excepciones),
`DEFAULT 'wompi'` en `cob_suscripcion.pasarela`, y suscripciones y cobros pendientes de negocios
colombianos pasados a Wompi. **Los negocios de otros países no se tocan**: Wompi solo cobra en
Colombia, y hasta que dLocal esté activo no tienen cómo pagar en línea.

**Verificado contra `escalapp_dev`**: con la ventana real no había candidatos; con una ventana
ampliada, el negocio 17 (plan hasta 2026-10-01) recibió `EA-17-202610` del 2-oct al 1-nov en Wompi,
y una segunda corrida no generó nada. La migración corrió dos veces sin cambios en la segunda.

### Un pago compra un mes desde el vencimiento (2026-09-15)

Regla del dueño, que **reemplaza** lo dicho arriba sobre dónde arranca el período:

> «Se me venció el plan el 10 de septiembre, se dieron 5 días más, pago el 15: la renovación no
> debe ser hasta el 15 de octubre, sino hasta el 10, porque esa fue la fecha de vencimiento.»

- **Un pago = un ciclo, sumado a la fecha de vencimiento.** Da igual si el plan se contrató por
  dos meses: cada mensualidad suma uno. Pagar en gracia no regala los días de gracia; pagar por
  adelantado no hace perder días.
- **Si el mes comprado ya no cubre el día del pago** (pagó mucho después de vencer), arranca ese
  día. Anclado al vencimiento, pagaría y seguiría vencido.
- **Un plan sin fecha de fin no se toca.**

**Se calcula al PAGAR, no al generar.** `aplicarPagoAprobado` lee el plan de mayor cobertura con
`FOR UPDATE` (`planParaRenovar`), aplica `calcularRenovacion`, fija el vencimiento
(`fijarVencimientoPlan`) y **reescribe el período de la factura con el que de verdad compró**. El
período que pone `generarFacturaPeriodo` es solo una estimación con la misma regla: el cobro
automático sale 5 días antes de vencer y el cliente puede pagar días o semanas después.

Antes el pago fijaba el fin del período estimado con `GREATEST`, y aplicarlo dos veces daba igual.
Ahora suma, así que la protección contra doble aplicación es el bloqueo: `FOR UPDATE` sobre la
factura (el mismo pago no se aplica dos veces) y sobre el plan (dos pagos simultáneos no leen la
misma fecha). `extenderPlan` desapareció.

**Factura anulada:** generar el cobro de un período cuya factura se anuló la **reactiva** con el
precio y la pasarela actuales. Antes la referencia UNIQUE devolvía la anulada y ese período no se
podía volver a cobrar.

Pruebas: `__tests__/cobranza/renovacion.test.js`, con el ejemplo del dueño y los casos borde.

### El cliente elige su plan (2026-09-15)

`POST /admin/cobranza/mi-plan` — lo usa el ADMINISTRADOR del negocio desde «Mis pagos».

**Elegir no cambia el plan: lo deja pedido.** El plan elegido se guarda en
`cob_suscripcion.id_plan_solicitado` y solo se hace efectivo cuando se paga el cobro que lo lleva.
Cambiar `id_plan` al elegir sería regalar el plan nuevo, y además la generación automática
sincroniza la suscripción con el plan vigente del negocio: el cambio se habría borrado esa misma
madrugada. Por eso la sincronización respeta un plan solicitado pendiente.

Dos desenlaces, y la respuesta dice cuál fue:

| `aplica` | Cuándo | Qué pasa |
|---|---|---|
| `ahora` | Hay un cobro pendiente | Ese cobro pasa a valer el plan nuevo; pagarlo estrena plan |
| `proximo_cobro` | Está al día y no debe nada | Conserva el plan que pagó; el nuevo se cobra en la próxima mensualidad |

**`cob_factura.id_plan`** dice qué plan cobra cada factura, y es el que queda en el negocio al
pagarla. Sin esa columna, un cobro emitido por el Plan Avanzado se aplicaría contra el plan que
tuviera la suscripción el día del pago.

**Los planes gratuitos no se ofrecen ni se aceptan:** `listarPlanesParaCliente` filtra `precio > 0`,
así que la prueba de 7 días —que se asigna al registrar el negocio, no se elige— queda fuera.

Migración: `npm run migrate:cobranza-plan-solicitado`.

### Solo se cobra lo vencido, y el cobro aparece solo (2026-09-15)

Dos reglas que salieron de ver la base: el Salón Demo tenía un cobro pendiente de **mayo de 2027**
con su plan vigente hasta esa fecha, y un negocio con el plan vencido el 5 de septiembre no tenía
cobro porque el cron no había vuelto a correr.

**1. `DIAS_ANTICIPACION_COBRO = 5` es la única ventana del módulo.** La usan el cron, la generación
bajo demanda y «Generar cobro». Generar un cobro con el plan vigente más allá de esa ventana ahora
responde `PLAN_VIGENTE`, y el botón de la consola se apaga con el motivo en el tooltip. Antes el
super admin podía crearle un cobro a alguien que acababa de pagar, y al cliente le aparecía como
deuda en su portal. Un plan sin fecha de fin no se cobra: `PLAN_SIN_VENCIMIENTO`.

**2. `asegurarCobroPendiente` genera al CONSULTAR**, no solo a las 08:00. Al abrir «Mis pagos» o
`/pagar`, si el plan venció —o vence dentro de la ventana— y no hay cobro pendiente, se crea en ese
momento; y si el negocio no tenía suscripción de cobro, la estrena. Hacía falta porque poner a mano
una fecha de vencimiento pasada dejaba al cliente sin nada que pagar hasta el día siguiente, y
porque la mitad de los negocios de la base no tenían suscripción: la consulta ni siquiera los
miraba.

Es silenciosa: si no se puede generar (sin precio en su moneda, sin pasarela activa en su país,
suscripción cancelada) devuelve null y la consulta sigue. Una pantalla de pagos no debe caerse
porque falte configurar un precio. El cron sigue como red de seguridad para quien nunca entra.

### Tres ajustes de la interfaz (2026-09-15)

1. **Pagar es solo del administrador.** El aviso de plan vencido del dashboard ofrecía «Pagar plan»
   a cualquier rol, y `/admin/mis-pagos` está cerrado con `adminGuard(['ADMINISTRADOR'])`: el botón
   llevaba a un portazo. Ahora quien no administra ve «consulta al administrador del negocio», y el
   ítem «Mis pagos» del menú no se le muestra.
2. **«En gracia» se llama «Vencido».** Es vocabulario de cobranza, no del dueño de un restaurante:
   para él el plan está vencido y lo que importa es cuánto plazo le queda (`Vencido · 3 días de
   plazo`). El estado `VENCIDO` se distingue como «Vencidos sin acceso» en los filtros.
3. **Personal del negocio** en Negocios: un modal por negocio con quién trabaja ahí, su rol EN ese
   negocio, editar la ficha e inhabilitar/habilitar. Vive en su propio componente
   (`negocios/personal-negocio/`) porque `negocios.component` ya mezcla listado, alta y vigencia.
   Inhabilitar suspende al usuario en **todo** el sistema, no solo en ese negocio, y el modal lo
   advierte antes de hacerlo. Roles y contraseñas siguen en Usuarios, donde se ve a la persona
   completa.

Sigue sin existir: la generación automática de facturas para suscripciones **manuales** (hoy el
portal solo muestra lo que un super admin generó), el correo con el link a `/pagar`, la pantalla
de super admin para configurar suscripción y precios por moneda, y el débito automático — Wompi
necesita el widget de tokenización en el frontend, y dLocal su API de suscripciones, porque su token
de tarjeta **solo vive 15 minutos**.

---

## 7. Lo que este documento NO decide

1. **Precio para Chile.** CLP 9.900 es un ejemplo. Decisión comercial del dueño.
2. **Si la venta a Chile es exportación de servicios** (sin IVA colombiano) y qué se declara. Es
   pregunta de contadora, y es *nueva*: hasta hoy todos los clientes eran colombianos.
3. **IVA sobre las mensualidades.** Sigue aplazado exactamente como en
   [`obligaciones-escalapp.md`](obligaciones-escalapp.md) §2. Si algún día se causa, el diseño ya
   tiene `impuestos` en `cob_factura`; lo que no tiene es la respuesta.
4. **Si al pagarle a dLocal (proveedor del exterior) hay retención de IVA por importación de
   servicios.** Contadora.
5. **Descuento anual** (§2.4): la cuenta está hecha, la decisión no.
6. **Facturación electrónica propia.** Sigue siendo el punto 7 del plan de `obligaciones` §1 y este
   diseño solo deja el hueco (`numero_factura`, `cufe`).
7. **Tarifas negociadas.** Las de §2 son de lista. Wompi tiene plan Gateway al 0% desde 2.000
   transacciones/mes: irrelevante hoy, útil de recordar en dos años.

---

## 8. Fuentes

Consultadas el **2026-09-08**:

- Wompi — Planes y tarifas: <https://wompi.com/es/co/planes-tarifas/> · pagos recurrentes y
  tokenización: <https://docs.wompi.co/docs/en/fuentes-de-pago>
- dLocal Go — cobertura y tarifas: <https://dlocalgo.com/en/coverage> ·
  <https://dlocalgo.com/wp-content/uploads/2024/09/pricinglist.pdf>
- Mercado Pago — comisiones CO/CL (páginas oficiales de cada país)
- Flow Chile (RUT chileno obligatorio): <https://web.flow.cl/es-cl/ayuda/>
- Stripe: no disponible para empresas de Colombia ni Chile (verificado en fuentes secundarias
  2026 — **reconfirmar antes de descartarlo del todo**)
