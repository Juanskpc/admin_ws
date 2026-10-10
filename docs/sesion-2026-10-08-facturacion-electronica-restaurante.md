# Sesión 2026-10-08/09 — Facturación electrónica del restaurante, de cero a producción

> **Punto de entrada para retomar la facturación electrónica.** El detalle tarea por tarea, las
> decisiones (D1–D20) y las notas del implementador están en
> [`plan-fe-restaurante.md`](plan-fe-restaurante.md) §2, §3 y §7. Esto es el resumen y el «cómo
> seguir».

## 0. Estado en una frase

**FE-2 y FE-3 del restaurante están en producción desde el 2026-10-09 00:50**, y no cambian nada
para ningún cliente hasta que el super admin configure uno. Faltan el QR en el tiquete impreso
(R11.2, espera decisiones) y el alta del primer cliente real.

| Repo | Commit desplegado | Rama |
|---|---|---|
| `admin_ws` | `5c650ef` (+ docs `285a2f4`) | `master` |
| `admin_app-v21` | `fa1d511` | `main` |
| `restaurante_app` | `11d9c0b` | `master` **y** `main` (iguales; ver §4) |

## 1. Qué hace hoy

- **Cobro con factura opcional (D20).** En Pedidos, junto al selector de mesa / «Para llevar» /
  domicilio, hay un recuadro **«Factura electrónica»**. Al marcarlo se abre una ventana con dos
  pestañas: **«Con datos del cliente»** (por defecto) y **«Anónima»** (consumidor final). Sin
  marcarlo, el cobro **no** se factura. El super admin puede hacer que un negocio facture todos sus
  cobros (`fe_configuracion.facturar_todo`).
- **La factura pedida viaja con el pedido** (`pedid_orden.factura_solicitada`): Mesas y Despacho
  abren el cobro con ella marcada, y el cobro directo desde la tarjeta de Despacho también la usa.
  En Mesas y Despacho la ventana esconde el modal de cobro mientras está abierta.
- **Emisión** por Factus (una cuenta por negocio, credenciales cifradas con `WHATSAPP_TOKEN_KEY` —el
  nombre es histórico—), con reintentos solos, reconciliación (solo para quien factura todo), copia
  propia del PDF y el XML, y nota crédito al anular un pedido cobrado.
- **El correo al comprador lo envía EscalApp**, no Factus (`send_email: false`): diseño del
  comprobante de pago de «Mis pagos», con **el color y el logo del negocio**, PDF y XML adjuntos.
  Una sola vez por documento (`fe_documento.correo_enviado_en`).
- **Pantallas:** «Emisión — solo super admin» en `/admin/facturacion` (credenciales, probar
  conexión, rangos —incluido crearlos en Factus—, impuestos por defecto, qué cobros se facturan,
  activar); pestaña **Facturas** en Caja (ver PDF, reintentar, completar datos); impuesto por
  producto en la carta y tipo de pago DIAN en Configuración → formas de pago.

## 2. Cómo probarlo en desarrollo

1. `.env` de `admin_ws`: `FEATURES_FORZADAS=facturacion_electronica` (ya está en el de este PC) y
   las `FACTUS_*` del sandbox.
2. Negocio de pruebas: **el 17 de la base compartida** («RESTAURANTE CHAYANE»), ya configurado con
   `node scripts/fe_configurar_sandbox.js 17 --aplicar`. Para otro negocio, el mismo script.
3. Cobrar un pedido con «Factura electrónica» marcada → Caja → Facturas.
4. ⚠️ **El sandbox de Factus no envía correos** a direcciones no autorizadas («El correo no está
   autorizado para recibir correos en el entorno sandbox»). Da igual: el correo lo manda EscalApp,
   y en pruebas sale rotulado «Ejemplo».
5. Pruebas: `DB_PORT=5432 npx jest __tests__/facturacion --forceExit` (139) y `npm test` en
   `restaurante_app` y `admin_app-v21`.

## 3. Cómo seguir (en este orden)

1. **R11.2 — QR y CUFE en el tiquete impreso.** Librería decidida el 2026-10-09: **`qrcode`**. Ese
   día se hizo la base y **se desplegó a producción el 2026-10-09 a las 16:35** (`admin_ws`
   `05aff29`, `restaurante_app` `e24d930`, ambos en `master`; respaldos `db_2026-10-09_1634.dump` y
   `web_restaurante_20261009_1635.tgz` en `/home/escalapp/backups/`; migración aplicada en
   producción, compartida y local). **`main` de `restaurante_app` quedó en `11d9c0b`, detrás de
   `master`**: Juan David tiene que mezclar `master` en `main`. Pestaña **Configuración → Tiquete**, donde el negocio arma su tiquete común y el de
   factura electrónica con vista previa al lado. Lo que exige la DIAN (emisor, número, resolución,
   CUFE, QR, comprador, impuestos, forma de pago) no es opción: sale siempre. Tabla
   `restaurante.tiquete_diseno` (`npm run migrate:restaurante-tiquete-diseno`), API
   `GET/PUT /restaurante/tiquete/diseno`, y una sola función que dibuja el tiquete
   (`shared/tiquete-diseno/tiquete-diseno.ts → construirTiqueteHtml`). **Falta** que Pedidos, Mesas
   y Despacho impriman con esa función (hoy cada uno tiene su copia) y decidir **cuándo** se
   imprime la factura: la propuesta del usuario es que, con factura electrónica, salgan **dos**
   tiquetes —el común para cocina y la factura para el cliente—, y eso obliga a imprimir la
   factura **después** del cobro, cuando ya hay CUFE.

   **Nada del proveedor se le muestra a nadie** (decisión del 2026-10-09): «Ver en línea» del
   correo y de Caja → Facturas abre la consulta de la DIAN por CUFE (`urlConsultaDian` en
   `app_core/facturacion/constantes.js`), no `url_publica`, que es una página de Factus. El PDF de
   Factus no trae su marca: lo que sale de Factus en el sandbox (logo, «FACTUS V2», NIT 1000789002-2)
   es la empresa de pruebas a cuyo nombre se factura allí. El logo del PDF real lo pone Factus con
   el que le mande cada cliente al activarse (no hay API para cambiarlo). El negocio 17 de la
   compartida tiene el logo de EscalApp, pero el archivo solo existe en el PC donde se subió.
2. **Revisar en pantalla lo que no se vio:** la tarjeta «Qué cobros se facturan» del panel, el
   impuesto en la carta, el tipo de pago en Configuración y la vista de teléfono de Pedidos.
3. **Primer cliente real:** alta en el panel de aliados de Factus (paquete individual), credenciales
   de **su** cuenta cargadas desde «Emisión», el cliente asocia el prefijo en el portal de la DIAN,
   y desde «Emisión» → «Crear un rango en el proveedor» (Factus no lo toma solo). Luego «Pasar a
   pruebas» o «Activar». Antes: confirmar con su contador el impuesto (INC 8 % o ninguno).
4. **Términos del servicio:** cláusulas 5–7 nuevas en `docs/legal/terminos-y-condiciones.md` §7
   (qué se factura lo decide el cliente; los datos del comprador los pone él; el envío del correo).
   Siguen siendo **borrador** hasta que las revise un abogado.
5. Sin decidir (comercial): qué plan incluye la feature `facturacion_electronica` y quién pone la
   plata del paquete anual de Factus (`precios-y-planes.md` §3).

## 4. Trampas de esta sesión (no volver a pagarlas)

- **`restaurante_app` tiene DOS ramas vivas, `master` y `main`, y Juan David trabaja en `main`.**
  Mirar solo `origin/master` casi borra de producción su Bandeja de conversaciones. Antes de
  desplegar: mezclar las dos y comparar los **textos** del build con los .js del VPS.
- **Un choque de merge que abarca el archivo entero son los finales de línea.** Se resolvió
  tomando su versión y aplicando `git diff --ignore-cr-at-eol <base> HEAD -- <archivo>`.
- **Migraciones con el registro nuevo:** `node scripts/migrar.js --pendientes` y
  `node scripts/migrar.js facturacion-emision`. La de emisión va **antes** del reinicio: el modelo
  ya pide `rest_metodo_pago.codigo_medio_pago_dian` y `pedid_orden.factura_solicitada`.
- **El número de pedido se calcula con `SUBSTRING(numero_orden FROM 5)`**: un pedido con un número
  que no sea `ORD-NNNN` (los de prueba se llamaron `FE-E2E-…`) bloquea crear pedidos en ese
  negocio. Se renumeraron a `ORD-0050..52` en la compartida.
- **La clave SMTP buena hoy es la del VPS;** la local estaba rota y se copió la de producción.
  Probar con `nodemailer … .verify()` antes de culpar al código.
- **Los logos de negocio viven en el disco del VPS**; en desarrollo sus URLs (que apuntan a
  `api.escalapp.cloud`) dan 404 para negocios creados en otro PC. El correo usa la inicial.
- **Escribir notas con comillas invertidas desde `node -e` en Bash las destruye** (sustitución de
  comandos). Usar un script con Write.

## 5. Facturas de prueba en el sandbox

Sondeo `SETP990024139–46` y `CRTE869`; humo del adaptador `SETP990024149–50` y `CRTE870`; cobros
reales del negocio 17 `SETP990024154–56`, `SETP990024199`, `SETP990024207` (con correo enviado) y
la nota `CRTE871` (anula la 154).
