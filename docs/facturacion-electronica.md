# Facturación electrónica: qué es, qué exige la DIAN y cómo la va a hacer EscalApp

**Estado:** documentación previa a la implementación · **Decisión que la gobierna:** [ADR-026](adr/ADR-026-facturacion-electronica.md) · **Fecha:** 2026-09-01 · **Backlog:** ESC-067 a ESC-071

> Este documento cierra ESC-067 («investigar y documentar requisitos DIAN»). Está escrito para
> leerse de arriba abajo la primera vez y consultarse por secciones después. La §1 no tiene
> tecnicismos a propósito: es la parte que hay que entender antes de decidir nada.
>
> **Lo legal que nos incumbe a nosotros como empresa** —facturar las mensualidades, IVA, datos
> personales, responsabilidad frente al cliente— tiene documento propio:
> [`obligaciones-escalapp.md`](obligaciones-escalapp.md). Resumen en §12.

---

## 0. Por qué esto ahora

No sale de la hoja de ruta técnica: **sale de la venta**. Los restaurantes con flujo de caja mayor
que el de las comidas rápidas —los que valen la pena como cliente— piden dos cosas antes de firmar:

1. **WhatsApp con pedidos automáticos** → hecho y en producción desde 2026-08-25 (ver
   [`asistente-restaurante.md`](asistente-restaurante.md)).
2. **Facturación electrónica** → esto.

O sea que la facturación electrónica no es una mejora del producto: es **la mitad del requisito de
entrada** a un segmento de cliente que hoy no se puede cerrar. Conviene que quede escrito, porque
dentro de seis meses nadie se acuerda de por qué se metió aquí.

El caso de uso principal es **restaurante**, pero la capacidad se diseña para toda la plataforma:
parqueadero, tienda, gym y reserva emiten exactamente los mismos documentos; solo cambia qué se
vende. **Y se diseña para poder estar apagada**, porque hay clientes que no la quieren y clientes
que ni siquiera están obligados a tenerla (§4).

---

## 1. La explicación en llano: POS y factura electrónica no son lo mismo

Esta sección responde la pregunta directa: *¿qué diferencia hay entre una factura POS y la
facturación electrónica?* La confusión es normal, porque desde 2024 **las dos son electrónicas** y
el nombre dejó de ayudar.

### 1.1 Primero: facturar es una obligación con la DIAN, no un recibo para el cliente

Cuando un negocio vende, la ley le exige dejar constancia de esa venta ante la DIAN. Eso es
facturar. El papelito que te dan es la parte visible; lo que importa es que **la DIAN recibió el
dato**.

La ley permite dejar esa constancia con **dos documentos distintos**, y ahí empieza todo:

| | **Factura electrónica de venta** | **Tiquete POS** (documento equivalente) |
|---|---|---|
| Qué es | El documento completo de la venta | Un comprobante simplificado |
| ¿Quién aparece? | Vendedor **y comprador identificado** | Solo el vendedor; el comprador puede ir anónimo |
| ¿Para qué le sirve al comprador? | Para **descontar IVA y meter el gasto como costo** en su declaración | Para nada tributario |
| Límite de monto | Ninguno | **Máximo 5 UVT** = **$261.870** en 2026 |
| ¿Se puede exigir? | **Sí, siempre**, sin importar el monto | — |

### 1.2 La regla que lo explica todo: ¿el comprador necesita descontar impuestos?

Un tiquete POS **no le sirve al comprador para restar ese gasto de sus impuestos**. Por eso la ley
(artículo 616-1 del Estatuto Tributario, modificado por la Ley 2155 de 2021) le puso techo: el
tiquete POS solo puede usarse cuando la venta **no supera 5 UVT**, que en 2026 son **$261.870** sin
impuestos.

De ahí salen las dos reglas prácticas que le importan a un restaurante:

- **Cuenta por encima de $261.870 → factura electrónica de venta, obligatoria.** Ya no es opcional.
- **El cliente la pide → factura electrónica de venta, sin importar el monto.** Aunque sean $8.000
  de un café, si el comensal la exige hay que expedirla. La ley dice exactamente eso: *«sin
  perjuicio de que el adquiriente del bien y/o servicio exija la expedición de la factura de venta,
  caso en el cual se deberá expedir la misma»*.

### 1.3 Esto es exactamente lo que viste en los restaurantes de cadena

Cuando te preguntan **la cédula y el correo** antes de cerrar la cuenta, están haciendo esto:

```
El mesero pregunta: "¿me regala su cédula y su correo?"
        │
        │   (te está identificando como ADQUIRIENTE)
        ▼
El sistema deja de emitir un tiquete POS anónimo
y emite una FACTURA ELECTRÓNICA DE VENTA a tu nombre
        │
        ▼
La manda a la DIAN, la DIAN la valida y devuelve un código único (el CUFE)
        │
        ▼
Te llega al correo en PDF + XML  ← por eso te piden el correo
```

Te piden el correo porque **entregártela es parte de la obligación**: no basta con transmitirla a la
DIAN, hay que ponerla en manos del comprador. Y te piden la cédula porque una factura sin comprador
identificado no es una factura.

Dos detalles que explican lo que has visto en la práctica:

- Si la cuenta pasa de $261.870, **te la piden aunque tú no la hayas pedido**. No es amabilidad: es
  que no pueden cerrar esa venta con un tiquete POS.
- Si solo querías el recibo para saber cuánto pagaste, con el tiquete POS bastaba. El correo y la
  cédula aparecen únicamente cuando entra en juego la factura de venta.

### 1.4 El giro de 2024: el tiquete POS también es electrónico ahora

Antes de 2024 el tiquete POS era papel y punto: la maquinita imprimía y la DIAN no se enteraba de
esa venta hasta la declaración. Eso se acabó.

La **Resolución 000165 del 1 de noviembre de 2023** convirtió los documentos equivalentes en
**documentos equivalentes electrónicos**: ahora el tiquete POS también se genera, se firma y **se
transmite a la DIAN**. La **Resolución 000008 del 31 de enero de 2024** puso el calendario:

| Quién | Desde cuándo debe emitir el tiquete POS **electrónico** |
|---|---|
| Grandes contribuyentes | **1 de mayo de 2024** |
| Declarantes de renta que no son grandes contribuyentes | **1 de junio de 2024** |
| No declarantes de renta | **1 de julio de 2024** |
| Los demás documentos equivalentes (peajes, cine, transporte…) | hasta el **1 de noviembre de 2024** |

**Consecuencia directa para EscalApp:** un restaurante **obligado a facturar** que hoy imprime desde
nuestro POS un tiquete que no se transmite a la DIAN **no está cumpliendo**. O lo cumple por fuera,
con otro software en paralelo —que es justo lo que nos hace perder la venta—, o no lo cumple. La
fecha ya pasó hace más de dos años. (Quién está obligado y quién no, en §4.3.)

### 1.5 Entonces, en una frase cada uno

- **Factura electrónica de venta:** el documento completo, con comprador identificado, sin límite de
  monto, que le sirve al comprador para sus impuestos. Se valida con la DIAN **antes** de entregarse.
- **Documento equivalente electrónico – tiquete POS:** el comprobante simplificado de mostrador,
  hasta 5 UVT, que también se transmite a la DIAN desde 2024, pero **no le sirve al comprador para
  descontar impuestos**.
- **Nota crédito:** el documento con el que se anula o corrige una factura ya aceptada. Porque una
  factura aceptada por la DIAN **no se borra ni se edita jamás**.

### 1.6 Un punto en el que las fuentes se contradicen — confírmalo con un contador

Al investigar esto aparecieron fuentes secundarias (blogs de proveedores) afirmando que la
Resolución 000165 de 2023 **eliminó** el límite de las 5 UVT para el POS electrónico. **El texto
vigente del artículo 616-1 del Estatuto Tributario sigue teniendo el límite** (consultado el
2026-09-01, con nota de última actualización del 2026-07-29), y una resolución de la DIAN no puede
derogar una ley. Por eso este documento asume que **el límite sigue vivo**.

Aun así, es exactamente el tipo de detalle que conviene que confirme el contador del primer cliente
antes de prometer nada por escrito, porque **cambia cuántas facturas de venta emite un restaurante
al día** — y con eso cambia el costo del proveedor y el precio del plan.

---

## 2. Qué exige la DIAN, en concreto

### 2.1 Las tres formas legales de emitir

| Forma | Qué es | ¿Nos sirve? |
|---|---|---|
| **Servicio gratuito de la DIAN** | Un portal web donde se factura a mano | No: no se integra con nada, hay que teclear cada venta |
| **Software propio o adquirido** | El negocio se habilita con su NIT y usa su propio software | Técnicamente sí, económicamente no — ver [ADR-026](adr/ADR-026-facturacion-electronica.md) |
| **Proveedor tecnológico (PT)** | Una empresa habilitada por la DIAN que transmite por cuenta del negocio | **Sí. Es lo que vamos a hacer** |

### 2.2 Ser nosotros el proveedor tecnológico está descartado, y por mucho

Para habilitar a una empresa como PT, la DIAN exige entre otras cosas:

- **Patrimonio contable ≥ 20.000 UVT** = **$1.047.480.000** con la UVT de 2026 ($52.374).
- **Propiedad, planta y equipo ≥ 10.000 UVT** = **$523.740.000**, localizada en Colombia.
- **Certificación ISO 27001**, o carta de compromiso de obtenerla en máximo 18 meses.

No es una puerta que se abra con esfuerzo: se abre con mil millones de pesos de patrimonio. Queda
cerrada y no hay que volver a discutirlo.

### 2.3 Lo que **cada cliente** tiene que tramitar, aunque usemos un proveedor

Esto es lo más fácil de olvidar y lo que más retrasa una implementación. Aunque EscalApp integre un
PT, **el obligado a facturar sigue siendo el negocio**, y el negocio tiene que:

1. Estar **habilitado como facturador electrónico** ante la DIAN (registro en el portal, aceptación
   de condiciones, set de pruebas).
2. Tener su **resolución de numeración** vigente: prefijo, rango desde–hasta y fecha de vencimiento.
   Sin resolución no se emite ni una factura.
3. **Autorizar al proveedor tecnológico** elegido.

**Es un trámite externo con plazos que no controlamos** — el mismo tipo de bloqueo que la
verificación de negocio de Meta en F8-C, y conviene tratarlo igual: se empieza el día que el cliente
firma, no el día que el código está listo. Ver §9 (FE-0).

### 2.4 Anexo técnico

La DIAN publica un **anexo técnico** con el formato exacto de los documentos (XML UBL 2.1, firma,
códigos de impuesto, validaciones). Desde el 1 de mayo de 2024 rige la **versión 1.9** para factura
electrónica de venta; el documento equivalente electrónico tiene el suyo.

Que ese anexo cambie —y cambia— es **problema del proveedor tecnológico, no nuestro**. Ese es
literalmente el servicio que estamos comprando.

---

## 3. La decisión

**Integrar la API de un proveedor tecnológico ya habilitado, detrás de un puerto con adaptadores
intercambiables.** El razonamiento completo, con las alternativas descartadas, está en
[ADR-026](adr/ADR-026-facturacion-electronica.md). Aquí solo el resumen:

- Construir el emisor son ~400–600 horas la primera versión y **mantenimiento perpetuo con plazos
  ajenos**. No es una funcionalidad: es un producto entero, y uno en el que no competimos.
- Un PT cuesta desde ~$20.000 COP/mes, o por bolsas de documentos. Es un costo operativo, no una
  inversión.
- El puerto con adaptadores es la misma forma que ya usamos en `intelligence/model/` (`puerto.js` +
  `adaptadores/`): si el proveedor sube el precio o se cae, se cambia el adaptador, no el producto.

**El freno real no es técnico, es de margen.** Los planes son $27.999 (Básico) y $59.999 (Avanzado);
$20.000/mes por inquilino se come el 71% del plan Básico. Ver §8.3.

---

## 4. Quién factura y quién no: los cuatro interruptores

**No todos los clientes quieren esto, y algunos ni siquiera están obligados.** Un negocio que
arranca y todavía está entendiendo su propia operación no quiere una pantalla pidiéndole códigos de
responsabilidad fiscal. Si la facturación se mete en el camino de ese cliente, perdemos al cliente
pequeño por ganar al grande — y el pequeño de hoy es el grande de dentro de dos años.

Y hay un caso más de fondo que hay que contemplar desde el modelo: **hay negocios que ni siquiera
están registrados** (§4.1).

Por eso la facturación **nace apagada** y se enciende por partes. Son cuatro preguntas distintas
que la gente confunde en una sola:

```
1. ¿El plan lo incluye?        → feature 'facturacion_electronica'        COMERCIAL
2. ¿Está registrado el negocio?→ gener_negocio_fiscal.estado_registro     LO DECLARA EL CLIENTE
3. ¿Qué emite este negocio?    → gener_negocio_fiscal.modo_facturacion    LO DECLARA EL CLIENTE
4. ¿Puede emitir ya?           → fe_configuracion.estado                  OPERATIVO
```

Es la misma distinción de tres capas que el proyecto ya usa para el asistente
([ADR-021](adr/ADR-021-features.md): feature ≠ capacidad ≠ política), y encaja en la costura que ya
existe: `intelligence/core/features.js` → añadir `FEATURE.FACTURACION_ELECTRONICA` y una entrada en
`FEATURES_POR_PLAN`. **Nadie pregunta por el plan; todos preguntan `estaHabilitado()`.**

### 4.1 El negocio que ni siquiera está registrado

Esto no es un caso raro: **buena parte de los clientes de EscalApp son negocios informales**, sin
matrícula mercantil y sin RUT. Ayudarlos a crecer con un sistema es parte de por qué existe el
producto, así que el modelo tiene que contemplarlos **sin tratarlos como una ficha a medio llenar**.

Por eso `estado_registro` tiene tres valores y no dos:

| Valor | Qué significa | Qué hace la interfaz |
|---|---|---|
| **`NO_DECLARADO`** *(defecto)* | Todavía no se lo hemos preguntado | Puede preguntarlo cuando toque |
| **`SIN_REGISTRO`** | El negocio no está registrado | **Deja de preguntar.** Es una respuesta, no un pendiente |
| **`REGISTRADO`** | Tiene matrícula y RUT | Aquí sí se le pueden pedir los datos fiscales |

La distinción entre los dos primeros parece un matiz y no lo es: si se pierde, la interfaz acaba
dándole la lata para siempre a alguien que **ya contestó**, y esa es la forma más rápida de que
alguien odie un producto.

**Un error fácil que conviene no cometer:** «no registrado» no significa «no facturable». Un
negocio informal **tiene dueño, y el dueño tiene cédula** — fiscalmente es una persona natural, y
**nosotros sí podemos facturarle la mensualidad**. Lo que no tiene es RUT ni resolución, o sea que
**él** no puede emitir.

Ese invariante está en la base, no en un `if`:

```sql
CONSTRAINT chk_negfiscal_modo_requiere_registro
    CHECK (modo_facturacion = 'NINGUNO' OR estado_registro = 'REGISTRADO')
```

Un negocio sin registro no puede tener la facturación encendida, y da igual por qué camino se
intente: panel, script o una migración futura escrita con prisa.

> **Y esto tiene una consecuencia legal, no solo técnica.** Lo que el cliente declare aquí es
> **responsabilidad suya**: nosotros no verificamos su registro ante la Cámara de Comercio ni ante
> la DIAN, y no estamos en posición de hacerlo. Si declara mal, las consecuencias son suyas — pero
> eso **solo nos protege si está escrito en los términos y condiciones**, que hoy **no existen**.
> Ver [`obligaciones-escalapp.md`](obligaciones-escalapp.md) §6.

### 4.2 El interruptor que importa: `modo_facturacion`

Vive en el negocio, lo declara el cliente, y **por defecto está en `NINGUNO`**:

| Valor | Qué hace | Para quién |
|---|---|---|
| **`NINGUNO`** *(defecto)* | Exactamente lo de hoy: recibo interno, no fiscal, no se transmite nada | El negocio que empieza, o el que factura por fuera con otro software |
| **`POS`** | Emite tiquete POS electrónico; ofrece factura de venta solo si se la piden | La mayoría de restaurantes, tiendas y parqueaderos |
| **`COMPLETO`** | POS electrónico + factura de venta automática cuando corresponde | El que ya tiene su contabilidad ordenada |

Con `NINGUNO`, **nada cambia para ese cliente**: no aparece la sección fiscal en el panel, no se le
piden campos, no se valida nada, no se llama a ningún proveedor y no se le cobra ningún documento.
Es literalmente el sistema de hoy.

### 4.3 «No querer» y «no estar obligado» no son lo mismo — y la diferencia nos protege

Esto hay que tenerlo claro porque es donde un SaaS se mete en problemas ajenos:

- **Quién está obligado lo dice la ley, no el cliente y mucho menos nosotros.** Una **persona
  jurídica** está obligada siempre. Una **persona natural** depende: si es responsable de IVA o del
  impoconsumo, si supera **3.500 UVT** de ingresos anuales (**$183.309.000** en 2026), si está en el
  Régimen Simple, y algún caso más (art. 616-2 del Estatuto Tributario y Resolución DIAN 227 de
  2025). **Un restaurante que cobra el 8% de impoconsumo es responsable del INC, y por ahí ya queda
  obligado.**
- **Nosotros no calculamos eso.** No tenemos sus ingresos, no somos sus contadores, y equivocarnos
  tiene consecuencias para el cliente y no para nosotros — que es precisamente el peor reparto
  posible de un riesgo.

Entonces el diseño es: **el cliente declara y nosotros dejamos rastro**.

```
gener_negocio_fiscal
├── obligado_a_facturar      boolean NULL   ← lo declara el cliente, no lo deducimos
├── declarado_por            id_usuario     ← quién lo marcó
├── declarado_en             timestamptz    ← cuándo
└── modo_facturacion         NINGUNO | POS | COMPLETO
```

Tres columnas baratas que el día que haya una discusión valen su peso en oro: **queda escrito quién
dijo qué y cuándo**. Y en la interfaz, una frase honesta cuando alguien elige `NINGUNO`: *«tu
negocio queda sin facturación electrónica; si estás obligado a facturar, confírmalo con tu
contador»*. Ni se lo impedimos ni se lo escondemos.

El mismo asunto, visto desde nuestro lado como empresa, está en §12 y en
[`obligaciones-escalapp.md`](obligaciones-escalapp.md).

---

## 5. El mapa de campos: qué falta exactamente

**Esta es la parte crítica.** Todo lo demás se puede cambiar después; los datos que no se
capturaron a tiempo, no. Y aplica a **todas las verticales**, no solo a restaurante: el documento
fiscal es el mismo, solo cambia qué se vende.

Lo que sigue responde una pregunta concreta: *«¿qué le tengo que pedir a un negocio para poder
facturar por él el día que quiera?»*

### 5.1 Regla de oro: los campos se piden al activar, no al registrarse

Todos los campos fiscales son **NULL por defecto y viven en tablas aparte**. Un negocio en
`NINGUNO` no ve ni uno. La validación no ocurre al guardar: ocurre al **activar**, con una función
que responde *qué falta*:

```js
puedeEmitir(id_negocio) →
  { puede: false, faltan: ['dv', 'municipio_dane', 'responsabilidades_fiscales'] }
```

Eso es lo que permite tener al cliente pequeño sin molestar y al grande listo en una sola pantalla.

### 5.2 Identidad fiscal del negocio → `general.gener_negocio_fiscal` (1:1, nueva)

Hoy `general.gener_negocio` tiene **`nit` y nada más**. Esto es lo que falta:

| Campo | ¿Obligatorio para emitir? | Por qué, y la trampa |
|---|---|---|
| `tipo_persona` | **Sí** | `1` jurídica / `2` natural. **Decide si está obligada siempre o no** (§4.2) |
| `tipo_documento` | **Sí** | Código DIAN: `31` NIT, `13` cédula, `41` pasaporte… |
| `numero_documento` | **Sí** | **Normalizado: sin puntos, sin guiones y SIN el dígito de verificación.** Hoy `nit` es texto libre y seguro trae de todo |
| **`dv`** | **Sí, si es NIT** | El dígito de verificación. **No lo tenemos.** Se calcula con el algoritmo de la DIAN, pero hay que **contrastarlo con el RUT**: si no cuadra, la DIAN rechaza el documento |
| `razon_social` | **Sí** | La del RUT, **no el nombre comercial**. «Pregonchos» no sirve; sirve lo que diga el RUT o el certificado de existencia |
| `nombre_comercial` | No | Lo que se ve en la representación gráfica |
| `primer_apellido`, `segundo_apellido`, `primer_nombre`, `otros_nombres` | Sí, si es persona natural | La DIAN pide el nombre **partido en cuatro**, no en una sola cadena |
| `responsabilidades_fiscales` | **Sí** | Códigos `O-13` gran contribuyente, `O-15` autorretenedor, `O-23` agente de retención de IVA, `O-47` Régimen Simple, `R-99-PN` no aplica. Salen del **RUT** |
| `tributos` | **Sí** | `01` IVA, `04` impoconsumo, `ZZ` no aplica. **Un restaurante suele ser `04`, no `01`** |
| `responsable_iva`, `responsable_inc` | Sí | Derivables de lo anterior, pero explícitos se leen mejor |
| `regimen` | Sí | Ordinario / Simple (RST) |
| `tipo_contribuyente` | Recomendado | Gran contribuyente / declarante de renta / no declarante. **Es lo que dice desde cuándo estaba obligado** según el calendario de 2024 (§1.4) |
| `actividad_ciiu` | Recomendado | Código de actividad económica del RUT |
| `matricula_mercantil` | No | Va en la representación gráfica |
| `direccion_fiscal` | **Sí** | La del RUT |
| `municipio_dane` | **Sí** | **Código DANE de 5 dígitos, no el nombre.** «Medellín» no es un dato válido; `05001` sí. Sin FK: el catálogo son ~1.100 municipios y lo publica cada proveedor, así que **llega en FE-2**. Sembrar aquí una lista parcial sería peor que no tenerla: parecería completa y el negocio de Envigado no se podría guardar |
| `departamento_dane` | **Sí** | 2 dígitos. **Catálogo completo ya sembrado** en `general.gener_departamento` (33, y no cambian) |
| `pais` | **Sí** | `CO` |
| `codigo_postal` | Recomendado | Lo pide el anexo técnico |
| `correo_facturacion` | **Sí** | Donde llegan las copias. **No es el `email_contacto` que ya existe**: ese es comercial, y el de facturación suele ser el del contador |
| `telefono_facturacion` | Recomendado | |
| `estado_registro` | **Sí** | `NO_DECLARADO` / `SIN_REGISTRO` / `REGISTRADO` — §4.1 |
| `obligado_a_facturar`, `declarado_por`, `declarado_en` | Sí | §4.3 |

> **Este bloque nos sirve dos veces.** Son exactamente los mismos datos que necesitamos **nosotros**
> para facturarle la mensualidad a ese cliente (§12). O sea que `gener_negocio_fiscal` hay que
> llenarlo **aunque ese negocio no emita nunca una sola factura**, porque ahí el que factura somos
> nosotros. Es el campo con mejor relación esfuerzo/beneficio de toda la lista.

### 5.3 Cómo emite → `facturacion.fe_configuracion` (1:1)

| Campo | Nota |
|---|---|
| `proveedor` | Qué adaptador usar |
| `credenciales` | **Cifradas.** Nunca en claro, nunca en logs, nunca en un `console.log` de depuración |
| `ambiente` | `PRUEBAS` / `PRODUCCION`. **Mezclarlos quema consecutivos reales** (§10) |
| `estado` | `SIN_CONFIGURAR` / `EN_PRUEBAS` / `ACTIVO` / `SUSPENDIDO` |
| `activado_en`, `activado_por` | Rastro |

### 5.4 Numeración → `facturacion.fe_resolucion` (varias por negocio)

Una por tipo de documento, porque la factura de venta y el POS electrónico llevan rangos distintos:

`tipo_documento` · `prefijo` · `numero_resolucion` · `fecha_resolucion` · `rango_desde` ·
`rango_hasta` · `vigencia_desde` · `vigencia_hasta` · `clave_tecnica` · `consecutivo_actual`

⚠️ **Resolución vencida o rango agotado = el negocio no puede facturar, y se entera en la caja un
sábado.** Hay que avisar antes: alerta al 10% restante y a 30 días del vencimiento.

### 5.5 El comprador → cuelga de `platform.persona_negocio`, no de una tabla nueva

Aquí hay una decisión que evita repetir un error viejo. Hoy cada vertical guarda a su cliente por su
cuenta: `tienda_cliente`, `reserva_cita.cliente_nombre`, `pedid_orden.contacto_telefono`,
`gym_miembro`, `parq_abonado`. Son **cinco verdades distintas sobre la misma persona**.

`platform.persona` / `platform.persona_negocio` ya existen desde F0 justo para esto
([ADR-006](adr/ADR-006-persona.md), [ADR-025](adr/ADR-025-identificadores-nivel-global-vacio.md)).
**Los datos fiscales del comprador van ahí**, no en una sexta tabla:

| Campo | Nota |
|---|---|
| `tipo_documento`, `numero_documento`, `dv` | Códigos DIAN. Un consumidor del común es `13` (cédula) |
| `razon_social` o los nombres partidos | Según el tipo de persona |
| `correo` | **Es por donde se entrega la factura.** Si falta, no hay entrega |
| `telefono` | Ya lo tenemos en E.164 — y es por donde podríamos entregarla por WhatsApp |
| `direccion`, `municipio_dane` | El anexo los pide para el adquiriente identificado |
| `responsabilidades_fiscales` | `R-99-PN` para el consumidor final |

**Y al emitir, todo eso se copia como snapshot dentro de `fe_documento`.** Si el cliente cambia de
correo mañana, la factura de ayer no cambia — la misma regla que ya aplica
`reserva_cita_servicio.precio_snapshot` y que el `master-plan.md` §160 fijó para todo el proyecto.

### 5.6 Lo que se vende → una columna en cada tabla de producto

Un documento fiscal exige el impuesto **discriminado por línea**. Hoy no existe en ninguna vertical:

| Vertical | Tabla | Qué falta |
|---|---|---|
| Restaurante | `restaurante.carta_producto` | `codigo_impuesto`, `tarifa_impuesto`, `unidad_medida_dian`, `codigo_producto` |
| Tienda | `tienda.tienda_producto` | lo mismo (su código de barras puede servir de `codigo_producto`) |
| Gym | `gym.gym_producto`, `gym.gym_plan` | lo mismo — y ojo: **la membresía es un servicio, el batido es un bien** |
| Reserva | `reserva.reserva_servicio` | lo mismo |
| Parqueadero | `parqueadero.parq_tarifa` | lo mismo; se factura un servicio por tiempo |

Además, y solo en restaurante: **la propina va como concepto aparte y no es base gravable** (§10).

> ⚠️ **Se llama `unidad_medida_dian` y no `unidad_medida` por un motivo que ya mordió una vez:**
> `tienda.tienda_producto` **ya tenía** una `unidad_medida` con valores legibles (`'und'`, `'kg'`,
> `'lt'`), que no son códigos de la DIAN. Reutilizar el nombre habría hecho que la misma columna
> significara una cosa en tienda y otra en las demás verticales — el tipo de ambigüedad que no se
> descubre hasta que sale una factura con la unidad equivocada.

> **Quién decide la tarifa: el contador del cliente, no nosotros y no el código.** Nosotros
> aportamos el campo y el catálogo (`facturacion.fe_impuesto`); el valor lo pone el negocio en su
> configuración. **No se quema un 19% ni un 8% en ninguna parte.** Un restaurante normal cobra
> impoconsumo del 8%, pero uno franquiciado va por IVA, y uno en Régimen Simple es otra
> conversación.

### 5.7 Y lo que ya existe pero no sirve como está

| Qué hay | Por qué no basta |
|---|---|
| `gener_negocio.nit` `STRING(50)` | Texto libre, sin DV, probablemente con puntos y guiones. **Hay que normalizarlo y verificarlo**, no confiar en él |
| `pedid_orden.impuesto` | Es un **total agregado**. La factura necesita el desglose por línea, y de un total no se reconstruye |
| `tienda_venta` | No tiene ni el agregado |
| `gener_negocio.email_contacto` | Es el correo comercial; el de facturación suele ser otro |

### 5.8 El mínimo con el que se puede arrancar

Si hay que pedirle datos a un cliente sin espantarlo, este es el orden. Los primeros seis dan para
emitir un **tiquete POS electrónico**, que es el 90% del volumen:

1. `tipo_persona`
2. `tipo_documento` + `numero_documento` + **`dv`**
3. `razon_social`
4. `responsabilidades_fiscales` + `tributos`
5. `direccion_fiscal` + `municipio_dane`
6. `correo_facturacion`
7. la **resolución de numeración** (§5.4)

Para la **factura de venta** hace falta además capturar al comprador (§5.5), que es un cambio en la
pantalla de cierre de cuenta, no en los datos maestros.

---

## 6. Qué hay que construir

### 6.1 Esquema propuesto: `facturacion`

Un esquema nuevo, no dentro de `general`. Motivo: `general` es identidad y tenencia (negocios,
usuarios, roles); los documentos fiscales son un **contexto propio**, con reglas de conservación
legal (mínimo 5 años), inmutabilidad y respaldo distintas del resto. Encaja con la organización por
dominio de [ADR-002](adr/ADR-002-multitenancy.md) y hace obvia la regla de retención.

> El backlog (ESC-068) proponía `general.gener_fe_config` y `general.gener_fe_documento`. Funciona
> igual; se prefiere el esquema propio por lo anterior. Si se decide lo contrario, lo único que
> cambia es el prefijo de los nombres. **La excepción es `gener_negocio_fiscal`, que sí va en
> `general`**: es identidad del inquilino y la necesitamos aunque nunca facture (§5.2).

```
general
└── gener_negocio_fiscal   identidad fiscal del inquilino (§5.2) — también la usamos para cobrarle

facturacion
├── fe_configuracion       proveedor, credenciales, ambiente, estado
├── fe_resolucion          rangos de numeración vigentes
├── fe_impuesto            catálogo: código DIAN, nombre, tarifa
├── fe_documento           cabecera — INMUTABLE una vez ACEPTADO
├── fe_documento_linea     líneas con impuesto discriminado
└── fe_intento             bitácora de cada llamada al proveedor
```

Campos que no pueden faltar en `fe_documento`:

| Campo | Por qué |
|---|---|
| `tipo` | `FV` factura de venta · `DEE_POS` tiquete POS electrónico · `NC` nota crédito · `ND` nota débito |
| `estado` | `EN_COLA` · `ENVIADO` · `ACEPTADO` · `RECHAZADO` · `ERROR` · `ANULADO` |
| `cufe` / `cude` | El código que devuelve la DIAN. Es **la prueba** de que el documento existe legalmente |
| `origen_vertical`, `origen_tipo`, `origen_id` | De qué venta salió. Sin FK (§6.3) |
| `adquiriente_*` | Snapshot del comprador tal como estaba al facturar — nunca se relee de otra tabla |
| `subtotal`, `total_impuestos`, `total_propina`, `total` | La propina va aparte y **no es base gravable** (§10) |
| `payload`, `respuesta` (jsonb) | Lo que exactamente se envió y lo que exactamente contestaron. Es la evidencia cuando algo se discute |

Convenciones, según [ADR-024](adr/ADR-024-persistencia.md) para esquemas nuevos: **PK en UUIDv7**
(`platform.uuid_generate_v7()`, porque producción es PostgreSQL 17 y no tiene `uuidv7()` nativo),
**`timestamptz` en UTC**, y `id_negocio` entero en cada tabla.

### 6.2 Las tres invariantes que no se negocian

1. **Un documento ACEPTADO por la DIAN no se edita ni se borra. Nunca.** Corregir es emitir una
   **nota crédito**. Cualquier `UPDATE` sobre un documento aceptado que no sea de los campos de
   entrega es un bug.
2. **Una venta se factura una sola vez.** `UNIQUE (id_negocio, origen_tipo, origen_id, tipo)` en
   `fe_documento`. Un reintento no puede generar una segunda factura de la misma mesa.
3. **El consecutivo no se reutiliza jamás.** Si el proveedor lo permite, **que lleve él el
   consecutivo** (§8.2): es una fuente de errores menos, y de las caras.

### 6.3 Las verticales no dependen de `facturacion`

[ADR-005](adr/ADR-005-independencia-verticales.md) (el test del apagón) obliga: **si la facturación
se cae o se apaga, el restaurante sigue vendiendo**. En la práctica:

- **Ninguna FK** desde una tabla de vertical hacia `facturacion`. El producto guarda un
  `codigo_impuesto` de texto, validado por la aplicación contra el catálogo, no por la base.
- La venta **se cierra aunque la DIAN esté caída**. El documento queda `EN_COLA` y un worker
  reintenta.
- Y con `modo_facturacion = NINGUNO` (§4.2) el esquema `facturacion` **ni se toca**.

### 6.4 Los endpoints (hechos el 2026-09-01)

| Método y ruta | Qué hace |
|---|---|
| `GET /admin/facturacion/catalogos` | Departamentos e impuestos, para los desplegables |
| `GET /admin/negocios/:id_negocio/datos-fiscales` | La ficha **y `estado`**: si puede emitir y **qué le falta** |
| `PUT /admin/negocios/:id_negocio/datos-fiscales` | Guarda los datos. Acepta un subconjunto |
| `PUT /admin/negocios/:id_negocio/datos-fiscales/declaracion` | Lo que el cliente **declara**: registro, obligación y modo |

### 6.5 La pantalla (`/admin/facturacion`, hecha el 2026-09-01)

**No abre con un formulario: abre con una pregunta.** *«¿Tu negocio está registrado en Cámara de
Comercio y tiene RUT?»*. De ahí salen los tres caminos de §4.1, y el del medio es el que importa:
quien contesta «todavía no» ve un mensaje amable, **ni un campo más**, y no se le vuelve a
preguntar. Recibir a un negocio informal con veinte campos pidiendo códigos de responsabilidad
fiscal se lee como «esto no es para ti».

Cuatro detalles que no son decorativos:

- **La lista de «lo que falta» la redacta el backend** y la pantalla la pinta tal cual. Escribirla
  en el frontend era la tentación —parece cosa de formulario— pero lo que la DIAN exige cambia, y
  duplicada cambiaría en dos sitios.
- **El formulario cambia con `tipo_persona`:** persona natural pide el nombre partido en cuatro;
  empresa pide razón social. Y si es empresa, la pantalla **informa** de que está obligada a
  facturar siempre, en vez de preguntárselo.
- **El DV se deja vacío y lo calcula el backend.** Si se escribe uno que no corresponde, el error
  dice cuál era.
- **Se avisa en la propia pantalla de que un restaurante cobra impoconsumo y no IVA**, que es el
  error tributario más fácil de este dominio — y se remata con «confírmalo con tu contador:
  nosotros no lo decidimos por ti».

Verificado de punta a punta contra el backend real: el informal no puede activar (409 con frase
legible), el NIT `800.197.268` se guarda como `800197268` con DV `4` calculado, un DV equivocado
se rechaza diciendo el correcto, y pedir el negocio de otro devuelve **403** en los cinco casos
probados.

Tres decisiones que se ven en el contrato:

- **El parámetro se llama `id_negocio`, no `id`** como el resto de rutas de negocio. No es
  capricho: `exigirPertenenciaNegocio` solo reconoce ese nombre, y por aquí pasan el NIT y la
  dirección fiscal del inquilino. Con `:id` quedarían fuera de esa comprobación, como
  `/negocios/:id/paleta`. Además el controlador **repite la comprobación a mano** con
  `puedeOperarEn()`, porque el middleware todavía va en modo observación (audita, no bloquea).
- **Los datos y la declaración van por endpoints distintos.** Corregir una dirección no es lo
  mismo que declarar la situación legal del negocio: lo segundo deja firma —`declarado_por`,
  `declarado_en`— y es lo único que nos respalda si el cliente declara algo que no es.
- **El `GET` devuelve `estado`, no solo la ficha.** La pantalla se dibuja a partir de lo que
  falta, no de una lista de campos quemada en el frontend. Así, cuando cambie lo que la DIAN
  exige, cambia en un sitio.

---

## 7. El flujo de emisión

### 7.1 El problema de tiempo, y por qué no todo va por el outbox

Una factura electrónica de venta se valida con la DIAN **antes** de entregarla al comprador. Pero el
mesero no puede quedarse esperando en la mesa. Los dos requisitos chocan, y se resuelven así:

```
Cierre de la cuenta (restaurante)
        │
        ├─ 1. ¿el cliente quiere factura a su nombre? ─── no ───┐
        │        │ sí (o el total supera 5 UVT → obligatorio)   │
        │        ▼                                              ▼
        │   captura cédula/NIT + nombre + correo      tiquete POS electrónico
        │        │                                    (adquiriente anónimo)
        │        └───────────────┬────────────────────────────┘
        │                        ▼
        │           fe_documento  estado = EN_COLA     ← se guarda ANTES de llamar a nadie
        │                        │
        │              intento SÍNCRONO al proveedor (timeout ~6 s)
        │                        │
        │         ┌──────────────┴──────────────┐
        │     respondió                    no respondió / error
        │         ▼                             ▼
        │   ACEPTADO: CUFE, PDF, XML      sigue EN_COLA; el worker reintenta
        │         │                             │
        │         ▼                             ▼
        └──▶ la venta se cierra IGUAL en los dos casos ──▶ entrega al cliente
                                                          (correo, y WhatsApp si lo tenemos)
```

La venta **nunca** queda bloqueada por la DIAN. Lo único que cambia es si el cliente se lleva el
documento en el momento o le llega unos minutos después.

### 7.2 Dónde sí entra el outbox

El [outbox transaccional de F1](adr/ADR-012-outbox.md) no se usa para *emitir* —eso necesita
respuesta inmediata— sino para lo que pasa **después**: al aceptarse un documento se publica
`documento.fiscal.aceptado.v1`, y de ahí cuelgan la entrega por WhatsApp y las notificaciones. Eso
además le da un consumidor real al evento nuevo, que es lo que exige la regla 4 de
[ADR-013](adr/ADR-013-catalogo-eventos.md).

**Ventaja que nadie más tiene:** ya tenemos el canal de WhatsApp conectado y funcionando. Entregar
la factura por WhatsApp además de por correo es, para nosotros, un adaptador; para la competencia es
un proyecto. Es un argumento de venta que sale gratis del trabajo de F8.

### 7.3 Por vertical

| Vertical | Cuándo se emite | De dónde salen las líneas |
|---|---|---|
| **Restaurante** | Al marcar la orden como PAGADA | `pedid_detalle` |
| **Parqueadero** | Al cerrar la factura de salida | `parq_factura` |
| **Tienda** | Al confirmar la venta | `tienda_venta_detalle` |
| **Gym** | Al registrar pago de membresía o venta | `gym_pago`, `gym_venta_detalle` |
| **Reserva** | Al registrar el pago de la cita | `reserva_pago_cita` |

---

## 8. Elegir proveedor

> **Investigación hecha el 2026-09-02.** Los precios de abajo salen de las páginas públicas de cada
> proveedor y, en el caso de Factus, de **su documentación oficial de API v2**, no de material
> comercial. La versión anterior de esta sección decía que Plemsi costaba «desde ~$20.000/mes»: era
> cierto y era engañoso — son **100 documentos al mes para un solo NIT**. Corregido.

### 8.1 El criterio que decide no es el precio, es la FORMA del costo

Esto es lo primero, porque ordena todo lo demás y no es obvio.

**Nosotros cobramos una mensualidad fija.** Si el proveedor cobra **por documento**, nuestro costo
sube con lo que venda el cliente pero nuestro ingreso no. El resultado es que **el restaurante que
más factura es el que menos margen deja** — y pasado cierto volumen, tenerlo cuesta dinero.

Con un módulo de facturación vendido a $45.000 y un costo de ~$25 por documento, el cruce está en
**1.800 documentos al mes ≈ 60 tiquetes al día**. Un restaurante ocupado lo pasa sin despeinarse.

| Volumen | Costo por documento | Costo plano |
|---|---|---|
| 300 doc/mes (10 al día) | $7.500 | ~$28.000 |
| 900 doc/mes (30 al día) | $22.500 | ~$28.000 |
| 1.800 doc/mes (60 al día) | **$45.000** — se come el módulo entero | ~$28.000 |
| 3.000 doc/mes (100 al día) | **$75.000** — pérdida | ~$28.000 |

> **La regla: nuestro ingreso es plano, así que el costo también tiene que serlo.** Entre dos
> proveedores, gana el que cobre por empresa y no por documento, aunque su precio de lista parezca
> más alto. Un cliente que crece debería alegrarnos, no preocuparnos.

Corolario para las verticales: en **reserva, gym y parqueadero** el volumen documental es bajo y el
cobro por documento sí funciona. El problema es **restaurante y tienda**, que emiten muchos
documentos pequeños. Si algún día conviene, el puerto permite **dos adaptadores a la vez**.

### 8.2 Factus: verificado en su documentación, y hay un problema

Factus fue el primer contacto (correo de integración con credenciales de sandbox, ya rotadas). Su
web bloquea rastreadores, así que se sacó el **índice completo de rutas** de `developers.factus.com.co`.

**Lo que sí tiene:** facturas de venta muy completas (estándar, mandatos, transporte, sector salud,
contingencia), con ejemplos de **consumidor final** y de **propina** — los dos casos de restaurante.
Notas crédito y débito, documentos soporte y sus notas de ajuste, nómina, rangos de numeración,
recepción RADIAN.

> ### ⚠️ Lo que NO tiene: documento equivalente electrónico (tiquete POS)
>
> No hay ruta, ni ejemplo, ni rango de numeración para POS. **Ni una.**
>
> Cuidado con la confusión que casi nos cuesta el error: los `documentos-soporte` que sí aparecen
> **son otra cosa** — son para cuando el cliente *compra* a alguien no obligado a facturar. El SDK
> de JavaScript de la comunidad (`factus-js`) los traduce como «documentos equivalentes», y esa
> traducción está mal.

Dos datos más de su documentación:

- **`/v2/companies` devuelve «la empresa del usuario», en singular.** Es **una cuenta por NIT**, no
  una integración para muchos. Multi-inquilino con Factus significa una cuenta por cliente.
- **Límite de 80 peticiones por minuto** por usuario, con `429` y cabeceras `X-RateLimit-*`. Para un
  restaurante sobra, pero conviene saberlo antes de un servicio con muchas cajas a la vez.

**Y sin embargo no queda descartado**, por una salida que es legal: el tiquete POS es una
*simplificación* que la ley permite, **no una obligación**. Un negocio puede emitir **factura
electrónica de venta para todo**, incluido consumidor final anónimo — y Factus tiene ese ejemplo
hecho. Emitir siempre factura de venta es hacer *más* de lo que la ley exige, nunca menos.

Lo que sí encaja muy bien es lo que contestaron por correo: *«nuestros paquetes cuentan con rangos
de numeración ilimitados para la creación de sucursales y no tienen limitación por número de
ventas»*. **Eso es exactamente la forma de costo de §8.1.** Falta el precio, que no es público.

### 8.3 Los candidatos, con precios reales

| Proveedor | Forma del costo | ¿Tiquete POS? | ¿Varios NIT? | Precio |
|---|---|---|---|---|
| **Factus** | **Plano, documentos ilimitados** | ❌ No | Una cuenta por NIT | No público — **cotizar** |
| **MATIAS API** (Lopezsoft) | Por documento, anual prepago | ✅ Sí | ✅ Programa «casas de software», clientes ilimitados | $220.000/año (5.000 doc, $44/doc) → $6.000.000/año (500.000 doc, **$12/doc**) |
| **Facturalatam** (Digital Búho) | Mensual por cupo de empresas + tope de documentos | ✅ Sí | ✅ Marca blanca | $99.900/mes (10 emp · 5.000 doc) · $349.900 (50 · 30.000) · $999.900 (200 · 150.000) |
| **Plemsi** | Por documento | ✅ Sí | Bolsa multiempresa, precio no público | $19.000/mes (100 doc) · $1.242.000/año (24.000) · **$16,83/doc** en volumen |
| **GridPOS** | Por documento, una empresa | ✅ Sí | ❌ | $1.049.900/año (30.000 doc) = $35/doc |
| **Saphety** | Por documento | ✅ Sí | ❌ | $1.200.000 / 2.000 doc = **$600/doc** — descartado |
| **Alegra · Dataico · The Factory HKA · Aliaddo · Siigo** | Cotización | ✅ Sí | Por confirmar | No público — **son PT confirmados en el catálogo de la DIAN** |

**Trayectoria de los dos que más encajan:** MATIAS declara 800+ empresas activas, 130+ casas de
software y 8,75M documentos en 2025, con aceptación DIAN en ~1,8 s; hay un testimonio de un
integrador que lleva dos años **gestionando varios clientes de restaurantes desde un solo panel**.
Facturalatam es **Digital Búho SAS, constituida el 19 de junio de 2024** y clasificada como
microempresa: precio bueno, respaldo corto para una ruta crítica.

⚠️ **MATIAS exige 3 clientes habilitados en 6 meses** para el programa de casas de software. Hoy
tenemos dos negocios.

### 8.4 PT autorizado vs. «software propio»: la diferencia cuesta $100.000 al año por cliente

No es un matiz jurídico, es una línea del presupuesto.

| | **Proveedor tecnológico (PT)** | **Software propio** |
|---|---|---|
| Quién firma | El PT, con su certificado, por mandato del cliente | **Cada negocio, con el suyo** |
| Certificado por NIT | Normalmente no hace falta | **Sí — ~$100.000/año, sin excepción** |
| Titular ante la DIAN | El negocio, con el PT de intermediario | El negocio, **directo** |
| Quiénes son | Alegra, Aliaddo, Saphety, HKA, Carvajal, Dataico, Siigo (verificados en el catálogo) | **MATIAS y Facturalatam lo declaran abiertamente** |

Que cada cliente sea titular directo **nos conviene** —encaja con
[`obligaciones-escalapp.md`](obligaciones-escalapp.md) §6: no quedamos en el medio—, pero añade un
trámite y un costo por cliente. Con un PT de verdad ese costo puede desaparecer. **Es una pregunta
de cotización, no de arquitectura.**

⚠️ **El certificado gratuito de la DIAN no sirve aquí:** solo funciona dentro del servicio gratuito
de la DIAN. En cuanto se usa un proveedor externo, hace falta uno de pago.

⚠️ **El listado de PT que publica la DIAN en PDF es de septiembre de 2020.** Sirve para confirmar a
los antiguos, no para descartar a nadie. Antes de firmar hay que mirar el **Catálogo de
Participantes vigente**: <https://micrositios.dian.gov.co/sistema-de-facturacion-electronica/proveedores-tecnologicos/>

### 8.5 Las preguntas que deciden — hacerlas ANTES de firmar

1. **¿Emiten documento equivalente electrónico (tiquete POS), o solo factura de venta?**
   Si no emiten POS, o nos sirve la vía de §8.2 (factura de venta para todo) o no nos sirven.
2. **¿El precio es por documento o por empresa?** Ver §8.1. Es *la* pregunta.
3. **¿Una integración para muchos NIT, o una cuenta por NIT?**
   Define si escalar a 50 clientes es una llamada o cincuenta.
4. **¿Hace falta certificado digital por cliente, o firman ustedes?** Ver §8.4.
5. **¿Quién lleva el consecutivo?** Preferimos que lo lleven ellos.
6. **¿Quién hace la habilitación de cada cliente ante la DIAN?** Si la hacen ellos, nos quitan el
   cuello de botella del onboarding.
7. **¿Hay sandbox separado de producción?** Imprescindible.
8. **¿Qué pasa cuando cambia el anexo técnico?** La respuesta correcta es «nada, lo actualizamos
   nosotros sin costo».
9. **¿Entregan ellos el correo al adquiriente, o lo hacemos nosotros?**
10. **¿Cuánto cuesta el documento por encima de la bolsa?** Es el precio que de verdad se paga.

### 8.6 Lo que falta por confirmar antes de decidir

1. **Cotizar Factus**: precio por cuenta, si es de verdad ilimitado en documentos, si tienen
   programa de integrador, y si el POS está en su hoja de ruta.
2. **Cotizar Alegra, Dataico y The Factory HKA** — PT confirmados. Un correo puede eliminar el
   certificado por cliente y traspasarles responsabilidad normativa.
3. **¿Un documento POS consume el mismo cupo que una factura?** Ninguno lo dice en su web y para un
   restaurante cambia el costo entero.
4. **Contar los tiquetes reales de Pregonchos** (`id_negocio` 12): órdenes pagadas al mes. Todo el
   análisis se apoya en «900 documentos al mes» y ese dato está en la base. **Con la cifra real la
   decisión se cierra sola.**

> La aritmética del margen y la estructura de planes que sale de todo esto tienen documento propio:
> **[`precios-y-planes.md`](precios-y-planes.md)**. Lo que no hay que hacer, y aquí no cambia: **la
> facturación no va incluida en el plan Básico.** Con el interruptor de §4.2, el cliente que no la
> quiere no la paga ni la ve.

---

## 9. Plan por fases

| Fase | Qué | Bloqueada por |
|---|---|---|
| **FE-0** | **No es código.** Confirmar con un contador el régimen y los impuestos del primer cliente; elegir proveedor con las preguntas de §8.2; que el cliente saque su **habilitación y su resolución de numeración**. Se empieza el día que firma | Trámite externo, plazos ajenos |
| **FE-1** | ✅ **HECHA el 2026-09-01, en local.** `general.gener_negocio_fiscal` + `general.gener_departamento` (33, completo) + `facturacion.fe_impuesto`, helper del NIT con DV, `puedeEmitir()`, y las 4 columnas fiscales en las 6 tablas de producto de las 5 verticales. `npm run migrate:facturacion`. **22 pruebas en verde.** Sin desplegar y sin aplicar en la base compartida | — |
| **FE-2** | Puerto + primer adaptador contra **sandbox**. Emitir factura de venta desde restaurante de punta a punta | FE-0 (credenciales), FE-1 |
| **FE-3** | Tiquete POS electrónico, notas crédito, worker de reintentos, entrega por correo y **por WhatsApp** | FE-2 |
| **FE-4** | ✅ **Endpoints y pantalla hechos (2026-09-01).** 4 endpoints + `/admin/facturacion` en `admin_app-v21`, con los tres caminos de §4.1. Verificado de punta a punta contra el backend real. Lo demás (listado de documentos, alerta de rangos, ESC-071) sigue esperando a FE-3 | El resto, FE-3 |
| **FE-5** | Resto de verticales: parqueadero, tienda, gym, reserva | FE-3 |

**FE-1 no dependía de nada externo**, y además **sirve aunque el cliente nunca facture**: es lo que
necesitamos para cobrarle nosotros (§12). Era el trabajo útil mientras el trámite avanza, y ya está.

**Lo que FE-1 dejó a propósito para después:** la pantalla para capturar estos datos (los
endpoints ya están, ver FE-4), el catálogo de municipios (llega con el proveedor, FE-2) y la feature
comercial de ADR-021 — no se añadió porque **todavía no hay nada que bloquear**: sin emisión, una
puerta cerrada no protege nada. Hay además una pregunta pendiente ahí: `features.js` vive hoy en
`intelligence/core/`, y hacer que facturación dependa de Intelligence sería una dependencia al
revés. Se decide en FE-2, que es cuando hace falta.

---

## 10. Trampas conocidas

Cosas que se descubren tarde y caro. Anotadas antes de tropezar con ellas.

- **La propina no es base gravable.** El 10% voluntario va como concepto aparte, no suma a la base
  del impuesto. Facturarlo como producto es un error tributario.
- **Un restaurante no cobra IVA, cobra impoconsumo (INC) del 8%.** Otro código, otra regla, y además
  depende del régimen del negocio. **No se quema en el código:** sale de la configuración del
  negocio y del catálogo de impuestos, y quien lo dice es el contador del cliente.
- **El NIT que tenemos hoy no es de fiar.** Texto libre, sin DV. Normalizar y verificar antes de
  usarlo para nada fiscal.
- **El municipio va en código DANE, no por nombre.**
- **Cuenta dividida entre comensales** = varios documentos, cada uno con su consecutivo.
- **Anular no es borrar.** Se emite nota crédito. Si alguien «anula» una orden ya facturada
  cambiando su estado, el documento fiscal sigue existiendo ante la DIAN.
- **El cliente que pide factura después de cerrada la cuenta.** Si ya se emitió el POS electrónico,
  toca nota crédito del POS + factura de venta nueva. **Se evita preguntando antes de cerrar**, y
  esa es una decisión de interfaz, no de backend.
- **Nunca mezclar sandbox y producción.** Una factura de prueba enviada al ambiente real quema un
  consecutivo que no se recupera.
- **Rango agotado o resolución vencida = el negocio no puede facturar.** Avisar con antelación, no
  cuando ya pasó.
- **Fecha de emisión en hora Bogotá.** Coincide con la convención del repo (`America/Bogota` wall
  time); si el negocio cierra a las 2 a.m., la fecha del documento es la que la DIAN espera, no la
  del turno.

---

## 11. Lo que queda explícitamente fuera del alcance

Nombrado para que no aparezca como sorpresa a mitad de camino:

- **Nómina electrónica.** Otro documento, otro anexo, otro proyecto. Nuestros clientes la resuelven
  con su contador.
- **RADIAN** (eventos de acuse, aceptación y rechazo para negociar facturas). Solo importa si el
  cliente vende a crédito y quiere factoring.
- **Documento soporte en compras a no obligados a facturar.** Es real y le sirve a un restaurante
  que compra en la plaza de mercado, pero es el lado de *compras*, no el de ventas. Anotado como
  candidato futuro.
- **Recepción de facturas de proveedores.**

---

## 12. Lo legal que nos incumbe a NOSOTROS

Todo lo anterior es sobre la factura que emite **el cliente**. Pero hay una segunda pregunta, más
incómoda y más urgente: **¿qué obligaciones tenemos nosotros por cobrar mensualidades y por manejar
los datos de los clientes de nuestros clientes?**

Tiene documento propio, porque es otro tema:
**[`obligaciones-escalapp.md`](obligaciones-escalapp.md)**. Los cuatro titulares:

1. **Nosotros también estamos obligados a facturar** lo que cobramos — y desde que EscalApp es
   **persona jurídica, esa obligación no tiene umbral: es de hoy**. No cobrar IVA no exime de
   facturar: son obligaciones independientes.
2. **Hoy las mensualidades NO llevan IVA** — la contadora lo confirmó el 2026-09-01: la empresa es
   muy pequeña y no es responsable de IVA. La pregunta de si el SaaS califica como computación en
   la nube (art. 476 ET) queda **aplazada, no resuelta**: vuelve el día que crezcamos.
3. **Manejamos datos personales de gente que no es cliente nuestro** (los comensales del
   restaurante). Ley 1581 de 2012: hace falta contrato de tratamiento y política publicada.
4. **Si nuestro software falla, el cliente no factura.** Eso hay que acotarlo por contrato antes del
   primer cliente grande, no después.

**El más rentable de los cuatro es el primero**, y por una razón bonita: para facturarle a nuestros
clientes necesitamos exactamente los mismos campos de §5.2 y exactamente el mismo adaptador de
§8. Podemos ser **nuestro propio primer cliente de facturación electrónica** y probar toda la
integración sin arriesgar la caja de nadie.

---

## 13. Glosario

| Término | Qué es en llano |
|---|---|
| **Adquiriente** | El comprador. Si va identificado, es factura de venta; si va anónimo, tiquete POS |
| **CUFE / CUDE** | El código único que la DIAN devuelve al validar. Es la prueba de que el documento existe |
| **DV** | Dígito de verificación del NIT. El número suelto después del guion |
| **Documento equivalente** | Un comprobante que la ley acepta en lugar de la factura (el tiquete POS es uno de doce tipos) |
| **DEE** | Documento equivalente electrónico: lo mismo, pero transmitido a la DIAN |
| **INC** | Impuesto nacional al consumo. El 8% de los restaurantes. **No es IVA** |
| **Proveedor tecnológico (PT)** | Empresa habilitada por la DIAN para transmitir por cuenta de otros |
| **Resolución de numeración** | El permiso de la DIAN que dice qué prefijo y qué rango de números puede usar un negocio |
| **Responsabilidades fiscales** | Los códigos del RUT que dicen qué es cada contribuyente (`O-47`, `R-99-PN`…) |
| **RST / Régimen Simple** | Régimen tributario opcional que unifica varios impuestos |
| **UBL 2.1 / XAdES** | El formato XML y la firma digital que exige el anexo técnico. Con un PT, no los tocamos |
| **UVT** | Unidad de Valor Tributario. **$52.374 en 2026** (Resolución 000238 del 15-dic-2025) |
| **Validación previa** | La DIAN aprueba la factura **antes** de que se entregue al comprador |

---

## 14. Fuentes

Consultadas el 2026-09-01. Las normas se citan por número para poder verificarlas.

- Artículo 616-1 del Estatuto Tributario (Ley 2155 de 2021, art. 13) — límite de 5 UVT del tiquete POS
- Artículo 616-2 del Estatuto Tributario — casos en que no se requiere expedir factura
- Resolución DIAN 001092 de 2022 — calendario del límite de 5 UVT
- Resolución DIAN 000165 del 1-nov-2023 — sistema de facturación y documentos equivalentes electrónicos
- Resolución DIAN 000008 del 31-ene-2024 — calendario del documento equivalente electrónico; anexo técnico 1.9
- Resolución DIAN 227 de 2025 — personas naturales obligadas a facturar electrónicamente
- Resolución DIAN 000238 del 15-dic-2025 — UVT 2026 = $52.374
- Resolución DIAN 000042 de 2020 — habilitación de proveedores tecnológicos (patrimonio 20.000 UVT)
- Concepto DIAN 1169 (013246) de 2025 — requisitos del software propio o adquirido
- Micrositio DIAN — Documento Equivalente Electrónico
