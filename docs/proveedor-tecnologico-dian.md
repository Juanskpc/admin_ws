# Ser proveedor tecnológico de la DIAN: qué exige, y si una sociedad lo cambia

**Estado:** exploración, **no hay ninguna decisión tomada** · **Fecha:** 2026-09-13 ·
**Relacionado:** [`facturacion-electronica.md`](facturacion-electronica.md) §2.2 y §8 ·
[ADR-026](adr/ADR-026-facturacion-electronica.md) alternativa A

> Este documento existe porque surgió la idea de **hacer sociedad con otra empresa de software** —una
> ya constituida y de mayor tamaño— para habilitarse juntos como proveedor tecnológico y dar el
> servicio a los dos. Está escrito para poder **enseñárselo a ellos**, así que evita jerga y no da
> nada por sabido.
>
> ⚠️ **Las cifras salen de la norma citada en §6 con la UVT de 2026. Son materia regulada y cambian.**
> Antes de gastar un peso hay que confirmarlas contra la resolución vigente y con un contador.

---

## 1. Antes de los requisitos: hay tres puertas, no una

Mucha gente usa «proveedor tecnológico» para cualquiera que venda facturación electrónica, y eso
confunde la conversación desde el primer minuto. Ante la DIAN son tres cosas distintas:

| | Qué es | ¿Requiere habilitación de PT? |
|---|---|---|
| **1. Proveedor tecnológico (PT)** | Transmite a la DIAN **por cuenta de otros**, firmando con su propio certificado | **Sí** — es lo que pide el patrimonio |
| **2. Software propio o adquirido** | Tu programa emite, pero **cada cliente firma con SU certificado y su NIT** | **No** |
| **3. Aliado / revendedor de un PT** | Usas la API de un PT ya habilitado | **No** |

**La puerta 1 es la única que tiene requisito de dinero.** Las otras dos no piden patrimonio, no
piden ISO y no piden habilitación como PT.

Hoy EscalApp va por la **puerta 3** (Factus). La **puerta 2** es la que casi nadie considera y suele
ser la que de verdad compite con la 1 — ver §4.

---

## 2. Los requisitos para ser proveedor tecnológico

### 2.1 Los tres que deciden, y son de plata

Con la UVT de 2026 ($52.374):

| Requisito | En UVT | En pesos |
|---|---|---|
| **Patrimonio contable** | ≥ 20.000 UVT | **≥ $1.047.480.000** |
| **Propiedad, planta y equipo**, ubicada en Colombia | ≥ 10.000 UVT | **≥ $523.740.000** |
| **Certificación ISO/IEC 27001** de seguridad de la información | — | O carta de compromiso de obtenerla en **máximo 18 meses** |

**Dos aclaraciones que evitan malentendidos:**

1. **No se suman.** El patrimonio es lo que queda al restarle las deudas a los activos. La propiedad,
   planta y equipo **ya está dentro** de esos activos. O sea: hace falta un patrimonio neto de al
   menos ~$1.047 millones, **del cual** al menos ~$524 millones tienen que estar en propiedad,
   planta y equipo en Colombia.
2. **⚠️ Los requisitos son de la EMPRESA que se habilita, no de sus socios.** Si se crea una sociedad
   nueva entre dos empresas, **la sociedad nueva** es la que tiene que cumplir el patrimonio. No se
   promedia, no se suma el de los socios, y no sirve que las empresas madre sean grandes. Habría que
   **capitalizarla de verdad** hasta esas cifras.

### 2.2 ⚠️ La trampa concreta para dos empresas de software

**El software no es propiedad, planta y equipo.** Contablemente es un **intangible**, y va en otra
línea del balance. Tampoco cuentan la plata en el banco ni lo que los clientes deben.

Propiedad, planta y equipo son cosas físicas: terrenos, edificios, vehículos, servidores, muebles,
equipos de cómputo.

Esto importa porque **una empresa de software puede facturar muchísimo y aun así tener casi nada en
esa línea.** Su valor está en el programa, en los clientes y en el equipo humano — y ninguna de las
tres cuenta aquí. Por eso, en la práctica, **el requisito difícil no suele ser el patrimonio: es el
medio millón de pesos en activos físicos.**

### 2.3 Los requisitos de papeles

Además de lo anterior, para presentarse hay que:

- Ser **persona jurídica** inscrita en el RUT, con el **objeto social** incluyendo prestar servicios
  de facturación electrónica.
- Estar **al día con la DIAN**: declaraciones presentadas y sin deudas exigibles.
- Que ni la empresa ni sus representantes hayan sido **sancionados o excluidos** antes de este
  régimen.
- Presentar los **estados financieros** que demuestren el patrimonio y la propiedad, planta y equipo
  — auditados/firmados como exija la norma.

### 2.4 Los requisitos técnicos

- **Superar el conjunto de pruebas de habilitación** en el ambiente de la DIAN: hay que emitir un
  lote de documentos de prueba y que todos pasen la validación.
- Tener el sistema conforme al **anexo técnico** vigente (el formato exacto del XML, las firmas, los
  códigos). Es un documento largo y **cambia**.

### 2.5 Lo que obliga DESPUÉS, y es lo que la gente no calcula

Ser PT no es un trámite que se hace una vez. Una vez habilitado:

- Hay que **mantener** el patrimonio, la propiedad planta y equipo y la ISO 27001. Si se caen, se
  cae la habilitación.
- Hay que **actualizar el sistema cada vez que la DIAN publica un anexo técnico nuevo**, en el plazo
  que ella fije. Esto es trabajo permanente de ingeniería, no de una vez.
- Hay que **garantizar disponibilidad del servicio** y conservar los documentos.
- **Hay un régimen sancionatorio propio para los PT** (artículo 684-4 del Estatuto Tributario): la
  DIAN puede multar al proveedor tecnológico directamente, y en casos graves quitarle la
  habilitación. Es decir: **se pasa de responder ante el cliente a responder ante la DIAN.**

---

## 3. La pregunta que resuelve la conversación en cinco minutos

Antes de reuniones, abogados y cuentas, hay **una sola pregunta** que se contesta mirando el balance:

> **¿Cuánto tiene la empresa en la línea «propiedad, planta y equipo» de su balance, y está en
> Colombia?**

- **Si la respuesta es menos de ~$524 millones** (lo normal en una empresa de software), la puerta 1
  está cerrada hoy, y no se abre con esfuerzo ni con una sociedad: se abre comprando activos físicos.
- **Si la respuesta es más**, entonces sí vale la pena seguir: mirar el patrimonio total, la ISO y
  todo lo demás.

La segunda pregunta, solo si la primera pasa:

> **¿Está la empresa dispuesta a mantener una certificación ISO 27001 y a asumir multas de la DIAN?**

---

## 4. Si la respuesta es «no»: las otras dos puertas, que siguen abiertas

**Que no se pueda ser PT no cierra el negocio.** Hay dos formas de dar el servicio sin esa
habilitación, y las dos son legales y comunes:

### Puerta 2 — Construir el emisor como «software propio o adquirido»

El programa lo hacemos nosotros, pero **cada cliente se habilita ante la DIAN con su propio NIT y
firma con su propio certificado**. Nosotros no transmitimos por cuenta de nadie, así que **no hace
falta el patrimonio, ni la ISO, ni la habilitación de PT**.

- **A favor:** control total, sin pagarle a nadie por documento, y el margen es nuestro entero.
- **En contra:** son **cientos de horas** la primera versión y **mantenimiento permanente** cada vez
  que la DIAN cambia el anexo técnico. Cada cliente necesita además su certificado digital
  (~$100.000–$130.000 al año).
- **Es la alternativa B de [ADR-026](adr/ADR-026-facturacion-electronica.md)**, descartada para
  EscalApp solo por ser un equipo de una persona. **Con dos empresas y un equipo de verdad detrás,
  esta es la opción que cambia de sentido**, no la de ser PT.

### Puerta 3 — Ser aliado de un PT ya habilitado

Es lo que EscalApp está a punto de hacer con Factus (§8.7 del otro documento): se compra un cupo de
documentos y se reparte entre los clientes.

- **A favor:** se puede empezar este mes, sin inversión y sin riesgo regulatorio.
- **En contra:** hay un costo por documento y se depende de un tercero.

### Comparación rápida para la conversación

| | Ser PT | Software propio | Aliado de un PT |
|---|---|---|---|
| Inversión inicial | **> $1.000 millones** | Cientos de horas de desarrollo | Casi cero |
| Tiempo hasta operar | Un año o más | Meses | Semanas |
| Responsable ante la DIAN | **La sociedad** | Cada cliente | Cada cliente |
| Costo por documento | Ninguno | Ninguno | Sí |
| Mantenimiento del anexo técnico | Nuestro, obligatorio | Nuestro, obligatorio | Del proveedor |
| ¿Se puede empezar hoy? | No | No | **Sí** |

---

## 4-bis. La puerta 2 a fondo: «software propio o adquirido»

*(Ampliado el 2026-09-13, porque es la opción que de verdad cambia si hay un socio detrás.)*

### Primero, una corrección que hay que hacer antes de nada

**No es «ser proveedor sin firma electrónica».** La firma electrónica **no desaparece nunca**: es lo
que hace que el documento sea válido ante la DIAN, y sin ella no hay factura electrónica de ningún
tipo.

Lo que cambia es **de quién es el certificado que firma**:

| | Quién firma | Quién es el titular ante la DIAN |
|---|---|---|
| **Proveedor tecnológico** | El PT, con **su** certificado, por mandato del cliente | El cliente, con el PT de intermediario |
| **Software propio/adquirido** | **Cada cliente, con SU propio certificado** | El cliente, directo |

Esa es toda la diferencia, y es justo la que quita el requisito de patrimonio: **si no transmites por
cuenta de otros, no eres proveedor tecnológico** y la DIAN no te pide ni patrimonio, ni ISO, ni
habilitación.

⚠️ **Consecuencia inmediata: el certificado digital de cada cliente SIGUE HACIENDO FALTA**, y sigue
costando ~$100.000–$130.000 al año por NIT. La puerta 2 **no ahorra el certificado**. Lo que ahorra
es el **costo por documento**.

### Cómo queda repartido el trabajo

| Lo hace el cliente (una vez) | Lo hacemos nosotros (siempre) |
|---|---|
| Habilitarse en el portal de la DIAN | Construir y mantener el emisor |
| Comprar su certificado digital | Generar el XML del anexo técnico |
| Registrar nuestro software y obtener su identificador y PIN | Firmar cada documento con su certificado |
| Pasar el conjunto de pruebas de la DIAN | Transmitir a la DIAN y procesar la respuesta |
| Pedir su resolución de numeración | Guardar XML, CUFE y PDF; entregar al comprador |

⚠️ **Fíjate en la columna izquierda: vuelve el cuello de botella del onboarding.** Eso es exactamente
lo que Factus nos quita haciendo él la habilitación (§8.2-quater del otro documento). En la puerta 2
lo recuperamos, y hay que multiplicarlo por cada cliente nuevo.

> **Por verificar:** si el conjunto de pruebas de la DIAN se repite **por cada cliente** o si basta
> con tenerlo aprobado una vez para el software. Es la diferencia entre un alta de minutos y un alta
> de días, y decide si la puerta 2 escala.

### Qué hay que construir exactamente

Esta es la lista real, y es más larga de lo que parece desde fuera:

1. **Generación del XML** en el formato exacto del anexo técnico vigente (hoy el 1.9), que es un
   estándar internacional con extensiones colombianas. Cientos de campos y reglas.
2. **Firma digital XAdES** del XML con el certificado del cliente. **Es la parte difícil**: no es
   «firmar un archivo», es una firma con estructura, sellos y referencias muy específicas, y si un
   byte no cuadra la DIAN la rechaza sin decir por qué.
3. **Cálculo del CUFE** (el código único de cada factura): un hash de campos concatenados en un orden
   exacto. Si se calcula mal, el documento se rechaza.
4. **Código de seguridad del software**, que se deriva del identificador y el PIN que el cliente
   obtuvo al registrarnos.
5. **Código QR** de la representación gráfica.
6. **Comunicación con el servicio web de la DIAN**, autenticada con certificado, más el manejo de sus
   respuestas y sus errores.
7. **Modo de contingencia**: qué se hace cuando la DIAN está caída. Hay un procedimiento formal, con
   numeración distinta y transmisión posterior.
8. **Notas crédito y débito**, y el documento equivalente POS si se quiere.
9. **Representación gráfica en PDF** con todos los campos obligatorios.
10. **Conservación** del XML firmado, el CUFE y el PDF.

Y después, **para siempre**: cada vez que la DIAN publica un anexo técnico nuevo, hay que
actualizarlo dentro del plazo que ella fije. **Esto no termina.**

[ADR-026](adr/ADR-026-facturacion-electronica.md) estimó **400–600 horas la primera versión**, y esa
estimación no incluye el mantenimiento.

### ⚠️ El problema central para un sistema en la nube: dónde viven las llaves

Este es el punto que no se ve hasta que se está construyendo, y es el más serio de los tres.

Para firmar con el certificado de un cliente **hay que tener acceso a su llave privada**. Y aquí
aparece un problema que el modelo de proveedor tecnológico no tiene:

- **El PT guarda UN certificado: el suyo.**
- **La puerta 2 obliga a guardar el certificado de CADA cliente** en nuestros servidores, porque el
  sistema está en la nube y firma solo, sin nadie delante.

O sea que pasaríamos a custodiar las llaves de firma fiscal de decenas de empresas. Eso trae:

- Un problema de **seguridad real**: si se filtran, alguien puede emitir facturas a nombre de
  nuestros clientes.
- Un problema de **responsabilidad**: somos los custodios, y eso hay que ponerlo en un contrato.
- Y una ironía: **para hacerlo bien acabas necesitando prácticamente los controles de una ISO
  27001** — que era uno de los requisitos que la puerta 2 evitaba.

No es un impedimento, es un costo escondido. Pero hay que contarlo en la conversación, porque
**cambia el tamaño del proyecto**.

### Qué se ahorra, con números

Comparado con lo que ya está decidido (puerta 3, aliado de Factus):

| | Puerta 3 — aliado | Puerta 2 — software propio |
|---|---|---|
| Certificado por cliente | $10.833/mes | **$8.333–10.833/mes — sigue** |
| Por documento | **$18–25** | **$0** |
| Zona Burger (1.750 doc/mes) | $42.333/mes | **~$10.833/mes** |
| Negocio pequeño (15 doc/mes) | $11.100/mes | ~$10.833/mes |

**El ahorro es de ~$31.500 al mes con un cliente grande y de ~$270 con uno pequeño.** Ese contraste
es la clave de toda la decisión: **la puerta 2 solo se paga con volumen de DOCUMENTOS**, no con
número de clientes. Cien barberías no la pagan; diez restaurantes grandes sí.

### La cuenta que decide

Cada documento emitido ahorra ~$18. Entonces:

> **Documentos necesarios para recuperar la inversión = (valor de las horas de desarrollo) ÷ $18**

Con 500 horas como referencia:

| Si la hora se valora en… | La inversión es | Hay que emitir… | Equivale a clientes como Zona Burger durante un año |
|---|---|---|---|
| $30.000 | $15.000.000 | **833.000 documentos** | ~40 |
| $50.000 | $25.000.000 | **1.390.000 documentos** | ~66 |
| $80.000 | $40.000.000 | **2.220.000 documentos** | ~106 |

*(Zona Burger proyecta ~21.000 documentos al año. Y esto **sin contar** el mantenimiento perpetuo
del anexo técnico, que hay que sumarle todos los años.)*

**Por eso se descartó para EscalApp solo**: con uno o dos clientes, la puerta 2 tarda décadas en
pagarse. **Y por eso cambia con un socio**: si entre las dos empresas la base de clientes emite más
de un millón de documentos al año, se paga en meses en vez de en décadas.

### El riesgo que no se puede trasladar

Con un proveedor, si la DIAN cambia el anexo técnico y algo se rompe, **es problema del proveedor** y
lo arregla él para todos sus clientes a la vez.

Con la puerta 2, si se rompe, **nuestros clientes no pueden facturar** y el que tiene que arreglarlo
—de noche, contra un plazo de la DIAN— somos nosotros. Con dos o tres clientes eso es una mala noche.
Con doscientos es una crisis de negocio.

Es la contrapartida exacta de no pagar por documento, y hay que decirla en voz alta.

### Lo que hay que preguntarle al socio

Igual que con la puerta 1 había **una** pregunta que resolvía la conversación (§3), aquí hay dos:

> **1. ¿Cuántos documentos electrónicos al año emitirían, entre sus clientes y los nuestros?**
>
> Si la respuesta pasa del millón, la puerta 2 se paga. Si está en decenas de miles, no.

> **2. ¿Quién mantiene esto dentro de cinco años?**
>
> No es una pregunta retórica. El anexo técnico cambia, y el compromiso es permanente. Si la
> respuesta es «ya veremos», la puerta 3 es mejor negocio aunque se pague por documento.

---

## 5. Una vía que no se ha explorado y merece una llamada

**Comprar o asociarse con un PT que YA esté habilitado**, en vez de habilitarse desde cero. En el
catálogo de participantes de la DIAN hay proveedores pequeños.

⚠️ **Cuidado con el supuesto fácil:** la habilitación **no se compra como un activo**, y un cambio de
dueño puede obligar a rehacer el trámite o a mantener las condiciones de la sociedad habilitada. Eso
hay que preguntárselo a un abogado tributarista **antes** de valorar nada, no después.

---

## 5-bis. La empresa socia cumple los dos requisitos de plata: qué significa exactamente

*(Añadido el 2026-09-13. La otra empresa confirmó que cumple patrimonio y propiedad planta y equipo.)*

### ⚠️ Lo primero, porque cambia la forma de todo lo demás

**Que ELLOS cumplan no significa que una sociedad nueva cumpla.** Es la misma advertencia de §2.1,
punto 2, y ahora es la que decide la estructura:

> Los requisitos son **de la persona jurídica que se habilita**, no de sus socios.

- Si **la empresa de ellos** se habilita → cumple hoy, porque el patrimonio y los activos ya están
  en su balance.
- Si se crea una **sociedad nueva** entre los dos → esa sociedad **nace en cero**. Para cumplir,
  alguien tendría que **aportarle** ~$1.047 millones de patrimonio, de los cuales ~$524 millones en
  propiedad, planta y equipo físicos, **sacándolos de su propio balance**.

Dicho claro: **la buena noticia habilita a su empresa, no a una sociedad nueva.** Eso no cierra el
plan — lo redirige.

### Las cuatro formas de hacerlo, de más fácil a más difícil

| | Quién se habilita ante la DIAN | Qué hace falta | Dificultad |
|---|---|---|---|
| **A. Acuerdo comercial** | Su empresa | Un contrato. Ellos son PT, nosotros su integrador con condiciones preferentes | **Baja** |
| **B. Contrato de colaboración** | Su empresa | Un contrato de colaboración o cuentas en participación: ellos ponen la habilitación, nosotros el software, y se reparten los ingresos | **Media** |
| **C. EscalApp entra al capital de su empresa** | Su empresa | Valorar qué aporta cada uno y emitir participación a favor de EscalApp | **Media-alta** |
| **D. Sociedad nueva entre los dos** | **La sociedad nueva** | Que ellos **trasladen** ~$524 M en activos físicos y ~$1.047 M de patrimonio a la nueva sociedad | **Muy alta** |

**La D es la que se está imaginando y es la más difícil de todas**, no por papeleo sino porque
obliga a la otra empresa a mover medio millar de millones de pesos en activos reales de su balance
al de una empresa recién creada, con el costo tributario de los aportes en especie y con su propio
balance debilitado. **Es poco probable que acepten, y con razón.**

**Las que de verdad funcionan son la B y la C**, y las dos tienen la misma forma de fondo: **la
habilitación se queda en la empresa que ya cumple, y EscalApp aporta el producto.** La diferencia es
si eso se paga con un reparto de ingresos (B) o con participación en la empresa (C).

### Lo que hay que entender antes de negociar nada: ser PT **no** ahorra el trabajo técnico

Este es el malentendido más caro posible, y conviene despejarlo ahora:

> **La habilitación como proveedor tecnológico da el permiso, no el software.**

Todo lo de §4-bis —el XML del anexo técnico, la firma XAdES, el CUFE, el servicio web de la DIAN, el
modo de contingencia, las notas crédito, la representación gráfica— **hay que construirlo igual**.
Ser PT es la puerta 2 **más** la habilitación, **más** la ISO, **más** responder ante la DIAN.

Pero hay una ventaja real, y no es menor: **el PT firma con UN solo certificado, el suyo.** Eso
elimina el problema central de la puerta 2 (custodiar la llave privada de cada cliente, §4-bis). Para
un sistema en la nube eso es una simplificación grande, no un detalle.

### ⚠️ La ISO 27001 no es un trámite

Ellos confirmaron los dos requisitos de plata. **El tercero sigue abierto y no es una firma:** es un
sistema de gestión de seguridad de la información, con auditoría externa, costo real y auditorías de
seguimiento **todos los años**. Se puede entrar con carta de compromiso a 18 meses, pero el reloj
corre y si no se obtiene, se cae la habilitación.

**Hay que preguntarles si ya la tienen o si han mirado lo que cuesta.** Es la diferencia entre
«cumplimos dos de tres» y «cumplimos tres de tres».

### El calendario real, y por qué esto NO detiene lo de Factus

| | Ser PT | Aliado de Factus |
|---|---|---|
| Construir el emisor | 400–600 h | 0 |
| ISO 27001 | 6–12 meses | — |
| Habilitación + pruebas DIAN | Semanas | — |
| Constitución/contratos + abogados | Semanas | — |
| **Primera factura real** | **Un año, siendo optimistas** | **Semanas** |

**Queremos poder vender facturación mucho antes de eso** (hoy ningún cliente la ha pedido todavía,
pero se quiere tener lista y anunciarla). Así que las dos cosas conviven y no compiten:

> **Factus ahora, para los clientes que la pidan; el PT como proyecto aparte, con su propio
> calendario.** Y si algún día el PT emite, el puerto de FE-2 permite cambiar el adaptador sin tocar
> el producto — que es exactamente para lo que se diseñó
> ([ADR-026](adr/ADR-026-facturacion-electronica.md)).

### Las preguntas que hay que resolver ANTES de llamar al abogado

**Verificación (antes de ilusionarse):**

1. **Pedir los estados financieros.** «Cumplimos» dicho por teléfono no es lo que la DIAN va a
   revisar. Hay que ver la cifra de patrimonio contable y la línea de propiedad, planta y equipo.
2. **Confirmar que esa propiedad planta y equipo está en Colombia** y es realmente PP&E, no
   intangibles ni inversiones.
3. **Confirmar que están al día con la DIAN** y sin sanciones previas (§2.3).
4. **Preguntar por la ISO 27001**: ¿la tienen, la han cotizado, están dispuestos?

**Negociación (lo que de verdad cuesta acordar):**

5. **¿De quién es el software?** Es el activo que aporta EscalApp y es lo que hace funcionar al PT.
   Si se cede, se cede el negocio entero.
6. **¿Qué pasa si la sociedad se rompe?** ¿EscalApp puede seguir facturando a sus clientes? ¿Con qué
   proveedor? Esto se pacta al principio o no se pacta nunca.
7. **¿Quién responde de las multas de la DIAN** (art. 684-4)? Recaen sobre el PT habilitado, o sea
   sobre su empresa — pero si el fallo es del software, que es nuestro, ¿cómo se reparte?
8. **¿Quién paga y mantiene la ISO**, y quién asume que caiga?
9. **¿Quién decide el roadmap técnico?** Un PT tiene obligaciones de plazo con la DIAN; si el anexo
   técnico cambia, alguien tiene que poder priorizar por encima de todo lo demás.

### Si esto avanza, necesita su propio ADR

[ADR-026](adr/ADR-026-facturacion-electronica.md) descartó ser PT **por imposible con los recursos de
entonces**, y su sección de impacto futuro dice literalmente que esa reevaluación *«sería un ADR
nuevo que reemplace a este»*. Con un socio que cumple el patrimonio, la premisa cambió.

**No se escribe todavía**: primero los estados financieros y la respuesta sobre la ISO. Si las dos
salen bien, entonces sí — **ADR-028**, y con él la decisión de estructura (A/B/C/D).

---

## 5-ter. La ISO 27001 en concreto

*(Añadido el 2026-09-13. **EscalApp se encarga de este requisito**, así que esta sección está escrita
para ejecutarla, no para decidirla.)*

### Qué es exactamente

**No certifica un producto ni un servidor. Certifica que la organización tiene un sistema de gestión
de seguridad de la información** (SGSI) funcionando: políticas, riesgos identificados, controles
aplicados y evidencia de que se revisan.

La norma vigente es **ISO/IEC 27001:2022**. Tiene dos partes:

1. **Las cláusulas 4 a 10** — el sistema de gestión en sí: contexto, liderazgo, planificación,
   soporte, operación, evaluación del desempeño y mejora. **Son obligatorias todas.**
2. **El Anexo A** — **93 controles** agrupados en cuatro temas: organizacionales (37), de personas
   (8), físicos (14) y tecnológicos (34). No hay que aplicarlos todos: hay que **justificar cuáles
   sí y cuáles no** en un documento llamado **Declaración de Aplicabilidad (SoA)**.

### ⚠️ La decisión que determina el costo: el ALCANCE

Esta es la parte que hay que acertar y casi nadie explica:

> **El alcance lo define uno mismo.** No hay que certificar la empresa entera.

Se puede acotar a algo como *«el desarrollo y la operación de la plataforma de facturación
electrónica»*, y dejar fuera contabilidad, ventas, oficinas que no intervengan, etc. **Un alcance
estrecho y bien escrito puede costar la mitad y tardar la mitad** — y es igual de válido ante la
DIAN, siempre que cubra el servicio que se presta como proveedor tecnológico.

⚠️ **Pero tiene que cubrir de verdad ese servicio.** Si el alcance excluye la infraestructura donde
corre la emisión, la certificación no sirve para lo que la DIAN pide.

### Cómo se obtiene, paso a paso

| # | Paso | Quién |
|---|---|---|
| 1 | **Definir el alcance** y conseguir el compromiso formal de la dirección (cláusula 5 — no es opcional, el auditor lo verifica) | Nosotros + dirección de ellos |
| 2 | **Inventario de activos de información** y **análisis de riesgos** con su plan de tratamiento | Nosotros |
| 3 | **Redactar políticas y procedimientos** y la **Declaración de Aplicabilidad** | Nosotros |
| 4 | **Implantar los controles** que salgan del análisis | Nosotros |
| 5 | **Auditoría interna** y **revisión por la dirección** — la norma las exige *antes* de certificar | Auditor interno (puede ser externo contratado) |
| 6 | **Auditoría de certificación Etapa 1** — revisan documentación y si el sistema está listo | Ente certificador |
| 7 | **Auditoría de certificación Etapa 2** — revisan que se cumple de verdad, con evidencias | Ente certificador |
| 8 | **Certificado**, vigencia **3 años** | Ente certificador |
| 9 | **Auditorías de seguimiento ANUALES** y **recertificación al tercer año** | Ente certificador |

⚠️ **Quien ayuda a implantarlo NO puede ser quien certifica.** Son roles incompatibles por la propia
acreditación, así que son dos contratos distintos con dos empresas distintas.

**Entes certificadores en Colombia:** ICONTEC, y las filiales locales de BSI, SGS, Bureau Veritas,
TÜV, AENOR, DNV. Conviene que estén **acreditados por ONAC** o por un organismo internacional
reconocido.

### Cuánto tarda y cuánto cuesta

**Tiempo realista con alcance acotado: 6 a 12 meses.** El paso 4 es el que se alarga, porque implica
cambiar cómo se trabaja, no escribir documentos.

⚠️ **Sobre el costo: las cifras de abajo son órdenes de magnitud, NO una cotización.** Dependen
muchísimo del alcance, del número de sedes y de personas. **Hay que pedir tres cotizaciones.**

| Concepto | Orden de magnitud (COP) | Frecuencia |
|---|---|---|
| Consultoría de implantación | $25–70 millones | Una vez |
| Auditoría de certificación (Etapas 1 y 2) | $15–35 millones | Una vez |
| Auditoría de seguimiento | $8–15 millones | **Cada año** |
| Recertificación | Similar a la inicial, algo menor | **Cada 3 años** |

**Hay una vía más barata si nos encargamos nosotros:** llevar la implantación internamente y
contratar consultoría solo para los huecos y para la auditoría interna. Ahorra buena parte del primer
renglón a cambio de meses de trabajo propio. **Dado que EscalApp asume este requisito, es la vía que
tiene sentido evaluar.**

### Lo que de verdad hay que hacer en el día a día

Los controles que más peso tienen para un caso como este, y que además **ya nos harían falta** por
manejar documentos fiscales y datos personales:

- **Control de accesos**: quién entra a qué, con qué permiso, y revisión periódica.
- **Desarrollo seguro**: la norma 2022 tiene un bloque entero sobre esto (ciclo de vida, revisión de
  código, separación de entornos, gestión de cambios). Es donde más nos va a tocar cambiar hábitos.
- **Gestión de incidentes**: detectar, registrar, responder y aprender. Con procedimiento escrito.
- **Copias de seguridad y continuidad**: probadas, no solo configuradas.
- **Registros (logs) y monitoreo**.
- **Criptografía**: cómo se guardan y rotan las llaves. Directamente relevante para los certificados
  de firma.
- **Gestión de proveedores**: qué terceros tocan la información y con qué garantías.

> **Coincidencia útil:** buena parte de esto se solapa con lo que ya exige la Ley 1581 de habeas
> data, que está en [`legal/`](legal/) y en
> [`obligaciones-escalapp.md`](obligaciones-escalapp.md). No se empieza de cero.

### ⚠️ Dos avisos que hay que tener presentes desde el primer día

1. **No es un certificado que se cuelga y ya.** Hay auditoría **todos los años**. Si una falla, el
   certificado se suspende — y con la ISO suspendida, **la habilitación como PT está en riesgo**.
   Esto es un compromiso operativo permanente, igual que el mantenimiento del anexo técnico.
2. **El plazo de 18 meses corre desde la habilitación**, no desde que se empieza a trabajar. Con 6–12
   meses de implantación, el margen existe pero no sobra. **Conviene arrancar la ISO en paralelo al
   desarrollo del emisor, no después.**

---

## 5-quater. Los requisitos ante la DIAN, y qué es exactamente «propiedad, planta y equipo»

### Qué es propiedad, planta y equipo (PP&E)

Es una **categoría contable**, no una forma de hablar. Bajo las normas NIIF que aplican en Colombia,
son los **activos tangibles** que la empresa tiene **para usarlos** en su operación —no para
venderlos— y que espera usar **más de un período**.

| ✅ **Sí es PP&E** | ❌ **No es PP&E** |
|---|---|
| Terrenos | **Software** (es intangible) |
| Edificios y construcciones | Licencias, marcas, patentes, *goodwill* |
| Maquinaria y equipo | Efectivo y bancos |
| Vehículos | Cuentas por cobrar |
| Muebles y enseres | Inventarios (esos son *inventario*) |
| Equipo de cómputo y **servidores propios** | Inversiones y participaciones |

### ⚠️ Cuatro trampas al leer la cifra del balance

1. **La depreciación puede hundir el número.** El balance muestra el valor **neto** (costo menos
   depreciación acumulada). Una empresa con activos viejos ya depreciados puede tener mucho hierro y
   **poca cifra**. Hay que mirar el valor neto, que es el que cuenta, y si queda corto preguntar si
   hay activos revaluables.
2. **Lo arrendado normalmente NO cuenta como PP&E.** Bajo NIIF 16, un local o unos equipos en
   arriendo aparecen como **«activos por derecho de uso»**, que es otra línea. Si su oficina o su
   centro de datos son alquilados, ojo.
3. **«En Colombia» es literal: ubicación física.** Servidores en un centro de datos del exterior no
   suman. Si su infraestructura está en la nube (AWS, Azure), **eso no es PP&E de ellos en
   absoluto** — es un servicio.
4. **La cifra tiene que estar en estados financieros**, firmados por contador y revisor fiscal si
   aplica. Es lo que la DIAN va a revisar, no una hoja de cálculo.

> **Qué pedirles, en concreto:** el **estado de situación financiera** del último cierre, y dentro
> de él las líneas de **«Propiedad, planta y equipo»** (neto) y de **patrimonio total**. Con la nota
> a los estados financieros que desglosa la PP&E, si la hay.

### Lo demás que exige la DIAN

Además del patrimonio, la PP&E y la ISO:

| Requisito | Cómo se comprueba |
|---|---|
| **Ser persona jurídica** con domicilio en Colombia | Certificado de existencia y representación legal de la cámara de comercio |
| **RUT** con el objeto/actividad que cubra prestar servicios de facturación electrónica | RUT actualizado; puede requerir agregar la responsabilidad o el código CIIU correspondiente |
| **Estar al día con la DIAN**: declaraciones presentadas y sin deudas exigibles | Estado de cuenta / paz y salvo |
| **No haber sido sancionado** ni haber perdido antes esta habilitación | Declaración y verificación de la DIAN |
| **Representante legal sin antecedentes** que lo inhabiliten | Certificados de antecedentes |
| **Estados financieros** del último cierre | Firmados por contador y revisor fiscal |
| **Superar el conjunto de pruebas** en el ambiente de habilitación | Se emite un lote de documentos de prueba y deben pasar todas las validaciones |

⚠️ **Esta lista hay que confirmarla contra la resolución vigente antes de radicar nada.** Está
construida a partir de la Resolución 000042 de 2020 y el Decreto 358 de 2020 (§7), y el trámite se ha
modificado. **Lo correcto es pedirle a la DIAN el checklist actual del trámite**, que es gratis y
evita sorpresas.

---

## 5-quinquies. Qué tener en cuenta para la negociación

*(Escrito para preparar la conversación, no para sustituir al abogado.)*

### La asimetría de fondo, que es lo único que de verdad hay que resolver

> **Lo que ellos aportan ya lo tienen. Lo que nosotros aportamos hay que hacerlo, y mantenerlo para
> siempre.**

Su balance existe hoy y no les cuesta nada extra ponerlo. Nuestro aporte es el emisor: 400–600 horas
la primera versión **más mantenimiento perpetuo** cada vez que la DIAN cambia el anexo técnico, más
la ISO, más el soporte.

**Si el reparto se negocia como «ellos ponen el respaldo, nosotros ponemos el software», se está
comparando un estado con un trabajo continuo**, y eso termina en EscalApp haciéndolo todo por una
participación minoritaria. La forma de corregirlo es reconocer el trabajo **recurrente** como tal:
una remuneración por operación y mantenimiento, aparte del reparto de utilidades.

### La palanca que ya está sobre la mesa

Ellos **hoy le pagan a Siigo** por su facturación electrónica interna. Eso es un número concreto, y
es el primer valor demostrable que podemos poner:

- Dejan de pagarlo.
- Se convierten en el **primer emisor real** del PT, que además sirve para las pruebas de
  habilitación.

⚠️ **Pero cuidado con venderlo como «integración gratis».** «Gratis» ancla nuestro aporte en el valor
de su factura de Siigo, que es pequeño al lado de construir y mantener un emisor. **Mejor planteado
así:** *«dejan de pagarle a un tercero **y** entran a un negocio nuevo»*, no *«les regalamos el
trabajo»*.

### Los nueve puntos que hay que dejar por escrito

| # | Punto | Por qué importa |
|---|---|---|
| 1 | **Propiedad del software** | Es el único activo que aportamos. Se **licencia** a la operación conjunta, no se cede. Si se cede, se cedió el negocio |
| 2 | **Reparto de ingresos Y remuneración por operación** | Ver la asimetría de arriba. Son dos cosas distintas y hay que pactar las dos |
| 3 | **Qué pasa a la salida** | Si se rompe: ¿seguimos facturando a nuestros clientes? ¿con qué proveedor? ¿hay período de transición? Se pacta al principio o no se pacta nunca |
| 4 | **Exclusividad, en ambos sentidos** | ¿Podemos vender el emisor a otros? ¿Pueden ellos usar otro proveedor? |
| 5 | **Responsabilidad por sanciones de la DIAN** | Recaen sobre el PT habilitado (su empresa), pero si el fallo es del software, que es nuestro. Hay que repartirlo **y ponerle tope** |
| 6 | **Quién paga y mantiene la ISO** | Nosotros nos encargamos de obtenerla; hay que pactar quién **paga** las auditorías anuales y qué pasa si se pierde |
| 7 | **Prioridad técnica** | Cuando la DIAN cambia el anexo técnico hay plazo. Alguien tiene que poder priorizar eso por encima de todo. Si ellos pueden bloquearlo, se pierde la habilitación |
| 8 | **Disponibilidad y soporte** | Un PT tiene obligaciones de servicio. Si un cliente no puede facturar un sábado a las 8 pm, **alguien tiene que responder**. ¿Quién, con qué horario y con cargo a quién? |
| 9 | **Plazo y revisión** | No firmar a perpetuidad. Revisión a los 12–18 meses, cuando ya haya números reales |

### ⚠️ Antes de la reunión: mirar el contrato que YA existe entre las dos empresas

Ellos usan **un software que desarrollamos nosotros**. Eso significa que ya hay un acuerdo previo, y
**hay que releerlo antes de negociar nada**, porque puede contener:

- **Cesión de propiedad intelectual** — si ese contrato dice que lo desarrollado es de ellos, el
  punto 1 de la tabla ya está decidido en contra nuestra y hay que renegociarlo, no asumirlo.
- Cláusulas de exclusividad o de no competencia que condicionen esto.

Es media hora de lectura y puede cambiar toda la postura.

### Cómo ordenar el proceso

1. **Carta de intención** (no vinculante) con los nueve puntos esbozados. Barata, rápida, y obliga a
   que ambas partes digan en serio lo que quieren.
2. **Verificación**: estados financieros, situación ante la DIAN, contrato previo.
3. **Solo entonces**, abogado y contador para la estructura B o C (§5-bis).

---

## 6. Lo que hay que verificar antes de gastar un peso

1. **Confirmar las cifras contra la resolución vigente.** Las de este documento salen de la
   Resolución DIAN 000042 de 2020 y la UVT de 2026. La norma se ha modificado varias veces.
2. **Mirar el balance de la otra empresa**, en concreto la línea de propiedad, planta y equipo (§3).
3. **Preguntarle a un contador** si el patrimonio contable de una sociedad recién creada se puede
   constituir con aportes en especie y qué se puede registrar como propiedad, planta y equipo.
4. **Preguntarle a un abogado tributarista** por la vía de §5.
5. **Pedir el conjunto de pruebas de habilitación** de la DIAN para calcular el trabajo técnico real.

---

## 7. Fuentes

- **Resolución DIAN 000042 de 2020** — habilitación de proveedores tecnológicos (patrimonio 20.000
  UVT, propiedad planta y equipo 10.000 UVT, ISO 27001)
- **Decreto 358 de 2020** — condiciones de los proveedores tecnológicos
- **Artículo 616-4 del Estatuto Tributario** — obligaciones del proveedor tecnológico
- **Artículo 684-4 del Estatuto Tributario** — sanciones aplicables a los proveedores tecnológicos
- **Concepto DIAN 1169 (013246) de 2025** — requisitos del software propio o adquirido (puerta 2)
- **Resolución DIAN 000238 del 15-dic-2025** — UVT 2026 = $52.374
- **Catálogo de Participantes vigente** —
  <https://micrositios.dian.gov.co/sistema-de-facturacion-electronica/proveedores-tecnologicos/>
