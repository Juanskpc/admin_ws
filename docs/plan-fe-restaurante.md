# Plan de implementación: facturación electrónica en el restaurante (FE-2 → FE-3)

> **Creado el 2026-09-28.** Plan ejecutable por tareas, escrito para que un modelo pequeño pueda
> tomar **una tarea** y terminarla sin tener que decidir nada de arquitectura. Todas las decisiones
> ya están tomadas en §2. Si una tarea obliga a decidir algo que no está aquí, **no lo decidas: para
> y pregunta**.
>
> Documentos de fondo (léelos solo si una tarea lo pide): `docs/facturacion-electronica.md` (el
> porqué de todo), `docs/adr/ADR-026-facturacion-electronica.md`, `docs/adr/ADR-005-*.md`
> (independencia de verticales), `docs/adr/ADR-024-persistencia.md`.

---

## 0. Cómo usar este plan (léelo entero antes de la primera tarea)

### 0.1 Reglas de trabajo

1. **Una tarea a la vez, en el orden de §4.** Cada tarea dice de cuáles depende. No empieces una
   tarea cuyas dependencias no estén marcadas ✅ en la tabla de §3.
2. **Al terminar una tarea:** marca su casilla en §3 (⬜ → ✅), anota la fecha y el commit. Un
   commit por tarea, con mensaje `feat(facturacion): <ID> <resumen>` (p. ej.
   `feat(facturacion): R1.1 migración de emisión`).
3. **No cambies el alcance.** Si ves algo que se podría mejorar fuera de la tarea, apúntalo en §7
   («Notas del implementador») y sigue.
4. **No inventes códigos de la DIAN ni campos de Factus.** Todo código DIAN o campo de la API de
   Factus que uses tiene que salir de este plan, del script `scripts/factus_factura_prueba.js`, o de
   lo que registró la tarea R0 en §5. Si no está en ninguno de los tres: para y pregunta.
5. **Nunca llames a Factus de producción.** Solo `https://api-sandbox.factus.com.co`. El código
   de producción existe, pero en desarrollo se niega a usarse (decisión D15).
6. **Base de datos:** trabajas contra la compartida (`DB_PORT=5433`, túnel al VPS de desarrollo)
   salvo para correr la suite completa de jest, que va contra la local (`DB_PORT=5432`).
   Comprueba siempre antes de migrar: `grep -E '^DB_(HOST|PORT|NAME)=' .env`.
7. **Estilo:** Prettier `printWidth 100`, comillas simples, 4 espacios en backend (`admin_ws`),
   2 en los frontends. Comentarios en español, explicando el **porqué**, con la densidad del
   código de alrededor.

### 0.2 Convenciones del repo que aplican aquí (no las rompas)

| Tema | Regla |
|---|---|
| Respuestas HTTP | `Respuesta.success(res, 'Mensaje', data)` / `Respuesta.error(res, 'Mensaje', status, errores)` de `app_core/helpers/respuesta.js` |
| Errores de dominio | `const e = new Error('msg'); e.code = 'FE_ALGO'; e.statusCode = 409; throw e;` — el controlador los reenvía sin reescribir |
| Validación | `express-validator` en línea en `routes/index.js`; el controlador llama `validationResult(req)` al principio |
| Transacciones | Las funciones que escriben aceptan `{ transaction }` y lo pasan a cada consulta |
| Migraciones | Idempotentes: `IF NOT EXISTS`, comprobar `information_schema` antes de cada `ALTER`, registrar `migrate:<nombre>` en `package.json` |
| Tablas nuevas (esquema `facturacion`) | PK `uuid DEFAULT platform.uuid_generate_v7()` (NO `uuidv7()`: no existe en PG17), fechas `timestamptz`, `id_negocio integer` en cada tabla (ADR-024) |
| Tablas existentes (`restaurante.*`) | Siguen con `timestamp without time zone` en hora Bogotá. No las cambies |
| Angular | Signals (`signal`, `computed`, `asReadonly`), componentes standalone, `ChangeDetectionStrategy.OnPush` |

### 0.3 Comandos

```bash
# Backend (desde admin_ws/)
npm run migrate:facturacion-emision                       # tras R1.1
DB_PORT=5432 npx jest __tests__/facturacion --forceExit   # pruebas de facturación (base local)
npx jest __tests__/facturacion/construir_factura.test.js  # una sola suite (no toca base)

# Frontend restaurante (desde restaurante_app/)
npm test
npm run build

# Frontend admin (desde admin_app-v21/)
npm test
```

> `--forceExit` hace falta: la suite de jest no termina sola por un asa abierta en
> `__tests__/intelligence` (conocido, no es tuyo).

### 0.4 Variables de entorno que usa este plan

Ya existen en el `.env` de desarrollo (las usa `scripts/factus_factura_prueba.js`):
`FACTUS_CLIENT_ID`, `FACTUS_CLIENT_SECRET`, `FACTUS_USERNAME`, `FACTUS_PASSWORD` (sandbox) y
`WHATSAPP_TOKEN_KEY` (clave de cifrado, la reutilizamos, ver D2).

Nuevas (añádelas a `.env.example` en la tarea que las introduce):

| Variable | Defecto | Tarea |
|---|---|---|
| `FE_WORKER_ENABLED` | `true` | R4.4 |
| `FE_WORKER_CRON` | `* * * * *` (cada minuto) | R4.4 |
| `FE_ESPERA_MS` | `5000` | R4.3 |

---

## 1. Qué se construye, en una frase por pieza

Cuando un restaurante con facturación activa **cobra un pedido**, EscalApp genera una **factura
electrónica de venta** a través de **Factus** (a consumidor final, o a nombre del cliente si la
pide), la guarda con su CUFE, su PDF y su XML, y se la envía al cliente por correo. **La venta nunca
espera ni falla por culpa de la facturación**: si Factus o la DIAN no responden, el documento queda
en cola y un proceso lo reintenta.

Piezas:

```
restaurante_app (Angular)                admin_app-v21 (Angular, super admin)
  cobro: datos del comprador               configurar Factus por negocio
  Caja: pestaña «Facturas»                 (credenciales, rango, estado)
  Carta/Métodos de pago: campos fiscales
        │                                          │
        ▼                                          ▼
app_restaurante_api  ── hook tras el cobro ──▶  app_core/facturacion/   ◀── app_admin_api
  pedidoService.marcarPagado / cerrarOrden        emisionService  (encola, emite, reintenta)
  cajaService.anularOrdenCobrada (NC)             origenes/restaurante (lee el pedido)
                                                  construirFactura (cálculo puro)
                                                  proveedores/factus (HTTP a Factus)
                                                  emisionScheduler (cron cada minuto)
                                                        │
                                                        ▼
                                            esquema facturacion (Postgres)
```

**Fuera de este plan:** las demás verticales (FE-5), entrega por WhatsApp, notas débito, notas
crédito parciales, propina (el restaurante no la registra hoy), facturar la venta de tiqueteras,
RADIAN, nómina electrónica, y el cobro comercial de la feature (qué plan la incluye).

---

## 2. Decisiones ya tomadas (no las reabras)

| # | Decisión | Por qué, en corto |
|---|---|---|
| **D1** | Solo **Factus** y solo **factura electrónica de venta** (`document: '01'`), también a consumidor final (`222222222222`). **No hay tiquete POS.** | Factus no emite documento equivalente POS (verificado); la factura de venta para todo es legal (hace más de lo exigido). `facturacion-electronica.md` §8.2 |
| **D2** | **Una cuenta de Factus por negocio.** Credenciales en `facturacion.fe_configuracion.credenciales_cifradas`, cifradas con `app_core/helpers/credencialCifrada.js` (clave `WHATSAPP_TOKEN_KEY`). | Reunión Factus 2026-09-14: credencial propia por cliente, también en bolsa |
| **D3** | **Factus lleva el consecutivo.** Nosotros guardamos solo qué rango (`numbering_range_id`) usa cada negocio. | Invariante 3 de §6.2: un consecutivo reutilizado es irrecuperable |
| **D4** | **La facturación ocurre DESPUÉS del commit del cobro**, en su propia transacción. Un error de facturación se registra y **nunca** se propaga a la respuesta del cobro. Un **barrido de reconciliación** recoge los pedidos cobrados que quedaron sin documento. | ADR-005 (test del apagón): si facturación se cae, el restaurante sigue vendiendo |
| **D5** | Se factura cuando el pedido **queda cobrado**: en `marcarPagado` y en `cerrarOrden`. Las dos llaman al mismo gancho, que es **idempotente** (UNIQUE por pedido). | Un pedido puede cobrarse por cualquiera de los dos caminos |
| **D6** | **El precio de carta ya incluye el impuesto.** Neto = `redondear2(precio / (1 + tarifa/100))`. | Probado en sandbox el 2026-09-14: Factus devuelve la línea exacta al precio de carta |
| **D7** | Impuesto de cada línea: el del **producto** (`carta_producto.codigo_impuesto/tarifa_impuesto`) si lo tiene; si no, el **por defecto del negocio** (`fe_configuracion.impuesto_defecto_*`). Si el negocio **no es responsable** de IVA ni de INC (`gener_negocio_fiscal.responsable_iva = false AND responsable_inc = false`), **toda línea va sin impuesto**, diga lo que diga el producto. | El impuesto lo decide el contador del cliente, nunca el código |
| **D8** | El **domicilio** es una línea aparte «Servicio de domicilio», con el impuesto de `fe_configuracion.impuesto_domicilio_*` (defecto: sin impuesto). | Es un servicio distinto del plato; su tratamiento lo confirma el contador |
| **D9** | El **descuento** del pedido se reparte en el precio de las líneas (ver R3.2). R0 puede cambiar esto por un descuento explícito si Factus lo soporta limpio. | Es la única forma que seguro cuadra sin probar nada nuevo |
| **D10** | **Comprador opcional.** Sin datos → consumidor final. **Si el total supera 5 UVT** ($261.870 en 2026) **y no hay comprador**, el documento se crea en `PENDIENTE_DATOS` y **no se envía** hasta que la caja lo complete. La venta se cierra igual. | Por encima de 5 UVT la ley pide identificar al comprador; bloquear la venta rompería D4 |
| **D11** | `modo_facturacion` `POS` y `COMPLETO` **se comportan igual en el backend** (los dos emiten factura de venta en cada cobro). Solo cambia la interfaz: en `COMPLETO` la sección «Factura a nombre de» aparece desplegada. | Sin tiquete POS no hay otra diferencia real |
| **D12** | Un negocio factura si y solo si se cumplen **los cuatro interruptores** (ver `debeFacturar`, R4.1). | `facturacion-electronica.md` §4 |
| **D13** | Guardamos **payload enviado, respuesta, PDF y XML** en la base (`fe_documento`, `fe_documento_archivo`). | Factus no conserva nada si se elimina la cuenta (T&C §f.7) |
| **D14** | **Una emisión a la vez por negocio.** El reclamo del documento es atómico en la base (`UPDATE … WHERE estado IN (…) RETURNING`) y además hay un candado en memoria por negocio. | En Factus una factura pendiente de un negocio bloquea las siguientes (409) |
| **D15** | `ambiente = 'PRODUCCION'` **está prohibido si `NODE_ENV !== 'production'`**: el adaptador lanza `FE_AMBIENTE_PROHIBIDO`. | Una factura de prueba en producción quema un consecutivo real |
| **D16** | Puerta comercial: `features.estaHabilitado(idNegocio, 'facturacion_electronica')` (ya existe en `intelligence/core/features.js`). Ningún plan la incluye todavía; en desarrollo se enciende con `FEATURES_FORZADAS=facturacion_electronica`. | ADR-021: se pregunta por la feature, nunca por el nombre del plan |
| **D17** | **Nota crédito solo por anulación total**, disparada al anular un pedido cobrado. | Es el único caso de corrección que existe hoy en el restaurante |
| **D18** | `fe_documento` **no tiene `ON DELETE CASCADE`** hacia el negocio (`ON DELETE RESTRICT`), y un documento `ACEPTADO` no se puede modificar ni borrar (trigger). | Conservación legal ≥ 5 años; invariante 1 de §6.2 |
| **D20** | **No todo cobro se factura** (decisión del usuario, 2026-10-09; **corrige D5, D10 y D11**). Por defecto se factura **solo el cobro en el que el cajero lo pide**, con el interruptor «Factura electrónica» de la pantalla de cobro: **anónima** (consumidor final) o **con los datos del cliente**. El negocio que quiera facturarlo todo enciende `fe_configuracion.facturar_todo` (lo hace el super admin) y entonces vale lo que decía D5. | Un negocio con un paquete pequeño de documentos no puede gastarlo en cada venta |
| **D19** | Pedidos con pago por **Cuenta/Tiquetera** se facturan por el total del pedido igual que los demás; la parte pagada con la cuenta va con medio de pago «otro» (`ZZZ`). **La venta de la tiquetera en sí NO se factura** en este plan. | Pendiente de contador (§6); no bloquea |

---

## 3. Tablero de tareas

Marca ✅ al terminar, con fecha y hash corto del commit.

> **Todo lo marcado ✅ está en la rama `feature/facturacion-emision`** de los tres repos
> (`admin_ws`, `admin_app-v21`, `restaurante_app`), commiteado por fases y **sin subir ni
> desplegar**. Quedan R11.2 (espera una decisión) y R12.1 (el despliegue, que lo hace una persona).

| ID | Tarea | Depende de | Estado |
|---|---|---|---|
| **R0.1** | Script de sondeo contra el sandbox | — | ✅ 2026-10-08 |
| **R0.2** | Ejecutar el sondeo y registrar resultados en §5 | R0.1 | ✅ 2026-10-08 |
| **R1.1** | Migración `migrate:facturacion-emision` | — | ✅ 2026-10-08 |
| **R1.2** | Pruebas de la migración (inmutabilidad y unicidad) | R1.1 | ✅ 2026-10-08 |
| **R2.1** | Puerto de proveedores + registro | — | ✅ 2026-10-08 |
| **R2.2** | Adaptador Factus: token, llamada HTTP y clasificación | R2.1 | ✅ 2026-10-08 |
| **R2.3** | Adaptador Factus: traducir documento → JSON de Factus | R2.2, R0.2 | ✅ 2026-10-08 |
| **R2.4** | Pruebas del adaptador (fetch simulado) | R2.3 | ✅ 2026-10-08 |
| **R3.1** | Constantes (UVT, códigos) y validación del comprador | — | ✅ 2026-10-08 |
| **R3.2** | `construirFactura`: cálculo puro de líneas y totales | R3.1 | ✅ 2026-10-08 |
| **R3.3** | Pruebas de `construirFactura` | R3.2 | ✅ 2026-10-08 |
| **R4.1** | `configuracionDao` + `debeFacturar` | R1.1 | ✅ 2026-10-08 |
| **R4.2** | Origen restaurante: leer el pedido para facturarlo | R1.1 | ✅ 2026-10-08 |
| **R4.3** | `emisionService`: encolar, emitir, archivar | R2.4, R3.3, R4.1, R4.2 | ✅ 2026-10-08 |
| **R4.4** | `emisionScheduler`: reintentos y reconciliación | R4.3 | ✅ 2026-10-08 |
| **R4.5** | Script `fe_configurar_sandbox.js` (preparar un negocio de desarrollo) | R4.1 | ✅ 2026-10-08 |
| **R4.6** | Pruebas de `emisionService` (proveedor simulado) | R4.3 | ✅ 2026-10-08 |
| **R5.1** | Gancho en `marcarPagado` y `cerrarOrden` | R4.3 | ✅ 2026-10-08 |
| **R5.2** | Validadores del campo `factura` en las rutas de cobro | R5.1 | ✅ 2026-10-08 |
| **R5.3** | Prueba de punta a punta contra el sandbox | R5.2, R4.5 | ✅ 2026-10-08 |
| **R6.1** | API super admin: configuración de Factus por negocio | R4.1, R2.4 | ✅ 2026-10-08 |
| **R6.2** | Pantalla super admin en `admin_app-v21` | R6.1 | ✅ 2026-10-08 |
| **R7.1** | Campos fiscales del producto (API de carta) | R1.1 | ✅ 2026-10-08 |
| **R7.2** | Código DIAN del método de pago (API) | R1.1 | ✅ 2026-10-08 |
| **R7.3** | API restaurante `GET /facturacion/estado` | R4.1 | ✅ 2026-10-08 |
| **R7.4** | Frontend: campos fiscales en carta y métodos de pago | R7.1, R7.2 | ✅ 2026-10-08 |
| **R8.1** | Frontend: `FacturacionService` + componente «Factura a nombre de» | R7.3 | ✅ 2026-10-08 |
| **R8.2** | Frontend: enviar `factura` desde Pedidos, Mesas y Despacho | R8.1, R5.2 | ✅ 2026-10-08 |
| **R9.1** | API restaurante: listar, ver PDF, reintentar, completar comprador | R4.3 | ✅ 2026-10-08 |
| **R9.2** | Frontend: pestaña «Facturas» en Caja | R9.1 | ✅ 2026-10-08 |
| **R10.1** | Nota crédito al anular un pedido cobrado | R4.3, R0.2 | ✅ 2026-10-08 |
| **R11.1** | Alertas de rango y vigencia | R6.1 | ✅ 2026-10-08 |
| **R11.2** | Número, CUFE y QR en el comprobante impreso | R8.2 | ⏸ espera decisión (ver §7) |
| **R12.1** | Documentación y despliegue | todo lo anterior | ⬜ |

Tareas que se pueden hacer **en paralelo** desde el inicio: R0.1, R1.1, R2.1, R3.1.

---

## 4. Las tareas

Formato de cada tarea: **Objetivo · Archivos · Pasos · Aceptación · No hagas**.

---

### FASE R0 — Comprobar en el sandbox lo que todavía no sabemos

El script `scripts/factus_factura_prueba.js` ya probó: token, consulta de empresa y rangos, factura
a consumidor final con y sin INC 8%, precio de carta con impuesto incluido, recargo de propina,
descarga de PDF y XML, y borrar una factura no validada. **Léelo entero antes de R0.1: es el
modelo a copiar.**

Lo que falta saber, y por eso existe R0:

| Pregunta | Por qué importa |
|---|---|
| P1. ¿Qué pasa si se envía dos veces el mismo `reference_code`? | Define la idempotencia de los reintentos |
| P2. ¿Cómo se consulta una factura por `reference_code`? | Para saber si un envío que se cortó llegó o no |
| P3. ¿Acepta `payment_method_code: 'ZZZ'` (otro)? ¿Y `47`, `48`, `49`? | Medios de pago de D19 y R7.2 |
| P4. ¿Qué exige para un comprador **identificado** con cédula (`13`) y con NIT (`31`)? ¿Pide `municipality_id`, `tribute_id`, `address`? | Datos que hay que pedir en el cobro |
| P5. ¿Hay descuento explícito que cuadre al centavo (`discount_rate` por línea)? | Podría reemplazar el reparto de D9 |
| P6. ¿Cómo se emite una **nota crédito** de anulación total? | R10.1 |
| P7. ¿Cuánto dura el token (`expires_in`)? | Caché de tokens de R2.2 |

#### R0.1 — Script de sondeo

**Objetivo:** un script que responda P1–P7 contra el sandbox, sin tocar la base de datos.

**Archivos:** crear `admin_ws/scripts/factus_sondeo.js`.

**Pasos:**
1. Copia de `factus_factura_prueba.js` las funciones `pedirToken`, `api`, `leer`,
   `clasificarErrores`, `guardar` y la guarda de sandbox (`if (!BASE.startsWith(URL_SANDBOX))`).
   Guarda la salida en `tmp/factus/sondeo/`.
2. Implementa subcomandos, uno por pregunta (`node scripts/factus_sondeo.js <subcomando>`):
   - `referencia-repetida` (P1): emite una factura mínima con `reference_code` fijo
     `ESCALAPP-SONDEO-<Date.now()>`, y la vuelve a enviar **idéntica**. Imprime el HTTP y el
     `message` de las dos respuestas.
   - `buscar-referencia <ref>` (P2): prueba `GET /v2/bills?filter[reference_code]=<ref>` e imprime
     la respuesta completa. Si devuelve error, prueba `GET /v1/bills?filter[reference_code]=<ref>`.
   - `medios-pago` (P3): emite 4 facturas mínimas, cada una con un `payment_method_code` distinto:
     `ZZZ`, `47`, `48`, `49`. Imprime cuál se validó.
   - `comprador-cedula` y `comprador-nit` (P4): emite una factura con este `customer` (cédula):
     ```json
     { "identification_document_code": "13", "identification": "1000000009",
       "names": "Cliente Prueba", "email": "<tu correo>", "legal_organization_code": "2" }
     ```
     y con NIT:
     ```json
     { "identification_document_code": "31", "identification": "900123456", "dv": "8",
       "company": "Empresa Prueba SAS", "email": "<tu correo>", "legal_organization_code": "1" }
     ```
     Si Factus responde 422, imprime los errores, añade los campos que pida
     (`tribute_id`, `municipality_id`, `address`) y repite. Para `municipality_id`, consulta antes
     `GET /v1/municipalities?name=Medellín` e imprime la forma de la respuesta.
     > El DV `8` de `900123456` hay que comprobarlo con `calcularDv` de `app_core/helpers/nit.js`
     > antes de usarlo; si no da 8, usa el que dé.
   - `descuento-linea` (P5): dos líneas con INC 8% (22.000 × 2 y 6.500 × 1, precio de carta con
     impuesto como en `--redondeo`) y `discount_rate: '10.00'` en las dos. Imprime nuestro total
     calculado y el de Factus.
   - `nota-credito <numero_factura>` (P6): consulta primero la factura
     (`GET /v2/bills/show/<numero>`) para obtener su `id`, y emite una nota crédito de anulación
     total por `POST /v2/credit-notes/validate`. **Antes de escribir el cuerpo, lee la
     documentación de notas crédito de Factus** (`https://developers.factus.com.co`) y copia su
     ejemplo; imprime lo que respondió.
   - `token` (P7): imprime `expires_in` y si trae `refresh_token`.
3. Cada subcomando que emite: si la factura queda rechazada, bórrala al final con
   `DELETE /v2/bills/destroy/reference/<ref>` (como hace `--eliminar`), para no bloquear las
   siguientes.

**Aceptación:** `node scripts/factus_sondeo.js token` imprime `expires_in` sin errores; cada
subcomando deja su JSON en `tmp/factus/sondeo/`.

**No hagas:** no guardes credenciales en archivos; no uses la URL de producción; no escribas en la
base.

#### R0.2 — Ejecutar y registrar

**Objetivo:** que §5 de este plan tenga las respuestas a P1–P7.

**Pasos:** corre cada subcomando. Rellena la tabla de §5 con lo observado **literalmente** (HTTP,
mensaje, campos). Si una respuesta contradice una decisión de §2, **no cambies la decisión**:
escríbelo en §5 con ⚠️ y avisa.

**Aceptación:** las 7 filas de §5 tienen resultado. Copia también el resumen en
`docs/facturacion-electronica.md` como nueva sección `#### 9. Sondeo del sandbox (fecha)` dentro
de §8.2-quinquies.

---

### FASE R1 — El esquema

#### R1.1 — Migración `migrate:facturacion-emision`

**Objetivo:** crear las tablas de emisión, el trigger de inmutabilidad y dos columnas nuevas.

**Archivos:**
- crear `admin_ws/migrations/migrate_facturacion_emision.js`
- editar `admin_ws/package.json`: añadir
  `"migrate:facturacion-emision": "node migrations/migrate_facturacion_emision.js"` justo debajo de
  `"migrate:facturacion"`.

**Pasos:**
1. Copia la estructura de `migrations/migrate_facturacion_datos_fiscales.js`: comentario de
   cabecera, `require('dotenv').config()`, `Models`, las funciones `existeTabla` y `existeColumna`,
   `migrate()` con una sola transacción, y el `.then/.catch` final.
2. Dentro de la transacción, ejecuta **en este orden** el SQL siguiente (cópialo tal cual):

```sql
CREATE SCHEMA IF NOT EXISTS facturacion;

-- 1. Cómo emite cada negocio (1:1)
CREATE TABLE IF NOT EXISTS facturacion.fe_configuracion (
    id_negocio                 integer PRIMARY KEY
                               REFERENCES general.gener_negocio(id_negocio) ON DELETE RESTRICT,
    proveedor                  varchar(20)  NOT NULL DEFAULT 'FACTUS',
    ambiente                   varchar(12)  NOT NULL DEFAULT 'PRUEBAS',
    estado                     varchar(15)  NOT NULL DEFAULT 'SIN_CONFIGURAR',
    -- JSON {client_id, client_secret, username, password} cifrado con credencialCifrada.cifrar()
    credenciales_cifradas      text,
    -- Impuesto que se aplica a un producto que no tiene el suyo (D7)
    impuesto_defecto_codigo    varchar(4)   NOT NULL DEFAULT 'ZZ',
    impuesto_defecto_tarifa    numeric(5,2) NOT NULL DEFAULT 0,
    -- Impuesto de la línea de domicilio (D8)
    impuesto_domicilio_codigo  varchar(4)   NOT NULL DEFAULT 'ZZ',
    impuesto_domicilio_tarifa  numeric(5,2) NOT NULL DEFAULT 0,
    -- ¿Factus envía el correo al comprador cuando hay correo?
    enviar_correo              boolean      NOT NULL DEFAULT true,
    activado_en                timestamptz,
    activado_por               integer REFERENCES general.gener_usuario(id_usuario),
    creado_en                  timestamptz  NOT NULL DEFAULT now(),
    actualizado_en             timestamptz  NOT NULL DEFAULT now(),
    CONSTRAINT chk_fecfg_proveedor CHECK (proveedor IN ('FACTUS')),
    CONSTRAINT chk_fecfg_ambiente  CHECK (ambiente IN ('PRUEBAS','PRODUCCION')),
    CONSTRAINT chk_fecfg_estado    CHECK (estado IN ('SIN_CONFIGURAR','EN_PRUEBAS','ACTIVO','SUSPENDIDO'))
);

-- 2. Rangos de numeración, copiados del proveedor (el proveedor lleva el consecutivo, D3)
CREATE TABLE IF NOT EXISTS facturacion.fe_resolucion (
    id_resolucion       uuid PRIMARY KEY DEFAULT platform.uuid_generate_v7(),
    id_negocio          integer NOT NULL
                        REFERENCES general.gener_negocio(id_negocio) ON DELETE RESTRICT,
    id_rango_proveedor  integer NOT NULL,
    tipo_documento      varchar(4)  NOT NULL DEFAULT 'FV',
    prefijo             varchar(10),
    numero_resolucion   varchar(40),
    rango_desde         bigint,
    rango_hasta         bigint,
    consecutivo_actual  bigint,
    vigencia_desde      date,
    vigencia_hasta      date,
    vencida             boolean NOT NULL DEFAULT false,
    en_uso              boolean NOT NULL DEFAULT false,
    sincronizado_en     timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT chk_feres_tipo CHECK (tipo_documento IN ('FV','NC')),
    CONSTRAINT uq_feres_rango UNIQUE (id_negocio, id_rango_proveedor)
);
-- Un solo rango en uso por negocio y tipo de documento
CREATE UNIQUE INDEX IF NOT EXISTS uq_feres_en_uso
    ON facturacion.fe_resolucion (id_negocio, tipo_documento) WHERE en_uso;

-- 3. El documento fiscal (cabecera)
CREATE TABLE IF NOT EXISTS facturacion.fe_documento (
    id_documento          uuid PRIMARY KEY DEFAULT platform.uuid_generate_v7(),
    id_negocio            integer NOT NULL
                          REFERENCES general.gener_negocio(id_negocio) ON DELETE RESTRICT,
    tipo                  varchar(4)  NOT NULL,              -- FV factura de venta · NC nota crédito
    estado                varchar(16) NOT NULL DEFAULT 'EN_COLA',
    ambiente              varchar(12) NOT NULL,              -- copiado de fe_configuracion al crear
    proveedor             varchar(20) NOT NULL DEFAULT 'FACTUS',
    -- De qué venta salió. Texto y sin FK a propósito (ADR-005).
    origen_vertical       varchar(20) NOT NULL,              -- 'RESTAURANTE'
    origen_tipo           varchar(30) NOT NULL,              -- 'PEDIDO'
    origen_id             varchar(40) NOT NULL,              -- id_orden como texto
    origen_referencia     varchar(40),                       -- numero_orden, para mostrar
    -- Para una NC: la factura que anula
    id_documento_referencia uuid REFERENCES facturacion.fe_documento(id_documento),
    -- Lo que se le manda al proveedor como reference_code. Único en todo el sistema.
    codigo_referencia     varchar(60) NOT NULL,
    -- Instantáneas: nunca se releen de otra tabla después de crear el documento
    emisor                jsonb NOT NULL,
    adquiriente           jsonb NOT NULL,
    pagos                 jsonb NOT NULL DEFAULT '[]'::jsonb,
    subtotal              numeric(14,2) NOT NULL DEFAULT 0,  -- suma de bases (sin impuestos)
    total_impuestos       numeric(14,2) NOT NULL DEFAULT 0,
    total                 numeric(14,2) NOT NULL DEFAULT 0,
    ajuste_redondeo       numeric(8,2)  NOT NULL DEFAULT 0,  -- ver R3.2
    -- Lo que devuelve el proveedor
    numero                varchar(30),
    cufe                  varchar(200),
    fecha_validacion      timestamptz,
    url_publica           text,
    url_qr                text,
    -- Reintentos
    intentos              integer NOT NULL DEFAULT 0,
    proximo_intento_en    timestamptz,
    ultimo_error          text,
    -- Evidencia
    payload               jsonb,
    respuesta             jsonb,
    avisos                jsonb NOT NULL DEFAULT '[]'::jsonb,
    creado_por            integer REFERENCES general.gener_usuario(id_usuario),
    creado_en             timestamptz NOT NULL DEFAULT now(),
    actualizado_en        timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT chk_fedoc_tipo   CHECK (tipo IN ('FV','NC')),
    CONSTRAINT chk_fedoc_estado CHECK (estado IN
        ('PENDIENTE_DATOS','EN_COLA','ENVIANDO','ACEPTADO','RECHAZADO','ERROR','ANULADO')),
    CONSTRAINT chk_fedoc_ambiente CHECK (ambiente IN ('PRUEBAS','PRODUCCION')),
    CONSTRAINT uq_fedoc_referencia UNIQUE (codigo_referencia),
    -- Invariante 2: una venta se factura una sola vez
    CONSTRAINT uq_fedoc_origen UNIQUE (id_negocio, origen_vertical, origen_tipo, origen_id, tipo)
);
CREATE INDEX IF NOT EXISTS ix_fedoc_negocio_fecha
    ON facturacion.fe_documento (id_negocio, creado_en DESC);
CREATE INDEX IF NOT EXISTS ix_fedoc_pendientes
    ON facturacion.fe_documento (proximo_intento_en)
    WHERE estado IN ('EN_COLA','ERROR','ENVIANDO');

-- 4. Líneas
CREATE TABLE IF NOT EXISTS facturacion.fe_documento_linea (
    id_linea           bigserial PRIMARY KEY,
    id_documento       uuid NOT NULL REFERENCES facturacion.fe_documento(id_documento),
    id_negocio         integer NOT NULL,
    orden              integer NOT NULL,
    codigo             varchar(50) NOT NULL,
    descripcion        varchar(300) NOT NULL,
    cantidad           numeric(12,3) NOT NULL,
    precio_bruto       numeric(14,2) NOT NULL,  -- precio de carta, con impuesto
    precio_neto        numeric(14,2) NOT NULL,  -- sin impuesto, lo que se envía como price
    codigo_impuesto    varchar(4) NOT NULL,
    tarifa_impuesto    numeric(5,2) NOT NULL,
    base               numeric(14,2) NOT NULL,
    impuesto           numeric(14,2) NOT NULL,
    total              numeric(14,2) NOT NULL,
    unidad_medida      varchar(10) NOT NULL,
    es_domicilio       boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS ix_felinea_documento ON facturacion.fe_documento_linea (id_documento);

-- 5. Bitácora de llamadas al proveedor
CREATE TABLE IF NOT EXISTS facturacion.fe_intento (
    id_intento     bigserial PRIMARY KEY,
    id_documento   uuid NOT NULL REFERENCES facturacion.fe_documento(id_documento),
    id_negocio     integer NOT NULL,
    iniciado_en    timestamptz NOT NULL DEFAULT now(),
    duracion_ms    integer,
    http_status    integer,
    resultado      varchar(24) NOT NULL,
    mensaje        text,
    respuesta      jsonb
);
CREATE INDEX IF NOT EXISTS ix_feintento_documento ON facturacion.fe_intento (id_documento);

-- 6. Copia propia del PDF y el XML (D13)
CREATE TABLE IF NOT EXISTS facturacion.fe_documento_archivo (
    id_documento   uuid NOT NULL REFERENCES facturacion.fe_documento(id_documento),
    tipo           varchar(3) NOT NULL,
    contenido      bytea NOT NULL,
    bytes          integer NOT NULL,
    sha256         char(64) NOT NULL,
    descargado_en  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (id_documento, tipo),
    CONSTRAINT chk_fearch_tipo CHECK (tipo IN ('PDF','XML'))
);

-- 7. Inmutabilidad (invariante 1, D18)
CREATE OR REPLACE FUNCTION facturacion.fe_documento_inmutable() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        IF OLD.estado = 'ACEPTADO'
           AND coalesce(current_setting('facturacion.permitir_borrado_pruebas', true), '') <> 'on' THEN
            RAISE EXCEPTION 'FE_DOCUMENTO_INMUTABLE: el documento % fue aceptado y no se puede borrar',
                OLD.id_documento;
        END IF;
        RETURN OLD;
    END IF;
    IF OLD.estado = 'ACEPTADO' AND (
           NEW.estado      IS DISTINCT FROM OLD.estado
        OR NEW.total       IS DISTINCT FROM OLD.total
        OR NEW.numero      IS DISTINCT FROM OLD.numero
        OR NEW.cufe        IS DISTINCT FROM OLD.cufe
        OR NEW.adquiriente IS DISTINCT FROM OLD.adquiriente
        OR NEW.emisor      IS DISTINCT FROM OLD.emisor
        OR NEW.payload     IS DISTINCT FROM OLD.payload
        OR NEW.respuesta   IS DISTINCT FROM OLD.respuesta) THEN
        RAISE EXCEPTION 'FE_DOCUMENTO_INMUTABLE: el documento % fue aceptado y no se puede modificar',
            OLD.id_documento;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_fe_documento_inmutable ON facturacion.fe_documento;
CREATE TRIGGER trg_fe_documento_inmutable
    BEFORE UPDATE OR DELETE ON facturacion.fe_documento
    FOR EACH ROW EXECUTE FUNCTION facturacion.fe_documento_inmutable();
```

3. Después, las dos columnas nuevas en tablas existentes, **cada una con `existeColumna` antes**:
   - `restaurante.rest_metodo_pago.codigo_medio_pago_dian varchar(3)` (NULL permitido; NULL se
     envía como `ZZZ`, ver R3.1).
   - Nada más: las columnas fiscales de `restaurante.carta_producto` ya existen desde FE-1
     (`codigo_impuesto`, `tarifa_impuesto`, `unidad_medida_dian`, `codigo_producto`).
4. Al final, imprime un resumen como el de la migración de FE-1.

**Aceptación:**
- `npm run migrate:facturacion-emision` corre sin errores **dos veces seguidas** contra la base
  compartida.
- `psql` → `\dt facturacion.*` muestra 7 tablas (`fe_impuesto` + las 6 nuevas).

**No hagas:** no uses `uuidv7()`; no pongas `ON DELETE CASCADE` en `fe_documento`; no crees un
modelo Sequelize para estas tablas (el módulo usa SQL con `Models.sequelize.query`, como
`datosFiscales.js`).

#### R1.2 — Pruebas de la migración

**Archivos:** crear `admin_ws/__tests__/facturacion/esquema_emision.test.js`.

**Pasos:** copia el `beforeAll`/`afterAll` de `__tests__/facturacion/datos_fiscales.test.js`
(crea un negocio «TEST FE-2 (borrar)»). Casos:
1. Insertar un `fe_documento` mínimo (`tipo 'FV'`, `ambiente 'PRUEBAS'`, `origen_*`,
   `codigo_referencia`, `emisor '{}'`, `adquiriente '{}'`) → ok.
2. Insertar otro con el mismo `(id_negocio, origen_vertical, origen_tipo, origen_id, tipo)` →
   falla con el nombre `uq_fedoc_origen`.
3. Ponerle `estado='ACEPTADO'` → ok. Luego cambiar `total` → falla con `FE_DOCUMENTO_INMUTABLE`.
4. Con `ACEPTADO`, cambiar `proximo_intento_en` → **sí** se permite (no es un campo fiscal).
5. `DELETE` de un aceptado → falla. Con
   `await sequelize.query("SET LOCAL facturacion.permitir_borrado_pruebas = 'on'", { transaction: t })`
   dentro de una transacción → se borra.

En `afterAll`, borra en orden: `fe_intento`, `fe_documento_linea`, `fe_documento_archivo`,
`fe_documento` (con el `SET LOCAL` de arriba), `gener_negocio_fiscal`, `gener_negocio`.

**Aceptación:** `DB_PORT=5432 npx jest __tests__/facturacion/esquema_emision.test.js --forceExit`
en verde (migra antes la base local).

---

### FASE R2 — El adaptador de Factus

Todo en `admin_ws/app_core/facturacion/proveedores/`. Sigue la forma de `app_core/cobranza/`
(un `index.js` que registra adaptadores y `adapters/*.js`).

#### R2.1 — Puerto y registro

**Archivos:** crear `app_core/facturacion/proveedores/index.js`.

**Contenido:** un comentario JSDoc que documente el **puerto** (la interfaz que todo adaptador
cumple) y un registro:

```js
'use strict';
/**
 * Puerto de proveedores de facturación electrónica.
 *
 * Todo adaptador exporta:
 *   codigo: string                                   'FACTUS'
 *   probarConexion({ credenciales, ambiente })       → { nit, dv, razon_social }
 *   listarRangos({ credenciales, ambiente })         → [RangoProveedor]
 *   emitirFactura({ credenciales, ambiente, documento, lineas, idRango, enviarCorreo })
 *                                                    → ResultadoEmision
 *   consultarPorReferencia({ credenciales, ambiente, codigoReferencia })
 *                                                    → ResultadoEmision | null (null = no existe)
 *   eliminarPendiente({ credenciales, ambiente, codigoReferencia }) → void
 *   descargarArchivo({ credenciales, ambiente, numero, tipo: 'PDF'|'XML' }) → Buffer
 *   emitirNotaCredito({ credenciales, ambiente, documento, lineas, facturaReferencia, idRango })
 *                                                    → ResultadoEmision          (R10.1)
 *
 * ResultadoEmision = {
 *   resultado: 'ACEPTADO' | 'PENDIENTE_DIAN' | 'RECHAZADO' | 'BLOQUEADO_PENDIENTE'
 *            | 'ERROR_CREDENCIALES' | 'ERROR_PROVEEDOR' | 'ERROR_RED',
 *   httpStatus: number | null,
 *   numero, cufe, fechaValidacion, urlPublica, urlQr,   // null salvo ACEPTADO
 *   avisos: [{ codigo, mensaje }], rechazos: [{ codigo, mensaje }],
 *   payload: object,      // lo que se envió (sin credenciales)
 *   respuesta: object,    // lo que contestó, tal cual
 *   mensaje: string,      // una frase legible para una persona
 * }
 *
 * RangoProveedor = { id, prefijo, desde, hasta, actual, resolucion,
 *                    vigenciaDesde, vigenciaHasta, vencido, tipoDocumento }
 *
 * Los adaptadores NO tocan la base de datos. Reciben todo por parámetro y devuelven datos.
 */
const factus = require('./factus');

const ADAPTADORES = new Map([[factus.codigo, factus]]);

function getProveedor(codigo) {
    const a = ADAPTADORES.get(codigo);
    if (!a) {
        const e = new Error(`Proveedor de facturación desconocido: ${codigo}`);
        e.code = 'FE_PROVEEDOR_DESCONOCIDO';
        e.statusCode = 500;
        throw e;
    }
    return a;
}

module.exports = { getProveedor };
```

**Aceptación:** `node -e "require('./app_core/facturacion/proveedores').getProveedor('FACTUS')"`
no falla (después de R2.2).

#### R2.2 — Factus: token, HTTP y clasificación

**Archivos:** crear `app_core/facturacion/proveedores/factus.js`.

**Pasos:**
1. Constantes:
   ```js
   const URL = { PRUEBAS: 'https://api-sandbox.factus.com.co', PRODUCCION: 'https://api.factus.com.co' };
   const TIMEOUT_MS = 8000;
   ```
2. `baseUrl(ambiente)`: si `ambiente === 'PRODUCCION' && process.env.NODE_ENV !== 'production'`
   lanza error tipado `FE_AMBIENTE_PROHIBIDO` (500) — D15. Si el ambiente no es uno de los dos,
   `FE_AMBIENTE_INVALIDO`.
3. **Caché de tokens en memoria:** `const tokens = new Map()` con clave
   `` `${ambiente}:${credenciales.username}` `` y valor `{ token, venceEn }` (milisegundos). En
   `obtenerToken(credenciales, ambiente)`: si hay token y le quedan > 60 s, devuélvelo; si no, pide
   uno con el mismo cuerpo que `pedirToken()` del script (grant `password`, `x-www-form-urlencoded`)
   y guarda `venceEn = Date.now() + expires_in * 1000`. Si falla, lanza `FE_CREDENCIALES_INVALIDAS`
   (401 hacia afuera se traduce en R4, aquí solo el error tipado). **Nunca** incluyas
   `client_secret` ni `password` en el mensaje del error ni en un `console.log`.
4. `llamar({ credenciales, ambiente, metodo, ruta, json })`:
   - usa `fetch` con `AbortController` y `TIMEOUT_MS`;
   - si responde 401, borra el token de la caché, pide otro y repite **una sola vez**;
   - devuelve `{ status, cuerpo }`; si `fetch` lanza (red, timeout), devuelve
     `{ status: null, cuerpo: null, errorRed: err.message }` — **no lances**.
   - `leer()` igual que en el script (JSON o `{ crudo }`).
5. `clasificar({ status, cuerpo, errorRed })` → `ResultadoEmision` parcial, con estas reglas **en
   este orden** (salen del script y de §8.2-quinquies punto 7):

   | Condición | `resultado` |
   |---|---|
   | `errorRed` | `ERROR_RED` |
   | `status === 401` (tras el reintento) | `ERROR_CREDENCIALES` |
   | `status === 409` | `BLOQUEADO_PENDIENTE` (hay una factura pendiente en Factus) |
   | `status === 400` o `422` | `RECHAZADO` (Factus rechazó por validación) |
   | `status >= 500` o `429` | `ERROR_PROVEEDOR` |
   | 2xx y `clasificarErrores(data.errors).rechazos.length > 0` | `RECHAZADO` |
   | 2xx y `data.is_validated` falso | `PENDIENTE_DIAN` |
   | 2xx y `data.is_validated` verdadero | `ACEPTADO` |

   Para `ACEPTADO` rellena: `numero = data.number`, `cufe = data.cufe`,
   `fechaValidacion = data.validated_at`, `urlPublica = data.links?.public_url`,
   `urlQr = data.links?.qr`. En todos, `avisos` y `rechazos` como arrays
   `[{ codigo, mensaje }]` a partir de `clasificarErrores`, `respuesta = cuerpo` y un `mensaje`
   legible en español (p. ej. «Factus no responde; se reintentará»).
6. `probarConexion`: `GET /v2/companies` → `{ nit, dv, razon_social }` (campos `nit`, `dv`,
   `company || names || trade_name`, como en el script).
7. `listarRangos`: `GET /v2/numbering-ranges?filter[document]=21&filter[is_active]=1` (igual que
   el script) → `RangoProveedor[]` (`tipoDocumento: 'FV'`, `vencido: Boolean(Number(x.is_expired))`,
   `desde: x.from`, `hasta: x.to`, `actual: x.current`, `prefijo: x.prefix`,
   `vigenciaHasta: x.end_date`, `vigenciaDesde: x.start_date ?? null`,
   `resolucion: x.resolution_number ?? null`). Acepta las dos formas de lista que maneja el script
   (`data` o `data.data`).
8. `eliminarPendiente`: `DELETE /v2/bills/destroy/reference/<ref>`.
9. `descargarArchivo`: `GET /v2/bills/<numero>/download-pdf` (campo `pdf_base_64_encoded`) o
   `download-xml` (campo `xml_base_64_encoded`) → `Buffer.from(b64, 'base64')`. Si no viene el
   campo, lanza `FE_ARCHIVO_NO_DISPONIBLE` (502).
10. `consultarPorReferencia`: con lo que haya encontrado R0.2 (P2). Devuelve `null` si no existe,
    o un `ResultadoEmision` clasificado con las mismas reglas. **Si R0.2 no encontró forma de
    consultar**, implementa la función devolviendo `undefined` y escribe en §7 que el reintento
    va a ciegas.

**No hagas:** no leas `process.env.FACTUS_*` aquí (las credenciales llegan por parámetro; esas
variables son solo del script y de R4.5); no toques la base de datos.

#### R2.3 — Factus: traducir documento → JSON

**Objetivo:** la función que convierte **nuestro** documento neutro (el que guarda `fe_documento`)
en el cuerpo de `POST /v2/bills/validate`, y `emitirFactura` que lo envía.

**Archivos:** `app_core/facturacion/proveedores/factus.js` (mismo archivo).

**Pasos:**
1. `traducirFactura({ documento, lineas, idRango, enviarCorreo })` → objeto JSON:
   ```js
   {
       reference_code: documento.codigo_referencia,
       document: '01',                 // factura electrónica de venta (D1)
       operation_type: '10',           // estándar
       numbering_range_id: idRango,    // D3
       send_email: enviarCorreo && Boolean(documento.adquiriente.correo),
       observation: `Pedido ${documento.origen_referencia}`,
       payment_details: documento.pagos.map((p) => ({
           payment_form: '1',                    // contado
           payment_method_code: p.codigo_dian,   // R3.1 garantiza que viene
           amount: txt(p.valor),
       })),
       customer: traducirComprador(documento.adquiriente),
       items: lineas.map((l) => ({
           code_reference: l.codigo,
           name: l.descripcion,
           quantity: txt(l.cantidad),
           discount_rate: '0.00',
           price: txt(l.precio_neto),
           unit_measure_code: l.unidad_medida,
           standard_code: '999',
           taxes: l.codigo_impuesto === 'ZZ'
               ? [{ is_excluded: true }]
               : [{ code: l.codigo_impuesto, rate: txt(l.tarifa_impuesto) }],
       })),
   }
   ```
   `txt(n)` = `(Math.round(n * 100) / 100).toFixed(2)`, como en el script.
2. `traducirComprador(a)`:
   - consumidor final (`a.consumidor_final === true`): exactamente el `customer` del script
     (`'13'`, `'222222222222'`, `'Consumidor Final'`, `legal_organization_code: '2'`).
   - identificado: con los campos que R0.2 (P4) confirmó para cédula y para NIT. Base mínima:
     `identification_document_code: a.tipo_documento`, `identification: a.numero_documento`,
     `dv` solo si es `'31'`, `names` (persona natural) o `company` (jurídica),
     `legal_organization_code: a.tipo_persona`, `email: a.correo` si hay, `phone: a.telefono` si
     hay, `address: a.direccion` si hay. **Añade solo los campos extra que R0.2 dejó registrados.**
3. `emitirFactura(args)`: `payload = traducirFactura(args)`; `llamar POST /v2/bills/validate`;
   `clasificar`; devuelve el resultado con `payload` incluido.

**Aceptación:** con el documento de ejemplo de R3.3, `traducirFactura` produce un JSON con la misma
forma que el `enviado` que guardó el script en `tmp/factus/*.json`.

#### R2.4 — Pruebas del adaptador

**Archivos:** crear `__tests__/facturacion/proveedor_factus.test.js`. **No usa base de datos.**

**Pasos:** reemplaza `global.fetch` con `jest.fn()` en `beforeEach` y restáuralo en `afterEach`.
Casos mínimos:
1. `clasificar` para cada fila de la tabla de R2.2 (7 casos), usando cuerpos copiados de las
   respuestas reales de `tmp/factus/` (pega en el test un JSON recortado; no leas archivos).
2. Un 401 seguido de token nuevo y 200 → `ACEPTADO`, y `fetch` llamado 4 veces (token, 401,
   token, 200).
3. Dos emisiones seguidas reutilizan el token (una sola llamada a `/oauth/token`).
4. `fetch` que lanza `AbortError` → `ERROR_RED`, sin excepción.
5. `ambiente: 'PRODUCCION'` con `NODE_ENV=test` → lanza `FE_AMBIENTE_PROHIBIDO` y `fetch` no se
   llama.
6. `traducirFactura` con consumidor final → `customer.identification === '222222222222'`.
7. Ningún mensaje de error contiene el `password` ni el `client_secret` de las credenciales de
   prueba.

**Aceptación:** `npx jest __tests__/facturacion/proveedor_factus.test.js` en verde.

---

### FASE R3 — El cálculo (funciones puras, sin base ni red)

#### R3.1 — Constantes y comprador

**Archivos:** crear `app_core/facturacion/constantes.js` y `app_core/facturacion/comprador.js`.

**`constantes.js`:**
```js
'use strict';
/** Valor de la UVT por año (resolución DIAN de cada año). Añadir el año nuevo cada diciembre. */
const UVT_POR_ANIO = { 2026: 52374 };
/** Por encima de 5 UVT hay que identificar al comprador (D10). */
const TOPE_UVT_CONSUMIDOR_FINAL = 5;

function topeConsumidorFinal(fecha = new Date()) {
    const anio = Number(
        new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota', year: 'numeric' }).format(fecha)
    );
    const uvt = UVT_POR_ANIO[anio];
    if (!uvt) {
        const ultimo = Math.max(...Object.keys(UVT_POR_ANIO).map(Number));
        console.warn(`[facturacion] Falta la UVT de ${anio}; se usa la de ${ultimo}.`);
        return UVT_POR_ANIO[ultimo] * TOPE_UVT_CONSUMIDOR_FINAL;
    }
    return uvt * TOPE_UVT_CONSUMIDOR_FINAL;
}

/** Medios de pago DIAN que ofrecemos en la pantalla de métodos de pago (R7.2). */
const MEDIOS_PAGO_DIAN = [
    { codigo: '10', nombre: 'Efectivo' },
    { codigo: '47', nombre: 'Transferencia' },
    { codigo: '48', nombre: 'Tarjeta crédito' },
    { codigo: '49', nombre: 'Tarjeta débito' },
    { codigo: 'ZZZ', nombre: 'Otro' },
];
const MEDIO_PAGO_POR_DEFECTO = 'ZZZ';

/** Unidad de medida por defecto de un plato: '94' = unidad (probado en sandbox). */
const UNIDAD_POR_DEFECTO = '94';

const CONSUMIDOR_FINAL = Object.freeze({
    consumidor_final: true,
    tipo_persona: '2',
    tipo_documento: '13',
    numero_documento: '222222222222',
    nombres: 'Consumidor Final',
});

module.exports = {
    UVT_POR_ANIO, TOPE_UVT_CONSUMIDOR_FINAL, topeConsumidorFinal,
    MEDIOS_PAGO_DIAN, MEDIO_PAGO_POR_DEFECTO, UNIDAD_POR_DEFECTO, CONSUMIDOR_FINAL,
};
```
> Si R0.2 (P3) muestra que Factus **no** acepta `ZZZ`, cambia `MEDIO_PAGO_POR_DEFECTO` a `'10'` y
> quita `ZZZ` de la lista. Anótalo en §7.

**`comprador.js`:** exporta `normalizarComprador(entrada)`:
- `entrada` null/undefined → devuelve `null` (se decidirá consumidor final más tarde).
- Campos aceptados: `tipo_persona` (`'1'|'2'`), `tipo_documento` (`'13'` cédula, `'31'` NIT,
  `'22'` cédula de extranjería, `'41'` pasaporte), `numero_documento`, `dv`, `razon_social`,
  `nombres`, `correo`, `telefono`, `direccion`.
- Normaliza `numero_documento` con `normalizarDocumento` de `app_core/helpers/nit.js`.
- Si `tipo_documento === '31'`: si no viene `dv` lo calcula con `calcularDv`; si viene y
  `esDvValido` es falso, lanza `FE_COMPRADOR_INVALIDO` (422) con el mensaje
  «El dígito de verificación no corresponde al NIT (debería ser X)».
- `tipo_persona === '1'` exige `razon_social`; `'2'` exige `nombres`. Si falta, `FE_COMPRADOR_INVALIDO`.
- `correo`, si viene, debe pasar `/^[^\s@]+@[^\s@]+\.[^\s@]+$/`.
- Devuelve el objeto limpio con `consumidor_final: false`.

#### R3.2 — `construirFactura`

**Archivos:** crear `app_core/facturacion/construirFactura.js`.

**Firma:**
```js
/**
 * @param {object} p
 * @param {Array<{codigo, descripcion, cantidad, precio_bruto, codigo_impuesto, tarifa_impuesto, unidad_medida}>} p.items
 *        Las líneas del pedido. precio_bruto es el precio de carta (con impuesto incluido, D6).
 *        codigo_impuesto/tarifa_impuesto YA resueltos (D7 lo resuelve el origen, R4.2).
 * @param {number} p.domicilio        valor del domicilio (0 si no hay)
 * @param {{codigo, tarifa}} p.impuestoDomicilio
 * @param {number} p.descuento        descuento total del pedido (0 si no hay)
 * @param {number} p.totalPedido      pedid_orden.total — lo que el cliente pagó
 * @param {Array<{codigo_dian, valor}>} p.pagos
 * @returns {{ lineas, subtotal, total_impuestos, total, pagos, ajuste_redondeo }}
 */
function construirFactura(p) { … }
```

**Algoritmo (sigue los pasos exactos; `r2(x) = Math.round(x * 100) / 100`):**
1. Si `domicilio > 0`, añade al final de `items` una línea
   `{ codigo: 'DOMICILIO', descripcion: 'Servicio de domicilio', cantidad: 1, precio_bruto: domicilio, codigo_impuesto: impuestoDomicilio.codigo, tarifa_impuesto: impuestoDomicilio.tarifa, unidad_medida: '94', es_domicilio: true }`.
2. **Descuento (D9):** `bruto = Σ cantidad × precio_bruto` de todas las líneas (incluido
   domicilio). Si `descuento > 0`: `factor = 1 - descuento / bruto`, y para cada línea
   `precio_bruto = r2(precio_bruto × factor)`. Si `descuento >= bruto`, lanza
   `FE_DESCUENTO_TOTAL` (422): un pedido regalado no se factura así (anótalo; no pasa hoy).
3. Por cada línea:
   - `precio_neto = tarifa > 0 ? r2(precio_bruto / (1 + tarifa / 100)) : precio_bruto`
   - `base = r2(cantidad × precio_neto)`
   - `impuesto = r2(base × tarifa / 100)`
   - `total = r2(base + impuesto)`
4. `subtotal = r2(Σ base)`, `total_impuestos = r2(Σ impuesto)`, `total = r2(subtotal + total_impuestos)`.
5. **Pagos:** copia `pagos`. `diferencia = r2(total − Σ pagos.valor)`. Si `diferencia !== 0`:
   - si `|diferencia| > 1 × número de líneas` (más de un peso por línea), lanza
     `FE_TOTALES_NO_CUADRAN` (500) con los dos números en el mensaje: es un bug, no redondeo;
   - si no, suma `diferencia` al pago de **mayor valor** y devuelve `ajuste_redondeo = diferencia`.
6. Devuelve `{ lineas, subtotal, total_impuestos, total, pagos, ajuste_redondeo }` con cada línea
   enriquecida con `orden` (1, 2, 3…), `precio_neto`, `base`, `impuesto`, `total`, `es_domicilio`.

**No hagas:** no leas la base, no leas fechas, no llames a Factus. Esta función recibe números y
devuelve números.

#### R3.3 — Pruebas de `construirFactura` y `comprador`

**Archivos:** crear `__tests__/facturacion/construir_factura.test.js` y
`__tests__/facturacion/comprador.test.js`. Sin base de datos.

**Casos obligatorios de `construirFactura`** (los números salen del sandbox, §8.2-quinquies punto 7):
1. **INC 8% con precio incluido:** hamburguesa 2 × 22.000 y limonada 1 × 6.500, tarifa 8, pago
   único de 50.500 → `precio_neto` 20.370,37 y 6.018,52; `subtotal` 46.759,26;
   `total_impuestos` 3.740,74; `total` 50.500,00; `ajuste_redondeo` 0.
2. **Sin impuesto:** 2 × 20.000 y 1 × 6.000, `ZZ` 0 → `total` 46.000, `total_impuestos` 0.
3. **Domicilio** 5.000 sin impuesto sobre el caso 2 → 3 líneas, la última `es_domicilio`,
   `total` 51.000.
4. **Descuento** 4.600 sobre el caso 2 (10%) → cada `precio_bruto` baja 10% y `total` 41.400.
5. **Multipago** 30.000 + 16.000 en el caso 2 → pagos intactos.
6. **Redondeo:** 3 × 7.333 con INC 8%, pago único de 21.999 → `precio_neto` 6.789,81, `subtotal`
   20.369,43, `total_impuestos` 1.629,55, `total` 21.998,98; el pago queda en 21.998,98 y
   `ajuste_redondeo` es −0,02.
7. **Descuadre grave:** pagos que suman 1.000 menos → lanza `FE_TOTALES_NO_CUADRAN`.

**`comprador.test.js`:** NIT `800197268` sin DV → DV `4`; con DV `5` → `FE_COMPRADOR_INVALIDO`;
persona jurídica sin razón social → error; correo inválido → error; `null` → `null`.

---

### FASE R4 — El servicio de emisión

#### R4.1 — Configuración y `debeFacturar`

**Archivos:** crear `app_core/facturacion/configuracionDao.js`.

**Funciones (todas aceptan `{ transaction }` como último argumento):**
- `obtener(idNegocio)` → fila de `fe_configuracion` o `null`. **Nunca** devuelve
  `credenciales_cifradas` tal cual: devuelve la fila sin ese campo y con
  `tiene_credenciales: boolean`.
- `obtenerCredenciales(idNegocio)` → objeto descifrado
  (`JSON.parse(credencialCifrada.descifrar(fila.credenciales_cifradas))`) o lanza
  `FE_SIN_CREDENCIALES` (409).
- `guardar(idNegocio, campos)` → upsert (`INSERT … ON CONFLICT (id_negocio) DO UPDATE`), lista
  blanca: `ambiente`, `impuesto_defecto_codigo`, `impuesto_defecto_tarifa`,
  `impuesto_domicilio_codigo`, `impuesto_domicilio_tarifa`, `enviar_correo`. Si `campos.credenciales`
  viene, cifra `JSON.stringify(credenciales)` y guarda en `credenciales_cifradas`. Actualiza
  `actualizado_en = now()`. Valida los códigos de impuesto contra `facturacion.fe_impuesto`
  (`codigo`, `tarifa`, `estado='A'`); si no existe la combinación, `FE_IMPUESTO_INVALIDO` (422).
- `cambiarEstado(idNegocio, estado, idUsuario)` → si pasa a `EN_PRUEBAS` o `ACTIVO` exige:
  credenciales, un rango `en_uso` en `fe_resolucion` y `datosFiscales.puedeEmitir(idNegocio).puede`.
  Si falta algo, `FE_NO_LISTO` (409) con la lista de lo que falta en el mensaje. Al pasar a
  `ACTIVO` o `EN_PRUEBAS` por primera vez, fija `activado_en = now()` y `activado_por`.
- `rangoEnUso(idNegocio, tipo = 'FV')` → fila de `fe_resolucion` con `en_uso` o `null`.
- `guardarRangos(idNegocio, rangos)` → upsert por `(id_negocio, id_rango_proveedor)` sin tocar
  `en_uso`; actualiza `sincronizado_en`.
- `usarRango(idNegocio, idResolucion)` → en una transacción: pone `en_uso=false` en todos los del
  negocio y tipo, y `true` en el elegido. Si el elegido está `vencida`, `FE_RANGO_VENCIDO` (409).
- **`debeFacturar(idNegocio)`** → `{ facturar: boolean, motivo: string|null, config }`. Comprueba en
  este orden y devuelve el primer motivo que falle:
  1. `features.estaHabilitado(idNegocio, 'facturacion_electronica')` → si no: `SIN_FEATURE`
     (importa `features` desde `../../intelligence/core/features`, como hace `pedidoService`).
  2. `datosFiscales.obtener(idNegocio).modo_facturacion !== 'NINGUNO'` → si no: `MODO_NINGUNO`.
  3. `datosFiscales.puedeEmitir(idNegocio).puede` → si no: `DATOS_INCOMPLETOS`.
  4. `config.estado` es `EN_PRUEBAS` o `ACTIVO` → si no: `NO_ACTIVO`.

**Aceptación:** cubierto por R4.6.

#### R4.2 — Origen restaurante

**Objetivo:** leer un pedido cobrado y devolverlo en el formato de `construirFactura`. Vive en el
módulo de facturación y **lee con SQL crudo**, sin importar `pedidoService` (evita un ciclo y
mantiene la vertical sin saber de facturación — ADR-005).

**Archivos:** crear `app_core/facturacion/origenes/restaurante.js`.

**Función:** `leerPedido(idOrden, { transaction })` → `null` si no existe, o:
```js
{
    id_orden, id_negocio, numero_orden, total, descuento, valor_domicilio,
    cobrado: boolean,        // estado_pago = 'pagado' OR (estado = 'CERRADA' AND id_caja IS NOT NULL)
    anulado: boolean,        // estado IN ('CANCELADA','ANULADA')
    items: [...],            // formato de construirFactura, impuesto YA resuelto (D7)
    pagos: [{ codigo_dian, valor }],
}
```
**Pasos:**
1. Pedido: `SELECT id_orden, id_negocio, numero_orden, total, descuento, valor_domicilio, estado, estado_pago, id_caja, id_metodo_pago FROM restaurante.pedid_orden WHERE id_orden = :idOrden`.
2. Líneas:
   ```sql
   SELECT d.id_detalle, d.cantidad, d.precio_unitario, p.id_producto, p.nombre,
          p.codigo_impuesto, p.tarifa_impuesto, p.unidad_medida_dian, p.codigo_producto
     FROM restaurante.pedid_detalle d
     JOIN restaurante.carta_producto p ON p.id_producto = d.id_producto
    WHERE d.id_orden = :idOrden
    ORDER BY d.id_detalle;
   ```
   `precio_bruto = Number(d.precio_unitario)` (es el precio **del momento del pedido**, no el de
   la carta de hoy). `codigo = p.codigo_producto || 'P' + p.id_producto`. `unidad_medida =
   p.unidad_medida_dian || UNIDAD_POR_DEFECTO`.
3. Impuesto por línea (D7): lee `gener_negocio_fiscal` (`responsable_iva`, `responsable_inc`) y
   `fe_configuracion` (`impuesto_defecto_*`). Si el negocio no es responsable de ninguno →
   `{ 'ZZ', 0 }`. Si no, el del producto si `codigo_impuesto` no es NULL, si no el por defecto.
4. Pagos:
   - Si hay filas en `restaurante.rest_pago_orden` para el pedido: una por fila, con
     `codigo_dian` = `rest_metodo_pago.codigo_medio_pago_dian` (JOIN por `id_metodo_pago`) o
     `MEDIO_PAGO_POR_DEFECTO` si es NULL, y `valor`.
   - Si no, un solo pago con `id_metodo_pago` del pedido y `valor = total`.
   - Si el método es la cuenta (`rest_metodo_pago.es_cuenta = true`), `codigo_dian = 'ZZZ'`
     (o `MEDIO_PAGO_POR_DEFECTO` si R0.2 descartó `ZZZ`) — D19.
   - Agrupa pagos con el mismo `codigo_dian` sumando valores.

**Aceptación:** cubierto por R4.6 (crea un pedido real en el negocio de prueba).

#### R4.3 — `emisionService`

**Archivos:** crear `app_core/facturacion/emisionService.js` y `app_core/facturacion/index.js`
(re-exporta lo que usan las verticales: `alCobrarPedido`, `alAnularPedido`).

**Funciones:**

**a) `crearDocumentoPedido({ idOrden, comprador, idUsuario })`** → fila de `fe_documento` o `null`.
En **su propia transacción**:
1. `pedido = origen.leerPedido(idOrden)`. Si `null`, `!pedido.cobrado` o `pedido.anulado` →
   `null`.
2. `{ facturar, config } = debeFacturar(pedido.id_negocio)`. Si no → `null`.
3. Si ya existe `fe_documento` con ese origen y `tipo 'FV'` → devuélvelo (idempotencia, D5). Si
   existe y está en `PENDIENTE_DATOS` y ahora llega `comprador`, actualiza el comprador (función
   `completarComprador`, abajo) y devuélvelo.
4. `adquiriente = normalizarComprador(comprador) ?? CONSUMIDOR_FINAL`.
5. `calculo = construirFactura({ items, domicilio: pedido.valor_domicilio, impuestoDomicilio, descuento: pedido.descuento, totalPedido: pedido.total, pagos })`.
6. `estado = adquiriente.consumidor_final && calculo.total > topeConsumidorFinal() ? 'PENDIENTE_DATOS' : 'EN_COLA'` (D10).
7. `emisor` = la ficha de `datosFiscales.obtener(idNegocio)` (instantánea completa).
8. `codigo_referencia = \`EA${idNegocio}-FV-${idOrden}\`` (y en ambiente `PRUEBAS`, prefijo
   `EAP`: así un documento de pruebas nunca comparte referencia con uno real).
9. `INSERT` en `fe_documento` (con `ON CONFLICT ON CONSTRAINT uq_fedoc_origen DO NOTHING RETURNING *`;
   si no devuelve fila, relee la existente) y las líneas en `fe_documento_linea`.
10. Si `construirFactura` lanza (`FE_TOTALES_NO_CUADRAN`, `FE_DESCUENTO_TOTAL`), crea el documento
    igual con `estado = 'ERROR'`, sin líneas y con `ultimo_error` = el mensaje, para que aparezca
    en la pestaña Facturas. **No relances.**

**b) `procesarDocumento(idDocumento, { forzar = false } = {})`** → la fila actualizada.
1. Candado en memoria por negocio: `const candados = new Map()` de `id_negocio → Promise`;
   encadena la ejecución detrás de la promesa anterior del mismo negocio (D14).
2. **Reclamo atómico:**
   ```sql
   UPDATE facturacion.fe_documento
      SET estado = 'ENVIANDO', intentos = intentos + 1, actualizado_en = now()
    WHERE id_documento = :id
      AND estado IN ('EN_COLA','ERROR')
      AND (:forzar OR proximo_intento_en IS NULL OR proximo_intento_en <= now())
   RETURNING *;
   ```
   Sin fila → otro proceso lo tiene o no toca: devuelve la fila actual sin hacer nada.
3. Si `intentos > 1` (ya se intentó antes), **primero** `consultarPorReferencia`: si Factus ya lo
   tiene `ACEPTADO`, guárdalo como aceptado y no reenvíes.
4. `emitirFactura({ credenciales, ambiente: doc.ambiente, documento: doc, lineas, idRango, enviarCorreo })`.
5. Registra una fila en `fe_intento` (`resultado`, `http_status`, `duracion_ms`, `mensaje`,
   `respuesta`).
6. Transición según `resultado`:

   | `resultado` | Nuevo `estado` | Además |
   |---|---|---|
   | `ACEPTADO` | `ACEPTADO` | guarda `numero`, `cufe`, `fecha_validacion`, `url_publica`, `url_qr`, `payload`, `respuesta`, `avisos`; luego llama `archivar` **sin esperar** (`.catch(console.error)`) |
   | `PENDIENTE_DIAN` | `ERROR` | `proximo_intento_en` = ahora + backoff; se reintentará **con los mismos datos** |
   | `ERROR_RED`, `ERROR_PROVEEDOR` | `ERROR` | backoff |
   | `BLOQUEADO_PENDIENTE` | `ERROR` | backoff; `ultimo_error` = «Hay otra factura pendiente en Factus para este negocio» |
   | `ERROR_CREDENCIALES` | `ERROR` | `proximo_intento_en = NULL` (no reintenta solo); `ultimo_error` claro |
   | `RECHAZADO` | `RECHAZADO` | guarda `payload`, `respuesta`, rechazos en `ultimo_error`; llama `eliminarPendiente` para que no bloquee las siguientes (si falla, solo `console.error`) |

   **Backoff** por número de intentos: `[1, 5, 15, 60, 360]` minutos; a partir del 6.º intento,
   `proximo_intento_en = NULL` y se queda en `ERROR` hasta que una persona pulse «Reintentar».
7. Cualquier excepción inesperada dentro de este paso: pon el documento en `ERROR` con el mensaje y
   backoff. **Nunca** lo dejes en `ENVIANDO`.

**c) `archivar(idDocumento)`**: para `PDF` y `XML`, si no existe fila en `fe_documento_archivo`,
`descargarArchivo` y guarda `contenido`, `bytes`, `sha256` (`crypto.createHash('sha256')`).

**d) `alCobrarPedido({ idOrden, comprador, idUsuario })`** → `{ estado, numero, url_publica, mensaje } | null`.
**Esta es la única función que llama la vertical, y nunca lanza:**
```js
async function alCobrarPedido({ idOrden, comprador = null, idUsuario = null }) {
    try {
        const doc = await crearDocumentoPedido({ idOrden, comprador, idUsuario });
        if (!doc) return null;
        if (doc.estado !== 'EN_COLA') return resumen(doc);
        const espera = Number(process.env.FE_ESPERA_MS || 5000);
        const final = await Promise.race([
            procesarDocumento(doc.id_documento, { forzar: true }),
            new Promise((r) => setTimeout(() => r(null), espera)),
        ]);
        return resumen(final || doc);   // si no alcanzó, sigue en proceso: el cliente lo verá luego
    } catch (err) {
        console.error('[facturacion] alCobrarPedido', idOrden, err.message);
        return null;
    }
}
```
`resumen(doc)` = `{ id_documento, estado, numero, url_publica, mensaje }` con `mensaje` legible:
`ACEPTADO` → «Factura X enviada», `PENDIENTE_DATOS` → «Faltan los datos del comprador (el total
supera 5 UVT)», otro → «La factura se está procesando».

**e) `completarComprador(idDocumento, comprador)`**: solo si `estado IN ('PENDIENTE_DATOS','RECHAZADO')`
(si no, `FE_DOCUMENTO_NO_EDITABLE` 409). Normaliza, actualiza `adquiriente`, pone `estado='EN_COLA'`,
`proximo_intento_en=NULL`. Si venía de `RECHAZADO`, además cambia `codigo_referencia` añadiendo
`-r<intentos>` (R0.2 P1 dirá si hace falta; si Factus acepta repetir la referencia tras borrar la
pendiente, no la cambies y anótalo).

**f) `reintentar(idDocumento)`**: solo desde `ERROR` o `RECHAZADO`; pone `EN_COLA`,
`proximo_intento_en = NULL` y llama `procesarDocumento(..., { forzar: true })`.

**g) `reconciliar()`**: pedidos cobrados sin documento. Consulta:
```sql
SELECT o.id_orden
  FROM restaurante.pedid_orden o
  JOIN facturacion.fe_configuracion c
    ON c.id_negocio = o.id_negocio AND c.estado IN ('EN_PRUEBAS','ACTIVO')
 WHERE (o.estado_pago = 'pagado' OR (o.estado = 'CERRADA' AND o.id_caja IS NOT NULL))
   AND o.estado NOT IN ('CANCELADA','ANULADA')
   AND o.fecha_creacion >= c.activado_en
   AND o.fecha_creacion >= now() - interval '72 hours'
   AND o.fecha_creacion <= now() - interval '2 minutes'
   AND NOT EXISTS (
       SELECT 1 FROM facturacion.fe_documento d
        WHERE d.id_negocio = o.id_negocio AND d.origen_vertical = 'RESTAURANTE'
          AND d.origen_tipo = 'PEDIDO' AND d.origen_id = o.id_orden::text AND d.tipo = 'FV')
 LIMIT 50;
```
> `fecha_creacion` es `timestamp without time zone` en hora Bogotá y `activado_en` es
> `timestamptz`: la comparación es correcta porque la sesión de Postgres está en
> `America/Bogota` (`conection.js`). No lo «arregles».

Por cada fila: `crearDocumentoPedido({ idOrden, comprador: null })` (queda en `EN_COLA` o
`PENDIENTE_DATOS`; lo enviará el ciclo de pendientes).

**h) `procesarPendientes()`**: primero devuelve a `EN_COLA` los `ENVIANDO` con
`actualizado_en < now() - interval '5 minutes'`; luego toma hasta 20 documentos
`estado IN ('EN_COLA','ERROR') AND (proximo_intento_en IS NULL OR proximo_intento_en <= now())`,
excluyendo `ERROR` con `proximo_intento_en IS NULL` (esos esperan a una persona — ojo: `EN_COLA`
con NULL sí se procesa), ordenados por `creado_en`, y llama `procesarDocumento` a cada uno **en
serie**.

#### R4.4 — `emisionScheduler`

**Archivos:** crear `app_core/facturacion/emisionScheduler.js`; editar `app.js`; editar
`.env.example`.

**Pasos:**
1. Copia la forma de `app_admin_api/services/cobranzaScheduler.js` (`node-cron`, bandera
   `initialized`, `iniciar()`).
2. `iniciar()`: si `process.env.FE_WORKER_ENABLED === 'false'`, imprime
   `[facturacion] worker apagado (FE_WORKER_ENABLED=false)` y sale. Si no, programa
   `FE_WORKER_CRON` (defecto `* * * * *`) con una bandera `corriendo` para que dos ciclos no se
   solapen. Cada ciclo: `await reconciliar(); await procesarPendientes();` dentro de `try/catch`
   con `console.error`.
3. En `app.js`, dentro del `app.listen`, debajo de `cobranzaScheduler.iniciar();`:
   ```js
   // Reintentos y reconciliación de facturación electrónica. Sin negocios configurados no hace
   // nada; se apaga con FE_WORKER_ENABLED=false.
   require('./app_core/facturacion/emisionScheduler').iniciar();
   ```
4. En `.env.example`, las tres variables de §0.4 con un comentario cada una.

**Aceptación:** `npm run dev` arranca y, con el negocio de R4.5 configurado, un pedido cobrado con
el worker encendido queda `ACEPTADO` en menos de dos minutos aunque `FE_ESPERA_MS=1`.

#### R4.5 — Script `fe_configurar_sandbox.js`

**Objetivo:** dejar un negocio de desarrollo listo para facturar en el sandbox con un comando.

**Archivos:** crear `admin_ws/scripts/fe_configurar_sandbox.js`.

**Uso:** `node scripts/fe_configurar_sandbox.js <id_negocio> [--aplicar]` (sin `--aplicar` solo
muestra lo que haría, como `reparar_roles_negocio.js`).

**Pasos:**
1. Aborta si `DB_NAME` no contiene `dev` (no es una base de desarrollo).
2. Lee `FACTUS_*` del `.env`; `probarConexion` con ambiente `PRUEBAS` e imprime la empresa.
3. Rellena la ficha fiscal del negocio con los datos de la empresa del sandbox
   (`datosFiscales.actualizar`) y los que falten con valores de prueba evidentes
   (`direccion_fiscal: 'Calle de prueba 1'`, `municipio_dane: '05001'`, `departamento_dane: '05'`,
   `responsabilidades_fiscales: ['R-99-PN']`, `tributos: ['ZZ']`, `correo_facturacion` = el de la
   empresa o `pruebas@escalapp.cloud`), declara `REGISTRADO` y modo `POS` con `datosFiscales.declarar`.
4. `configuracionDao.guardar` con credenciales y `ambiente: 'PRUEBAS'`; `listarRangos` →
   `guardarRangos`; `usarRango` con el primer rango vigente; `cambiarEstado('EN_PRUEBAS')`.
5. Imprime cómo encender la feature en desarrollo: `FEATURES_FORZADAS=facturacion_electronica`.

**Aceptación:** tras correrlo, `debeFacturar(id)` devuelve `{ facturar: true }` con la feature
forzada.

#### R4.6 — Pruebas de `emisionService`

**Archivos:** crear `__tests__/facturacion/emision.test.js`. **Base local** (`DB_PORT=5432`).

**Preparación:** negocio de usar y tirar con ficha fiscal completa (copia `fijarFicha` de
`datos_fiscales.test.js`), `fe_configuracion` en `EN_PRUEBAS` con credenciales cifradas falsas
(pon `WHATSAPP_TOKEN_KEY` de prueba en `process.env` si falta:
`crypto.randomBytes(32).toString('base64')`), un `fe_resolucion` `en_uso`, un producto de carta
y un pedido `estado_pago='pagado'` con un `pedid_detalle`. Fuerza la feature con
`process.env.FEATURES_FORZADAS = 'facturacion_electronica'` **antes** de `require` de los módulos.
Simula el proveedor con `jest.mock('../../app_core/facturacion/proveedores', …)` devolviendo un
adaptador falso cuyas funciones son `jest.fn()`.

**Casos:**
1. `alCobrarPedido` con proveedor que devuelve `ACEPTADO` → documento `ACEPTADO`, `numero` y
   `cufe` guardados, una fila en `fe_intento`.
2. Llamarlo dos veces → **un** documento (idempotencia) y `emitirFactura` llamado una vez.
3. Proveedor `ERROR_RED` → `ERROR` con `proximo_intento_en` ≈ ahora + 1 min.
4. Proveedor `RECHAZADO` → `RECHAZADO` y `eliminarPendiente` llamado.
5. Proveedor que tarda más que `FE_ESPERA_MS` (pon `FE_ESPERA_MS=50` y una promesa de 500 ms) →
   `alCobrarPedido` vuelve en < 200 ms con estado `ENVIANDO`/`EN_COLA`, y al terminar el documento
   queda `ACEPTADO`.
6. Proveedor que **lanza** → `alCobrarPedido` devuelve `null`, no lanza; documento en `ERROR`.
7. Pedido con total > 261.870 sin comprador → `PENDIENTE_DATOS` y `emitirFactura` **no** se llama.
8. Negocio con `modo_facturacion = 'NINGUNO'` → `alCobrarPedido` devuelve `null` y no crea nada.
9. `reconciliar` encuentra un pedido cobrado sin documento y lo crea.
10. Dos `procesarDocumento` simultáneos del mismo documento → `emitirFactura` llamado **una** vez.

**Aceptación:** `DB_PORT=5432 npx jest __tests__/facturacion --forceExit` todo en verde.

---

### FASE R5 — Enganchar el cobro del restaurante

#### R5.1 — Gancho en `marcarPagado` y `cerrarOrden`

**Archivos:** `app_restaurante_api/services/pedidoService.js`, `app_restaurante_api/controllers/pedidoController.js`.

**Pasos:**
1. Arriba de `pedidoService.js`, junto a los demás `require`:
   ```js
   // Facturación electrónica (ADR-026). Se llama DESPUÉS del commit y nunca lanza: si la
   // facturación se cae, el cobro sigue (ADR-005). Ver docs/plan-fe-restaurante.md D4.
   const facturacion = require('../../app_core/facturacion');
   ```
2. `marcarPagado(idOrden, { …, factura = null })`: añade `factura` a los parámetros. Después de
   `await t.commit();` y **antes** de `return orden;`:
   ```js
   orden.dataValues.factura = await facturacion.alCobrarPedido({
       idOrden: orden.id_orden, comprador: factura, idUsuario,
   });
   ```
3. `cerrarOrden(idOrden, { …, factura = null })`: igual. Cambia el final
   `await t.commit(); return getOrdenById(idOrden);` por:
   ```js
   await t.commit();
   const resultado = await getOrdenById(idOrden);
   if (resultado) {
       resultado.dataValues.factura = await facturacion.alCobrarPedido({
           idOrden, comprador: factura, idUsuario,
       });
   }
   return resultado;
   ```
   **No** lo pongas en la rama temprana `if (orden.estado === 'CERRADA')` (ese pedido ya pasó por
   aquí antes).
4. En `pedidoController.js`, en los handlers `marcarPagado` y `cerrarOrden`, pasa
   `factura: req.body.factura ?? null` al servicio.

**Aceptación:** los tests existentes de restaurante siguen en verde:
`DB_PORT=5432 npx jest __tests__/restaurante --forceExit`. Con un negocio en `NINGUNO`, la
respuesta trae `factura: null` y nada más cambia.

**No hagas:** no metas la llamada dentro de la transacción `t`; no uses `avisarTrasCommit` para
esto; no hagas `await` de nada de facturación antes del commit.

#### R5.2 — Validadores del campo `factura`

**Archivos:** `app_restaurante_api/controllers/pedidoController.js` (arrays
`marcarPagadoValidators` y `cerrarOrdenValidators`).

Añade a los dos arrays:
```js
body('factura').optional({ nullable: true }).isObject(),
body('factura.tipo_persona').if(body('factura').exists({ values: 'null' }))
    .isIn(['1', '2']),
body('factura.tipo_documento').if(body('factura').exists({ values: 'null' }))
    .isIn(['13', '22', '31', '41']),
body('factura.numero_documento').if(body('factura').exists({ values: 'null' }))
    .isString().trim().isLength({ min: 3, max: 20 }),
body('factura.dv').optional({ nullable: true }).isString().matches(/^[0-9]$/),
body('factura.razon_social').optional({ nullable: true }).isString().isLength({ max: 255 }),
body('factura.nombres').optional({ nullable: true }).isString().isLength({ max: 255 }),
body('factura.correo').optional({ nullable: true }).isEmail(),
body('factura.telefono').optional({ nullable: true }).isString().isLength({ max: 30 }),
body('factura.direccion').optional({ nullable: true }).isString().isLength({ max: 255 }),
```
> La validación de fondo (DV, razón social según tipo de persona) la hace `normalizarComprador`.
> Si el comprador es inválido allí, `alCobrarPedido` devuelve `null` y el documento **no** se crea
> hasta la reconciliación (como consumidor final)… **eso sería incorrecto** para un total > 5 UVT.
> Por eso: en `crearDocumentoPedido`, si `normalizarComprador` lanza `FE_COMPRADOR_INVALIDO`, crea
> el documento en `PENDIENTE_DATOS` con `ultimo_error` = el mensaje. Asegúrate de que R4.3 lo haga
> y añade el caso a R4.6.

**Aceptación:** enviar `factura: { tipo_documento: '99' }` responde 400; `factura: null` pasa.

#### R5.3 — Prueba de punta a punta contra el sandbox

**Objetivo:** ver una factura real del sandbox salir de un cobro del restaurante.

**Pasos (manuales, con `curl` o Postman; no hace falta navegador):**
1. `node scripts/fe_configurar_sandbox.js <id_negocio_restaurante> --aplicar` en la base compartida.
2. Arranca `npm run dev` con `FEATURES_FORZADAS=facturacion_electronica`.
3. Inicia sesión como el admin de ese negocio, abre caja, crea un pedido y cóbralo con
   `PATCH /restaurante/pedidos/:id/marcar-pagado`.
4. La respuesta trae `data.factura.estado === 'ACEPTADO'` y un `numero` `SETP…`.
5. Repite con `factura: { tipo_persona: '2', tipo_documento: '13', numero_documento: '1000000009', nombres: 'Cliente Prueba', correo: '<tu correo>' }` y comprueba que llega el correo.
6. Anota en §7 los números de factura obtenidos.

---

### FASE R6 — Configuración por el super admin

#### R6.1 — API super admin

**Archivos:** crear `app_admin_api/controllers/feConfiguracionController.js`; editar
`app_admin_api/routes/index.js`.

**Rutas** (todas con `requireSuperAdmin`, parámetro `:id_negocio` — ver el comentario de la ruta
de datos fiscales sobre por qué se llama así):

| Método y ruta | Cuerpo | Hace |
|---|---|---|
| `GET /negocios/:id_negocio/facturacion-electronica` | — | `{ config (sin credenciales), rangos, puede_emitir: puedeEmitir(), debe_facturar: debeFacturar(), feature: bool }` |
| `PUT /negocios/:id_negocio/facturacion-electronica` | `ambiente`, `credenciales{client_id,client_secret,username,password}` (opcional), impuestos, `enviar_correo` | `configuracionDao.guardar` |
| `POST /negocios/:id_negocio/facturacion-electronica/probar` | — | `probarConexion`; devuelve la empresa y `coincide_nit` (compara con `gener_negocio_fiscal.numero_documento`) |
| `POST /negocios/:id_negocio/facturacion-electronica/rangos/sincronizar` | — | `listarRangos` → `guardarRangos` → devuelve la lista |
| `PUT /negocios/:id_negocio/facturacion-electronica/rangos/:id_resolucion/usar` | — | `usarRango` |
| `PATCH /negocios/:id_negocio/facturacion-electronica/estado` | `estado` | `cambiarEstado` |

Validadores: `param('id_negocio').isInt({ min: 1 })`, `body('ambiente').optional().isIn(['PRUEBAS','PRODUCCION'])`,
`body('estado').isIn(['EN_PRUEBAS','ACTIVO','SUSPENDIDO'])`, credenciales como strings no vacíos
de máx. 255. Copia `validar` y el manejo de errores de `datosFiscalesController.js`.

> ⚠️ `PRODUCCION` se puede **guardar** desde el panel en desarrollo, pero el adaptador se negará a
> usarlo (D15). Eso es a propósito: la pantalla de producción se prueba en producción.

**Aceptación:** con `curl` como super admin, el flujo guardar → probar → sincronizar → usar →
estado `EN_PRUEBAS` funciona sobre un negocio de la base compartida; como admin de negocio, cada
ruta responde 403.

#### R6.2 — Pantalla super admin

**Archivos:** `admin_app-v21/src/app/admin/data-access/facturacion.service.ts` (añadir métodos),
`admin_app-v21/src/app/admin/models/facturacion.models.ts` (tipos), nuevo componente
`admin_app-v21/src/app/admin/features/facturacion/fe-operacion/` (`.ts`, `.html`, `.scss`).

**Pasos:**
1. Lee primero `facturacion.component.ts` completo: la pantalla actual es la ficha fiscal del
   negocio. El componente nuevo se muestra **debajo**, solo si el usuario es super admin (usa la
   misma señal/guard de rol que usa el resto del panel para super admin; búscala con
   `grep -rn "SUPER" admin_app-v21/src/app/admin --include=*.ts`).
2. Secciones del componente, en este orden: **Estado** (chip con `estado` y `ambiente`, lista
   `debe_facturar.motivo`) · **Credenciales** (4 campos tipo password, botón Guardar; nunca
   muestra las guardadas, solo «Credenciales guardadas ✓») · **Probar conexión** (muestra NIT y
   razón social; aviso ámbar si `coincide_nit` es falso) · **Rangos** (tabla, botón Sincronizar,
   radio «Usar») · **Impuestos por defecto** (dos `select` alimentados por
   `GET /admin/facturacion/catalogos`) · **Botones de estado** (Pasar a pruebas / Activar /
   Suspender, con confirmación).
3. Tokens de color del admin (`--color-*`), nunca los de la landing.
4. Prueba Vitest: el componente no se renderiza para un usuario sin rol de super admin.

**Aceptación:** `npm test` y `npm run build` en verde en `admin_app-v21`.

---

### FASE R7 — Datos fiscales en el restaurante

#### R7.1 — Campos fiscales del producto (API)

**Archivos:** `app_core/models/restaurante.carta_producto.js`,
`app_restaurante_api/services/cartaAdminService.js`,
`app_restaurante_api/controllers/cartaAdminController.js`.

**Pasos:**
1. Modelo: añade `codigo_impuesto: DataTypes.STRING(4)`, `tarifa_impuesto: DataTypes.DECIMAL(5, 2)`,
   `unidad_medida_dian: DataTypes.STRING(10)`, `codigo_producto: DataTypes.STRING(50)`, todos
   `allowNull: true` (las columnas ya existen desde FE-1).
2. `crearProducto` y `editarProducto`: añade los 4 campos a la desestructuración y a lo que se
   guarda (en `editarProducto` con el mismo patrón `campo ?? prod.campo`; ojo: para poder
   **borrar** el impuesto de un producto, acepta `null` explícito: usa
   `campo !== undefined ? campo : prod.campo`).
3. Valida que `(codigo_impuesto, tarifa_impuesto)` exista en `facturacion.fe_impuesto` si viene
   `codigo_impuesto`; si no, error tipado `FE_IMPUESTO_INVALIDO` (422). Los dos van juntos: uno
   sin el otro también es 422.
4. Controlador: pasa los 4 campos del `req.body`.

**Aceptación:** crear y editar un producto con `codigo_impuesto: '04', tarifa_impuesto: 8`
funciona; con `'04', 19` responde 422.

#### R7.2 — Código DIAN del método de pago (API)

**Archivos:** `app_core/models/restaurante.rest_metodo_pago.js`,
`app_restaurante_api/services/metodoPagoService.js`,
`app_restaurante_api/routes/index.js` (validadores de `POST`/`PUT /metodos-pago`).

**Pasos:** añade `codigo_medio_pago_dian: { type: DataTypes.STRING(3), allowNull: true }` al
modelo; acéptalo en crear/editar; validador
`body('codigo_medio_pago_dian').optional({ nullable: true }).isIn(['10','47','48','49','ZZZ'])`
(la lista de `MEDIOS_PAGO_DIAN`; si R0.2 quitó `ZZZ`, quítalo aquí también); el `GET` de métodos de
pago debe devolverlo.

#### R7.3 — `GET /restaurante/facturacion/estado`

**Archivos:** crear `app_restaurante_api/controllers/facturacionController.js`; editar
`app_restaurante_api/routes/index.js` (después del bloque de `/metodos-pago`).

**Ruta:** `GET /facturacion/estado` con `query('id_negocio').isInt({ min: 1 })`. Respuesta:
```json
{ "activa": true, "modo": "POS", "ambiente": "PRUEBAS",
  "tope_identificacion": 261870, "motivo": null }
```
`activa = debeFacturar(id).facturar`. Con `activa: false`, devuelve `modo` y `motivo` igual (la
pantalla de Configuración lo muestra). Comprueba la pertenencia con `resolverPrincipalUsuario` y
`puedeOperarEn` como `autorizar()` de `datosFiscalesController.js` (el middleware global todavía
puede estar en modo observación).

#### R7.4 — Frontend: carta y métodos de pago

**Archivos:** los de la pantalla de carta y los de métodos de pago en `restaurante_app`. Encuéntralos
con `grep -rn "carta/admin/productos" restaurante_app/src --include=*.ts` y
`grep -rn "metodos-pago" restaurante_app/src --include=*.ts`.

**Pasos:**
1. En el formulario de producto, una sección plegable «Datos fiscales», **visible solo si**
   `FacturacionService.estado().activa || modo !== 'NINGUNO'` (el servicio es de R8.1; si aún no
   existe, crea primero solo el servicio con `cargarEstado`). Campos: `select` Impuesto (opciones
   del catálogo: «Usar el del negocio» = null, «INC 8%», «IVA 19%», «IVA 5%», «Sin impuesto»),
   `codigo_producto` (texto), `unidad_medida_dian` (texto, placeholder `94`).
   Texto de ayuda: «Confírmalo con tu contador: nosotros no lo decidimos por ti».
2. En métodos de pago, un `select` «Tipo para la factura electrónica» con `MEDIOS_PAGO_DIAN`,
   visible con la misma condición.
3. Prueba Vitest: la sección no aparece con `activa: false` y `modo: 'NINGUNO'`.

---

### FASE R8 — El cobro en la interfaz

#### R8.1 — `FacturacionService` y componente «Factura a nombre de»

**Archivos:**
- crear `restaurante_app/src/app/core/services/facturacion.service.ts`
- crear `restaurante_app/src/app/restaurante/shared/datos-factura/datos-factura.ts` (+ `.html`, `.scss`)
- editar `restaurante_app/src/app/restaurante/shared/multipago-selector/multipago-selector.ts` y `.html`

**Pasos:**
1. `FacturacionService` (`providedIn: 'root'`): `private readonly _estado = signal<EstadoFe | null>(null)`,
   `estado = this._estado.asReadonly()`, `activa = computed(() => !!this._estado()?.activa)`,
   `cargarEstado(idNegocio)` que llama `GET ${environment.apiUrl}/facturacion/estado`. Llama a
   `cargarEstado` donde se cargan los demás datos de sesión del negocio (búscalo en
   `auth.service.ts` o donde se lea `permite_multipago`).
2. `DatosFacturaComponent` (standalone, OnPush): un interruptor «Factura a nombre de un cliente»;
   al encenderlo, campos: Tipo (Cédula `13` / NIT `31` / Cédula de extranjería `22` / Pasaporte
   `41`), Número, Nombre o Razón social (la etiqueta cambia con el tipo: NIT → razón social y
   `tipo_persona '1'`; el resto → nombres y `tipo_persona '2'`), Correo, Teléfono (opcional).
   El DV **no se pide** (lo calcula el servidor).
   - `input` `total: number`, `input` `modo: 'POS' | 'COMPLETO'`.
   - Si `modo === 'COMPLETO'` el interruptor nace encendido.
   - Si `total > tope_identificacion`, el interruptor nace encendido y **no se puede apagar**, con
     el texto «Por encima de $261.870 la factura debe llevar los datos del comprador».
   - `output` / señal pública `datos(): DatosFactura | null` (null si apagado).
   - `valido = computed(...)`: apagado → true; encendido → número ≥ 3 dígitos, nombre no vacío,
     correo con formato si se escribió.
3. **Mete `<app-datos-factura>` DENTRO de `multipago-selector.html`**, al final, con
   `@if (facturacion.activa())`. Motivo: las tres pantallas que cobran comparten este selector;
   ponerlo por pantalla ya dejó una vez a Mesas sin el selector de cuentas (ver CLAUDE.md,
   «Tiqueteras y fiado»).
4. Añade a `PagoSeleccion` el campo `factura: DatosFactura | null`, y haz que `valido` sea falso si
   `DatosFacturaComponent.valido()` es falso.
5. Pruebas Vitest del componente: tope forzado, cambio de etiqueta NIT/cédula, `datos()` null cuando
   está apagado.

#### R8.2 — Enviar `factura` desde las tres pantallas

**Archivos:** `restaurante_app/src/app/restaurante/features/pedidos/pedidos.ts` (llamadas en torno a
las líneas 1948 y 2008), `restaurante_app/src/app/core/services/mesas.service.ts` (línea ~171),
`restaurante_app/src/app/restaurante/features/despacho/despacho.ts` (llamada `marcar-pagado`
~1311). Las líneas son aproximadas: búscalas por la URL.

**Pasos:**
1. En cada llamada que **cobra** (no en las de Despacho que solo cierran pedidos ya cobrados con
   `{}`, líneas ~1099 y ~1154), añade `factura: seleccion.factura` al cuerpo, leyendo del mismo
   `PagoSeleccion` del que ya salen `idMetodoPago` y `pagos`.
2. Al recibir la respuesta, si `data.factura` no es null, muestra un aviso con el servicio de
   avisos que ya use esa pantalla (`ui-feedback.service.ts`): `data.factura.mensaje`. Si
   `estado === 'PENDIENTE_DATOS'`, aviso ámbar; si `ACEPTADO`, verde; si no, neutro.
3. Si el negocio no factura, nada cambia (`factura` va `null` y la respuesta trae `factura: null`).

**Aceptación:** `npm test` y `npm run build` en verde; en `ng serve` contra el backend con el
negocio de R4.5, cobrar un pedido muestra «Factura SETP… enviada».

---

### FASE R9 — Ver y corregir facturas

#### R9.1 — API restaurante

**Archivos:** `app_restaurante_api/controllers/facturacionController.js`,
`app_restaurante_api/routes/index.js`, `app_core/facturacion/emisionService.js` (funciones de
lectura: `listar`, `obtenerArchivo`).

| Método y ruta | Validadores | Hace |
|---|---|---|
| `GET /facturacion/documentos` | `id_negocio` int; `desde`, `hasta` fecha ISO opcionales; `estado` opcional (uno de los 7) | Lista `{ id_documento, tipo, estado, numero, origen_referencia, adquiriente.nombres/razon_social, total, creado_en, ultimo_error, url_publica }`, orden `creado_en DESC`, máx. 200 |
| `GET /facturacion/documentos/:id/pdf` | `id` uuid; `id_negocio` int | Devuelve el PDF de `fe_documento_archivo` con `Content-Type: application/pdf`. Si no está, intenta `archivar` y reintenta; si sigue sin estar, 404 `FE_ARCHIVO_NO_DISPONIBLE` |
| `POST /facturacion/documentos/:id/reintentar` | `id` uuid; `body id_negocio` | `reintentar` |
| `PUT /facturacion/documentos/:id/comprador` | igual que R5.2 pero sobre `body.*` sin el prefijo `factura.` | `completarComprador` y luego `procesarDocumento(forzar)` |

**Todas** comprueban que el documento sea del `id_negocio` (`WHERE id_documento = :id AND
id_negocio = :idNegocio`; si no, 404 — no distingas «no existe» de «no es tuyo») y la pertenencia
del usuario como en R7.3.

#### R9.2 — Pestaña «Facturas» en Caja

**Archivos:** `restaurante_app/src/app/restaurante/features/caja/` (lee `caja.ts` para ver cómo
están hechas las pestañas actuales y sigue el mismo patrón), `facturacion.service.ts`.

**Pasos:**
1. Pestaña visible solo con `facturacion.activa()` (o si hay documentos: basta con `activa`).
2. Tabla: Fecha · Pedido · Número · Comprador · Total · Estado (chip: ACEPTADO verde, EN_COLA /
   ENVIANDO gris, PENDIENTE_DATOS ámbar, ERROR / RECHAZADO rojo) · Acciones.
3. Acciones por estado: `ACEPTADO` → «Ver PDF» (abre el blob en una pestaña nueva) y «Ver en
   Factus» (`url_publica`); `ERROR`/`RECHAZADO` → «Reintentar» y el `ultimo_error` visible;
   `PENDIENTE_DATOS`/`RECHAZADO` → «Completar datos» (abre `DatosFacturaComponent` en un modal y
   llama `PUT …/comprador`).
4. Filtro por estado y por fecha (hoy por defecto).
5. Se refresca con los avisos en vivo que ya usa Caja (`realtime.service.ts`, tema `CAJA`) y con un
   botón «Actualizar».
6. Prueba Vitest: los botones que aparecen para cada estado.

---

### FASE R10 — Nota crédito al anular

#### R10.1 — Anulación total

**Archivos:** `app_core/facturacion/emisionService.js` (`alAnularPedido`),
`app_core/facturacion/proveedores/factus.js` (`emitirNotaCredito`, con lo que R0.2 P6 registró),
`app_restaurante_api/services/cajaService.js` (`anularOrdenCobrada`, línea ~1120).

**Reglas:**
1. `alAnularPedido({ idOrden, idUsuario })` — nunca lanza, como `alCobrarPedido`. Busca el `FV` del
   pedido:
   - no hay → no hace nada;
   - `PENDIENTE_DATOS`, `EN_COLA`, `ERROR`, `RECHAZADO` → pasa a `ANULADO` con un `UPDATE … WHERE
     estado IN (esos cuatro)` (si justo lo reclamó el worker y está `ENVIANDO`, espera 10 s y
     reintenta una vez; si ya salió `ACEPTADO`, sigue con el caso siguiente);
   - `ACEPTADO` → crea un documento `tipo 'NC'`, mismo origen, `id_documento_referencia` = el FV,
     mismas líneas y totales, `codigo_referencia = EA<neg>-NC-<idOrden>`, y lo procesa igual que un
     FV (en `procesarDocumento`, si `tipo === 'NC'` llama `emitirNotaCredito` en lugar de
     `emitirFactura`, pasando el número y el id de Factus del FV que está en `respuesta.data`).
2. En `cajaService.anularOrdenCobrada`, después del commit, llama
   `facturacion.alAnularPedido({ idOrden, idUsuario })` **sin esperar** su resultado para la
   respuesta (`.catch(() => {})` no hace falta porque no lanza, pero no uses `await` si la
   respuesta de anular no lo necesita).
3. Rango de la NC: si R0.2 muestra que la NC necesita su propio rango, `listarRangos` debe traer
   también los de nota crédito (`filter[document]` del código que R0.2 identifique) y guardarlos
   con `tipo_documento 'NC'`; `usarRango` ya distingue por tipo.
4. Pruebas en `emision.test.js`: anular un pedido con FV `EN_COLA` → FV `ANULADO`, sin llamar al
   proveedor; con FV `ACEPTADO` → NC `ACEPTADO` con `id_documento_referencia`.

---

### FASE R11 — Terminaciones

#### R11.1 — Alertas de rango y vigencia

`GET /restaurante/facturacion/estado` (R7.3) y el `GET` de R6.1 añaden `alertas: string[]`:
- «Quedan N números en el rango» si `(rango_hasta − consecutivo_actual) / (rango_hasta − rango_desde + 1) < 0,10`;
- «La resolución vence el DD/MM/AAAA» si `vigencia_hasta − hoy < 30 días`;
- «La resolución está vencida» si `vencida`.
`consecutivo_actual` se actualiza en cada `ACEPTADO` si la respuesta trae el número (extrae la
parte numérica de `numero` quitando el `prefijo`), y en cada sincronización. La pantalla de
Configuración del restaurante y la de R6.2 las muestran en una franja ámbar. El worker (R4.4)
sincroniza los rangos de cada negocio activo **una vez al día** (usa una segunda tarea cron
`0 6 * * *`).

#### R11.2 — Número, CUFE y QR en el comprobante impreso

Encuentra la función de impresión (`grep -rn "window.print\|imprimir" restaurante_app/src --include=*.ts`,
aparece en `mesas.ts`, `pedidos.ts` y `despacho.ts`). Si la orden tiene `factura.estado === 'ACEPTADO'`,
añade al pie: «Factura electrónica de venta N.º {numero}», «CUFE: {cufe}» (letra pequeña, con
salto de línea permitido) y un QR de `url_qr`. Para el QR, **pregunta antes** qué librería usar
(no añadas dependencias sin permiso). Para que el CUFE llegue, `resumen()` de R4.3 debe incluir
`cufe` y `url_qr`.

---

### FASE R12 — Cierre

#### R12.1 — Documentación y despliegue

1. `docs/facturacion-electronica.md` §9: marca FE-2 y la parte de FE-3 hecha, con fecha, y enlaza
   este plan.
2. `docs/ESTADO-Y-CONTINUACION.md`: un párrafo en §4-0 con qué quedó y cómo probarlo.
3. `CLAUDE.md` (raíz del workspace): una viñeta en «Things to watch» sobre la facturación
   electrónica del restaurante: nace apagada, dónde se configura, que la venta no depende de ella,
   y el trigger de inmutabilidad.
4. **Despliegue** (lo hace una persona, no el modelo; déjalo escrito como lista):
   1. Respaldo de la base de producción.
   2. `git pull` + `npm install --omit=dev`; comprobar `git log --oneline -1`. **Todavía sin
      reiniciar.**
   3. `npm run migrate:facturacion-emision` (y `npm run migrate:facturacion` si no se aplicó nunca
      en producción — compruébalo antes con `psql`: `\dt general.gener_negocio_fiscal`).
      ⚠️ **La migración va ANTES del reinicio, no después:** el modelo `rest_metodo_pago` ya pide la
      columna `codigo_medio_pago_dian`, y sin ella **toda** consulta de formas de pago falla — o
      sea, no se podría cobrar en ningún restaurante. Después, `sudo systemctl restart
      escalapp-api` y `journalctl`.
   4. Build y subida de `restaurante_app` y `admin_app-v21` según CLAUDE.md (admin NO renombra
      `index.csr.html`).
   5. Nada cambia para ningún cliente hasta que un super admin configure uno. Verificar con un
      cobro normal que la respuesta trae `factura: null`.

---

## 5. Resultados del sondeo del sandbox (lo rellena R0.2)

> Ejecutado el **2026-10-08** con `scripts/factus_sondeo.js`. Las respuestas completas están en
> `tmp/factus/sondeo/` (fuera de git). Ninguna contradice una decisión de §2.

| Pregunta | Resultado observado | Consecuencia en el plan |
|---|---|---|
| P1 `reference_code` repetido | **No duplica.** Las dos veces HTTP 201 «registrado y validado con éxito» y el **mismo número** (`SETP990024139`). Repetido también a través del adaptador: mismo documento. | R4.3 b) paso 3 y e) |
| P2 consultar por referencia | `GET /v2/bills?filter[reference_code]=<ref>` → 200, `data.data[]` con `number`, `reference_code`, `is_validated`, `errors`, `total` (sin CUFE ni enlaces). La v1 responde **403**. El documento entero: `GET /v2/bills/<número>`. | R2.2 paso 10 |
| P3 medios de pago `ZZZ`/`47`/`48`/`49` | Los cuatro validan (201). `ZZZ` se queda como medio por defecto. | R3.1 `MEDIO_PAGO_POR_DEFECTO`, R7.2 |
| P4 comprador cédula / NIT | Los dos validan **solo con los campos mínimos** del plan (cédula `1000000009`; NIT `900123456`, DV `8` según `calcularDv`). No pide `tribute`, `address` ni `municipality`: Factus rellena «No informado», ZZ y R-99-PN. | R2.3 `traducirComprador`, R8.1 campos |
| P5 `discount_rate` por línea | Cuadra al centavo: 2 × 22.000 + 1 × 6.500 con INC 8 % y `discount_rate: 10.00` → Factus 45.450,00 = nuestro 45.450,00. **D9 no se cambia** (falta la aprobación del usuario); queda como alternativa conocida. | D9 (solo se cambia si cuadra al centavo y el usuario lo aprueba) |
| P6 nota crédito | `POST /v2/credit-notes/validate` con el cuerpo de la factura + `correction_concept_code: '2'`, `customization_id: '20'`, `bill_number` y un `numbering_range_id` de un rango **«Nota Crédito»** → 201, `CRTE869`, con `cude` (no `cufe`). Avisos, no rechazos: CAK55 (sin correo) y CBF02. | R10.1 |
| P7 duración del token | `expires_in: 3600`, `token_type: Bearer`, y **sí** trae `refresh_token` (no se usa: se repite el grant `password`). | R2.2 caché |

---

## 6. Preguntas para el contador (no bloquean; el plan ya tiene un valor por defecto)

| Pregunta | Qué hace el plan mientras tanto |
|---|---|
| ¿El domicilio causa impuesto? ¿Cuál? | Sin impuesto (`impuesto_domicilio_*` = ZZ), configurable por negocio |
| Negocio **no responsable** de IVA/INC: ¿basta con líneas «excluidas» (`is_excluded`)? Factus las rotula «IVA excluido 0%» | Se usa `is_excluded` (validado por la DIAN en sandbox) |
| La venta de una **tiquetera** (prepago), ¿se factura al venderla o al consumirla? | Se factura al consumir; la venta no se factura (D19) |
| Un pedido **fiado**, ¿forma de pago crédito (`payment_form 2`)? | Contado con medio `ZZZ` |
| ¿El tope de 5 UVT para identificar al comprador aplica igual a la factura de venta que emitimos siempre? | Sí, se exige por encima del tope (D10) |

---

## 7. Notas del implementador

(Anota aquí, con fecha y tarea, lo que encontraste fuera del alcance, las decisiones que tuviste
que pedir y los números de factura de las pruebas contra el sandbox.)

### 2026-10-08 — R0, R1, R2 y R3

**Hecho, sin commitear** (el usuario no lo ha pedido): R0.1–R0.2, R1.1–R1.2, R2.1–R2.4, R3.1–R3.3.
`migrate:facturacion-emision` aplicada dos veces en la local (5432) y en la compartida (5433);
**no** en producción. `DB_PORT=5432 npx jest __tests__/facturacion --forceExit`: 94 pruebas en verde.

**Facturas de prueba en el sandbox:** sondeo `SETP990024139`–`SETP990024146` y nota `CRTE869`;
humo del adaptador (cálculo → emisión → reintento → consulta → PDF/XML → nota crédito)
`SETP990024149`, `SETP990024150` y `CRTE870`. En el humo, un pedido de 67.999 con INC, descuento,
domicilio y dos pagos salió por 67.999,01 en Factus y en nuestro cálculo (`ajuste_redondeo` 0,01).

**Desviaciones del texto del plan, todas en `proveedores/factus.js`:**

- **`listarRangos` no filtra por `filter[document]=21`**: recorre todas las páginas y traduce el
  nombre del documento («Factura de Venta» → `FV`, «Nota Crédito» → `NC`). Así el mismo listado
  sirve para el rango de notas crédito, que R10.1 necesita. Lo que no es ninguno de los dos
  (documento soporte, nota débito, nómina) sale con `tipoDocumento: null`: **R4.1 `guardarRangos`
  debe saltárselos**, porque `chk_feres_tipo` solo admite FV y NC.
- **La unidad de medida que no sea `94` se envía como `94`.** En Orbita se probaron ocho códigos
  que la documentación de Factus da por válidos y los ocho rechazaron la factura.
- **`fechaValidacion` se convierte**: Factus manda `08-10-2026 09:23:26 PM` (día-mes-año, hora de
  Bogotá) y `new Date()` lo leería como 10 de agosto.
- **`emitirNotaCredito` y `descargarArchivo(..., documento: 'NC')` ya están**, porque el sondeo dejó
  el cuerpo probado. R10.1 solo tiene que llamarlos. `consultarPorReferencia` busca **solo
  facturas**: para notas crédito hay que resolverlo en R10.1.
- **Cualquier HTTP que no sea 2xx, 400, 401, 409 o 422 es `ERROR_PROVEEDOR`** (el plan solo nombraba
  429 y 5xx; un 403 o un 404 no podían quedar sin clasificar).
- **`llamar` no lanza tampoco por credenciales**: un token rechazado vuelve como 401 y se clasifica
  `ERROR_CREDENCIALES`. `probarConexion` sí lanza `FE_CREDENCIALES_INVALIDAS`, que es lo que la
  pantalla de R6 necesita.
- `comprador.js` no limpia a dígitos un pasaporte (`41`): lleva letras.

**Lo aprendido en Orbita (JD&D, en producción con la DIAN desde el 2026-10-07) que este plan no
contemplaba — afecta a R6 y a R12:**

1. **Factus no toma el rango solo.** Después de que el cliente asocia el prefijo en el portal de la
   DIAN, el rango hay que **crearlo por API**: `GET /v2/numbering-ranges/dian` (lo que la DIAN
   tiene asociado) → `POST /v2/numbering-ranges`. Hasta entonces `listarRangos` no lo devuelve.
   Modelo: `sst_ws/scripts/factus-rango-crear-fe.mjs` y `factus-rangos-consultar.mjs`. **R6.1
   necesita esa acción** («Crear rango desde la DIAN»), o el super admin no puede terminar un alta.
2. **El rango de notas crédito es aparte** y tampoco existe solo: en Orbita se creó a mano (sin
   resolución). Sin él R10.1 no puede anular.
3. **El alta de un cliente va por el panel de aliados** de Factus (somos aliado, a nombre de
   Nicolás Pantoja Páez): se radica la solicitud con el paquete, Factus activa y entrega las
   credenciales de producción de **esa** cuenta. El certificado viene con el paquete y queda a
   nombre del cliente. En la DIAN el software sale como «software propio» del cliente.
4. **Las credenciales de producción de un cliente nunca pasan por un `.env` local ni por un chat**:
   se cargan en R6.2, desde el navegador del super admin, directo a `credenciales_cifradas`.
5. Orbita usa 30 s de timeout con Factus y aquí son 8 s (`TIMEOUT_MS`). Con la idempotencia de P1
   un corte temprano no duplica, pero si en producción se ven muchos `ERROR_RED`, es lo primero que
   mirar.

**`WHATSAPP_TOKEN_KEY`:** estaba vacía en el `.env` de este PC; se generó una **solo de desarrollo**
el 2026-10-08. El nombre es histórico (nació con los tokens de WhatsApp): es la única clave del
servidor para todo lo que se custodia cifrado por negocio, no una clave de WhatsApp ni una por
negocio. ⚠️ Cada PC de desarrollo tiene la suya, así que **las credenciales que un dev guarda en la
base compartida el otro no las puede descifrar**: para emitir desde el otro PC hay que volver a
correr `fe_configurar_sandbox.js` allí (o compartir la clave de desarrollo).

### 2026-10-09 — Facturar solo lo que se pide, y el interruptor con ventana (D20)

Tras ver las pantallas, el usuario cambió dos cosas:

1. **«Factura a nombre de» ya no es una casilla con campos dentro del cobro.** En Pedidos hay un
   interruptor **«Factura electrónica»** en el hueco junto al selector de mesa (o al aviso «Para
   llevar», o al botón del domicilio), y al marcarlo se abre una **ventana** con dos pestañas:
   «Con datos del cliente» (la que abre por defecto) y «Anónima». Es
   `shared/factura-chip/` (`FacturaChipComponent`), controlado: lo elegido vive en la pantalla
   (`facturaPedido`) para que no se pierda al cambiar de «En mesa» a «Para llevar». En Mesas y
   Despacho el mismo interruptor va dentro del selector de pago, debajo del desplegable.
2. **Facturar es opcional por cobro (D20).** Sin marcar el interruptor, el cobro **no** se
   factura. El contrato del cobro quedó así: sin `factura` → no se factura;
   `factura: { consumidor_final: true }` → anónima; `factura: { tipo_persona, … }` → a nombre
   del cliente. `fe_configuracion.facturar_todo` (nueva, `false` por defecto; la migración
   `migrate:facturacion-emision` la añade y está aplicada en la local y en la compartida)
   devuelve el comportamiento anterior, y **la reconciliación solo corre para esos negocios**:
   en los demás no hay forma de saber si a un pedido le falta la factura o nadie la pidió.

Consecuencias que conviene tener presentes:

- **⚠️ Decidir qué se factura es responsabilidad del negocio, no nuestra.** Quien está obligado a
  facturar lo está por cada venta; ofrecer el interruptor no cambia eso. Tiene que quedar dicho
  en los términos del servicio, igual que la declaración de registro (ver
  `docs/obligaciones-escalapp.md`).
- Una **anónima** no vale por encima del tope de 5 UVT: la ventana no deja elegirla, y si el
  pedido crece después de elegirla el cobro avisa (`avisoFacturaIncompleta`).
- El **cobro directo desde la tarjeta de Despacho** no factura (no hay dónde pedirlo): hay que
  abrir el detalle.
- `modo_facturacion` POS/COMPLETO ya no cambia nada en la pantalla (D11 queda sin efecto): la
  ventana abre siempre en «Con datos del cliente».
- `DatosFacturaComponent` quedó en solo el formulario (sin interruptor ni tope); lo usan la
  ventana y la fila «Completar datos» de Caja.
- En el panel del super admin hay una tarjeta nueva, «5. Qué cobros se facturan».

Verificado: 136 pruebas de facturación en el backend, 367 en `restaurante_app`, y visto en el
navegador el interruptor en Pedidos (modo «Para llevar») y la ventana abierta. **No visto:** Mesas,
Despacho, la pestaña «Anónima» y un cobro completo desde la interfaz.

### 2026-10-08 (madrugada del 9) — R6 a R11

**Hecho y commiteado** en `feature/facturacion-emision`: R6.1, R6.2, R7.1–R7.4, R8.1, R8.2, R9.1,
R9.2, R10.1 y R11.1. Backend: 130 pruebas de facturación en verde; restaurante 233/235 (las mismas
dos de datos locales). `restaurante_app`: 359 pruebas en verde y build de producción correcto.
`admin_app-v21`: las 9 del componente nuevo en verde y build correcto; **3 archivos de prueba
fallan igual que antes de estos cambios** (`app.spec`, `admin.service.spec`,
`admin-dashboard.component.spec`: comprobado con `git stash`).

**⚠️ Ninguna pantalla se ha visto en un navegador.** Compilan y sus pruebas pasan, pero el aspecto
—sobre todo «Factura a nombre de» dentro del cobro de Mesas, que es un panel estrecho, y la tabla
de Facturas en un teléfono— está por mirar.

**Probado contra el sandbox real:** las rutas nuevas por HTTP con el backend en el puerto 3011
(el super admin configura, prueba la conexión, sincroniza y ve lo asociado en la DIAN; un admin de
negocio recibe **403** en las siete; pedir el PDF de otro negocio da **404**), completar el
comprador de una factura que lo esperaba (`SETP990024156`) y la nota crédito de una anulación
(`CRTE871`, que anula `SETP990024154`).

**No probado:** `POST …/rangos` (crear un rango) contra el sandbox: crearía un rango de verdad en
la cuenta de pruebas que comparten todos. Está cubierto con `fetch` simulado y con el cuerpo que
ya funcionó en Orbita. La anulación desde la pantalla de Caja tampoco: el usuario 1 no tiene el
permiso `caja_eliminar_pedido`, así que el gancho se llamó directamente (el pedido `FE-E2E-A`
del negocio 17 quedó con nota crédito pero **sin anular en caja**: es un dato de prueba incoherente).

**Lo que se añadió sobre el plan:**

- **Crear el rango en el proveedor** (`GET …/rangos/dian`, `POST …/rangos`), que el plan no tenía
  y sin lo cual un alta no se termina (aprendido en Orbita). En la pantalla va plegado dentro de
  «Numeración», con un botón que rellena el formulario con lo que la DIAN tiene asociado.
- `GET /restaurante/facturacion/estado` devuelve además `medios_pago`, `impuestos` y
  `alertas`: así la carta y Configuración no llevan esas listas quemadas.
- `resumen()` incluye `tipo`, `cufe` y `url_qr` (lo necesitará R11.2).

**Desviaciones:**

- **La pestaña Facturas completa los datos en una fila desplegable, no en un modal.** Usa el mismo
  `DatosFacturaComponent` del cobro, con `[siempre]="true"` (sin interruptor).
- **`PagoSeleccion` lleva `factura` y además `facturaValida`.** `valido` ya incluye la factura,
  como pedía el plan, pero las pantallas necesitaban saber QUÉ falla para no decir «elige una
  forma de pago» a quien ya la eligió: `avisoFacturaIncompleta()`.
- **El cobro directo desde la tarjeta de Despacho** (`seleccionGuardada`) no pregunta «a nombre de
  quién»: sale a consumidor final, y si supera el tope queda en `PENDIENTE_DATOS` para completarlo
  en Caja.
- **La unidad de medida no se pregunta en la carta**: Factus solo acepta `94` y el adaptador la
  fuerza. Un campo de texto libre ahí solo serviría para escribir algo que no vale.
- **El tipo de pago para la factura se guarda al elegirlo** en la lista de formas de pago, sin
  entrar a editar. La forma de pago «Cuenta / Tiquetera» no lo pregunta (siempre «otro», D19).
- `listarRangos`/`consultarPorReferencia` para notas crédito: no hizo falta; una nota que falla se
  reenvía con su misma referencia.
- `alAnularPedido` espera `FE_ESPERA_ANULAR_MS` (10 s por defecto) si el documento está
  `ENVIANDO`. No está en `.env.example` a propósito: solo existe para que las pruebas no esperen.

**⏸ R11.2 (número, CUFE y QR en el comprobante impreso) — espera dos decisiones del usuario:**

1. **Qué librería de QR usar** (el plan prohíbe añadir dependencias sin preguntar).
   `sst_ws` de Orbita ya usa `qrcode`.
2. **El orden en Pedidos y Mesas:** hoy se pregunta «¿imprimir?» y se imprime **antes** de cobrar,
   así que al imprimir todavía no hay factura. Para que el tiquete lleve el CUFE habría que
   imprimir después de la respuesta del cobro — es decir, esperar los segundos de la DIAN antes
   de que salga el papel. Es un cambio en cómo trabaja el cajero, no un detalle de código.

### 2026-10-08 (noche) — R4 y R5

**Hecho, sin commitear:** R4.1–R4.6 y R5.1–R5.3. `DB_PORT=5432 npx jest __tests__/facturacion
--forceExit`: 118 pruebas en verde. `__tests__/restaurante`: 233 de 235; las dos que fallan
(`proveedores` «el historial…» y `auditoria_actor` «cerrarCaja…») dependen de datos de la base
local —un negocio sin insumos en gramos y una caja con pedidos pendientes— y no pasan por el cobro.

**R5.3, de punta a punta en la compartida** (negocio 17 «RESTAURANTE CHAYANE», configurado con
`fe_configurar_sandbox.js 17 --aplicar`; rangos FV 389 y NC 1776): tres pedidos cobrados con el
`PedidoService.marcarPagado` real y `FEATURES_FORZADAS=facturacion_electronica`:

| Pedido | Resultado |
|---|---|
| $33.000 a consumidor final | `SETP990024154`, ACEPTADO, PDF y XML archivados |
| $16.000 a nombre de NIT 900123456 | `SETP990024155`, ACEPTADO |
| $320.000 sin comprador | `PENDIENTE_DATOS`, no se envió (D10) |

El cobro con factura tardó **4–5 s** en responder. Casi todo es la latencia del túnel a la base
(138 ms por consulta) más los ~2 s de Factus; en producción la base es local. Aun así, **es lo
que va a notar el cajero**: `FE_ESPERA_MS` es el tope de esa espera. No se probó la llegada del
correo (los compradores de prueba iban sin correo).

**Desviaciones y hallazgos de R4/R5:**

- **La referencia en PRUEBAS lleva un sufijo aleatorio** (`EAP17-FV-1150-3f9a1c2e`). Todas las
  bases de desarrollo emiten contra la MISMA cuenta del sandbox y Factus devuelve el documento
  existente cuando se repite una referencia: sin el sufijo, el pedido 10 de la base local habría
  recibido sin error la factura del pedido 10 de la compartida. En producción la referencia sigue
  siendo `EA<negocio>-FV-<orden>`.
- **`crearDocumentoPedido` empieza por una sola consulta** (¿este negocio tiene configuración
  activa?) antes de leer el pedido. Es D12 en otro orden: al negocio que no factura —casi todos—
  el cobro le cuesta una consulta y nada más.
- **`leerPedido` devuelve también `impuestoDomicilio`**, ya resuelto con D7 (un negocio no
  responsable tampoco le pone impuesto al domicilio).
- **Si el proveedor lanza una excepción, `alCobrarPedido` devuelve el resumen en `ERROR`**, no
  `null` como decía R4.6 caso 6: el documento existe y la caja lo puede ver. `null` queda para
  «este negocio no factura» y para un fallo anterior a crear el documento.
- **Un error nuestro (`FE_SIN_CREDENCIALES`, `FE_SIN_RANGO`, `FE_SIN_LINEAS`) no se reintenta
  solo**: esperar no lo arregla. Queda en `ERROR` hasta que alguien pulse «Reintentar».
- **`reintentar` y `completarComprador` estrenan referencia solo si el documento estaba
  RECHAZADO** (sufijo `-r<intentos>`): en Orbita se vio que la referencia de un rechazado queda
  gastada. Un `ERROR` reintenta con la misma, que es lo que lo hace idempotente.
- **El gancho usa `adjuntarFactura()`** en vez de escribir en `orden.dataValues` directamente: la
  orden ya está cobrada y confirmada, y esa línea no puede lanzar venga la orden como venga.
- Los validadores de `factura` responden **422**, como el resto de ese controlador (el plan decía
  400).
- 🐛 **Arreglado un fallo de FE-1 que está en producción:** `datosFiscales.actualizar` no podía
  guardar `responsabilidades_fiscales` ni `tributos` («malformed array literal»), o sea que
  **la pantalla `/admin/facturacion` falla al guardar esos dos campos**. La suite no lo veía
  porque los fijaba con SQL directo. Corregido aquí y con prueba; **falta desplegarlo**.
- Se aplicaron en la **compartida** las tres migraciones del 2026-10-07 que estaban pendientes
  (`restaurante-cambio-cliente`, `negocio-asistente-stock`, `negocio-tiempo-recoger`): sin la
  primera, `marcarPagado` fallaba ahí para cualquiera. Y en la **local**,
  `restaurante-metodo-pago-domicilio` y `restaurante-proveedores`, que le faltaban.
- El negocio 17 de la compartida quedó declarado REGISTRADO, en modo POS, con la ficha de la
  empresa del sandbox y en `EN_PRUEBAS`. Antes estaba en `SIN_REGISTRO`. Sin la feature forzada
  no cambia nada para quien lo use.
