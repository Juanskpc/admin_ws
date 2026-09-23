# Facturación electrónica: qué es, qué exige la DIAN y cómo la va a hacer EscalApp

**Estado:** documentación previa a la implementación · **Decisión que la gobierna:** [ADR-026](adr/ADR-026-facturacion-electronica.md) · **Fecha:** 2026-09-01 · **Última revisión:** 2026-09-15 (§8.2-sexies: llegan el Contrato de Alianza y el Acuerdo de Confidencialidad; no existe paquete mensual) · **Backlog:** ESC-067 a ESC-071

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

### 1.5-bis ⚠️ «POS ilimitado» NO significa «documentos ilimitados»

*(Añadido el 2026-09-11, después de leer los planes de Loggro.)*

Es la confusión más cara de este dominio y la usan **todos** los competidores, no por engaño sino
porque la palabra «POS» significa dos cosas distintas:

| «POS» como… | Qué es | ¿Cuesta por unidad? |
|---|---|---|
| **Módulo de software** | La pantalla de caja donde el mesero registra la venta | **No.** Es tu propio software |
| **Documento fiscal** | El documento equivalente electrónico que se transmite a la DIAN | **Sí.** Consume cupo del proveedor |

Cuando un plan dice **«POS Online ILIMITADO»**, habla de lo primero: puedes registrar todas las
ventas que quieras en la caja. **No** quiere decir que puedas transmitir documentos gratis a la
DIAN. Prueba de ello, en el mismo plan que promete «POS ilimitado»: **30 facturas electrónicas
incluidas al mes** y los documentos ilimitados **como recargo aparte** (§8.8).

**La regla, sin adornos: desde 2024, cada venta de un negocio obligado a facturar genera un
documento electrónico que va a la DIAN.** No existe un mínimo por debajo del cual la venta no
produzca documento. Un café de $3.000 genera documento igual que una cuenta de $300.000; lo único
que cambia es **cuál** de los dos documentos (§1.2).

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
cerrada **para EscalApp sola**, y con eso se decidió [ADR-026](adr/ADR-026-facturacion-electronica.md).

> 🔄 **Reabierta como exploración el 2026-09-13, y por una vía que no existía cuando se escribió
> esto: una SOCIEDAD.** Una empresa de software con la que ya se trabaja —cliente de un sistema
> que desarrollamos nosotros— confirmó que **cumple el patrimonio y la propiedad, planta y
> equipo**. Eso no habilita a EscalApp ni a una sociedad nueva (los requisitos son de la persona
> jurídica que se habilita, no de sus socios), pero sí abre estructuras donde **la habilitación
> se queda en la empresa que ya cumple** y EscalApp aporta el producto.
>
> **Todo el análisis vive en [`proveedor-tecnologico-dian.md`](proveedor-tecnologico-dian.md)**:
> las tres puertas, los requisitos explicados, la ISO 27001 paso a paso, qué es exactamente
> propiedad planta y equipo, las cuatro estructuras societarias y los nueve puntos de la
> negociación.
>
> ⚠️ **Esto NO detiene la integración con Factus**, y no debe: entre construir el emisor, la ISO
> y la habilitación, la primera factura real de un PT está a un año, y queremos poder ofrecer
> facturación antes de eso. Si algún día el PT emite, se cambia el adaptador del puerto de FE-2 — que es
> exactamente para lo que se diseñó. **Si avanza, necesita un ADR-028** que reemplace al 026.

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

> **Investigación hecha el 2026-09-02, rehecha el 2026-09-11.** Los precios salen de las páginas
> públicas de cada proveedor y, en el caso de Factus, de **su lista de precios oficial y de sus
> Términos y Condiciones**, recibidos por correo el 2026-09-11.
>
> **Dos correcciones importantes respecto a la versión anterior de esta sección:**
>
> 1. **Decía que Plemsi costaba «desde ~$20.000/mes».** Era cierto y era engañoso: son 100
>    documentos al mes para un solo NIT. Corregido el 2026-09-02.
> 2. **Decía que Factus tenía costo PLANO con documentos ilimitados. Es FALSO.** Factus cobra por
>    **bolsa anual de documentos**, igual que casi todos. El error salió de leer una frase de un
>    correo comercial —*«rangos de numeración ilimitados para la creación de sucursales y no tienen
>    limitación por número de ventas»*— como si hablara del cupo de documentos. **Habla de los
>    rangos de numeración de las sucursales**, que es otra cosa. La misma frase aparece como nota
>    al pie de su lista de precios, justo debajo de la tabla de bolsas. Corregido el 2026-09-11, y
>    con ello cae la única razón por la que Factus parecía el favorito. Ver §8.2.

### 8.1 El criterio que decide no es el precio, es la FORMA del costo

Esto es lo primero, porque ordena todo lo demás y no es obvio.

**Nosotros cobramos una mensualidad fija.** Si el proveedor cobra **por documento**, nuestro costo
sube con lo que venda el cliente pero nuestro ingreso no. El resultado es que **el restaurante que
más factura es el que menos margen deja** — y pasado cierto volumen, tenerlo cuesta dinero.

Con un módulo de facturación vendido a $45.000 y un costo de ~$25 por documento, el cruce está en
**1.800 documentos al mes ≈ 60 tiquetes al día**. Un restaurante ocupado lo pasa sin despeinarse.

### El volumen real, medido (2026-09-11)

> ⚠️ **Aclarado el 2026-09-14: Zona Burger NO ha pedido facturación electrónica.** Se usa como
> **referencia de cuánto vende un restaurante activo**, porque es el que más vende en la base. Hoy
> **ningún cliente la ha pedido**: se construye para estar listos cuando alguien la pida, para
> fijar los planes y para poder anunciarla. Donde este documento dice «el costo de Zona Burger»,
> léase «el costo de un restaurante de ese tamaño».

Hasta hoy esta sección se apoyaba en «900 documentos al mes», que era una cifra inventada. **Ya no
hace falta suponer.** Contados en la base de producción (consulta de solo lectura sobre
`restaurante.pedid_orden`, órdenes en estado `CERRADA`), el cliente que más vende —**ZONA BURGER**,
`id_negocio` **6**— lleva este ritmo:

| Mes | Tiquetes | Días con venta | Tiquetes/día | Ticket promedio | Ventas |
|---|---|---|---|---|---|
| 2026-04 (parcial) | 149 | 7 | 21,3 | $25.812 | $3.846.043 |
| 2026-05 | 1.226 | 30 | 40,9 | $32.263 | $39.554.500 |
| 2026-06 | 1.192 | 30 | 39,7 | $31.927 | $38.057.500 |
| 2026-07 | 1.494 | 30 | 49,8 | $33.415 | $49.922.500 |
| 2026-08 | **1.730** | 30 | **57,7** | $32.553 | $56.316.002 |
| 2026-09 (11 días) | 549 | 11 | 49,9 | $34.172 | $18.760.500 |

Últimos 30 días: **1.627 tiquetes**, sin un solo día en blanco. Por tipo: LLEVAR 662, DOMICILIO
501, MESA 464. Acumulado desde abril: 6.340 órdenes cobradas y 69 canceladas.

**Tres lecturas que cambian el análisis:**

1. **El volumen real es casi el doble de la hipótesis** (1.730 contra 900) y **sube todos los
   meses**. La proyección anual de este solo cliente es de **~21.000 documentos**, y con la
   tendencia de julio y agosto el año que viene son 30.000.
2. **Ya está prácticamente en el punto de quiebre** de 1.800 documentos que define esta sección.
   Lo cruza este mes o el próximo.
3. **No es el único negocio**, pero sí el que manda. El resto de negocios de producción están uno
   o dos órdenes de magnitud por debajo (el segundo, `ZONA BURGER PR`, es un piloto abandonado con
   140 tiquetes en total y nada desde agosto). Cualquier estructura de precios tiene que aguantar
   a un cliente así, porque es justo el cliente que se quiere tener.

### ⚠️ Tiquetes vendidos y documentos emitidos no son el mismo número (2026-09-12)

Toda la tabla de arriba cuenta **tiquetes**, o sea ventas, y da por hecho que cada venta genera un
documento electrónico. **Legalmente es así**: desde el calendario de 2024, un negocio obligado tiene
que emitir un documento por cada venta, sin mínimo por monto (§1.4).

**En la práctica no ocurre así, y conviene decirlo en voz alta porque cambia las cuentas.** Muchos
negocios pequeños y medianos solo emiten cuando el cliente lo pide. No es una suposición cómoda: es
la explicación más simple de un dato que ya está en este documento — **Loggro incluye 30 documentos
al mes** en planes de $120.990 a $219.990 (§8.8), y todos los competidores anuncian «POS ilimitado»
refiriéndose al módulo de caja (§1.5-bis). Si el restaurante típico emitiera 1.700 documentos al
mes, un plan con 30 incluidos sería inservible y nadie lo compraría. **Ese número existe porque a
una parte real de su base le alcanza.**

#### Qué se hace con eso, y qué NO se hace

Lo que **no** se hace es diseñar el producto suponiendo que el cliente incumple. No por moral: por
riesgo. Si la DIAN aprieta la fiscalización, o si el contador del cliente le dice que emita todo,
**el volumen se multiplica de un mes al siguiente** y la bolsa que compramos se queda corta a mitad
de año — con el bloqueo automático de §8.2-bis esperando al final.

Lo que sí se hace, y es más simple que estimar:

> **El tramo se cobra por documentos EMITIDOS, medidos por nosotros, no por tiquetes vendidos.**

El sistema sabe exactamente cuántos documentos mandó al proveedor: es un contador, no una hipótesis.
Con eso, el procedimiento se cae de maduro:

1. Un cliente nuevo **arranca en el tramo bajo**, sin adivinar nada.
2. Se mide **un mes real** de emisión.
3. La bolsa se dimensiona sobre lo medido, y el tramo del cliente se ajusta cuando lo cruza, avisado
   por adelantado.

Así, la pregunta «¿cuánto declara de verdad este cliente?» deja de tener que contestarse **antes** de
vender: la contesta el propio sistema el primer mes, y la respuesta vale a la vez para lo que
pagamos y para lo que cobramos.

#### Lo que sigue siendo verdad de la medición

Los 1.730 tiquetes al mes de Zona Burger son el **techo** de su volumen documental, y es el número
con el que hay que dimensionar el peor caso y negociar la bolsa. Lo que cambia es que **no es
necesariamente lo que se va a emitir el primer mes**. Las dos cifras importan y son distintas:

| | Para qué sirve |
|---|---|
| **Tiquetes vendidos** (1.730/mes) | Dimensionar el peor caso, negociar el tramo de la bolsa, saber a qué se expone el margen |
| **Documentos emitidos** (por medir) | Cobrar el tramo, comprar la bolsa del año, decirle al cliente cuánto paga |

**Medir la segunda es trabajo de FE-2**, y hasta que exista no hay forma de saberla: hoy el sistema
no emite nada, así que el contador está en cero por construcción. Mientras tanto, **todas las
cuentas de este documento usan el techo**, que es el supuesto conservador — si la emisión real es
menor, todo sale mejor de lo escrito, nunca peor.

### La conclusión, después de ver los precios de verdad

La regla original decía: *«nuestro ingreso es plano, así que el costo también tiene que serlo»*.
**Con los precios reales en la mano, esa salida no existe: no hay proveedor de costo plano.** Ver
§8.2 — el único candidato que lo parecía no lo era.

Así que la regla se invierte, y es la conclusión práctica de toda esta sección:

> **Si el costo es por documento y no se puede evitar, el ingreso NO puede ser plano.** El módulo
> de facturación tiene que cobrarse por tramos de volumen, o pasarse al cliente a precio de costo.
> Lo que no se puede es venderlo a precio fijo con un costo variable detrás.

Quién paga esa bolsa —el cliente directamente o nosotros revendiéndola— se decide en §8.7, y la
vara para fijar el precio está en §8.8: **lo que cobra el líder del mercado, que es tres veces lo
que cobramos nosotros.**

Corolario para las verticales: en **reserva, gym y parqueadero** el volumen documental es bajo y el
cobro por documento apenas se nota. El problema es **restaurante y tienda**, que emiten muchos
documentos pequeños. Si algún día conviene, el puerto permite **dos adaptadores a la vez**.

### 8.2 Factus: la lista de precios real (2026-09-11)

Factus fue el primer contacto. El 2026-09-11 mandaron **la lista de precios y los Términos y
Condiciones completos**, así que esta sección deja de ser deducción y pasa a ser dato.

#### Facturación electrónica — bolsas ANUALES, conexión API

Incluye notas crédito y débito, documento soporte y nota de ajuste.

| Documentos/año | Precio anual | Costo por documento |
|---|---|---|
| 150 | $169.000 | $1.127 |
| 400 | $190.000 | $475 |
| 1.600 | $220.000 | $138 |
| 2.500 | $260.000 | $104 |
| 5.000 | $290.000 | $58 |
| 10.000 | $390.000 | $39 |
| 15.000 | $440.000 | $29 |
| 20.000 | $490.000 | $25 |
| 35.000 | $820.000 | $23 |
| 50.000 | $1.100.000 | $22 |
| 80.000 | $1.700.000 | $21 |
| 120.000 | $2.160.000 | **$18** |

> Nota al pie de la propia lista: *«Rangos de numeración ilimitados para la creación de sucursales,
> sin limitación por ventas»*. **Esto es lo que se malinterpretó como "documentos ilimitados".** Lo
> ilimitado son los rangos de numeración de las sucursales, no la bolsa. La tabla de arriba es la
> que manda.

Hay dos listas más, ambas fuera de nuestro alcance hoy (§11): **RADIAN** (recepción de documentos,
desde $60.000/año por 24 hasta $900.000 por 5.000) y **nómina electrónica por interfaz de aliados
API** (desde $60.000/año por 24 hasta $480.000 por 1.200). Se anotan porque la de nómina confirma
que **existe un programa de aliados**, que es la pregunta que puede cambiarlo todo (§8.6).

#### Qué cuesta ZONA BURGER con estos precios

Con ~21.000 documentos al año y creciendo, la bolsa de 20.000 se le queda corta antes de terminar
el año:

| Bolsa | Precio anual | Equivalente mensual | Alcanza |
|---|---|---|---|
| 20.000 | $490.000 | $40.833 | No — ya va en 20.760/año |
| 35.000 | $820.000 | $68.333 | Sí, con margen para el crecimiento |
| **20.000 + 5.000 al agotarse** | **$780.000** | **$65.000** | **Sí, y es lo más barato** |

> ✅ **La tercera fila se añadió el 2026-09-12**, cuando Factus confirmó que **las bolsas se pueden
> sumar** y que **lo que sobra caduca al año** (§8.2-quater). Eso invierte la recomendación que
> tenía esta tabla: comprar «con margen para el crecimiento» es pagar por documentos que caducan.
> Lo correcto es comprar el tramo justo y ampliar al agotarse.

**$65.000 al mes de costo contra un módulo de $45.000 es pérdida directa.** No es un problema de
Factus: es el problema de §8.1 con cifras reales. Y conviene ver la otra cara: ese mismo negocio
factura **$56 millones al mes**, así que $65.000 es el **0,12% de sus ventas**. El costo no es caro
para el cliente. Es caro solo si lo absorbemos nosotros a precio fijo.

#### ⚠️ Sigue sin emitir documento equivalente electrónico (tiquete POS)

Lo verificado el 2026-09-02 en el índice de rutas de su API v2 **queda confirmado por la propia
lista de precios**, que enumera qué incluye la bolsa: *«notas crédito y débito, documento soporte y
nota de ajuste»*. **Ni una mención al documento equivalente ni al tiquete POS.**

Cuidado con la confusión que casi nos cuesta el error: los `documentos-soporte` **son otra cosa** —
son para cuando el cliente *compra* a alguien no obligado a facturar. El SDK de JavaScript de la
comunidad (`factus-js`) los traduce como «documentos equivalentes», y esa traducción está mal.

**Y sigue sin quedar descartado por esto**, por la misma salida legal: el tiquete POS es una
*simplificación* que la ley permite, **no una obligación**. Un negocio puede emitir **factura
electrónica de venta para todo**, incluido consumidor final anónimo — y Factus tiene ese ejemplo
hecho, junto con el de propina, que son justo los dos casos de restaurante. Emitir siempre factura
de venta es hacer *más* de lo que la ley exige, nunca menos.

#### Dos límites técnicos de su documentación

- **`/v2/companies` devuelve «la empresa del usuario», en singular.** Leído solo, parece **una
  cuenta por NIT** y no una integración para muchos. ⚠️ **No se puede concluir eso del endpoint**
  (§8.2-ter explica por qué): comercialmente **sí existe la bolsa repartida entre varios NIT**.
  Lo que sigue sin saberse es si esa modalidad usa **una sola credencial** o mantiene una cuenta
  por cliente con la bolsa en común — es la pregunta 2 del correo de §8.9, y **decide el diseño
  del adaptador de FE-2**.
- **Límite de 80 peticiones por minuto** por usuario, con `429` y cabeceras `X-RateLimit-*`. Para
  Zona Burger sobra por mucho (58 tiquetes al **día**), pero conviene saberlo antes de un cliente
  con muchas cajas simultáneas.

### 8.2-bis Lo que dicen los Términos y Condiciones, y hay cuatro cosas que importan

Leídos completos el 2026-09-11. La mayoría es lo normal. **Cuatro cláusulas cambian cómo hay que
construir la integración**, y ninguna es negociable con ellos:

1. **§f.9 — Bloqueo automático por no renovación.** *«En caso de vencerse el plazo de suscripción y
   no realizar la renovación, FACTUS bloqueará automáticamente la cuenta»*. Traducido: **el día que
   se acabe la bolsa o venza el año, el cliente no puede facturar**, y es una tarde de restaurante
   perdida. **Obligación para nosotros: vigilar el saldo de la bolsa y avisar con semanas de
   antelación**, igual que ya está previsto para el rango de numeración en §10. Es la misma
   trampa con otro dueño.
2. **§f.7 — No hay respaldo al eliminar una cuenta, y es irreversible.** *«no existe respaldo de
   información en caso de eliminación de cuentas»*. Los documentos fiscales hay que conservarlos
   años por ley. **Obligación para nosotros: guardar en nuestra base el XML firmado, el CUFE y el
   PDF de cada documento emitido**, no solo el identificador. Si el cliente se va de Factus, sus
   facturas se quedan con nosotros. Esto es un requisito de diseño de FE-2, no un "estaría bien".
3. **§f.11 — Ocho días calendario para el certificado digital.** Tras comprar el plan, el cliente
   tiene 8 días para mandar la documentación del certificado; si no, **el plan empieza a contar
   desde el día noveno igual**, esté activo o no. Dicho de otro modo: **el reloj de la suscripción
   corre aunque el cliente no haya terminado su trámite.** El onboarding tiene fecha límite y hay
   que decírselo al cliente el primer día. Queda por confirmar si el certificado va incluido en el
   precio o se cobra aparte (§8.4: son ~$100.000/año si es aparte).
4. **§g — Se eximen de toda garantía.** *«FACTUS no se hará responsable por la exactitud,
   confiabilidad o integridad del contenido»*, y *«renuncia a toda garantía explícita o
   implícita»*. Ellos no responden y el obligado ante la DIAN es el cliente. **Nosotros quedamos en
   el medio comercialmente aunque no legalmente**, que es exactamente lo que
   [`obligaciones-escalapp.md`](obligaciones-escalapp.md) §6 dice que hay que evitar.

Lo demás, anotado sin alarma: registro por cuenta con **cámara de comercio de menos de 30 días,
cédula del representante legal y RUT** (fricción de onboarding, y hay que pedírselo al cliente);
mención expresa a un **«acuerdo de alianza y acuerdo de confidencialidad (para aliados)»**, que
confirma el programa de aliados; retracto de 5 días hábiles y **ninguna devolución fuera de ese
plazo**; el uso de la API está expresamente permitido; y la jurisdicción es Bucaramanga.

### 8.2-ter ~~La pregunta que Factus contesta sola~~ — deducción equivocada, se conserva como aviso

> ❌ **Esta sección se equivocó, y el error se corrigió el 2026-09-12 (§8.2-quater).** Se deja
> escrita porque la forma del error se repite: **se dedujo una postura de negocio a partir de un
> detalle de la API.** Que `/v2/companies` devuelva una empresa en singular dice cómo está hecho
> un endpoint, no qué vende la empresa. El programa de aliados existía todo el tiempo y bastaba
> con preguntar.

Lo que decía: que una cuenta por NIT no es una limitación menor sino una **postura**, que con
Factus no se puede agrupar el volumen de varios clientes en una bolsa grande y barata, y que por
tanto **ser el intermediario con Factus daría todo el costo y ninguna ventaja de escala**. De ahí
concluía que Factus nos empujaba, sin querer, hacia lo que
[`obligaciones-escalapp.md`](obligaciones-escalapp.md) §6 ya recomendaba: **no quedar en el medio**
de la relación fiscal del cliente con la DIAN.

**Lo cierto es que sí se puede agrupar** (bolsa repartida entre varios NIT, certificado aparte), y
que el argumento de «no quedar en el medio» protege menos de lo que parecía — está desmontado con
cuidado al final de §8.7.

### 8.2-quater La respuesta de Factus (2026-09-12): sí hay bolsa compartida, y cuesta $130.000 por NIT

Factus contestó las cinco preguntas de §8.9. **Cierra la pregunta que §8.7 había dejado como bisagra
de toda la decisión**, y la respuesta es que sí. Textualmente:

> 1. *«Si nuestro programa de aliados les permite tener varios clientes o NIT activos, para sistemas
>    SaaS tenemos las dos opciones, paquetes para 1 solo NIT con certificado incluido y bolsas para
>    dividir en varios NIT donde se adquiere el certificado por cada uno por aparte.»*
> 2. *«Solo manejamos factura electrónica que es válida por la DIAN para sistemas POS y se puede
>    emitir como consumidor final.»*
> 3. *«Para clientes con alto volumen también pueden adquirir paquetes individuales, cada paquete o
>    bolsa tiene una vigencia de 1 año, si se agota pueden adquirir uno nuevamente.»*
> 4. *«En los paquetes individuales viene incluido, en las bolsas se cobra por aparte y tiene un
>    valor de 130mil anual.»*
> 5. *«Nosotros hacemos todo el proceso de habilitación ante la DIAN, una vez activo el NIT
>    activado solo debe agregar el rango de numeración, nosotros incluimos el envío de correo de la
>    factura en todos los planes.»*

#### 1. Hay dos productos, no uno, y son los dos caminos de §8.7 con precio

| | **Paquete individual** | **Bolsa repartida entre varios NIT** |
|---|---|---|
| Para quién | Un solo NIT | Varios clientes bajo nuestra integración |
| Certificado digital | **Incluido** | **$130.000/año por cada NIT**, aparte |
| Quién compra | El cliente | Nosotros |
| Corresponde a | **Opción A** de §8.7 | **Opción B** de §8.7 |

Los $130.000 anuales del certificado son, literalmente, **el precio de la opción B**: es lo que
cuesta por cliente y por año poder repartir una bolsa grande. Y esa cifra convierte una decisión que
llevaba dos semanas abierta en una cuenta de restar.

#### 2. La bolsa compartida NO conviene con un solo cliente, y sí con dos

La comparación, con el volumen real de ZONA BURGER (21.000 documentos/año, §8.1) y aprovechando que
la respuesta 3 confirma que **las bolsas se pueden sumar**:

| Clientes de ese tamaño | Qué se compra | Bolsas | Certificados | Total/año | **Por cliente/mes** |
|---|---|---|---|---|---|
| **A — 1, paquete individual** | 20.000 + 5.000 al agotarse | $780.000 | incluido | $780.000 | **$65.000** |
| B — 1 en bolsa repartida | igual | $780.000 | $130.000 | $910.000 | **$75.833** |
| B — 2 | bolsa de 50.000 | $1.100.000 | $260.000 | $1.360.000 | **$56.667** |
| B — 3 | 50.000 + 15.000 | $1.540.000 | $390.000 | $1.930.000 | **$53.611** |
| B — 5 | bolsa de 120.000 | $2.160.000 | $650.000 | $2.810.000 | **$46.833** |

Con un cliente, B pierde por **exactamente el certificado** ($130.000/año = $10.833/mes): la bolsa
es la misma, el certificado es lo único que se suma. **Con el segundo cliente ya gana**, y a partir
de ahí la ventaja crece sola.

De paso, esa tabla corrige un dato que esta sección arrastraba: el costo de Zona Burger no son
$68.333/mes (la bolsa de 35.000), son **$65.000** comprando la de 20.000 y ampliando con una de
5.000 al agotarse. Es poco, pero es la diferencia entre comprar bien y comprar «con margen».

#### 3. Donde la bolsa compartida de verdad gana no es con el cliente grande, es con los pequeños

Eso es lo contrario de lo que parecía. Una barbería o un parqueadero que emite **150 documentos al
año**:

| | Costo anual | Por documento |
|---|---|---|
| Paquete individual (tramo de 150) | **$169.000** | $1.127 |
| Dentro de la bolsa compartida (tramo alto, $18/doc) | 150 × $18 = $2.700 **+ $130.000 de certificado** = **$132.700** | $885 |

El cliente grande ahorra un 28% al agruparse; el pequeño ahorra menos en plata, pero **se ahorra el
tramo absurdo**: paga documentos a precio de mayorista en vez de a $1.127 cada uno.

> **El número que hay que llevarse de aquí:** en la opción B el costo marginal de un cliente es
> **$130.000/año ≈ $10.833/mes de suelo fijo** (el certificado) **más $18–25 por documento**. Un
> cliente pequeño cuesta el certificado y poco más; Zona Burger cuesta $10.833 + $31.500 =
> **$42.333/mes**. Contra el módulo de $99.000 que propone §8.8, el margen es de $56.667.

#### 4. Factus hace la habilitación ante la DIAN

Era **la ventaja que ponía a Alegra por delante** en §8.6, y desaparece: *«nosotros hacemos todo el
proceso de habilitación»*. Al cliente solo le queda **agregar el rango de numeración**, que sigue
siendo trámite suyo y que §10 ya vigila. Esto quita el cuello de botella del onboarding, que era el
verdadero riesgo operativo de vender esto a varios clientes a la vez.

#### 5. El correo al adquiriente va incluido en todos los planes

Cierra la pregunta 9 de §8.5: no hay que construir el envío. Lo que **sí** hay que construir sigue
siendo guardar copia propia del XML firmado, el CUFE y el PDF (§8.2-bis, punto 2) — que ellos
entreguen el correo no nos exime de conservar el documento.

#### 6. Las bolsas se suman, y caducan al año

*«cada paquete o bolsa tiene una vigencia de 1 año, si se agota pueden adquirir uno nuevamente»*.
Dos consecuencias, una buena y una mala:

- **Buena:** se puede empezar por el tramo justo y ampliar al agotarse, en vez de comprar de entrada
  un tramo grande.
- **Mala:** **lo que sobra se pierde al año.** Comprar «con margen para el crecimiento» —que es lo
  que recomendaba la versión anterior de §8.2— es tirar dinero. La regla correcta es comprar el
  tramo que cubre lo previsto y **vigilar el saldo**, que es la misma obligación que ya imponía el
  bloqueo automático de §8.2-bis, punto 1.

#### Lo que la respuesta 2 deja a medias

*«Solo manejamos factura electrónica que es válida por la DIAN para sistemas POS y se puede emitir
como consumidor final»* admite dos lecturas, y conviene no quedarse con la cómoda:

- **Lectura probable, y coherente con todo lo demás:** no emiten documento equivalente POS; emiten
  **factura electrónica de venta**, que sirve perfectamente en un punto de venta y admite adquiriente
  «consumidor final». Es exactamente la salida legal de §8.2 —hacer *más* de lo que la ley exige,
  nunca menos—, confirmada ahora por el propio proveedor.
- **Lectura optimista:** que tengan algo específico para POS. **Su propia lista de precios lo
  desmiente** (enumera notas crédito y débito, documento soporte y nota de ajuste, sin una palabra
  del documento equivalente), y el índice de rutas de su API v2 también.

Se asume la primera. Pero confirmarlo es **una línea de correo**, y va en el siguiente (§8.9).

#### Lo que sigue sin contestar, y ahora es lo único que falta

> ✅ **Actualizado el 2026-09-14 con la reunión (§8.2-quinquies):** la 2 está contestada (una
> cuenta por cliente), la 3 casi (avisan antes y la recarga es inmediata; el consumo por cliente en
> bolsa llega «en los próximos meses») y la 4 a medias (alianza + confidencialidad, sin
> exclusividad; mínimos sin hablar). La 1 sigue abierta.

1. **¿La bolsa repartida se cobra con la misma lista de precios pública, o hay lista de aliados?**
   Todas las cuentas de arriba usan la lista pública, que es el supuesto conservador. Si hay
   descuento de aliado, B gana antes de llegar al segundo cliente.
2. **¿Una sola credencial para varios NIT, o una cuenta por NIT con la bolsa en común?** Es una
   pregunta técnica, no comercial, y **decide cómo se diseña el adaptador de FE-2**: si es una
   credencial, `fe_configuracion` guarda un identificador de empresa; si son cuentas separadas,
   guarda credenciales por negocio. Recordar que `/v2/companies` devuelve *«la empresa del
   usuario»*, en singular (§8.2).
3. **¿Qué pasa en el instante en que se agota la bolsa?** ¿Se bloquea la emisión de inmediato, hay
   aviso previo, y existe un endpoint para consultar el saldo? Sin endpoint de saldo, vigilar el
   consumo hay que hacerlo contando nosotros los documentos emitidos.
4. **¿Qué exige el programa de aliados?** Contrato, confidencialidad y —lo que importa— **si pide
   un mínimo de clientes**. MATIAS pide 3 habilitados en 6 meses (§8.3); si Factus pide algo
   parecido, hoy no se cumple.

### 8.2-quinquies La reunión con Factus (2026-09-14): una cuenta por cliente, sin exclusividad, y se pueden mezclar

Factus contestó el correo de seguimiento de §8.9 ofreciendo una reunión por Meet. Se preparó un
guion de 13 preguntas y estas son las respuestas, **tomadas a mano durante la llamada**: son lo que
se dijo de viva voz, no un texto de ellos. Lo que decide diseño hay que pedirlo confirmado por
correo (al final de esta sección).

| # | Pregunta | Lo que dijeron | Estado |
|---|---|---|---|
| P1 | ¿Qué se necesita para entrar al programa? | Es para **sistemas que se integran por API**. Se firma un **acuerdo de alianza y uno de confidencialidad**. **Sin mínimo de clientes ni costo de entrada** | ✅ |
| P2 | ¿Exclusividad o no competencia? | **No hay exclusividad**, solo alianza y confidencialidad | ✅ |
| P3 | ¿Una credencial para todos o una por cliente? | *«Los usuarios facturan por aparte»*; **la credencial es independiente por usuario** | ✅ **una cuenta por cliente, con la bolsa en común** |
| — | ¿Paquete individual o bolsa? | Los dos, como ya se sabía, **y se pueden mezclar** («pueden ser híbridas») | ✅ nuevo |
| P4 | ¿Sandbox con varias empresas? | Sí, **se puede hacer todo el flujo**, pero los documentos **salen con los datos de Factus** | ✅ a medias: una empresa de prueba, la suya |
| P5 | ¿Sin tiquete POS, factura de venta para todo? | Confirmado: no emiten POS; la DIAN permite cumplir solo con factura electrónica, que tiene más ventajas y admite consumidor final | ✅ |
| P6 | ¿Precio de aliado? | **No hay precios de aliado**: aplica la misma lista pública (la de §8.2) | ✅ las cuentas de `precios-y-planes.md` ya la usan |
| P7 | ¿Consultar saldo y consumo por cliente? | **Paquete individual: sí** se consulta lo gastado. **Bolsa: los documentos se asignan a cada cliente**, y consultar el consumo **llegará «en los próximos meses»** | ⚠️ en bolsa, todavía no |
| P8 | ¿Qué pasa al agotarse? | **Avisan antes** de que se acabe, y la **activación de una bolsa nueva es inmediata** | ✅ |
| P9 | ¿Intermitencias y soporte? | Ante intermitencias **se espera y se vuelve a intentar**. El horario llegó por escrito en el Acuerdo de Nivel de Servicio | ✅ ver apartado 6: después de las 8 p. m. no hay respuesta hasta el día siguiente |
| P10 | ¿Cambios del anexo técnico? | **Las actualizaciones las hacen ellos** | ✅ se pide confirmar por escrito que no tiene costo |
| P11 | ¿Descargar XML y PDF por la API? | No se habló | ⏳ |
| P12 | ¿Papeles y tiempo del alta? | Jurídica: **cámara de comercio, RUT y cédula del representante legal**. Natural: **RUT y cédula**. De palabra dijeron 3 días hábiles; **por escrito, 1 a 2 días hábiles** (lo usual, 1) | ✅ por escrito, ver abajo |
| P13 | ¿El límite de 80 peticiones/minuto es compartido? | **Es por usuario**, y cada cliente es un usuario | ✅ no se comparte |

#### 1. La pregunta que bloqueaba FE-2 está contestada: una cuenta por cliente

Cada negocio es **un usuario de Factus con su propia credencial**; lo que se comparte, si se usa
bolsa, es el cupo de documentos. Consecuencias directas para el diseño:

- **`facturacion.fe_configuracion` guarda credenciales por negocio**, no un identificador de empresa
  bajo una credencial nuestra. Eso cuadra con que `/v2/companies` devuelva *«la empresa del
  usuario»* en singular (§8.2): el endpoint decía la verdad técnica, lo que estaba mal en §8.2-ter
  era sacar de ahí la postura comercial.
- **Custodiamos credenciales de terceros**, así que van **cifradas en reposo** y nunca viajan al
  frontend. No es opcional: con ellas se emiten documentos fiscales a nombre del cliente.
- **El límite de 80 peticiones/minuto es de cada cliente**, no de todos juntos. Deja de ser un techo
  para crecer.
- **Falta saber quién crea esas cuentas**: si nosotros por la API o Factus a mano en cada alta.
  Cambia el alta, no el adaptador.

#### 2. El sandbox desbloquea construir, aunque sea con una sola empresa

*«Sale con los datos de Factus»* significa que el ambiente de pruebas emite a nombre de su empresa
de prueba, no de varias. **No bloquea**: como cada cliente es una credencial, dos negocios de la
base de desarrollo pueden apuntar a la misma credencial de sandbox y el adaptador no nota la
diferencia. Lo que no se puede probar así es que dos NIT distintos convivan, y eso de nuestro lado
es solo una fila distinta en `fe_configuracion`.

#### 3. ⚠️ Lo que cambia de §8.7: la razón técnica para elegir B desde el primer cliente se cae

§8.7 eligió B «desde el primer cliente» con tres razones. La primera era que **construir el
producto dos veces cuesta más de $130.000**: en A el negocio pegaba *sus* credenciales y en B las
gestionábamos nosotros. **Con una cuenta por cliente en los dos casos, la integración es la misma**:
paquete individual o bolsa, el adaptador habla con una credencial por negocio. Y además **se pueden
mezclar**. Lo único que cambia entre A y B es **quién compra y cómo se reparten los documentos**, no
el código.

Las otras dos razones siguen en pie, pero **las dos necesitan varios clientes**: B gana con el
segundo cliente grande, y el cliente pequeño solo tiene sentido dentro de una bolsa que ya agregue
volumen. Con un único cliente, B solo cuesta los $130.000 del certificado y no compra nada a cambio.
Se suma un motivo práctico: **en bolsa todavía no se puede consultar el consumo por cliente**, y en
el paquete individual sí.

> **Qué se hace con esto (corregido el 2026-09-14): nada que comprar todavía.** Ningún cliente ha
> pedido facturación; Zona Burger era solo la referencia de volumen (§8.1). Así que ahora se
> **construye y se prueba en el sandbox**, que no cuesta nada, y **la modalidad se decide con el
> primer cliente real**. La regla para ese día: **con un solo cliente, paquete individual**
> ($130.000/año más barato, certificado incluido, consumo consultable); **la bolsa, cuando haya
> varios que agregar**. Cada cliente se decide al comprar su cupo, nunca a mitad de año, porque lo
> que sobra caduca (§8.2-quater, punto 6). **El código no tiene que elegir**: una credencial por
> negocio sirve para las dos.
>
> Y **los tramos de `precios-y-planes.md` aguantan aunque nunca se llegue a la bolsa**: comprobado
> con los precios del paquete individual en ese documento, §3.

Queda por confirmar que **dentro de la alianza podemos comprar nosotros el paquete individual a
nombre del cliente**. Si no, ese cliente le compra a Factus y nosotros le cobramos solo la
integración (la opción A tal como estaba escrita).

#### 4. Una pregunta nueva que salió de la P7

*«Por bolsa, se le asigna a cada cliente»*: la bolsa no es un cupo común del que todos gastan, sino
**cantidades asignadas por NIT**. Entonces hay que saber **qué pasa cuando un cliente gasta su parte
y la bolsa todavía tiene saldo**: si se bloquea ese cliente, y si se puede **reasignar** sin
esperar. Es la trampa del bloqueo automático (§8.2-bis, punto 1) con una capa más, y hasta que
llegue la consulta de consumo prometida hay que contar nosotros lo emitido por cliente, que ya era
el plan para cobrar por tramos.

#### 5. El alta de un cliente, con tiempos

Se **compra el paquete** (el comprobante es uno de los requisitos) → se mandan los papeles a
`activacion@factus.com.co` → **1 a 2 días hábiles** → el cliente agrega su rango de numeración. Con
el plazo de 8 días de §8.2-bis, punto 3, que corre desde la compra, el mensaje para el cliente es:
**tener todos los papeles listos antes de comprar**. La lista exacta está en el apartado siguiente.

#### 6. Lo que mandaron por escrito durante la reunión (chat de WhatsApp, 2026-09-14)

Esto **sí es texto de Factus**, así que manda sobre las notas de la llamada cuando no coinciden.

**Modalidades, confirmadas por escrito:**
- **Paquete:** se activa para **1 NIT (una razón social)**, dura **1 año**, incluye facturas
  electrónicas, notas crédito, documentos soporte y notas de ajuste, y **trae su certificado
  digital**.
- **Bolsa multifacturador:** se divide entre los clientes que se quiera, y **por cada cliente
  activado se compra un certificado de $130.000/año**.

**Documentos del aliado (nosotros).** El mensaje los enumeraba como adjuntos, pero **con el usuario
de pruebas solo llegaron dos: el Acuerdo de Nivel de Servicio 2026 y los Términos y Condiciones**
(los mismos de §8.2-bis). **El contrato y el acuerdo de confidencialidad NO llegaron: hay que
pedirlos.**

| Documento | Estado | Qué hacer |
|---|---|---|
| Acuerdo de Nivel de Servicio 2026 | ✅ Recibido | Solo leer; no se devuelve. Resumen abajo |
| Términos y Condiciones | ✅ Recibido | Ya analizados en §8.2-bis |
| Acuerdo de Confidencialidad y No Divulgación | ❌ **No llegó** | Pedirlo; luego diligenciar, firmar y devolver |
| Contrato de Alianza Comercial | ❌ **No llegó** | Pedirlo; leerlo completo antes de firmar |

**El Acuerdo de Nivel de Servicio, en lo que le importa a un restaurante:**

- Servicio **24/7**; horario hábil de soporte **lunes a viernes, 8 a. m. a 8 p. m.**
- **Falla crítica** (no conecta la API ni la plataforma): en horario hábil responden en **1 hora**;
  en fin de semana o festivo entre 8 a. m. y 8 p. m., en **2 horas**; **después de las 8 p. m.,
  al día siguiente desde las 8 a. m.** Falla media: 4 horas hábiles; baja: 6 horas hábiles.
- ⚠️ **Mantenimiento programado: después de las 8 p. m.**, hasta 4 horas, una vez al mes, avisado
  con 72 horas. **Esa es la hora pico de la cena**, y un viernes a las 9 p. m. con la API caída no
  hay a quién llamar hasta el sábado. **Conclusión de diseño: la venta NUNCA puede esperar a que
  salga la factura.** La emisión va aparte y se reintenta sola (§7), y los avisos de mantenimiento
  de Factus hay que convertirlos en un aviso al restaurante.
- **Los tiempos no cuentan si la falla es de la DIAN**, si entró en contingencia, o por fuerza
  mayor.
- Soporte: WhatsApp +57 316 133 1234 · `soporte@factus.com.co`.

**Dos detalles nuevos de los Términos y Condiciones** que no estaban en §8.2-bis:
- §f.2 dice que los paquetes se pueden adquirir **«de manera mensual o anual»**. Si existe el
  paquete mensual, **resuelve buena parte de «quién pone la plata del año»**
  ([`precios-y-planes.md`](precios-y-planes.md) §3). Va en el correo de cierre.
- Se dan por aceptados **con solo recibirlos por correo** y pueden cambiar **sin previo aviso**.
  Por eso lo que nos importe tiene que quedar en el **contrato de alianza**, no en los T&C.

> ⚠️ **Leer el contrato de alianza completo antes de firmarlo.** De palabra dijeron que no hay
> exclusividad; lo que vale es lo que diga el contrato, y ahí también deberían estar los mínimos,
> el costo de entrada y los precios (preguntas 1 y 2 del correo de cierre). **Varias preguntas del
> correo se pueden contestar leyéndolo**, así que conviene leerlo primero y preguntar solo lo que
> no esté.

**Cuando se pase a producción**, los datos de cada cliente se mandan a
**`activacion@factus.com.co`**:

| Requisito | Nota |
|---|---|
| RUT actualizado | |
| Certificado de existencia y representación legal, **de menos de 30 días** | No aplica a persona natural |
| Cédula del representante legal | |
| **Comprobante de compra del paquete** | O sea: primero se compra, después se activa |
| **Logo en PNG o JPG** | Lo pinta Factus en el PDF. Podemos tomarlo del logo que el negocio ya tiene en EscalApp |
| **Versión de la integración (v1 o v2)** | La nuestra es **v2** |

**Tiempo de activación: 1 a 2 días hábiles, lo usual 1.** Corrige los 3 días que quedaron en las
notas de la llamada.

#### 7. ✅ Primeras facturas en el sandbox (2026-09-14): validadas, y los totales cuadran al centavo

Con `node scripts/factus_factura_prueba.js` (solo sandbox). Tres facturas de restaurante a
consumidor final, con propina del 10% como recargo; **las tres validadas por la DIAN** (ambiente de
habilitación) en unos segundos:

| Número | Escenario | Nuestro total | Total de Factus |
|---|---|---|---|
| SETP990019103 | Sin impuesto (`is_excluded`) | $50.600,00 | **$50.600,00** |
| SETP990019104 | Impuesto al consumo 8% | $54.280,00 | **$54.280,00** |
| SETP990019105 | INC 8% con precios de carta que YA lo incluyen (22.000 y 6.500) | $55.175,93 | **$55.175,93** |

**Lo que se aprendió, y es lo que hay que usar en FE-2:**

- **Precio de carta con impuesto incluido: funciona.** Se divide entre 1,08 con dos decimales
  ($22.000 → $20.370,37) y Factus devuelve la línea en **exactamente** $44.000 y $6.500: el cliente ve
  en la factura el mismo precio que en la carta. No hizo falta `cash_rounding_amount`.
- **La propina como recargo `03` funciona**: sale en el PDF como «Recargo global», fuera de la base
  del impuesto, y suma al total. Los pagos deben sumar el total **con** la propina.
- **`is_excluded: true` se valida, pero Factus lo reporta como «IVA excluido, 0%»**
  (`tribute 01`). Para un negocio no responsable funciona en la práctica, pero legalmente
  «excluido» y «no responsable» son figuras distintas → pregunta 6 del correo de cierre, y
  confirmarlo con un contador antes del primer cliente.
- **Los cuatro avisos salen en las tres facturas y NO son rechazos**: `FAJ43b` y `FAJ44b` (nombre
  y NIT de la empresa de pruebas no coinciden con el RUT), `RUT01` (validación de RUT «próximamente»)
  y `FAQ04a` («la descripción no corresponde al código»). Como aparecen igual con y sin impuesto,
  **salen de los datos de la empresa de pruebas de Factus, no de lo que enviamos**. Con un NIT real
  habrá que volver a mirar `FAQ04a`.
- **La respuesta trae todo lo que hay que guardar**, sin llamadas extra: `number`, `cufe`,
  `validated_at`, `totals` (bruto, base, impuesto, recargos, total), `links.public_url` (la factura
  en la web de Factus) y `links.qr` (el enlace de la DIAN). **La factura viene directo en `data`**,
  sin envoltorio.
- **PDF y XML se descargan por la API** en base64 (`/v2/bills/:number/download-pdf` y
  `download-xml`). Esto cierra la duda de §8.2-bis punto 2: sí podemos guardar copia propia.
- El encabezado `X-RateLimit-Remaining` marcó 117 tras tres peticiones: el límite real del sandbox
  parece **120 por minuto**, no los 80 que dice la documentación. No cambia nada; se anota.

#### 8. Si EscalApp compra para facturar sus propias mensualidades (analizado 2026-09-14, sin decidir)

**Contexto:** hoy EscalApp tiene 4 clientes (2 fijos, 2 sin confirmar), así que emitiría muy pocas
facturas. **Para PROBAR no hace falta comprar nada**: el sandbox pasa por el ambiente de
habilitación de la DIAN y cubre todo lo que es código (apartado 7). Lo único que el sandbox no
cubre es trámite: alta de un NIT real, cruce con el RUT real, correo al comprador y consumo de la
bolsa. La vía recomendada sigue siendo **construir y probar en sandbox, y pasar a producción con el
primer cliente que la pida**. Comprar para EscalApp es opcional y se analiza por si se quiere
ensayar el alta real o empezar a facturar las mensualidades.

**Si se compra: paquete individual, no bolsa.** Con un solo NIT la bolsa trae los mismos documentos
y cobra el certificado aparte (150 documentos: $169.000 en paquete contra $299.000 en bolsa). La
bolsa solo sirve con varios NIT que la repartan, y no hay precio de aliado que lo cambie (P6).

**Recomendado: el de 400 documentos/año por $190.000.**

| Paquete | Precio/año | Alcanza para (facturas de mensualidad) |
|---|---|---|
| 150 | $169.000 | ~12 clientes todo el año |
| **400** | **$190.000** | **~30 clientes todo el año** |

Hoy serían 24–48 al año, más **notas crédito** (correcciones) y **documentos soporte** (pagos a
personas no obligadas a facturar, p. ej. un desarrollador persona natural), que salen del mismo
paquete. El de 150 alcanza para hoy, pero **cuesta solo $21.000 menos**, y si la publicidad trae
clientes y se agota, comprar otro de 150 deja el año en $338.000. Si no se esperan más de ~10
clientes en el año, el de 150 basta.

**Antes de comprar:**
1. **Papeles listos antes de pagar** (RUT, cámara de comercio de menos de 30 días, cédula del
   representante): desde la compra corren 8 días (T&C §f.11) o el año empieza a contar igual.
2. **Decidir antes la SAS con el socio.** Un NIT nuevo no hereda el paquete del actual: lo que
   quede se pierde. Si la sociedad va pronto, esperar a tener el NIT definitivo.
3. **Esperar la respuesta del paquete mensual** (pregunta 6 del correo): con pocos clientes podría
   salir mejor.
4. **Preguntar si el paquete incluye la plataforma web de Factus** para facturar a mano (sus T&C
   §f.1 la describen). Si la incluye, EscalApp puede facturar sus mensualidades desde ya, sin
   esperar la integración.

Aparte de todo esto: EscalApp es persona jurídica y **está obligada a facturar sus mensualidades**
con o sin Factus ([`obligaciones-escalapp.md`](obligaciones-escalapp.md)) — revisarlo con la
contadora.

#### El correo de cierre (pendiente de enviar)

Dos propósitos: dejar por escrito lo que se dijo de viva voz y cerrar lo que no dio tiempo.

---

**Asunto:** Resumen de la reunión y preguntas pendientes — EscalApp

Buen día, y gracias por el espacio de hoy.

Para dejar por escrito lo conversado, entendimos lo siguiente; les agradecemos confirmarlo o
corregirlo:

- El programa de aliados es para sistemas que se integran por API. Para entrar se firma un acuerdo
  de alianza y uno de confidencialidad, **sin exclusividad**, **sin mínimo de clientes** y **sin
  costo de entrada**.
- **No hay precios especiales para aliados**: aplica la misma lista de precios que nos enviaron.
- Cada cliente tiene **su propio usuario y credenciales**, con límite de peticiones independiente.
- Podemos combinar **paquetes individuales** (con certificado incluido) y **bolsas repartidas**
  entre varios NIT (con certificado aparte, $130.000/año).
- La activación de cada cliente la hacen ustedes con su RUT, certificado de existencia y
  representación legal y cédula del representante legal (en persona natural, RUT y cédula), y
  toma de 1 a 2 días hábiles.
- La activación de una bolsa nueva es inmediata y avisan antes de que se agote.
- Las actualizaciones por cambios en el **anexo técnico de la DIAN** las realizan ustedes, sin
  costo adicional para nosotros.

Por ahora estamos en la fase de integración en el ambiente de pruebas: la compra de paquetes vendrá
cuando activemos al primer cliente. Recibimos el acuerdo de nivel de servicio y los términos y
condiciones, pero **no el contrato de alianza comercial ni el acuerdo de confidencialidad**: ¿nos
los pueden enviar para revisarlos antes de devolverlos firmados?

Nos quedan algunas preguntas:

1. ¿Firmar el contrato de alianza **nos obliga a comprar en alguna fecha**, o podemos firmarlo ahora
   y hacer la primera compra cuando tengamos el primer cliente?
2. Para entender bien **el alta de cada cliente**: una vez enviamos sus documentos, ¿ustedes crean
   su cuenta y **nos entregan sus credenciales de API**, o las creamos nosotros? ¿Nos pueden
   compartir el paso a paso completo, desde la compra hasta que el cliente emite su primera factura
   (documentos, certificado digital, habilitación y rango de numeración), y qué parte le toca a
   cada uno?
3. En la bolsa, si un cliente **gasta los documentos que tiene asignados** y la bolsa aún tiene
   saldo, ¿se bloquea ese cliente? ¿Se pueden **reasignar** documentos entre clientes, y es
   inmediato?
4. Dentro de la alianza, ¿podemos **comprar nosotros un paquete individual a nombre de un cliente**?
5. Para un negocio que **no es responsable de IVA ni de impuesto al consumo**, ¿cómo se deben
   reportar los productos? En pruebas usamos `is_excluded: true` y la factura se validó, pero en la
   respuesta aparece como **IVA excluido**, que legalmente es otra figura.
6. Los términos dicen que los paquetes se adquieren **«de manera mensual o anual»**. ¿Existe un
   **paquete mensual**, y a qué precio?

Quedamos atentos para recibir los acuerdos de alianza y confidencialidad.

Gracias,

---

### 8.2-sexies Llegan el Contrato de Alianza y la Confidencialidad (2026-09-15): se cierra el correo, y se cae la esperanza del paquete mensual

El mismo asesor (+57 316 133 1234) contestó el correo de cierre de §8.9, mitad por WhatsApp mitad
por correo. Por correo llegaron por fin los **dos documentos que faltaban** (§8.2-quinquies, punto
6): el **Acuerdo de Confidencialidad y No Divulgación** y el **Contrato de Alianza Comercial**
(«CONTRATO DE SOFTWARE (API) – ALIANZA COMERCIAL»). Los dos ya se leyeron completos, no solo el
resumen.

#### 1. Las 6 preguntas del correo de cierre, contra la respuesta

| # | Pregunta (§8.9) | Respuesta (WhatsApp, 2026-09-15) | Estado |
|---|---|---|---|
| 1 | ¿Firmar obliga a comprar en una fecha? | **No.** *«Los documentos se envían en PDF firmados para quedar en pie como ALIADOS y ya puedas proceder cuando lo desees con las activaciones que desees realizar.»* Coincide con la cláusula CUARTA del contrato: el pago es **«de forma anticipada para la activación o renovación»**, no al firmar | ✅ **Se puede firmar ya, sin comprar nada** |
| 2 | Paso a paso del alta, ¿quién crea la cuenta? | Parcial: al activar el panel mandan videos guía; la asociación de **rangos de numeración** la hace el aliado o su contador. No dice explícitamente quién genera las credenciales | ⚠️ sigue sin ser el paso a paso completo que se pidió |
| 3 | En bolsa, ¿se puede reasignar entre clientes? | **Sí, a solicitud**: *«tú nos indicas cuántos documentos le asignamos a cada cliente y si deseas agregarle más documentos, lo realizamos según tu solicitud».* No es autoservicio ni instantáneo, pero confirma que se puede | ✅ resuelto, manual |
| 4 | ¿Podemos comprar un paquete a nombre de un cliente? | Confirmado, y por escrito en el contrato — cláusula PRIMERA.B: *«El ALIADO podrá hacer uso propio o si así lo desea comercializar con los usuarios de su software»* | ✅ |
| 5 | Producto sin IVA ni impoconsumo, ¿`is_excluded` es correcto? | **✅ Resuelta por WhatsApp el 2026-09-22**, al reenviar la pregunta junto con los contratos firmados: *«si sr debe enviarse como is_excluded en true»*, *«un producto puede ser excluido o exento»*, *«la responsabilidad es aparte según el facturador»* — es decir: el campo del producto (excluido/exento) es independiente de si el NEGOCIO es responsable de IVA/INC, que se configura aparte. Confirma el diseño que ya asumía §5.7 | ✅ **resuelta** |
| 6 | ¿Existe paquete mensual? | **No.** *«Nuestros paquetes son anuales, tanto en individuales como en bolsas.»* | ❌ **cierra la esperanza de §8.2-quinquies sobre el T&C §f.2** |

**Consecuencia de la 6:** §8.2-quinquies apuntaba que un paquete mensual *«resuelve buena parte de
quién pone la plata del año»* (`precios-y-planes.md` §3). Queda descartado: la mención de «mensual o
anual» en los T&C (§f.2) no se traduce en un producto real. **La pregunta de quién paga el año sigue
abierta, sin la salida fácil**, y las tres opciones de `precios-y-planes.md` §3 —permanencia de 12
meses, cobro de activación, o que el cliente compre su propio paquete— siguen siendo las únicas
sobre la mesa. La buena noticia es que la respuesta 1 dice que **no hay prisa por decidirlo para
firmar la alianza**: eso solo hace falta el día que exista un cliente real.

#### 2. Lo que trae el Contrato de Alianza, leído completo por primera vez

- **Reparto de responsabilidad, tal como ya se había diseñado** (cláusula SEGUNDA.K y PARÁGRAFO
  PRIMERO de la QUINTA): Factus responde por la infraestructura y el funcionamiento del API y por
  la habilitación ante la DIAN; EscalApp responde por la integración y por los datos que envía, y
  es **el único responsable comercial y de soporte frente a sus propios clientes** — Factus no
  asume ninguna obligación directa con ellos. Coincide exactamente con la postura de
  [`obligaciones-escalapp.md`](obligaciones-escalapp.md) §6: no quedar en el medio.
- **Garantía si Factus pierde la habilitación ante la DIAN** (PARÁGRAFO SEGUNDO de la cláusula
  PRIMERA): si no la restablece en **3 días hábiles**, debe devolver proporcionalmente lo pagado por
  los paquetes no ejecutados, **y asume la responsabilidad frente a EscalApp** por las consecuencias
  administrativas o económicas que eso le genere a los usuarios finales. Es una protección real, no
  cosmética.
- **Continuidad del servicio si la alianza termina** (PARÁGRAFO de la cláusula NOVENA): los paquetes
  ya activos siguen operando **hasta su vencimiento anual**, pase lo que pase con la relación
  comercial. Si el motivo de la terminación es un incumplimiento de Factus, EscalApp además puede
  exigir la devolución proporcional de lo pagado por paquetes no ejecutados, en 30 días hábiles.
- **Terminación unilateral sin penalidad**, con 60 días calendario de preaviso (cláusula NOVENA.5).
  Vigencia de 1 año, con renovación automática salvo aviso de 60 días antes del vencimiento.
- **Autorización de marca** (DÉCIMA SEGUNDA): se puede usar el nombre «FACTUS» para promocionar el
  servicio a nuestros clientes, respetando sus lineamientos gráficos, mientras dure el contrato.
- **Cesión y subcontratación** (DÉCIMA TERCERA): Factus puede ceder el contrato en una fusión o
  venta sin pedirnos autorización previa, si el nuevo operador acredita capacidad equivalente
  (avisando en 15 días). Si subcontrata algo que toque nuestros datos o los de nuestros clientes,
  sí necesita autorización previa nuestra, y el subcontratista debe firmar las mismas obligaciones
  de confidencialidad y protección de datos que Factus.
- **Domicilio contractual: San Gil, Santander.** Arreglo directo → conciliación → justicia ordinaria
  colombiana, en ese orden (cláusula DÉCIMA).

#### 3. Lo que trae el Acuerdo de Confidencialidad

- **Recíproco**, y sobrevive **5 años** después de terminada la relación comercial (cláusula QUINTA).
- **Fija por escrito el reparto de datos personales que hasta ahora era solo un diseño nuestro**
  (cláusula PRIMERA y SÉPTIMA): **EscalApp (ALIADO) es RESPONSABLE del tratamiento** de los datos de
  sus usuarios finales; **Factus es ENCARGADO del tratamiento**, obligación que le sobrevive aunque
  termine la relación. Esto cierra por contrato lo que `obligaciones-escalapp.md` §6 ya asumía como
  diseño — conviene citarlo ahí cuando se actualice ese documento.
- Mismo domicilio de controversias: San Gil, Santander.

#### 4. Requisitos documentales, ya confirmados y con quién

| Para quién | Documentos | Cuándo |
|---|---|---|
| **EscalApp, como ALIADO** (una sola vez) | Cámara de Comercio (**≤30 días**) + RUT actualizado | Antes de firmar |
| **Cada cliente que se active** | RUT, certificado de existencia y representación legal (≤30 días; no aplica a persona natural), cédula del representante legal, comprobante de pago del paquete, logo PNG/JPG, versión de integración (**v2**, la nuestra) | Al comprar su paquete, a `activacion@factus.com.co` |

**Pago:** transferencia a la cuenta de ahorros Bancolombia **322-000053-83** (Llave
**0090582804**), a nombre de **FACTUS S.A.S., NIT 901724254-1**.

⚠️ **EscalApp está registrada como Sociedad Unipersonal a nombre personal de Nicolás** (matrícula
renovada el 2026-08-28) — la Cámara de Comercio caduca en 30 días, así que conviene sacarla **justo
antes de enviar los documentos firmados**, no antes.

#### 5. Qué falta, en orden

1. **Diligenciar y firmar** el Acuerdo de Confidencialidad y el Contrato de Alianza, con los datos
   de EscalApp / Nicolás como representante legal. **Firmarlos no obliga a comprar nada** (P1): se
   puede hacer ya, sin esperar al primer cliente.
2. **Sacar la Cámara de Comercio actualizada (≤30 días) y el RUT** de EscalApp para adjuntarlos.
3. ✅ **Pregunta 5 resuelta (2026-09-22)** — ver tabla arriba. Ya no queda ningún punto legal
   pendiente para poder facturarle a un cliente no responsable de IVA/INC.
4. **Retomar «quién pone la plata del año»** en `precios-y-planes.md` §3 — ya hay un candidato a
   primer cliente real (JDD Consultores, ver `project_fe_como_servicio_terceros` en memoria de
   ADMIN_APP), así que esto deja de ser hipotético y toca decidirlo pronto, ya sin la salida del
   paquete mensual.

#### 6. ⚠️ Contradicción sin resolver: ¿hay o no precio de aliado?

La reunión del 2026-09-14 contestó **P6** con un «no»: *«No hay precios de aliado: aplica la misma
lista pública»* (§8.2-quinquies), y `precios-y-planes.md` ya calculó los tramos con esa lista. El
mensaje de WhatsApp del 2026-09-15 dice lo contrario, aunque de pasada: *«Los valores que te
brindamos son especiales para ti como ALIADO»*.

**No se sabe si es una lista de precios real que no han mandado, o solo una forma de hablar** (el
asesor podría referirse a que la relación comercial es directa, no a un descuento). No conviene
asumir ninguna de las dos. **Pendiente: preguntarlo por escrito y, si existe, pedir la lista** —
cambiaría los márgenes por tramos de `precios-y-planes.md` §3.

---

### 8.3 Los candidatos, con precios reales

| Proveedor | Forma del costo | ¿Tiquete POS? | ¿Varios NIT? | Precio |
|---|---|---|---|---|
| **Factus** | **Bolsa anual por documentos** (no plano — corregido 2026-09-11) | ❌ No | ✅ **Sí, con el programa de aliados** (bolsa repartida, +$130.000/año por NIT — corregido 2026-09-12, §8.2-quater) | $169.000/año (150 doc) → $2.160.000/año (120.000 doc, **$18/doc**). Tabla completa en §8.2 |
| **MATIAS API** (Lopezsoft) | Por documento, anual prepago | ✅ Sí | ✅ Programa «casas de software», clientes ilimitados | $220.000/año (5.000 doc, $44/doc) → $6.000.000/año (500.000 doc, **$12/doc**) |
| **Facturalatam** (Digital Búho) | Mensual por cupo de empresas + tope de documentos | ✅ Sí | ✅ Marca blanca | $99.900/mes (10 emp · 5.000 doc) · $349.900 (50 · 30.000) · $999.900 (200 · 150.000) |
| **Plemsi** | Por documento | ✅ Sí | Bolsa multiempresa, precio no público | $19.000/mes (100 doc) · $1.242.000/año (24.000) · **$16,83/doc** en volumen |
| **GridPOS** | Por documento, una empresa | ✅ Sí | ❌ | $1.049.900/año (30.000 doc) = $35/doc |
| **Saphety** | Por documento | ✅ Sí | ❌ | $1.200.000 / 2.000 doc = **$600/doc** — descartado |
| **Alegra · Dataico · The Factory HKA · Aliaddo · Siigo** | Cotización | ✅ Sí | Por confirmar | No público — **son PT confirmados en el catálogo de la DIAN** |

**Comparación directa con el volumen real de ZONA BURGER** (~21.000 documentos/año, §8.1). Es la
tabla que importa, porque es lo que costaría *hoy* el cliente que ya tenemos:

| Proveedor | Qué habría que comprar | Costo mensual de ESE cliente | ¿Se puede agrupar con otros clientes? |
|---|---|---|---|
| **Factus** | Bolsa de 20.000 + una de 5.000 al agotarse | **$65.000** | ✅ **Sí** (bolsa repartida entre NIT, §8.2-quater) |
| **MATIAS** (tramo alto, $12/doc) | Parte de una bolsa compartida | ~$21.000 | ✅ Sí, y es su modelo |
| **Facturalatam** ($349.900/mes, 50 emp · 30.000 doc) | ~70% del cupo de documentos del plan | ~$20.580 si se llena de clientes así | ⚠️ Sí en empresas, pero el techo real son los documentos: caben 17, no 50 |
| **Plemsi** ($51,75/doc a 24.000/año) | Bolsa propia | ~$89.500 | Bolsa multiempresa, precio no público |
| **GridPOS** ($35/doc) | Bolsa propia | ~$60.550 | ❌ No |

> **Lo que enseña la tabla:** la diferencia real entre los dos modelos no es el precio de lista,
> es **si el volumen de todos los clientes se suma en una sola bolsa**. Quien agrupa llega al tramo
> alto desde el primer día; quien no, deja a cada cliente arrancando en su propio tramo caro.
>
> ✅ **Corregido el 2026-09-12: Factus SÍ agrupa.** Esta tabla se escribió dando por hecho que
> Factus era una cuenta por NIT sin remedio. Su programa de aliados ofrece bolsa repartida entre
> varios NIT, cobrando el certificado digital aparte ($130.000/año por cada uno). Ver
> §8.2-quater, que rehace las cuentas.
>
> ⚠️ **Aún así, el descuento por agrupar solo llega con volumen.** MATIAS a $12/doc son 500.000
> documentos al año ≈ 24 clientes del tamaño de Zona Burger. Con Factus el punto de equilibrio es
> mucho más temprano —**dos clientes**— porque lo único que hay que amortizar es el certificado.

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
| Certificado por NIT | Normalmente no hace falta | **Sí — $100.000–$130.000/año, sin excepción** |
| Titular ante la DIAN | El negocio, con el PT de intermediario | El negocio, **directo** |
| Quiénes son | Alegra, Aliaddo, Saphety, HKA, Carvajal, Dataico, Siigo (verificados en el catálogo) | **MATIAS y Facturalatam lo declaran abiertamente** |

Que cada cliente sea titular directo **nos conviene** —encaja con
[`obligaciones-escalapp.md`](obligaciones-escalapp.md) §6: no quedamos en el medio—, pero añade un
trámite y un costo por cliente. Con un PT de verdad ese costo puede desaparecer. **Es una pregunta
de cotización, no de arquitectura.**

✅ **Precio real, confirmado el 2026-09-12:** Factus cobra el certificado **$130.000/año por NIT**
en su modalidad de bolsa repartida, y lo **incluye** en el paquete individual (§8.2-quater). O sea
que el certificado no es un costo inevitable: es el peaje de agrupar. Y es barato para lo que
compra.

⚠️ **El certificado gratuito de la DIAN no sirve aquí:** solo funciona dentro del servicio gratuito
de la DIAN. En cuanto se usa un proveedor externo, hace falta uno de pago.

⚠️ **El listado de PT que publica la DIAN en PDF es de septiembre de 2020.** Sirve para confirmar a
los antiguos, no para descartar a nadie. Antes de firmar hay que mirar el **Catálogo de
Participantes vigente**: <https://micrositios.dian.gov.co/sistema-de-facturacion-electronica/proveedores-tecnologicos/>

### 8.5 Las preguntas que deciden — hacerlas ANTES de firmar

> **Factus ya contestó las 11**, primero con su lista de precios y sus T&C (§8.2) y el 2026-09-12
> con el correo de §8.9 (§8.2-quater). Se marcan abajo con su respuesta, para que la próxima
> cotización se compare contra algo y no contra el aire.

1. **¿Emiten documento equivalente electrónico (tiquete POS), o solo factura de venta?**
   Si no emiten POS, o nos sirve la vía de §8.2 (factura de venta para todo) o no nos sirven.
   · *Factus: **NO**. Vía de factura de venta para todo, que es legal.*
2. **¿El precio es por documento o por empresa?** Ver §8.1. Es *la* pregunta.
   · *Factus: **por documento**, en bolsa anual. Lo contrario de lo que creíamos.*
3. **¿Una integración para muchos NIT, o una cuenta por NIT?**
   Define si escalar a 50 clientes es una llamada o cincuenta.
   · *Factus: **las dos cosas, y se elige.** Paquete individual = una cuenta por NIT, con
   certificado incluido. Programa de aliados = **bolsa repartida entre varios NIT**, con el
   certificado aparte a $130.000/año cada uno (§8.2-quater). **Y técnicamente es una cuenta por
   cliente con credencial propia**, también en la bolsa; las dos modalidades se pueden mezclar
   (reunión del 2026-09-14, §8.2-quinquies).*
4. **¿Hace falta certificado digital por cliente, o firman ustedes?** Ver §8.4.
   · *Factus: **contestado.** Incluido en el paquete individual; **$130.000/año por NIT** en la
   bolsa repartida. Siguen los 8 días de plazo para mandar la documentación (§f.11).*
5. **¿Quién lleva el consecutivo?** Preferimos que lo lleven ellos.
   · *Factus: rangos de numeración ilimitados por sucursal, incluidos.*
6. **¿Quién hace la habilitación de cada cliente ante la DIAN?** Si la hacen ellos, nos quitan el
   cuello de botella del onboarding.
   · *Factus: **la hacen ellos, entera.** «Nosotros hacemos todo el proceso de habilitación ante
   la DIAN»; al cliente solo le queda **agregar el rango de numeración**. Esto quita el cuello de
   botella del onboarding, que era la ventaja de Alegra.*
7. **¿Hay sandbox separado de producción?** Imprescindible.
   · *Factus: **sí**, ya nos mandaron credenciales de sandbox (rotadas).*
8. **¿Qué pasa cuando cambia el anexo técnico?** La respuesta correcta es «nada, lo actualizamos
   nosotros sin costo».
   · *Factus: **por confirmar.** Los T&C §f.12 dicen que el servicio es genérico y se reservan el
   derecho de actualización, lo que apunta a que sí.*
9. **¿Entregan ellos el correo al adquiriente, o lo hacemos nosotros?**
   · *Factus: **ellos, incluido en todos los planes.** No hay que construir el envío — pero sí
   guardar copia propia del documento (§8.2-bis, punto 2).*
10. **¿Cuánto cuesta el documento por encima de la bolsa?** Es el precio que de verdad se paga.
    · *Factus: **no hay documento suelto por encima de la bolsa: se compra otra bolsa.** «Cada
    paquete o bolsa tiene una vigencia de 1 año, si se agota pueden adquirir uno nuevamente», o
    sea que **sumar sí se puede**: 20.000 + 5.000 sale por $780.000 contra los $820.000 de la de
    35.000. El reverso es que **el saldo que sobra caduca al año**. Sigue sin contestar qué pasa
    en el instante en que se agota: si bloquea, si avisa, y si hay forma de consultar el saldo.*

**La pregunta que decidía, y ya está contestada:**

11. **¿Qué es exactamente el «programa de aliados» que mencionan sus T&C?**
    · *Factus: **existe y permite varios NIT.** «Bolsas para dividir en varios NIT donde se
    adquiere el certificado por cada uno por aparte». Es justo el caso que §8.3 daba por imposible
    con Factus, y por eso §8.7 pasa de condicional a decidida. Falta el precio de aliado: todas
    las cuentas de §8.2-quater usan la lista pública, que es el supuesto conservador.*

### 8.6 Lo que falta por confirmar antes de decidir

**Ya resuelto:** el volumen real de Zona Burger (§8.1), la lista de precios y los T&C de Factus
(§8.2) y —el 2026-09-12— las cinco preguntas del correo, incluida la del programa de aliados
(§8.2-quater). Con eso, §8.7 deja de ser condicional.

Lo que queda:

1. **Las cuatro preguntas de seguimiento a Factus** (final de §8.2-quater): precio de aliado, una
   credencial o varias, qué pasa exactamente al agotarse la bolsa, y requisitos del programa.
   **Ninguna bloquea la decisión comercial; la segunda sí bloquea el diseño del adaptador de FE-2.**
   Correo listo en §8.9.
2. **Cotizar Alegra como contraste, ya sin urgencia.** Era el mejor candidato sobre el papel por
   tres razones, y **Factus acaba de igualar dos**: integración para varios NIT y habilitación ante
   la DIAN hecha por el proveedor. La ventaja que le queda es real pero más estrecha — **emite
   documento equivalente POS electrónico** y es una empresa mucho más grande, lo cual pesa en una
   ruta donde *un cliente no puede vender si la facturación se cae*. Sigue valiendo la pena pedir
   precio (es el mismo correo cambiando el contexto), pero ya no es el favorito por defecto. Anotar
   también [Alanube](https://www.alanube.co/colombia/), que sigue sin evaluar.
3. **¿Un documento POS consume el mismo cupo que una factura?** Con Factus la pregunta se vuelve
   teórica —no emite POS y emitiremos factura de venta para todo— pero sigue viva para Alegra y los
   demás.
4. **Confirmar con un contador** el régimen y los impuestos del primer cliente, y que el cliente
   saque su **resolución de numeración**: tras la respuesta 5 de Factus, es el único trámite que
   sigue siendo suyo.

### 8.7 Quién compra la bolsa: la decisión que ordena todo lo demás

Los precios reales dejan tres caminos, y hay que elegir uno antes de escribir la primera línea del
adaptador, porque cambian qué guarda la base y qué pantalla hay que construir.

| | **A. El cliente compra su bolsa** | **B. Revendemos por tramos** | **C. Precio fijo, absorbemos** |
|---|---|---|---|
| Quién paga a Factus | El cliente, con su NIT | Nosotros | Nosotros |
| Qué cobramos | Solo la integración | Módulo por tramos de volumen | Módulo plano |
| Certificado digital | **Incluido** en el paquete | **$130.000/año por NIT**, aparte | Igual que B |
| Costo con Zona Burger | $65.000/mes, lo paga el cliente | $75.833/mes con 1 cliente · **$56.667 con 2** | Igual que B, y lo pagamos nosotros |
| Margen con Zona Burger | Intacto | Positivo si los tramos están bien | **−$20.000/mes** |
| Si el cliente crece | Nos da igual, es su bolsa | Sube su tramo, avisado | Duele más cada mes |
| Quién queda en el medio | Comercialmente, nosotros igual | Nosotros | Nosotros |
| Fricción de alta | El cliente manda sus documentos y pega sus credenciales | El cliente manda sus documentos; las credenciales son nuestras | Igual que B |

**C queda descartada por aritmética**, no por opinión: $65.000 de costo contra $45.000 de ingreso.

**Entre A y B, el mercado ya votó por B.** Loggro —que es proveedor tecnológico y por tanto tiene el
costo marginal más bajo posible— vende los documentos ilimitados como recargo aparte **«según tu
facturación mensual»** (§8.8). O sea: revende, y escala el precio con el volumen del cliente. No es
una rareza, es el estándar de la categoría, y los clientes lo aceptan.

**La respuesta llegó el 2026-09-12, y es «sí»** (§8.2-quater): el programa de aliados reparte una
bolsa entre varios NIT, cobrando el certificado digital aparte, $130.000/año por cada uno. Así que
esto deja de ser una bifurcación y pasa a ser una decisión.

#### Decisión: **B, y desde el primer cliente**

> ⚠️ **Matizada el 2026-09-14 (§8.2-quinquies, punto 3).** En la reunión Factus confirmó que cada
> cliente tiene **su propia credencial también en la bolsa** y que **paquetes y bolsa se pueden
> mezclar**. Eso tumba la razón 1 de abajo: la integración es la misma en A y en B. Las razones 2 y
> 3 siguen valiendo, pero solo desde que hay varios clientes. **Hoy no hay ninguno** (Zona Burger
> es solo la referencia de volumen): la modalidad se decide con el primer cliente real —paquete
> individual si es uno, bolsa cuando haya varios— y mientras tanto se construye en el sandbox.

Con un solo cliente, B cuesta **$130.000 al año más que A** — exactamente el certificado, porque la
bolsa es la misma. Es la única desventaja, y es la más barata de pagar que se podía esperar. Tres
razones para pagarla ya y no «cuando lleguen más clientes»:

1. **Construir el producto dos veces cuesta más de $130.000.** El modelo decide qué guarda
   `facturacion.fe_configuracion` y cómo es la pantalla: en A, el negocio pega **sus** credenciales
   de Factus; en B, nosotros gestionamos las cuentas y el negocio no ve credencial ninguna.
   Empezar por A y migrar después es rehacer la pantalla **y** hacer que el cliente compre el
   certificado que en A no necesitaba. El ahorro se evapora en la migración.
2. **Con el segundo cliente que facture, B ya gana** (§8.2-quater): $56.667/mes por cliente contra
   $65.000. Y §0 dice que esto existe justamente porque **hay un segmento de cliente que no se puede
   cerrar sin facturación electrónica** — o sea que si el módulo funciona, el segundo cliente es el
   objetivo, no una posibilidad remota.
3. **El cliente pequeño solo tiene sentido en B.** Una barbería paga $1.127 por documento en su
   propio paquete y $18 dentro de la bolsa. En A, venderle facturación a un cliente pequeño es
   venderle algo caro y malo.

#### El argumento de A que había que pesar, y por qué no gana

A defendía **no quedar en el medio** ([`obligaciones-escalapp.md`](obligaciones-escalapp.md) §6), y
el §g de los T&C de Factus —que se eximen de toda garantía— lo hacía sonar serio. Mirado de cerca,
protege menos de lo que parece:

- **Ante la DIAN, el obligado es el cliente en los dos casos.** B no traslada ninguna obligación
  fiscal: compramos la bolsa, no firmamos las facturas. El titular sigue siendo el negocio, con su
  NIT, su certificado y su resolución de numeración.
- **El soporte lo recibimos nosotros en los dos casos.** Si una factura no sale, el cliente llama a
  quien le vendió el software, no a Factus. A no evita esa llamada; solo evita que además le
  cobremos la bolsa.
- **Ya somos intermediarios en la otra mitad del producto.** El canal de WhatsApp funciona con
  **nuestro** token y **nuestra** WABA (F8-C), y el cliente no tiene relación con Meta. Si ese
  modelo es aceptable ahí —y lleva meses en producción— el mismo modelo con Factus no introduce una
  categoría de riesgo nueva.

Lo que sí hay que hacer, y no es opcional: **guardar en nuestra base el XML firmado, el CUFE y el
PDF de cada documento** (§8.2-bis, punto 2), **vigilar el saldo de la bolsa** antes de que el
bloqueo automático deje a un restaurante sin facturar una tarde (§8.2-bis, punto 1), y **decir en el
contrato** que las obligaciones fiscales son del cliente y nosotros somos el medio técnico.

> **Y lo que no dependía de la respuesta sigue igual:** el módulo de facturación **se cobra por
> tramos de volumen**, nunca plano. Con los costos de §8.2-quater y la vara de §8.8, los tramos
> tienen suelo: el certificado ($10.833/mes) más los documentos. Un cliente de 150 documentos al año
> cuesta ~$11.100/mes y uno como Zona Burger ~$42.333/mes. Ver
> [`precios-y-planes.md`](precios-y-planes.md), que hay que rehacer con esto.

---

### 8.8 El punto de referencia del mercado: qué cobra Loggro, y qué enseña

*(Añadido el 2026-09-11.)* **Loggro** es competencia directa en restaurantes y, a diferencia de
nosotros, **es proveedor tecnológico autorizado por la DIAN**, o sea que emite con su propia
infraestructura y no le compra la bolsa a nadie. Sus precios públicos son la mejor vara de medir
que hay.

| Plan Restobar | Precio/mes | Cajas | Usuarios | Facturas electrónicas incluidas |
|---|---|---|---|---|
| Básico | $120.990 | 1 | 3 | **30/mes** |
| Estándar | $175.990 | 2 | 6 | **30/mes** |
| Premium | $219.990 | 5 | ilimitados | **30/mes** |

Y por separado, para poder facturar de verdad:

| Recargo | Precio |
|---|---|
| Documentos electrónicos **ilimitados** | **desde $45.990/mes, «según tu facturación mensual»** |
| Bolsa suelta de documentos | **desde $92.400 por 50** ($1.848 por documento) |
| Caja adicional | $39.990/mes |

**Cuatro cosas que esto enseña, y cada una vale más que una cotización:**

1. **Ni siquiera un proveedor tecnológico regala los documentos.** Loggro emite con su propia
   infraestructura, sin intermediarios, y aun así incluye **30 al mes** y cobra aparte por el resto.
   Si el que tiene el costo marginal más bajo del mercado no lo regala, nosotros tampoco podemos.
2. **Las 30 incluidas son un gesto, no una funcionalidad.** ZONA BURGER hace 1.730 al mes. Cualquier
   restaurante real necesita el recargo desde el primer mes. **El plan base es el gancho; la
   facturación es la factura de verdad.**
3. **Cobran los documentos ilimitados «según tu facturación mensual».** Es exactamente la salida de
   §8.1: si el costo escala con el volumen, **el precio también escala**. El líder del mercado no
   vende esto a precio plano, y no es por descuido.
4. **Un restaurante que factura de verdad le paga a Loggro ~$167.000/mes como mínimo** ($120.990 +
   $45.990), y eso con una sola caja y tres usuarios.

#### Dónde quedamos nosotros

| | **EscalApp hoy** | **Loggro Restobar** |
|---|---|---|
| Plan base | $59.999 (Avanzado) | $120.990 (Básico) |
| Facturación electrónica | No existe todavía | 30/mes incluidas |
| Documentos sin límite | — | desde $45.990/mes |
| Asistente de WhatsApp con pedidos | ✅ Incluido | ❌ No lo tienen |
| **Total realista, restaurante que factura** | **$59.999** | **~$167.000** |

**Estamos a un tercio del precio del mercado, y con una funcionalidad que ellos no tienen.** Eso
cambia el problema de §8.1: el módulo de facturación nunca tuvo que valer $45.000. Un módulo a
**$99.000** deja al cliente **por debajo de Loggro** —$59.999 + $99.000 = $158.999 contra
~$167.000— y el margen depende de cómo se compre la bolsa:

| | Costo de Zona Burger | Margen del módulo de $99.000 |
|---|---|---|
| Bolsa de 35.000 (lo que se creía el 2026-09-11) | $68.333/mes | $30.667 |
| Bolsa de 20.000 + 5.000, comprada por el cliente (A) | $65.000/mes | no aplica, la paga él |
| **Dentro de la bolsa repartida, 5 clientes (B)** | **$42.333/mes** | **$56.667** |

La tercera fila es la decisión de §8.7, y es la que hay que usar para fijar precio.

> **La conclusión que hay que llevarse:** el problema nunca fue que la facturación electrónica sea
> cara. **Es cara para todos.** El problema era nuestro precio, que se fijó sin mirar lo que cobra
> el mercado. Ver [`precios-y-planes.md`](precios-y-planes.md), que hay que revisar con esto.

⚠️ **Lo que falta confirmar de Loggro:** cuánto sube ese «desde $45.990» para un negocio que factura
$56 millones al mes, y si su documento equivalente POS consume el cupo de las 30 o va aparte. Su
página de precios **no lo dice**, y es la misma pregunta abierta que tenemos con todos los
proveedores (§8.6, punto 4). La inferencia razonable es que **sí consume cupo**: si los documentos
POS fueran ilimitados y gratis, nadie compraría el recargo de documentos ilimitados.

---

### 8.9 El correo a Factus: el enviado, y el de seguimiento

#### ✅ El primero — enviado, contestado el 2026-09-12

Cinco preguntas: programa de aliados, documento equivalente POS, documentos por encima de la bolsa,
certificado digital, y habilitación + entrega al adquiriente. **Las cinco tienen respuesta**, y está
transcrita y analizada en [§8.2-quater](#82-quater-la-respuesta-de-factus-2026-09-12-sí-hay-bolsa-compartida-y-cuesta-130000-por-nit).
La primera —la que decidía— salió a favor: **sí hay bolsa repartida entre varios NIT**.

#### El de seguimiento, listo para enviar

> **Enviado el 2026-09-13.** Factus contestó ofreciendo una **reunión por Meet** en vez de responder
> por escrito. Para la llamada se preparó un guion con estas mismas preguntas (P1 admisión, P2
> exclusividad separada de la admisión, P3 una credencial o varias, P4 sandbox multi-NIT, P5 la
> confirmación de POS), más siete que salen mejor de viva voz: precio de aliado, saldo, bolsa
> agotada, soporte y contingencia, cambios del anexo técnico, copia del XML/PDF, alta de un cliente
> y el límite de 80 peticiones/minuto. **Lo que se diga en la llamada hay que pedirlo confirmado por
> correo** antes de darlo por respuesta aquí.
>
> **Reunión hecha el 2026-09-14.** Las respuestas están en §8.2-quinquies, y lo que quedó sin
> contestar va en el correo de cierre de esa misma sección.

Seis preguntas y una confirmación. **El orden importa y no es el de la primera versión.**

> ⚠️ **Corregido el 2026-09-13.** El borrador anterior abría diciendo *«nos quedamos con la modalidad
> de bolsa repartida»* y dejaba para el final la pregunta de qué se exige para entrar al programa.
> **Eso es dar por concedido algo que todavía no nos han concedido**, y si resulta que hay un mínimo
> de clientes —MATIAS pide 3 en 6 meses (§8.3)— las otras cinco preguntas sobraban. **La admisión va
> primero porque condiciona todo lo demás.**
>
> Se añadieron además dos cosas que no estaban en ninguna pregunta: **si entrar cuesta dinero** y
> **si obliga a exclusividad**. La segunda no es menor: [ADR-026](adr/ADR-026-facturacion-electronica.md)
> diseña un puerto con adaptadores intercambiables precisamente para poder cambiar de proveedor o
> tener dos a la vez, y una cláusula de exclusividad rompería ese supuesto.

**Qué bloquea qué:**

| Pregunta | Bloquea |
|---|---|
| **1 — admisión** | Todo lo demás. Si no entramos, se vuelve a §8.7 opción A |
| **3 — multi-NIT técnico** | Escribir el adaptador de FE-2: decide si `fe_configuracion` guarda un identificador de empresa o credenciales por negocio |
| **6 — sandbox multi-NIT** | Poder *empezar* a escribirlo sin clientes reales dados de alta |
| 2, 4, 5 | Nada técnico: precio y operación |

---

**Asunto:** Programa de aliados — condiciones e integración (EscalApp)

Buen día, y gracias por las respuestas.

Somos una plataforma SaaS de gestión para restaurantes y otros negocios, y **queremos entrar a su
programa de aliados** en la modalidad de bolsa repartida entre varios NIT. Antes de avanzar
necesitamos entender las condiciones y algunos detalles de la integración.

**1. Condiciones para ser aliado.** ¿Qué se requiere para entrar al programa?
En concreto: ¿qué documentos hay que firmar; **hay un mínimo de clientes o de documentos** para
entrar o para mantenerse; **tiene algún costo de entrada, cuota periódica o compra mínima**; y **exige
algún tipo de exclusividad**? Hoy arrancaríamos con un cliente.

**2. Precios del aliado.** ¿La bolsa repartida se cobra con **la misma lista de precios** que nos
enviaron, o el programa tiene lista propia? Si hay condiciones por volumen agregado, ¿a partir de
cuántos documentos o cuántos NIT?

**3. Cómo funciona técnicamente el multi-NIT.** ¿Gestionamos todos los clientes con **una sola
credencial de API**, indicando el NIT en cada petición, o cada cliente sigue teniendo **su propia
cuenta y sus propias credenciales** y lo único compartido es la bolsa de documentos? Lo preguntamos
porque el endpoint `/v2/companies` de la API v2 devuelve *«la empresa del usuario»*, en singular, y
la respuesta cambia cómo construimos la integración.

**4. Saldo de la bolsa y consumo por cliente.** ¿Hay un **endpoint para consultar el saldo** de
documentos disponibles? ¿Y se puede ver **cuántos ha consumido cada NIT** dentro de la bolsa
compartida? Lo necesitamos para avisarle al cliente antes de que se quede sin poder facturar, y para
cuadrar su consumo con nuestro propio conteo.

**5. Qué pasa exactamente cuando se agota la bolsa.** ¿Se bloquea la emisión en el mismo momento?
¿Avisan con antelación? ¿La ampliación es inmediata o tarda en reflejarse?

**6. Entorno de pruebas con varios NIT.** Ya tenemos credenciales de sandbox. ¿Ese entorno permite
**probar el flujo completo con varias empresas a la vez**, sin tener NIT reales habilitados? Nos hace
falta para construir y probar la integración antes de dar de alta al primer cliente.

Y una confirmación, para no dar nada por supuesto: entendemos que **ustedes no emiten documento
equivalente POS electrónico**, y que la vía es emitir **factura electrónica de venta para todo**,
incluido consumidor final anónimo. ¿Es correcto?

Gracias,

---

**Cómo leer la respuesta a la 1:**

| Si contestan… | Qué significa | Qué hacemos |
|---|---|---|
| Contrato y nada más | Entramos, y el resto del correo aplica | Seguir con FE-2 |
| Mínimo de clientes o compra mínima alcanzable | Entramos asumiendo ese compromiso | Comprobar que la compra mínima no supere el costo de la opción A |
| Mínimo inalcanzable hoy, o exclusividad | El programa no nos sirve todavía | **Volver a §8.7 opción A**: el cliente compra su paquete individual, con certificado incluido, y nosotros cobramos solo la integración |

**Que la respuesta sea mala no nos deja sin camino**, y conviene tenerlo claro antes de preguntar: la
opción A sigue existiendo, cuesta $65.000/mes para Zona Burger en vez de $75.833, y lo único que se
pierde es el margen del cliente pequeño y la comodidad de no gestionar credenciales ajenas.

---

**El mismo correo sirve para Alegra, Dataico y HKA** cambiando el primer párrafo por el contexto de
§8.6 y añadiendo la pregunta de si el documento POS consume el mismo cupo que una factura.

---

## 9. Plan por fases

| Fase | Qué | Bloqueada por |
|---|---|---|
| **FE-0** | **No es código. EN CURSO.** ✅ Volumen real medido (§8.1), ✅ Factus cotizado con lista de precios y T&C (§8.2), ✅ las 11 preguntas contestadas incluido el programa de aliados (§8.2-quater) y ✅ **decidido quién compra la bolsa: opción B, bolsa repartida** (§8.7). ⬜ Falta: las 4 preguntas de seguimiento (§8.9) —de las cuales **la de una credencial o varias bloquea FE-2**—, cotizar Alegra como contraste, confirmar con un contador el régimen y los impuestos del primer cliente, y que el cliente saque su **resolución de numeración** (la habilitación la hace Factus) | Trámite externo, plazos ajenos |
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
- **Bolsa de documentos agotada = exactamente lo mismo, y con otro dueño.** *(añadido 2026-09-11)*
  Los T&C de Factus §f.9 bloquean la cuenta automáticamente al vencer la suscripción. Zona Burger
  gasta ~1.730 documentos al mes: una bolsa de 20.000 se acaba en once meses y medio, no en doce.
  **Hay que vigilar el saldo de la bolsa igual que el rango de numeración**, y avisar en semanas,
  no en días.
- **El proveedor no guarda nada si la cuenta se elimina.** *(añadido 2026-09-11)* T&C de Factus
  §f.7: *«no existe respaldo de información en caso de eliminación de cuentas»*, e irreversible.
  Los documentos fiscales se conservan por ley durante años. **Guardamos nosotros el XML firmado,
  el CUFE y el PDF de cada documento emitido.** No es opcional y no es "por si acaso": es la única
  copia que sobrevive a un cambio de proveedor.
- **El reloj de la suscripción corre aunque el cliente no termine su trámite.** *(añadido
  2026-09-11)* T&C de Factus §f.11: 8 días calendario para mandar la documentación del certificado
  digital; pasados, el plan empieza a contar igual. **El onboarding tiene fecha límite desde el día
  que se compra**, y hay que decírselo al cliente antes, no después.
- **Fecha de emisión en hora Bogotá.** Coincide con la convención del repo (`America/Bogota` wall
  time); si el negocio cierra a las 2 a.m., la fecha del documento es la que la DIAN espera, no la
  del turno.

---

## 11. Lo que queda explícitamente fuera del alcance

Nombrado para que no aparezca como sorpresa a mitad de camino:

- **Nómina electrónica.** Otro documento, otro anexo, otro proyecto. Nuestros clientes la resuelven
  con su contador. *(Factus la vende aparte: desde $60.000/año por 24 documentos hasta $480.000 por
  1.200, «por interfaz aliados API». Anotado como posible venta cruzada futura, no como alcance.)*
- **RADIAN** (eventos de acuse, aceptación y rechazo para negociar facturas). Solo importa si el
  cliente vende a crédito y quiere factoring. *(Factus: bolsa aparte, desde $60.000/año por 24
  documentos hasta $900.000 por 5.000.)*
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

**Añadidas el 2026-09-11:** lista oficial de precios de Factus (tres bolsas anuales: facturación
electrónica por conexión API, recepción RADIAN y nómina electrónica por interfaz de aliados API) y
**Términos y Condiciones Generales de Uso del Sistema y Servicios de FACTUS S.A.S.**, recibidos por
correo. Volumen de ZONA BURGER (`id_negocio` 6) contado en la base de producción con una consulta
de solo lectura sobre `restaurante.pedid_orden`.

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
