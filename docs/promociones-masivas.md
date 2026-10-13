# Promoción masiva por WhatsApp — análisis de viabilidad y diseño

**Estado:** **F0, F1 y F2 construidas** (§11, §12, §13) · sin desplegar y con la migración de F2
pendiente de correr · **Fecha:** 2026-10-13 ·
**Hermanos:** [`whatsapp-costo-mensajes.md`](whatsapp-costo-mensajes.md) (qué cobra Meta) ·
[`asistente-economia.md`](asistente-economia.md) (quién le paga a quién) ·
[`cobro-mensualidades.md`](cobro-mensualidades.md) (los rieles de cobro) ·
[`embedded-signup.md`](embedded-signup.md) §9.1 (de quién es la WABA) ·
[`legal/anexo-encargado-tratamiento.md`](legal/anexo-encargado-tratamiento.md) (quién responde ante la SIC)

> **En una frase.** Es viable y casi todo el músculo ya está construido —la ficha del cliente, el
> consentimiento, el canal, el cobro—, pero **el cuello de botella no es técnico: es la lista de
> autorizados, que hoy está vacía**, y el riesgo no es el costo sino la calificación de calidad del
> número, que si cae se lleva por delante el canal que le trae el 39 % de los pedidos. Y el dinero:
> cobrarlo por mensaje rinde menos que meterlo en el plan Avanzado.

---

## 1. Lo que ya está hecho (y por eso esto es barato)

| Pieza | Dónde | Qué falta |
|---|---|---|
| Ficha del cliente, común a verticales | `platform.persona_negocio` (ADR-006) | nada |
| **La salida y su prueba** | `persona_negocio.promos_excluido` + origen y prueba | ✅ **hecho** — F0, §11 |
| Etiquetas libres por cliente | `persona_negocio.etiquetas text[]` | nada |
| Los datos de segmentación ya calculados | `cuentaService.listarDirectorio` — `pedidos`, `total_gastado`, `ultimo_pedido` | ✅ **generalizado** — F1, §12 |
| Envío con el número y token **del inquilino** | `intelligence/channels/whatsapp/api.js` → `enviarMensaje` acepta cualquier `payload` | nada |
| Catálogo de plantillas y su contrato con Meta | `intelligence/core/plantillas.js` | ✅ **dos plantillas MARKETING** — F2, §13 |
| Cola de salida con entrega al-menos-una-vez | el entregador de F5-C sobre `intelligence.mensaje` | ✅ **ritmo propio** — F2, §13.5 |
| Estado de entrega por mensaje | `intelligence.mensaje.estado_entrega` + `crudo.acuse` | ✅ **ya traía el código** — F2, §13.1 |
| Medidor de cuota y aviso al 80 % | `channels/whatsapp/cuota.js`, `avisos/cuotaWhatsapp.js` | nada |
| Cobro, pasarelas, facturas, prorrateo | esquema `cobranza` + adaptadores Wompi/dLocal/manual | compra de **un solo pago** (§5.3) |
| Paquetes vendibles de mensajes | complemento `MENSAJES_ASISTENTE` ($19.999 / 6.000 msj/mes) | nada — se reusa de cross-sell |

**Nada de esto hay que inventarlo.** Lo nuevo es: segmentos, biblioteca de plantillas por inquilino,
campañas con su libro de destinatarios, créditos, y una vista.

---

## 2. La plata: tres cuentas distintas que no hay que mezclar

### 2.1 Lo que Meta le cobra al inquilino

Confirmado: un mensaje **MARKETING** no es un mensaje de servicio. No entra en la asignación de
1.000 gratis (esa es solo de servicio) y se cobra **desde el primero**.

| Categoría, a un número colombiano | USD/mensaje | ≈ COP (a 4.000) |
|---|---|---|
| Servicio (texto libre en ventana de 24 h) | 0,0008 | $3,2 — y los primeros 1.000 del mes, gratis |
| Utility (`pedido_listo`, `recordatorio_cita`) | 0,0008 | $3,2 |
| **Marketing (esto)** | **0,0125** | **$50** |

> **Sí, es mucho más caro: ~15,6 veces.** Era la sospecha a validar y se confirma. Y lo paga **el
> inquilino con su tarjeta**, no nosotros: como Tech Provider, su número vive en una WABA y una
> empresa separadas de las nuestras ([`embedded-signup.md`](embedded-signup.md) §9.1). Por eso
> **no podemos revender mensajes de Meta** — igual que con el asistente.

Un detalle que juega a favor y conviene saber: una plantilla de marketing mandada **dentro** de una
ventana de 24 h abierta **se cobra igual**, pero **no cuenta** contra el tope por usuario de §6.5.
No sirve para dormidos (que es el caso de uso), pero sí para el que acaba de escribir.

⚠️ **Dos cosas a verificar antes de publicar un precio:**

1. **El *rate card* en COP, no el de dólares.** COP es moneda de facturación de Meta desde el
   2026-04-01, así que el inquilino probablemente se vea cobrado en pesos a la tarifa en pesos, que
   no es el dólar por la TRM del día. Los precios solo cambian el 1 de enero / abril / julio /
   octubre y con 1 mes de aviso: **la tarifa debe ser un dato con fecha en la base, no una constante
   en el código.**
2. La página de precios de Meta marca **«Colombia – Higher utility and authentication rates»**
   desde el 2025-10-01. Nuestro $0,0008 de utility sale del *rate card* leído por el dueño y de dos
   tablas de terceros, pero esa nota huele a que Colombia tiene una fila propia. Vale revisarlo,
   porque si el utility subió, el costo del **asistente** sube con él.

### 2.2 Lo que nos cuesta a nosotros

**Mandar, casi nada.** No hay IA en el envío: es un POST por destinatario. La imagen la sirve Node
desde `uploads/`, ya desplegado.

**Lo que sí cuesta es el éxito.** Una promoción que funciona devuelve conversaciones, y una
conversación son **9,1 mensajes salientes del asistente** (medido, mes completo de Zona Burger):

| Campaña de 400 destinatarios | |
|---|---|
| Costo Meta del envío (al inquilino) | **$20.000 COP** |
| Si responde el 10 % (40 conversaciones) | 364 mensajes de servicio |
| …que a él le cuestan (si ya gastó sus 1.000 gratis) | ~$1.165 COP |
| …que a **nosotros** nos cuestan en IA (364 × $0,93) | **$339 COP** |
| …y que consumen de su techo contratado de 6.000 | **6 %** |

> ⚠️ **El riesgo operativo escondido: el freno.** Zona Burger ya iba camino de ~6.300 mensajes al
> mes contra un techo de 6.000. Una promoción exitosa lo empuja al freno **justo cuando llegan los
> pedidos**, y el freno degrada el asistente. El simulador tiene que mirar `cuota.consumoDe()` y
> decirlo antes: *«esta promoción puede gastar ~400 mensajes y te quedan 180; necesitas un paquete»*.
> Es el cross-sell más natural que tiene el producto y a la vez el fallo más vergonzoso si no se avisa.
>
> Nota técnica a favor: los mensajes de campaña **no** contaminan ese techo, porque la consulta de
> `cuota.js` ya excluye lo que lleva `plantilla IS NOT NULL`. Lo que lo consume son **las
> respuestas**, que es justo lo que hay que presupuestar.

### 2.3 Lo que podemos cobrar — y la conclusión incómoda

Cobrar por mensaje, con la cartera de hoy:

| Supuesto | Cifra |
|---|---|
| Negocios activos | 9 (1 con uso real del asistente) |
| Adopción realista año 1 | 3–5 negocios · 1–2 campañas/mes · ~400 destinatarios |
| A $25 COP nuestros por mensaje | **$30.000 – $100.000 COP/mes** |
| Comisión de pasarela sobre un pago de $10.000 | 11,6 % (2,65 % + $700 + IVA) |
| Trabajo estimado | 3–5 semanas |

**Eso es entre medio plan Avanzado y dos planes.** Como línea de ingreso, hoy es marginal.

Ahora la comparación que cambia la decisión: la diferencia entre Básico y Avanzado es **$32.000 al
mes**. Si «Promociones, 300 envíos incluidos» mueve **un solo** cliente de Básico a Avanzado y lo
retiene un año, son **$384.000** — más que todo el ingreso por mensaje de la cartera entera. Y a
nosotros los 300 envíos nos cuestan **$0**, porque el envío se lo cobra Meta a él.

> **Recomendación comercial, en contra de lo que parecía:** el motor económico de esto **no es
> venderlo por mensaje, es que sea razón para subir de plan.** El precio por mensaje sirve para
> otras dos cosas, que no son poco: **ser un freno al spam** (lo gratis e ilimitado es exactamente
> lo que quema la calificación del número) y **cobrar la cola larga** del que manda 3.000.
>
> Modelo híbrido propuesto:
>
> - **Plan Avanzado incluye 300 envíos/mes**, no acumulables.
> - **Básico: 0 incluidos**, puede comprar créditos.
> - **Créditos extra de un solo pago**, 12 meses de vigencia:
>
>   | Paquete | Precio | Por envío |
>   |---|---|---|
>   | 300 | $9.900 | $33 |
>   | 1.000 | $24.900 | $25 |
>   | 3.000 | $59.900 | $20 |
>
> - **Nada por debajo de $9.900:** la pasarela se lleva un fijo de $700 + IVA, y un cobro de $3.000
>   es 28 % de comisión. Un pago pequeño no es un pago, es una donación a Wompi.
> - **1 crédito = 1 mensaje ENTREGADO.** Lo fallido se devuelve solo (§6.5). Cobrar un mensaje que
>   Meta no entregó es la clase de detalle que cuesta un cliente.

### 2.4 Lo que gana el negocio — la cuenta que va en el simulador

No prometer tasas de respuesta que no hemos medido. Lo que sí se puede calcular con sus datos:

```
Costo total       = destinatarios × (tarifa Meta + nuestro crédito)
Pedidos para empatar = Costo total / (ticket promedio × margen)
```

Con 400 dormidos, ticket real de $27.321 y margen 30 % (configurable):
costo $20.000 + $10.000 = $30.000 → **necesita 3,7 pedidos**, el **0,9 %** de los enviados.

Esa es la frase del simulador: **«si vuelven 4 de estos 400 clientes, la promoción se pagó»**. Es
verificable después, con la atribución de §6.6 — y ahí el producto deja de venderse con promesas.

⚠️ **Hacer la cuenta con margen, no con venta.** Con venta (400 × $50 = $20.000 contra un pedido de
$27.321) sale «con un pedido ya ganaste», que es mentira: de ese pedido el restaurante se queda con
~$8.200. Una promesa inflada en el simulador es la forma más rápida de que el dueño no vuelva a
confiar en una cifra nuestra.

---

## 3. El muro técnico que casi nadie ve a tiempo: la plantilla

Un mensaje a alguien que no escribió en las últimas 24 h **solo sale por plantilla aprobada por
Meta, palabra por palabra** (ya está escrito en `plantillas.js`, y ya mordió una vez con `es` vs
`es_CO` → `#132001`). Y una promoción es texto nuevo cada semana.

Las dos salidas, y hay que tomar las dos:

1. **Biblioteca de 2–3 plantillas MARKETING reusables, con huecos**, creadas y aprobadas **en el
   alta del canal, no cuando el dueño quiere mandar la promo el viernes a las 6 p.m.** Encabezado
   IMAGE (la imagen se manda en el envío, no en la plantilla) + cuerpo con 2–3 variables:

   > Encabezado: `[imagen]`
   > `Hola {{1}}, en {{2}} tenemos algo para ti: {{3}}.` *(válido hasta {{4}})*
   > `Responde a este mensaje y te atendemos.`
   > Botones: `Ver la carta` (URL) · `No quiero promociones` (respuesta rápida)

   Reglas de Meta que esto respeta y que se rechazan si no: **no terminar en variable**, sin saltos
   de línea ni tabulaciones dentro de una variable, y que el cuerpo no sea casi todo huecos.

2. **Creación de plantilla a medida por API** (`POST /{waba_id}/message_templates` con el token del
   inquilino, scope `whatsapp_business_management`) + seguimiento del estado por el webhook
   `message_template_status_update`. Es lo que hace cualquier plataforma de campañas, y es lo que
   permite una promo con texto libre. **Pero la aprobación tarda de minutos a 24 h y puede
   rechazarse**, así que la campaña necesita el estado `PENDIENTE_PLANTILLA` y no puede prometer
   hora de salida.

⚠️ **Y la pregunta que hay que contestar mirando la base antes de escribir una línea:** ¿cuáles
inquilinos salen con **token propio** (`numero_canal.origen = 'embedded_signup'`) y cuáles caen al
token global? Porque el que cae al global **manda por NUESTRA WABA**: Meta nos cobraría a nosotros
el marketing y su mala calidad sería nuestra calificación. **A esos hay que bloquearles la función**
hasta que conecten su número.

---

## 4. Al cliente final no se le pregunta nada

**Decisión del dueño, 2026-10-12, y da forma a todo lo demás.** La primera versión de este
documento proponía que el asistente preguntara a cada cliente si quería recibir promociones. Se
descartó, y el argumento es bueno:

> Nadie pregunta eso. A ningún consumidor le preguntaron si quería la publicidad que recibe: le
> llega, y la ignora o se da de baja. Y al comensal que está pidiendo una hamburguesa, una pregunta
> sobre publicidad no le aporta nada — no la pidió, no la espera, y alarga el único mensaje que sí
> quería leer.

Así que el modelo es **lista por defecto con exclusiones**, no lista de autorizados:

| | |
|---|---|
| **Audiencia** | todo cliente del negocio con teléfono: `platform.persona_negocio`, que solo nace de un pedido confirmado o de una cuenta abierta a mano. **No hay desconocidos ahí dentro.** |
| **Lo que saca a alguien** | `promos_excluido` — pidió la baja. Es lo único que bloquea un envío |
| **Lo que no se mira** | `consentimiento_mensajeria` (ADR-006). Sigue significando «dijo que sí explícitamente», nadie la pone en `true`, y usarla como filtro dejaría la audiencia en cero para siempre |
| **El flujo conversacional** | **no se toca.** Lo único que el asistente hace con las promociones es atender la baja si alguien la escribe |

### 4.1 Lo que esto deja en pie, y hay que resolver donde sí se puede

El marco no desaparece porque no preguntemos:

- **Meta** exige opt-in para marketing. Lo que **no** exige es que sea una pregunta en el chat:
  vale cualquier canal donde quede claro que el negocio escribirá por WhatsApp. Las formas
  realistas, en orden de esfuerzo: la **línea en la promoción misma** («recibes esto porque has
  pedido en X — responde *no promos* para no recibir más»), una **casilla en la carta o la vitrina**
  y un **aviso en los términos del negocio**. Las tres son avisos, no preguntas, y ninguna
  interrumpe a nadie.
- **Ley 1581 de 2012 / SIC:** el negocio es el **Responsable** y nosotros el **Encargado**
  ([`legal/anexo-encargado-tratamiento.md`](legal/anexo-encargado-tratamiento.md) §1). La relación
  con el titular es suya, y la decisión de mandarle publicidad a su propia clientela también.
- ⚠️ **Nuestro anexo §2.5 le hace prometer al cliente «no usar el asistente para comunicaciones no
  solicitadas».** Esa cláusula, tal como está escrita, choca con la función que le vamos a vender.
  **Hay que reescribirla antes del primer envío** — no por formalismo: es una cláusula que nosotros
  le pusimos y que su propio uso del producto incumpliría.

### 4.2 Lo que NO se puede quitar: la salida

Es lo único no negociable, y no por legalismo sino por mecánica:

> Sin una salida visible, el cliente molesto no se da de baja: **bloquea el número o lo reporta**.
> Y eso no lo paga EscalApp — lo paga la **calificación de calidad del número del negocio**, que es
> el mismo por el que le entra el 39 % de los pedidos. El daño es decenas de veces mayor que lo que
> la promoción podía ganar.

Por eso F0 construye exactamente tres cosas (§11): la **baja** por WhatsApp, su **prueba** (con qué
palabras la pidió y cuándo), y el **conteo honesto** de a cuántos se le puede escribir hoy. La
salida va **dentro de la promoción**, que es donde el cliente la busca cuando le molesta, y nunca
antes.

Y una regla que queda fija: **no se importan listas.** Ni CSV ni pegar números. La audiencia es la
que el negocio se ganó atendiendo, y una lista comprada es el vector de spam más directo que existe
— el que puede costarnos la app de Meta para **todos** los inquilinos a la vez.

---

## 5. Los rieles de cobro: qué falta

### 5.1 Lo que ya sirve

`cob_factura` con `referencia` idempotente, `tipo` (`renovacion` | `ajuste`), adaptadores
Wompi/dLocal/manual con una sola superficie, webhooks firmados con respaldo por consulta, y
conciliación. **No se construye un segundo sistema de cobro.**

### 5.2 Lo que NO sirve

El complemento (`cob_suscripcion_complemento`) es **mensual y recurrente**. Un paquete de créditos
es **un solo pago y consumible**. Meterlo ahí haría que renovara solo cada mes: un cobro que el
dueño no pidió.

### 5.3 Lo nuevo

- `cob_factura.tipo` acepta **`compra`** — y `aplicarPagoAprobado` **no le suma ciclo** (ya existe
  ese camino para `ajuste`; es la misma pieza).
- Referencia idempotente propia: `EA-<id_negocio>-C<consecutivo>` (la actual es `EA-6-202610`, por
  mes: no sirve para dos compras el mismo mes).
- **Libro de créditos** `cobranza.cob_credito_campana`: `tipo` (`COMPRA` | `CONSUMO` | `DEVOLUCION` |
  `CORTESIA` | `VENCIMIENTO`), `cantidad` con signo, `id_factura`, `id_campana`, `vence_en`.
  **El saldo se deriva del libro, nunca una columna** — el mismo criterio que `rest_cuenta`, por la
  misma razón: dos verdades sobre la misma plata siempre acaban divergiendo.
- `trg_audit` en `campana` y `cob_credito_campana` **en la misma migración** (regla fija: llevan
  dinero y estado). No en `campana_destinatario`: alta rotación, bajo valor.
- **El retenedor** (`es_retenedor`, pasarela `manual`) no puede comprar con tarjeta: su compra queda
  `pendiente` y un super-admin la marca pagada. Igual que hoy con el plan.
- **Dónde se paga:** el checkout vive en `admin_app_v21` → «Mis pagos». `negocio_app` ya hace
  exactamente esto en `mi-plan-panel.ts`: muestra y salta por SSO. **El crédito se compra antes, en
  Mis pagos; la campaña solo lo gasta.** Mandar al dueño a otro origen a mitad de armar una promo es
  perder la promo.

---

## 6. Diseño técnico

### 6.1 Dónde vive (y por qué sirve para reserva)

Módulo de **plataforma**, no del vertical: `app_core/promociones/`, tablas en `platform`, rutas en
`app_admin_api` (que es donde ya vive lo transversal: cobranza, personas, auditoría).

Lo único que cambia entre verticales es **cuál es el hecho que define a un cliente**: en restaurante
un pedido, en reserva una cita, mañana en gym una asistencia. Eso es un adaptador de 30 líneas:

```js
// app_core/promociones/hechos/{restaurante,reserva}.js
// → { id_persona_negocio, eventos, ultimo_evento, valor_total }
```

El segmentador, la plantilla, los créditos, el envío y los informes son **los mismos**. Es la lección
de `unirRespuestas`: una regla de plataforma metida en un adaptador solo se aplica al adaptador que
la escribió.

### 6.2 Tablas

```
platform.campana                -- nombre, estado, plantilla, parámetros, imagen, segmento (jsonb),
                                -- estimados, creditos_reservados, programada_para (hora Bogotá)
platform.campana_destinatario   -- por persona: estado, motivo_omision, wamid, codigo_error,
                                -- credito_cobrado, respondio_en, id_evento_atribuido
platform.plantilla_promocion    -- biblioteca por negocio: nombre_meta, idioma, estado_meta, cuerpo
cobranza.cob_credito_campana    -- el libro de créditos (§5.3)
```

El **segmento se guarda como definición**, no como lista de personas: así se repite la campaña el mes
siguiente y se audita a quién se decidió escribir y por qué.

Estados de la campaña: `BORRADOR` → `PENDIENTE_PLANTILLA` → `LISTA` → `PROGRAMADA` → `ENVIANDO` →
`ENVIADA`, más `PAUSADA`, `CANCELADA`, `FALLIDA`.

### 6.3 Los segmentos (lo que el dueño pidió)

Sobre `eventos` / `ultimo_evento` / `valor_total`, con umbrales por defecto y ajustables:

| Segmento | Regla por defecto | Para qué |
|---|---|---|
| **Frecuente** | ≥ 4 eventos y último ≤ 30 días | **Los que NO necesitan promoción** (su caso de uso) |
| **Intermedio** | 2–3 eventos, último ≤ 60 días | Subir frecuencia |
| **Ocasional** | 1 evento, último ≤ 60 días | Segunda compra |
| **En riesgo** | último entre 45 y 120 días | **Recuperar** — el de más valor |
| **Dormido** | último > 120 días | Último intento, barato |
| **Alto valor** | `valor_total` en el top 20 % | Trato aparte |

Filtros duros, siempre aplicados y **no desactivables** (todos los aplica `audiencia.esContactable`
más los topes de §6.7): con teléfono E.164 válido · **sin baja** (`promos_excluido`) · sin la
conversación bloqueada · sin promoción nuestra en los últimos N días · no escribiendo ahora mismo
(si tiene ventana abierta, mejor que lo atienda el asistente).

Selección a mano también: la tabla con casillas, sobre el mismo listado.

### 6.4 Envío: ritmo, no ráfaga

- Por la cola (`platform.outbox`) con un **ritmo** propio: Meta aguanta 80/s, pero el límite que
  manda es el **tier de mensajería** (usuarios únicos por 24 h). **Sin verificación de empresa son
  250**: una campaña de 400 hay que partirla en dos días, y hay que **decírselo antes**, no fallar a
  la mitad. Se lee de `GET /{waba_id}/phone_numbers?fields=quality_rating,throughput` y del tier.
- **Nunca entre 21:00 y 08:00** hora de Bogotá. Una promoción a las 11 p.m. es una denuncia.
- **Pausa automática** si la calidad del número cae a amarillo durante el envío, y freno en rojo.

### 6.5 Estados y la devolución de créditos

El webhook de estados ya llega; falta guardar `codigo_error` y actuar:

| Error | Qué significa | Qué hacemos |
|---|---|---|
| `131049` | tope de marketing **por usuario** (lo fija Meta, es adaptativo y no público; cuenta **entre todos los negocios**) | no es culpa de nadie: **devolver el crédito**, no reintentar antes de 24 h |
| `131042` | problema de **método de pago** en la cuenta del cliente | abortar la campaña y mandarlo a arreglarlo en Meta |
| `132001` | plantilla/idioma que no existe | abortar: es bug nuestro |
| número no está en WhatsApp / inválido | | devolver crédito y **marcar la ficha** |

⚠️ **Dos exclusiones de Meta que hay que filtrar antes de cobrar:** las plantillas de marketing
**no se entregan a números de Estados Unidos** (+1), y la tarifa es **por el país del destinatario**
— un `+56` cuesta lo del *rate card* chileno, no el colombiano. El simulador tiene que agrupar por
prefijo.

### 6.6 El informe, que es el producto

Entregados · leídos · respondieron · **pidieron** · venta atribuida · costo Meta · créditos · y
**costo por cliente recuperado**.

Atribución: primer evento (pedido/cita) del destinatario en los **7 días** siguientes al envío, y
cuenta como *recuperado* solo si **no tenía ninguno en los 30 días previos**. Es defendible,
explicable al dueño y se calcula con `id_persona_negocio`, que ya está en `pedid_orden`.

### 6.7 Los frenos, que protegen al cliente de sí mismo

Server-side, no en la interfaz:

- Máximo **1 campaña por semana** por negocio.
- Un cliente final no recibe **más de 2 promociones al mes** del mismo negocio (nuestro tope,
  más estricto que el de Meta).
- Máximo de destinatarios por campaña según el tier del número.
- Permisos nuevos: `promociones_ver` y `promociones_enviar` (gastar plata) — sembrados en **FALSE**
  salvo administrador, y **migrados antes del despliegue del frontend** (la regla de los subniveles:
  «ausente» == «denegado» en la sesión viva).

### 6.8 La compuerta de elegibilidad — «que nada salga mal»

Un solo servicio, `promociones/elegibilidad.js`, que contesta sí/no **con motivo** y lo usan la vista
y la API (esconder un botón no cierra una API):

1. Plan activo.
2. Canal de WhatsApp activo (`numero_canal.estado = 'A'`).
3. **Token propio** (`origen = 'embedded_signup'`). Si sale por nuestra WABA → **no**.
4. Empresa verificada y `quality_rating` no rojo; tier suficiente para el tamaño pedido.
5. Plantilla `APPROVED` en **su** WABA.
6. **Mensaje de prueba al número del dueño, entregado.** Cuesta $50 y valida de una vez las tres
   cosas que no se pueden consultar con fiabilidad: que hay método de pago en Meta (si no, `131042`),
   que la plantilla existe con ese idioma, y que el número puede mandar marketing. **Ninguna campaña
   se cobra sin que la prueba haya llegado.**
7. Créditos suficientes (o envíos incluidos del plan).
8. Contactables > 0 (`audiencia.resumenDeAudiencia`).
9. Cuota del asistente con margen para las respuestas (§2.2) — aquí se ofrece el paquete.

### 6.9 La vista: **nueva, y de primer nivel**

**Una vista aparte**, `/promociones` al mismo nivel que `/conversaciones` (que es el precedente: un
módulo transversal no se cuelga de un vertical), **no una pestaña de Clientes**. Razones: tiene su
propio permiso, su propio flujo de 4 pasos, su propio historial con resultados, y una campaña **no es
un cliente** — meterla en Clientes mezcla el directorio con la herramienta.

Pero sí **una puerta desde Clientes**: botón «Crear promoción con estos clientes» que abre
`/promociones` con el filtro puesto. Es donde el dueño está cuando se le ocurre la idea.

El flujo, en una sola pantalla con pasos:

1. **Audiencia** — segmentos recomendados con su conteo en vivo, filtros, selección a mano, y los
   excluidos dichos con su motivo («120 sin autorización», «8 recibieron una promo esta semana»).
2. **Mensaje** — plantilla de la biblioteca, imagen, textos, **vista previa igual que WhatsApp**.
3. **Simulador** — el desglose: *«400 envíos · Meta te cobrará ~$20.000 a tu tarjeta de WhatsApp ·
   EscalApp: 400 créditos (tienes 300, te faltan 100) · necesitas 4 pedidos para empatar»*, con el
   total arriba y las dos líneas explicadas debajo. Exactamente el reparto pedido: un total, y
   dicho sin ambigüedad qué se paga aquí y qué le llega de Meta.
4. **Prueba y envío** — prueba al dueño, luego programar (con el aviso del horario y del ritmo).

Más **Historial** con el informe de §6.6.

---

## 7. Fases, en el orden en que no se pierde el trabajo

| Fase | Qué | Por qué en ese orden |
|---|---|---|
| **F0** ✅ **hecha** (§11) | Audiencia: la baja por WhatsApp con su prueba, el conteo de contactables, migración | Es lo que hace defendible el resto. Y es barata: sin interfaz y sin tocar el flujo conversacional |
| **F1** ✅ **hecha** (§12) | Adaptador de hechos, segmentos, vista con conteos y simulador, **sin enviar** | Vale por sí sola (el dueño ya ve a quién tiene) y se ve qué segmentos mira de verdad antes de construir el resto |
| **F2** ✅ **hecha** (§13) | Biblioteca de plantillas, compuerta de elegibilidad, prueba al dueño, envío con ritmo, estados, informe y atribución | Aquí funciona. **Sale GRATIS y con tope**, en piloto con un negocio |
| **F2,5** (2 semanas de reloj, 0 de trabajo) | **Medir** la tasa de respuesta y de conversión reales | **No se puede poner precio a algo cuyo rendimiento no hemos medido.** Es lo mismo que pasó con el costo del modelo: se vendía casi a costo y nadie lo sabía |
| **F3** (~4–5 días) | Créditos, compra de un solo pago, devoluciones, envíos incluidos en el plan | Con el dato de F2,5, el precio se pone sobre números |
| **F4** (~2–3 días) | Adaptador de reserva | El resto ya es de plataforma |
| **F5** | Anexo legal actualizado (§2.5), política del cliente, y la pantalla que se lo explica | Tiene que estar firmado antes del primer envío de un cliente que no sea el piloto |

**Total ~4 semanas de trabajo** repartidas en ~6 de calendario. F5 no es opcional ni es el final:
el texto del anexo hay que tenerlo listo antes de F2.

---

## 8. Los riesgos, ordenados por lo que cuesta cada uno

1. **🔴 Quemar el número del inquilino.** Si la calidad cae y Meta restringe el número, muere el
   canal que le trae el **39 % de los pedidos**. El daño es 50 veces mayor que lo que la promoción
   podía ganar, y el dueño lo va a atribuir a EscalApp. **Es el riesgo que manda, y sube al no
   preguntarle nada al cliente** (§4): lo que antes filtraba una autorización ahora lo tiene que
   filtrar el oficio. *Mitigación:* la salida visible en cada promoción, topes de frecuencia, pausa
   automática por calidad, ningún envío a quien nunca pidió nada, y empezar por los segmentos que
   más agradecen el mensaje antes que por toda la base.
2. **🔴 Nuestra app de Meta.** Somos Tech Provider: un inquilino spameando nos salpica a **todos**
   los inquilinos. *Mitigación:* los frenos van en el servidor, no en la interfaz; nada de importar
   listas; rastro de auditoría de cada campaña y de cada baja.
3. **🟠 La primera campaña a toda la base.** Mandarle a 800 personas de golpe el primer mensaje
   publicitario que reciben de ese número es la forma más rápida de juntar bloqueos. *Mitigación:*
   empezar por un segmento, mirar la calidad del número y los bloqueos a las 24 h, y subir desde
   ahí. El tope por campaña de §6.7 está para esto.
4. **🟠 El freno del asistente a mitad de promoción** (§2.2). *Mitigación:* el simulador lo mira y
   ofrece el paquete.
5. **🟠 La promoción funciona demasiado.** 100 pedidos en una hora en una cocina que no avisaron.
   *Mitigación:* ritmo de envío, programación por franjas, y decírselo: «esto puede traerte ~N
   pedidos en las 2 horas siguientes».
6. **🟡 Cobrar por lo que no se entregó.** *Mitigación:* 1 crédito = 1 entregado, devolución
   automática por webhook.
7. **🟡 La plantilla rechazada el viernes a las 6 p.m.** *Mitigación:* biblioteca pre-aprobada; el
   texto a medida es la excepción, con su estado visible.
8. **🟡 La tarifa de Meta se mueve** (1 ene / 1 abr / 1 jul / 1 oct). *Mitigación:* tarifa como dato
   con fecha, nunca constante; y el simulador dice «estimado según el *rate card* de <fecha>».
9. **🟡 Créditos sin vencimiento = pasivo eterno.** *Mitigación:* 12 meses, dicho en la compra.
10. **🟡 Que esto se convierta en «mensajería masiva para cualquier cosa».** *Mitigación:* el nombre
    y la vista son **promociones**; el cuerpo sale de plantillas de marketing y nada más.

---

## 9. Lo que queda por decidir (y quién)

1. **El precio.** Depende de F2,5. La propuesta de partida está en §2.3, con la recomendación de
   meter 300 envíos en el Avanzado — decisión del dueño.
2. **¿Exige el asistente IA?** Técnicamente no hace falta para enviar, pero mandar 400 mensajes a un
   número que nadie atiende es peor que no mandarlos. Voto: **exigirlo** (o al menos exigir la
   Bandeja atendida) y decirlo en la pantalla.
3. **¿Quién puede comprar créditos?** Hoy «Mis pagos» es solo del ADMINISTRADOR. Mantenerlo.
4. **El `rate card` en COP y la nota de «Colombia – higher utility rates»** (§2.1) — hay que leerlo.
5. **Qué inquilinos tienen token propio** (§3) — hay que mirar `platform.numero_canal` en producción.
6. **Marketing Messages Lite.** Hay indicios de que las WABA que no aceptaron sus términos pagan un
   recargo (~6 %) sobre el marketing normal desde el 2026-01-01. Verificar qué les aplica a nuestros
   inquilinos antes de publicar la tarifa del simulador.

---

## 10. Fuentes

- [Pricing on the WhatsApp Business Platform](https://developers.facebook.com/docs/whatsapp/pricing) — por mensaje desde el 2025-07-01; «All marketing template messages are charged»; tiers por volumen solo para utility/authentication; COP como moneda de facturación desde el 2026-04-01; cambios de precio solo el 1 de ene/abr/jul/oct.
- [Per-user marketing template message limits](https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/marketing-templates/per-user-limits/) — tope adaptativo **entre negocios**, no publicado; `131049`; esperar 24 h; no se entregan a números de EE. UU.; lo mandado dentro de la ventana de 24 h no cuenta contra el tope.
- Tarifas de Colombia (terceros, concuerdan entre sí): [SleekFlow](https://sleekflow.io/blog/whatsapp-business-price) · [WHAutomate](https://whautomate.com/whatsapp-business-api-pricing) · [Zernio](https://changelog.zernio.com/blog/whatsapp-business-api-pricing) · [Flowcall](https://www.flowcall.co/blog/whatsapp-business-api-pricing) — marketing **USD 0,0125**, utility/auth **USD 0,0008**.
- [Gupshup — MM Lite y recargo del 6 %](https://support.gupshup.io/hc/en-us/articles/53700207494169) — las WABA que no aceptaron los términos de Marketing Messages Lite pagan un recargo sobre marketing desde el 2026-01-01.
- Límites de mensajería y calidad: [Chatarmin](https://chatarmin.com/en/blog/whats-app-messaging-limits) · [AiSensy](https://m.aisensy.com/blog/whatsapp-message-limits-guide/) — 250 usuarios únicos/24 h sin verificación de empresa; escalera 1K → 10K → 100K.
- Internas: `whatsapp-costo-mensajes.md` (9,1 mensajes por pedido; los dos techos) · `asistente-economia.md` §3 (no podemos revender mensajes) · `embedded-signup.md` §9.1 (la WABA es del cliente) · `legal/anexo-encargado-tratamiento.md` §1–2.

---

## 11. F0 — lo que quedó construido (2026-10-12, en PROD desde 2026-10-13)

> **En una frase.** La audiencia de un negocio son **todos** sus clientes con teléfono, sin
> preguntarle nada a nadie; lo que F0 construye es **la salida** (y su prueba) y el **conteo
> honesto** de a cuántos se le puede escribir hoy. El flujo conversacional de un pedido **no cambia
> ni un carácter**.

### 11.1 Los archivos

| Qué | Dónde |
|---|---|
| Migración (`promos_excluido`, `promos_excluido_en`, origen y prueba, índice de contactables) | `migrations/migrate_promociones_audiencia.js` · `npm run migrate:promociones-audiencia` |
| La audiencia: único dueño de «¿a quién puedo escribirle?» | `app_core/promociones/audiencia.js` |
| La baja por WhatsApp (lo único que el asistente hace con esto) | `intelligence/engine/bajaPromociones.js` |
| Dónde se escucha | `intelligence/engine/manejadorEscalera.js`, justo detrás de `optout` |
| Pruebas (16, sin Postgres) | `__tests__/promociones/audiencia.test.js` |

Funciones de `audiencia.js`: `resumenDeAudiencia` (el conteo), `esContactable` (por destinatario, en
el momento de enviar), `excluirPorTelefono` (la baja desde el canal), `excluir` / `readmitir` (desde
la ficha, con el usuario que lo hizo), `porTelefono`.

### 11.2 Las cuatro decisiones que esto congela

1. **No se pregunta nunca.** Ni al pedir, ni al confirmar, ni después. La prueba de regresión está
   en la suite: la confirmación de un pedido tiene que decir **exactamente** lo que devuelve el
   `hecho` de la capacidad, sin una letra más. Si alguien vuelve a colgar algo de ahí, falla.
2. **La audiencia es por defecto y se resta.** `promos_excluido` es lo único que bloquea un envío.
   `consentimiento_mensajeria` (ADR-006) **no se mira** — sigue significando el sí explícito, y
   usarla como filtro dejaría la audiencia en cero para siempre. Si algún día hay casilla en la
   vitrina, volverá a servir y sumará.
3. **«no promos» no es `BAJA`.** Saca de las promociones y **deja la conversación viva**. Es lo
   único que se le escribe al cliente (en el pie de la promoción, F2): enseñarle `BAJA` sería
   tenderle una trampa — perdería el WhatsApp por el que pide la comida y se enteraría la próxima
   vez que tuviera hambre.
4. **`STOP`/`BAJA` ahora excluye también.** Era un agujero abierto desde F8-A: la conversación
   quedaba `bloqueada` y la ficha seguía contactable, así que una campaña —que mira fichas, no
   conversaciones— le habría escrito a quien acababa de pedir que no le escribieran. Para las bajas
   **anteriores** a hoy, `resumenDeAudiencia` y `esContactable` las descuentan cruzando por el
   estado de la conversación, no solo por la columna.

Y una que importa para F2: **`esContactable` se vuelve a comprobar por destinatario en el momento de
enviar**, no solo al armar la campaña. Entre que el dueño aprieta «enviar» y sale el mensaje número
400 pueden pasar horas, y en esas horas alguien puede haberse dado de baja.

### 11.3 Lo que no hace y hay que saber

- **No manda nada** y no hay vista de Promociones todavía: eso es F1/F2.
- **No hay casilla en la vitrina ni botón de baja en la ficha del cliente.** El módulo ya acepta
  esos orígenes (`ORIGEN.VITRINA`, `ORIGEN.MOSTRADOR`, `ORIGEN.NEGOCIO`) y `excluir`/`readmitir`
  están escritas para que las llame un controlador; falta la pantalla, que va con F1.
- **La única palabra que el cliente conoce hoy es la que le diga la promoción.** Mientras no exista
  el envío, quien escriba «no promos» por su cuenta ya queda fuera de la primera campaña.
- **Ningún `trg_audit`.** El historial va por eventos de aplicación (`auditoria.audit_evento`,
  módulo `promociones`, acciones `baja_promociones` y `readmision_promociones`); la fila guarda el
  estado y la prueba. El por qué, en la cabecera de la migración.

### 11.4 Cómo se mira

```bash
# La migración (idempotente; registra en general.gener_migracion)
node scripts/migrar.js promociones-audiencia

# A cuántos se le puede escribir hoy, y quién queda fuera
node -e "require('dotenv').config();
  require('./app_core/promociones/audiencia')
    .resumenDeAudiencia({ idNegocio: 6 }).then(console.log)"
# → { personas, con_telefono, contactables, de_baja, bloqueados, sin_telefono }

# El historial de bajas de un negocio
psql -c "SELECT fecha, accion, detalle->>'origen' AS origen
           FROM auditoria.audit_evento
          WHERE modulo = 'promociones' AND id_negocio = 6
          ORDER BY fecha DESC LIMIT 20;"
```

Verificado contra la base de desarrollo: 4 personas con teléfono → **4 contactables sin preguntar
nada**; la baja deja a una en 0 contactable y guarda su prueba; una baja repetida no hace nada; una
ficha de otro negocio responde `false` (falla cerrado); `readmitir` la devuelve y deja su evento con
el usuario que lo hizo.

### 11.5 Para desplegarlo

1. `git pull` en el VPS → **backup** → `node scripts/migrar.js promociones-audiencia` →
   `sudo systemctl restart escalapp-api`.
2. **`negocio_app` no cambia**: F0 no tiene interfaz. No hace falta build ni subida.
3. Lo que **sí** hay que hacer antes del primer envío de verdad (no de F0, pero sin esto no se
   manda nada): reescribir el §2.5 del anexo de encargado (§4.1) y decidir el texto del pie de la
   promoción con la salida.

---

## 12. F1 — lo que quedó construido (2026-10-12, en PROD desde 2026-10-13)

> **En una frase.** La vista `/promociones` ya enseña a cuántos clientes se le puede escribir, los
> parte en grupos con una recomendación para cada uno, y dice lo que costaría — **sin enviar nada**.
> El backend ya es transversal: reserva funciona hoy, solo le falta pantalla.

### 12.1 Los archivos

| Qué | Dónde |
|---|---|
| El hecho de cada vertical (pedido / cita) | `app_core/promociones/hechos/{index,restaurante,reserva}.js` |
| Los segmentos y sus consultas | `app_core/promociones/segmentos.js` |
| La tarifa de Meta, como dato con fecha | `app_core/promociones/tarifas.js` |
| El simulador (costo, punto de equilibrio, consumo del asistente) | `app_core/promociones/simulador.js` |
| API | `app_admin_api/controllers/promocionController.js` + 6 rutas en `/admin/promociones/*` |
| Módulo y permiso | `migrations/migrate_promociones_modulo.js` · `npm run migrate:promociones-modulo` |
| Vista | `negocio_app/src/app/features/promociones/` + `core/services/promociones.service.ts` |
| Pruebas (37, sin Postgres) | `__tests__/promociones/` |

### 12.2 Los segmentos, y la corrección a la tabla de §6.3

La tabla de §6.3 servía para explicar la idea, **no para contar gente**: sus rangos se solapaban
(«frecuente: ≥4 y ≤30 días» junto a «en riesgo: 45–120»), y una persona que cae en dos segmentos
hace que los conteos no sumen y que el total no se pueda creer. Lo construido evalúa **por
antigüedad primero** y la primera regla que casa gana:

| Orden | Segmento | Regla | Recomendado |
|---|---|---|---|
| 1 | `sin_actividad` | sin ningún evento (ficha abierta a mano) | no |
| 2 | `dormido` | más de 120 días | no |
| 3 | `en_riesgo` | entre 46 y 120 días | **sí** |
| 4 | `frecuente` | ≤ 45 días y 4+ visitas | **no — y se dice por qué** |
| 5 | `intermedio` | ≤ 45 días y 2–3 visitas | no |
| 6 | `ocasional` | ≤ 45 días y 1 visita | **sí** |

`alto_valor` es una **bandera**, no un segmento: el top 20 % por gasto (percentil sobre el propio
negocio, no un umbral fijo). Un cliente puede ser a la vez el que más gasta y el que no viene desde
hace tres meses, y meterlo en un cajón aparte escondería justo al que más urge recuperar.

Los cortes viven en `segmentos.UMBRALES` y el `CASE` de SQL los interpola — hay una prueba que falla
si alguien los escribe a mano dentro del SQL, porque entonces la pantalla diría un umbral y se
aplicaría otro.

### 12.3 Lo que la pantalla deja claro, por orden

1. **Que «todos mis clientes» no son «todos mis mensajes».** Cuatro tarjetas: a cuántos se le puede
   escribir, cuántos no tienen teléfono, cuántos pidieron no recibir y cuántos bloquearon el número.
2. **A quién NO hace falta escribirle.** «Frecuentes» aparece con su conteo y con el texto de que
   normalmente no hay que mandarles nada — que es literalmente lo que pidió el dueño.
3. **Qué cobra Meta y qué cobramos nosotros, separado.** El cargo de Meta va **a la tarjeta de su
   cuenta de WhatsApp**, y la pantalla lo dice con esas palabras. En dólares primero y en pesos como
   referencia, avisando de que Meta usa su propia tasa.
4. **Cuántos pedidos tiene que traer para empatar**, con el deslizador de su margen al lado.

Y arranca con los segmentos recomendados ya marcados: es la respuesta a «¿a quién le mando?» para
quien abre esto por primera vez, y se deshace con un clic.

### 12.4 Las decisiones que esto congela

1. **Sin selección no se asume «todos».** `destinatariosParaEnvio` sin segmentos ni personas
   responde `PROMOS_SIN_DESTINATARIOS` (422). Una campaña a toda la base por omisión es el error
   más caro que puede cometer esta pantalla, y la prueba lo fija.
2. **El punto de equilibrio se calcula con el MARGEN, no con la venta.** Con la venta sale «con un
   pedido ya ganaste» y es mentira: de un pedido de $27.321 el restaurante se queda con ~$8.200. Hay
   prueba de regresión.
3. **Una tarifa que no tenemos no se estima.** Colombia está confirmada (US$0,0125); **Chile no está
   publicado** y ahí ya hay un inquilino, así que esos destinatarios se cuentan aparte y la pantalla
   lo dice. Los números de EE. UU. no se cobran porque Meta no les entrega marketing.
4. **El costo que no se ve va en la misma respuesta**: si contestan, el asistente gasta ~9,1
   mensajes por conversación del techo contratado. El simulador mira `cuota.consumoDe` y avisa
   cuando no alcanza — es el cross-sell del paquete y, si no se avisa, el fallo más vergonzoso que
   puede tener esta función.
5. **El módulo nace cerrado y solo para el ADMINISTRADOR.** Una promoción gasta dinero del negocio:
   no es una pantalla de operación. Se siembra también `promociones_enviar`, que F1 no usa, porque
   un subnivel que llega con el frontend que lo necesita aparece **denegado** para todos hasta que
   cada uno vuelva a entrar.
6. **La vista es transversal** (`features/promociones/`, no `restaurante/features/`), como
   `conversaciones`. Lo único que cambia por vertical es el adaptador de hechos, de 30 líneas.

### 12.5 Dos cosas que se arreglaron por el camino

- **`= ANY(:lista)` no funciona con Sequelize.** Expande los arrays de `replacements` como lista
  separada por comas, así que `ANY('a','b')` es un error de sintaxis de Postgres. Va con
  `IN (:lista)`, que es lo que ya usaba el resto del repo. Lo cazó la prueba contra la base de
  desarrollo, no el `node --check`.
- **Los backticks dentro de un *template literal* de SQL cortan la cadena.** Pasó dos veces, las dos
  en un comentario de SQL que citaba un identificador. En el SQL los comentarios van sin backticks.

### 12.6 Cómo se mira

```bash
npm run migrate:promociones-audiencia   # F0: la salida y su prueba
npm run migrate:promociones-modulo      # F1: el módulo y el permiso
npx jest __tests__/promociones/         # 37 pruebas, sin base
```

Verificado contra la base de desarrollo, por los dos verticales: el negocio de reserva sale con sus
4 `ocasional` (1 cita, 32–37 días) y su simulación; el de restaurante, con sus fichas
`sin_actividad`. Y la API corta con **403** cuando el token de un negocio pide la audiencia de otro.

### 12.7 Lo que falta para F2 (el envío)

En orden de riesgo, no de esfuerzo:

1. La **biblioteca de plantillas MARKETING** por WABA, creada y aprobada en el alta del canal (§3).
2. La **compuerta de elegibilidad** completa (§6.8): token propio, calidad del número, tier, y el
   **mensaje de prueba al dueño** antes de cobrar nada.
3. El **envío con ritmo** y los estados por destinatario, con la devolución de créditos de §6.5.
4. El **pie de la promoción con la salida** («responde *no promos*»), que es lo que sustituye a la
   pregunta que se decidió no hacer (§4).
5. Y antes del primer envío de un cliente que no sea el piloto: **reescribir el §2.5 del anexo de
   encargado**, que hoy le hace prometer no usar el asistente para comunicaciones no solicitadas.

---

## 13. F2 — el envío (2026-10-13, en PROD · ver §14 para el alcance)

> **En una frase.** Ya se puede mandar: plantillas creadas y aprobadas en la WABA **del
> inquilino**, compuerta con prueba real al dueño antes de cobrar nada, envío con ritmo —el tier de
> Meta, no la velocidad de la API— y un informe que dice quién volvió a pedir.

### 13.1 La decisión que da forma a todo

**El despachador no llama a la Cloud API.** Convierte cada destinatario en una fila de
`intelligence.mensaje` con su plantilla, y lo manda **el entregador que ya existe** desde F5-C. Eso
hereda cuatro cosas que habría habido que escribir otra vez:

- el número y el token **del inquilino** (el fallo que peor duele, resuelto en F8-C),
- reintentos con backoff y *dead letter*,
- el `estado_entrega` corregido por el acuse del webhook (`marcarAcuseDelCanal`), con el **código de
  error de Meta** dentro,
- y el Ledger, que es donde ya se mira todo lo demás.

Por eso `campana_destinatario` guarda `id_mensaje` y **no** el estado de la entrega: un contador
paralelo sería una segunda verdad sobre lo mismo, y la primera vez que divergieran no habría forma
de saber cuál miente. Es el mismo criterio del medidor de cuota (§3 de
[`whatsapp-costo-mensajes.md`](whatsapp-costo-mensajes.md)).

### 13.2 Los archivos

| Qué | Dónde |
|---|---|
| Tablas (`campana`, `campana_destinatario`, `plantilla_promocion`) | `migrations/migrate_promociones_campanas.js` · `npm run migrate:promociones-campanas` |
| Las plantillas MARKETING, como código | `intelligence/core/plantillas.js` → `promocion_texto`, `promocion_imagen` |
| Crearlas y sincronizarlas en la WABA del inquilino | `app_core/promociones/plantillasMeta.js` |
| La compuerta | `app_core/promociones/elegibilidad.js` |
| Ciclo de vida e informe | `app_core/promociones/campanas.js` |
| El envío con ritmo y la devolución de créditos | `app_core/promociones/despachador.js` (arranca en `app.js`) |
| El encabezado de imagen en el envío | `intelligence/channels/whatsapp/adaptador.js` → `renderizarPlantilla` |
| La WABA de un negocio | `intelligence/channels/whatsapp/numeros.js` → `wabaDeNegocio` |
| API | 12 rutas nuevas en `/admin/promociones/*` (18 en total) |
| Vista | `negocio_app` → pasos **A quién · Qué dice · Revisar y enviar · Historial** |
| Pruebas (32, sin base ni red) | `__tests__/promociones/envio.test.js` |

### 13.3 Las plantillas: dos, y por qué dos

El texto vive en el **código** y de ahí se somete a cada WABA: el catálogo no puede derivar de lo
aprobado si lo aprobado se genera desde el catálogo. Es lo contrario de lo que pasó con
`pedido_listo`, que se copió a mano y costó un `#132001`.

- **`promocion_texto`** — sin encabezado. **Se puede aprobar sin tener ninguna imagen**, así que un
  negocio siempre tiene un camino para enviar.
- **`promocion_imagen`** — encabezado IMAGE. Meta **no acepta un enlace para crearla**: exige un
  `header_handle` de su API de subidas, así que hace falta subirle una imagen de ejemplo antes
  (`plantillasMeta.subirEjemplo`, con el token de la **app**, no el del inquilino). Al **enviar** sí
  va un `link`, que es la imagen de verdad de cada campaña. Confundir las dos cosas es un 400 con un
  mensaje que no ayuda.

Las dos llevan **la salida dentro**: pie con «responde: no promos» (cabe en los 60 caracteres de
Meta) y un botón de respuesta rápida. ⚠️ **El texto del botón tiene que casar con
`engine/bajaPromociones.PALABRAS_BAJA`** — lo que vuelve de un botón es un mensaje de texto normal, y
si no casa, el cliente pulsa «No quiero promociones» y **no pasa nada**: ni error, ni log, solo un
cliente que a continuación bloquea el número. Hay una prueba que lo fija.

Y el cuerpo dice de dónde salió el mensaje («recibes este mensaje porque has pedido con nosotros»):
es lo que pide la política de Meta y lo que hace que el cliente reconozca al negocio en vez de
reportarlo.

### 13.4 La compuerta, y qué bloquea de verdad

| | Bloquea | Por qué |
|---|---|---|
| Sin plan activo | sí | es una función del plan |
| Canal que **no es suyo** (alta manual) | **sí** | saldría por NUESTRA WABA: Meta nos factura a nosotros y su mala calidad es la de todos los inquilinos |
| Sin plantilla `APPROVED` | sí | el envío moriría en *dead letter* con `#132001` |
| Calidad del número en **rojo** | sí | una campaña ahí es cómo se pierde el número |
| **La prueba al dueño sin entregar** | sí | ver abajo |
| Sin contactables | sí | no hay nada que mandar |
| Calidad amarilla · calidad no leída · tier corto · cupo justo · fuera de horario | **avisan** | son decisiones del dueño, o datos que no pudimos leer |

**La prueba al dueño es el centro de todo esto.** Antes de mandarle nada a 400 clientes se manda
**un** mensaje real al número del negocio. Cuesta ~$50 y comprueba de una vez las tres cosas que no
se pueden consultar con fiabilidad: que su cuenta de Meta **tiene método de pago** (si no, `131042`,
y no hay API que lo diga antes), que la plantilla existe en su WABA con ese nombre e idioma, y que el
número puede mandar marketing. Y de paso le enseña al dueño exactamente lo que va a recibir su
cliente.

### 13.5 El ritmo

- **El límite que manda no son los 80 msj/s de la Cloud API: es el tier.** Sin verificación de
  empresa son **250 personas nuevas cada 24 h**. Una campaña de 400 se manda en dos días, y eso no
  es un fallo — lo que sería un fallo es intentarla entera, que Meta rechace la mitad y que el dueño
  crea que salió. El despachador lee el tier, descuenta lo ya encolado en 24 h y para cuando se
  agota.
- **Solo entre las 8:00 y las 21:00** de Bogotá. Una promoción a las 11 de la noche es una denuncia.
  La franja es una constante compartida entre la compuerta y el despachador: dos franjas distintas
  —una que avisa y otra que manda— es un dueño que no entiende por qué su promoción no salió.
- **Pausa automática si la calidad cae a rojo** durante el envío. Se pregunta como mucho cada 15
  minutos, porque es una llamada a Meta por campaña: hacerlo en cada pase convertiría el freno en el
  gasto.
- **Una transacción por destinatario, con el lock dentro** (igual que `intelligence/recordatorios`):
  *un lock que no dura tanto como el trabajo que protege no es un lock*.
- **Y vuelve a comprobar la baja en el último momento.** Entre que el dueño aprieta «enviar» y sale
  el mensaje 400 pueden pasar horas, y en esas horas alguien puede haberse dado de baja. Un filtro
  aplicado solo al armar la campaña es un mensaje que sale **después** de la baja.

### 13.6 Los créditos

`1 crédito = 1 mensaje entregado`, y eso es verdad y no una frase: `devolverCreditosFallidos` busca
los que el Ledger marcó `fallido` y los devuelve. Cubre los tres casos reales: el número no tiene
WhatsApp, el cliente nos bloqueó, y el tope de marketing por usuario de Meta (`131049`), que no es
culpa de nadie. Todavía **no hay precio** —eso es F3—: lo que se cuenta son envíos.

### 13.7 Lo que quedó pendiente, y es poco pero hay que saberlo

1. ~~La migración no se ha corrido~~ — **corrida en desarrollo y en producción el 2026-10-13**
   (`promociones-audiencia`, `promociones-modulo`, `promociones-campanas`).
2. **Nada de F2 se ha probado contra Meta.** Las 32 pruebas corren sin red: comprueban el *payload*
   que se le manda, no que Meta lo acepte. La primera campaña real es lo que valida el camino
   completo, y el orden correcto es: pedir las plantillas → esperar la aprobación → prueba al dueño
   → 20 destinatarios → mirar calidad y bloqueos a las 24 h → subir.
3. **`WHATSAPP_APP_ID` / `WHATSAPP_APP_SECRET` hacen falta para la plantilla con imagen** (la API de
   subidas de Meta cuelga de la app, no de la WABA). Sin ellas, `promocion_texto` se crea igual y la
   de imagen se omite **con su motivo**: el negocio no se queda sin camino.
4. **`APP_PUBLIC_URL` tiene que estar bien** en producción: la imagen de la promoción se sirve desde
   `/uploads/promociones` y **la descarga un servidor de Meta**, no el navegador. Una URL relativa o
   un dominio que no resuelva es una promoción que sale sin imagen.
5. **El webhook `message_template_status_update` no se usa**: el estado de las plantillas se refresca
   preguntando (`sincronizar`). Usarlo exige añadir el campo en la app de Meta y no cambia nada de lo
   que el dueño ve.
6. **La atribución mira si el cliente pidió en los 7 días siguientes**, pero el «recuperado» se
   aproxima por el segmento al que pertenecía (`en_riesgo`/`dormido`) en vez de volver a mirar sus
   30 días previos. Es honesto y suficiente para la primera campaña; afinarlo es media hora cuando
   haya datos que lo pidan.

### 13.8 El despliegue (hecho el 2026-10-13)

1. Backup (`backup.sh`) → `git pull` → `npm install --omit=dev` → las cuatro migraciones en orden
   (`restaurante-rubros`, `promociones-audiencia`, `promociones-modulo`, `promociones-campanas`) →
   `sudo systemctl restart escalapp-api`. **Las migraciones van antes del reinicio**: el modelo
   Sequelize ya declara `permite_promociones`, y un arranque sin la columna rompe toda consulta a
   `gener_negocio`.
2. En el arranque se leyó: `[promociones] Despachador iniciado — sondeo cada 15000ms, lote 20,
   franja 8:00–21:00.` Se apaga con `PROMOS_DESPACHADOR_ENABLED=false`.
3. Build y subida de `negocio_app` (con su `cp index.csr.html index.html`).
4. Comprobado contra la base de producción, con el código de producción: la lista blanca da `true`
   solo para el negocio 12, `canalDe(12)` pasa con la WABA de EscalApp, `canalDe(13)` niega, y la
   sesión de un administrador del 13 no trae ni la bandera ni la vista.
5. Y lo que no es código, **todavía pendiente**: **reescribir el §2.5 del anexo de encargado**
   (§4.1), que hoy le hace prometer al cliente no usar el asistente para comunicaciones no
   solicitadas. Hace falta antes del primer envío de un cliente que no sea el piloto.

---

## 14. El piloto: encendido para UN negocio (2026-10-13, EN PRODUCCIÓN)

> **En una frase.** Está desplegado, y encendido solo para **Restaurante pregonchos** —el
> restaurante con el que EscalApp se prueba a sí misma—. Para los demás restaurantes el módulo
> existe, está sembrado y está apagado: ni menú, ni ruta, ni API.

### 14.1 Dos candados, porque son dos preguntas distintas

| | Qué contesta | Quién lo decide |
|---|---|---|
| `gener_negocio.permite_promociones` | **a qué negocios** se les ofrece la función | EscalApp |
| La matriz (`gener_rol_nivel` / `gener_nivel_negocio`) | **qué rol** la ve dentro de ese negocio | el dueño |

La matriz sola no servía, y el motivo es concreto: `usuarioAdminDao.getPermisosRol` **siembra sola**
la fila que falta en `gener_nivel_negocio` con el valor de la plantilla del rol, la primera vez que
alguien abre «Roles y permisos». Con la plantilla concediéndolo, a cualquier restaurante le habría
aparecido el módulo por el simple hecho de que su dueño entró a mirar los permisos de su personal.
Nadie lo habría decidido, y lo que hay detrás manda publicidad y gasta dinero.

Así que la plantilla del rol queda explícitamente en `false` —la fila existe para que el módulo se
vea en la matriz y se pueda conceder a mano— y el `true` se escribe **solo** en el
`gener_nivel_negocio` del negocio del piloto.

**La lista blanca falla cerrado siempre** (`app_core/promociones/habilitado.js`): columna que falta,
base caída, lo que sea → `false`. Un negocio que debería tenerla y se queda sin ella es una molestia
de un minuto; al revés es publicidad a nombre de quien no la pidió, y eso no se deshace.

### 14.2 Dónde se comprueba

- **La API**, en el único sitio por el que pasan las 18 rutas: `negocioDeLaPeticion` del controlador
  → 403 `PROMOS_NO_HABILITADO`. La excepción es `getDisponible`, que **contesta** la pregunta: un
  endpoint de diagnóstico que responde 403 no diagnostica nada.
- **El despachador**, en cada pase sobre cada campaña. Apagarle la función a un negocio tiene que
  parar lo que ya está saliendo: entre crear una campaña y el último mensaje pasan días, y es en
  esos días cuando se decide apagarla.
- **El frontend**, en el menú y en el guard, con la bandera que viaja en la sesión. No para cerrar
  nada —eso lo hace la API— sino para no pintar una pantalla que va a dar 403.

Lo fija `__tests__/promociones/habilitado.test.js`, que **recorre los 18 handlers** y exige que
ninguno trabaje para un negocio fuera de la lista. Una ruta nueva que se olvide de la compuerta sale
el día que se escribe.

### 14.3 ⚠️ La excepción del canal, y por qué existe

La compuerta bloquea un canal que no es del inquilino (`origen = 'manual'`), porque sale por
**nuestra** WABA: Meta nos factura a nosotros y su mala calificación es la de todos los demás.

Y resulta que el negocio del piloto es exactamente eso: atiende el número de la plataforma
(`WHATSAPP_NEGOCIO_ID = 12` en producción). Con la regla tal cual, el único negocio con la función
encendida habría visto para siempre «conecta tu propio número», y la primera campaña real —la que
valida el camino entero antes de vendérselo a nadie— no se habría podido mandar nunca.

Para ese negocio el argumento se da la vuelta: la factura y la calificación **son** nuestras, y
somos nosotros los que decidimos arriesgarlas. Así que `plantillasMeta.canalDe` lo deja pasar con
las credenciales del servidor (`WHATSAPP_TOKEN` + `WHATSAPP_WABA_ID`), devuelve
`deLaPlataforma: true`, y la compuerta lo **avisa** en voz alta (`PROMOS_CANAL_DE_ESCALAPP`) en vez
de callárselo. Para cualquier otro negocio de alta manual sigue siendo un `no`.

### 14.4 ⚠️ La prueba no puede ir al número del negocio

Se encontró preparando el piloto, y afectaba a todos los negocios, no solo a este: la prueba se
mandaba «al WhatsApp del dueño», que se deducía del canal. **Pero ese es el número que ENVÍA**, y la
Cloud API no se manda mensajes a sí misma. Era una prueba que iba a fallar siempre, y encima en el
único sitio donde un fallo se lee como «tu cuenta de Meta tiene un problema».

Ahora el destino **se pide**: un campo en el paso «Revisar y enviar» con el móvil de quien va a
revisarla, y un `no` inmediato —`PROMOS_PRUEBA_A_SI_MISMO`, comparando por dígitos— si es el mismo
número que envía.

### 14.5 Cómo se le enciende al siguiente negocio

```sql
UPDATE general.gener_negocio SET permite_promociones = true WHERE id_negocio = N;
```

…y concederle la vista PROMOCIONES al rol en Usuarios → Roles y permisos. Quien tenga sesión abierta
tiene que volver a entrar.

No hay pantalla para esto a propósito: mientras sea un piloto, encenderlo es una decisión comercial
con nombre y apellido, no un interruptor que se pulsa sin pensar. Queda en la auditoría (`trg_audit`
de `gener_negocio`) con quién lo hizo.

Y antes de encenderlo a un cliente de verdad, dos cosas que no son código: que **conecte su propio
número** (sin eso la compuerta lo bloquea, y con razón) y **reescribir el §2.5 del anexo de
encargado** (§4.1), que hoy le hace prometer que el asistente no se usará para comunicaciones no
solicitadas.
