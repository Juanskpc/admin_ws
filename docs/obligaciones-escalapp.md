# Lo legal que nos incumbe a NOSOTROS: cobrar mensualidades y manejar datos ajenos

**Fecha:** 2026-09-01 · **Relacionado:** [`facturacion-electronica.md`](facturacion-electronica.md) §12 · [ADR-024](adr/ADR-024-persistencia.md) (gobierno de PII)

> **Aviso, y va en serio:** esto es un **mapa de lo que hay que preguntar**, no asesoría legal ni
> contable. Cada punto termina en «confírmalo con un contador o un abogado» porque es exactamente
> ahí donde termina lo que se puede resolver leyendo. Lo que sí hace este documento es que ninguna
> de estas preguntas te agarre por sorpresa **después** de haber firmado con un cliente grande.

---

## Por qué existe este documento

`facturacion-electronica.md` habla de la factura que emite **el cliente**. Este habla de las
obligaciones que tenemos **nosotros**, y que son de tres tipos:

1. **Tributarias** — cobramos mensualidades: hay que facturarlas, y hay que saber si llevan IVA.
2. **De datos personales** — guardamos información de gente que ni siquiera es cliente nuestra: los
   comensales del restaurante.
3. **Contractuales** — si nuestro software falla, el que recibe la sanción de la DIAN es el cliente.

Las tres se vuelven más grandes el día que entre la facturación electrónica. Ninguna es un problema
hoy; **las tres son mucho más baratas de resolver ahora que después**.

---

## 1. Nosotros también estamos obligados a facturar lo que cobramos

EscalApp cobra $27.999 y $59.999 al mes. **Eso es una venta de servicios**, y toda venta necesita su
documento.

### Cómo estamos hoy

**EscalApp está registrada como PERSONA JURÍDICA** (confirmado por el dueño el 2026-09-01), y su
contadora ha dicho que **todavía no declara IVA** porque la empresa es muy pequeña.

Esas dos frases juntas dan una conclusión que conviene no confundir:

> ## ⚠️ Una persona jurídica está obligada a facturar. Siempre.
>
> No hay umbral que valga. Los topes de 3.500 UVT y las excepciones del artículo 616-2 del
> Estatuto Tributario son para **personas naturales**; una sociedad no entra ahí.
>
> **Y no ser responsable de IVA no cambia nada:** la obligación de facturar es una obligación
> **formal e independiente** de la responsabilidad frente al IVA. Se puede —y se debe— facturar
> electrónicamente sin cobrar un peso de IVA. Lo que dijo la contadora sobre el IVA es correcto y
> no contradice esto: son dos cosas distintas.

O sea que el punto 7 del plan (sacar nuestra habilitación y nuestra resolución de numeración) **no
es preparación para el futuro: es una obligación de hoy**, y conviene preguntarle a la contadora
desde cuándo corre y si hay algo pendiente.

### Lo que viene: la SAS con el socio

El dueño quiere más adelante constituir una **SAS en sociedad con su compañero**. Dos cosas que
conviene saber antes, porque cambian el orden de los trámites:

- **Si se constituye una sociedad NUEVA, el NIT es nuevo.** Y con un NIT nuevo hay que **rehacer
  la habilitación ante la DIAN y sacar otra resolución de numeración**: la del NIT viejo no se
  hereda. Si eso va a pasar pronto, quizá convenga hacer la habilitación una sola vez, ya con la
  figura definitiva.
- **Si en cambio la sociedad actual ya es una SAS y solo entra un socio nuevo**, es una reforma de
  estatutos: **el NIT no cambia** y no hay que rehacer nada.

**Pregúntale a la contadora cuál de los dos casos es el tuyo antes de arrancar el trámite.** Es la
diferencia entre hacerlo una vez o dos.

### Qué hay que hacer, y no es mucho

1. **RUT actualizado** con las responsabilidades correctas.
2. **Habilitación como facturador electrónico** ante la DIAN.
3. **Resolución de numeración propia** — prefijo y rango para las facturas de EscalApp.
4. **Un emisor**: el servicio gratuito de la DIAN sirve para arrancar (son pocas facturas al mes), o
   nuestra propia cuenta en el proveedor tecnológico que elijamos.

### La idea buena: ser nuestro propio primer cliente

Si vamos a integrar un proveedor tecnológico de todas formas, **EscalApp puede ser el primer negocio
que factura con esa integración**. Ventajas, todas reales:

- Se prueba el adaptador entero **sin arriesgar la caja de un cliente**.
- Se recorre el trámite de habilitación una vez **en cabeza propia**, y así sabemos exactamente qué
  pedirle al cliente y cuánto tarda — en vez de descubrirlo con él esperando.
- Los datos que necesitamos para facturarle a un inquilino son **exactamente los mismos** de
  `gener_negocio_fiscal` ([`facturacion-electronica.md`](facturacion-electronica.md) §5.2). O sea
  que FE-1 se paga sola aunque ningún cliente active la facturación.

**Esto convierte a FE-1 en trabajo útil desde el primer día, sin depender de que ningún cliente
quiera nada.**

---

## 2. ¿Las mensualidades llevan IVA? — la pregunta de $5.320

Es la que más plata mueve y la que menos gente se hace a tiempo.

**El servicio de computación en la nube está EXCLUIDO de IVA** en Colombia (artículo 476 del
Estatuto Tributario, numeral 21 — antes numeral 24). La DIAN lo reafirmó en 2024 y hay un
**Concepto Unificado 017056 de 2017**, hecho junto con el MinTIC, con los lineamientos para
determinar si un servicio califica.

**Pero la exclusión no es automática.** La propia DIAN dice que si el servicio *«no cumple con los
elementos necesarios para identificar plenamente el servicio de computación en la nube, no opera la
exclusión»*. Y ahí hay una duda honesta que conviene mirar de frente:

> EscalApp corre en **un VPS de 1 vCPU en Vultr**. Las características que se le suelen exigir a la
> computación en la nube —autoservicio bajo demanda, elasticidad rápida, agrupación de recursos,
> servicio medido— **no son obviamente las nuestras**. Que el software esté *en internet* no lo
> convierte en *cloud computing* para efectos tributarios. Puede que califique; puede que lo que
> vendemos se lea mejor como licenciamiento de software o servicio de gestión, que es otra cosa.

Lo que está en juego:

| | Si está excluido | Si está gravado |
|---|---|---|
| Plan Básico | $27.999 | $27.999 + 19% = **$33.319** |
| Plan Avanzado | $59.999 | $59.999 + 19% = **$71.399** |

**Estado a 2026-09-01: la contadora dice que todavía NO se declara IVA**, porque la empresa es muy
pequeña. Mientras seamos no responsables de IVA, las mensualidades salen sin IVA, califique o no la
exclusión — y en la factura el tributo va como `ZZ` (no causa).

Así que la pregunta de arriba **no está resuelta, está aplazada**. Se vuelve urgente el día que
crucemos el umbral y haya que decidir si lo que vendemos es computación en la nube o no. Conviene
tener la respuesta antes de ese día, no ese día.

**Acción concreta:** decidir esto **antes de publicar precios en la landing**. «$27.999 IVA
incluido», «$27.999 + IVA» y «$27.999» son tres promesas distintas, y cambiar de una a otra con
clientes ya firmados es una conversación fea.

---

## 3. Retención en la fuente e ICA: lo que entra no es lo que facturas

Si el cliente es una **persona jurídica**, muy probablemente sea agente de retención. Al pagarnos:

- Nos practica **retención en la fuente** sobre servicios.
- Puede practicar **ReteICA** municipal.

Es decir: **facturamos $59.999 y nos consignan menos**. No es una pérdida (se descuenta del impuesto
de renta), pero sí tiene dos efectos prácticos que hay que tener resueltos:

- **La conciliación deja de cuadrar sola.** Lo que llega al banco no coincide con lo facturado, y
  eso confunde a cualquiera que revise las cuentas sin saberlo.
- Si algún día se cobra por **pasarela de pagos o débito automático**, el cliente empresa igual
  puede retener, y hay que decidir cómo se maneja esa diferencia.

También hay **ICA municipal** por la actividad económica en el municipio donde se opera. Es el
impuesto que más se olvida en negocios pequeños.

---

## 4. Datos personales: manejamos información de gente que no es cliente nuestro

Este es el punto que la facturación electrónica **agranda de verdad**, y conviene verlo claro.

### Qué cambia con la facturación

| Hoy | Con facturación electrónica |
|---|---|
| Guardamos el teléfono de un comensal y su conversación con el bot | Guardamos **cédula, nombre completo, correo y dirección** de ese comensal |
| Se puede borrar si alguien lo pide | **Hay que conservarlo 5 años** por obligación fiscal |

Pasamos de datos de contacto a **identidad plena, en un documento que no se puede borrar**. Es un
salto de categoría, no un incremento.

### El reparto de papeles (Ley 1581 de 2012)

- **El negocio es el RESPONSABLE** del tratamiento: son sus clientes, él decide para qué se usan.
- **EscalApp es el ENCARGADO**: tratamos esos datos por cuenta del negocio.

Eso significa que necesitamos, y hoy no está todo:

1. **Cláusula o anexo de tratamiento de datos** en el contrato con cada negocio. Sin eso, estamos
   tratando datos personales por cuenta de otro sin el papel que lo autoriza.
2. **Política de tratamiento de datos publicada** y accesible desde la landing y desde el menú
   digital (que es público y donde un comensal deja su teléfono).
3. **Canal para ejercer derechos** (consultar, actualizar, suprimir) y un plazo de respuesta.
4. **Medidas de seguridad** demostrables: cifrado de credenciales, control de acceso, respaldo.
   Parte ya existe; hay que poder enseñarlo escrito.
5. ~~**RNBD** (Registro Nacional de Bases de Datos, ante la SIC)~~ — **RESUELTO 2026-09-01: NO
   aplica.** La obligación recae sobre sociedades con activos totales superiores a **100.000 UVT**
   ($5.237.400.000 en 2026) y EscalApp está muy por debajo. Revisar solo si la empresa crece.

### La contradicción que hay que saber responder

> «Bórrenme mis datos» ← derecho del comensal, Ley 1581
> «Consérvelos 5 años» ← obligación fiscal, art. 632 del Estatuto Tributario

**Gana la obligación legal de conservación:** un documento fiscal emitido no se borra porque el
comprador lo pida. Lo que sí se puede es dejar de usar sus datos para todo lo demás (marketing,
conversaciones). Conviene tenerlo escrito en la política **antes** de que alguien lo pregunte, y
tener claro en el código qué se borra y qué no.

### ⚠️ Y el hallazgo gordo: todo está ya fuera del país

Al redactar la política salió algo que no estaba medido. **Estados Unidos NO figura en el listado
de países con nivel adecuado de protección** de la SIC (Circular Externa 5 de 2017). Y esto no va
solo del modelo de IA, que era el riesgo que [ADR-024](adr/ADR-024-persistencia.md) había
anticipado:

> **El VPS está en Miami.** La base de datos entera —con los teléfonos, los nombres, las
> conversaciones y, en cuanto entre la facturación, las cédulas— ya vive en Estados Unidos. La
> transferencia internacional no es algo que vaya a pasar: **lleva pasando desde la migración de
> agosto**.

Conforme al artículo 26 de la Ley 1581, eso exige autorización expresa e inequívoca del titular
(u otra de las vías del artículo). Práctico:

- Para **nuestros usuarios** se resuelve con la política aceptada al registrarse.
- Para los **clientes de nuestros clientes** —el comensal que escribe por WhatsApp— **la
  autorización la tiene que pedir el negocio**, que es quien tiene la relación con él. Por eso el
  anexo de encargado se la exige explícitamente.
- Queda una pregunta para el abogado: si conviene además una **Declaración de Conformidad** ante
  la SIC.

### Y la regla técnica que sale de aquí

**Los datos fiscales del comprador no entran al prompt del modelo.** [ADR-024](adr/ADR-024-persistencia.md)
ya nombró el riesgo de mandar datos personales a un proveedor de LLM extranjero; con cédulas y
direcciones en la base, esa línea deja de ser teórica. La cédula del comensal no le hace falta al
asistente para nada.

---

## 5. Conservación y qué pasa si un cliente se va

- **5 años** de conservación de los documentos y sus soportes (art. 632 ET).
- Los documentos están **en nuestra base y en la del proveedor tecnológico**. Hay que saber cuál de
  los dos es la copia buena, y decirlo en el contrato.
- **Un cliente que se va tiene que poder llevarse sus documentos.** Hace falta una exportación
  (XML + PDF + un CSV de control) y una frase en el contrato sobre quién conserva qué después de
  terminada la relación.

Esto no es solo cortesía: retener los documentos fiscales de alguien que ya no es cliente es
buscarse un problema evitable.

---

## 6. Si nuestro software falla, el que responde ante la DIAN es el cliente

**El punto más importante de todo el documento.**

No somos proveedor tecnológico, así que el **obligado a facturar es el negocio**. Si un sábado a las
9 de la noche el proveedor se cae, o nuestro servidor se cae, o hay un bug:

- El que no facturó es el cliente.
- El que se expone a sanción es el cliente.
- El que va a llamar furioso es el cliente, y con razón.

### Las políticas de EscalApp no existen todavía — y ya hay tres cosas que dependen de ellas

**Punto pendiente reconocido el 2026-09-01.** Hoy no hay términos y condiciones, ni política de
tratamiento de datos, ni nada firmado: la relación con los clientes se sostiene en la confianza.
Eso funciona perfecto hasta el día que no.

Y con la facturación electrónica ya hay **tres cláusulas concretas** que necesitan existir, no en
abstracto:

1. **Lo que el cliente declara es responsabilidad del cliente.** Si dice que su negocio está
   registrado y no lo está, o marca mal si es persona natural o jurídica, o pone un NIT que no es
   suyo — **eso es suyo**. EscalApp no verifica nada ante la Cámara de Comercio ni ante la DIAN, y
   no está en posición de hacerlo. Debe decirse con esas palabras.
2. **Quién es el obligado a facturar.** El obligado es el negocio, no nosotros. No somos proveedor
   tecnológico ni asesores tributarios, y no respondemos por si el cliente debía facturar y no lo
   hizo.
3. **Qué pasa cuando el sistema no está disponible.** Corremos en un VPS de 1 vCPU sin alta
   disponibilidad. Hay que decir qué se promete y qué no, y describir el modo contingencia.

A eso se suma el **anexo de tratamiento de datos** (§4), que es otra pieza del mismo paquete.

**Es trabajo de abogado, se hace una sola vez, y bloquea al primer cliente grande.** Es de las
pocas cosas de esta lista que no se pueden resolver programando.

> ✅ **Borradores escritos el 2026-09-01** en [`legal/`](legal/): términos y condiciones,
> política de tratamiento de datos y anexo de encargado. **No están vigentes**: son el material
> para llegar donde el abogado con el trabajo hecho, con las cláusulas ya identificadas. Falta
> rellenar los datos de la sociedad, que los revise un abogado, publicarlos en la landing y
> guardar la aceptación con versión y fecha.

Lo que hay que tener **antes** del primer cliente grande, no después:

1. **Términos de servicio escritos**, con **limitación de responsabilidad**. Hoy la relación se
   sostiene en la confianza, que funciona perfecto hasta el día que no.
2. **Decir la verdad sobre la disponibilidad.** Corremos en **un VPS de 1 vCPU sin alta
   disponibilidad**, con respaldo diario a las 3:30 a.m. Prometer 99,9% sería mentir; decir «hacemos
   lo razonable y esto es lo que hay» es defendible y honesto.
3. **Un modo contingencia documentado**, que el cliente sepa de antemano: si la DIAN o el proveedor
   no responden, la venta se cierra igual y el documento se transmite después
   ([`facturacion-electronica.md`](facturacion-electronica.md) §7.1). Eso ya está en el diseño; hay
   que escribirlo también en el lado comercial.
4. **Cuidado con el copy de marketing.** «Cumplimiento garantizado ante la DIAN» es una **obligación
   de resultado**. «Emite tus documentos electrónicos desde el mismo sistema donde vendes» describe
   lo mismo sin firmar un cheque. La frase de la landing es una decisión legal disfrazada de
   redacción.

---

## 7. El contrato con el proveedor tecnológico

Cuando se firme con el PT elegido, revisar tres cosas:

- **Quién responde ante el cliente final** si el PT se cae o rechaza documentos por su culpa.
- **Portabilidad**: si nos vamos, ¿nos llevamos los XML y los CUFE?
- **Tratamiento de datos**: el PT también es un encargado, y por él pasan las cédulas y correos de
  los comensales. Necesita su propio acuerdo.

---

## 8. Qué hacer y cuándo

| # | Acción | Cuándo | Cuesta |
|---|---|---|---|
| 1 | ~~¿Las mensualidades llevan IVA?~~ **RESUELTO 2026-09-01: hoy no, la empresa es muy pequeña.** Queda pendiente la pregunta de la exclusión para cuando crezcamos | — | Hecho |
| 1b | Preguntarle a la contadora: **siendo persona jurídica ya estamos obligados a facturar — ¿desde cuándo, y hay algo pendiente?** Y si la SAS con el socio será NIT nuevo | **Ya** | Una consulta |
| 2 | Decidir cómo se muestran los precios en la landing | Con (1b) | Nada |
| 3 | Redactar las **políticas de EscalApp**: términos y condiciones + limitación de responsabilidad + **las tres cláusulas de §6** (lo que el cliente declara es suyo; el obligado a facturar es él; qué se promete de disponibilidad) | **Antes del primer cliente grande.** Hoy no existe ninguna | Un abogado, una vez |
| 4 | **Anexo de tratamiento de datos** en el contrato con cada negocio | Antes de activar facturación | Se redacta una vez |
| 5 | **Política de tratamiento de datos** publicada en la landing y el menú digital | Antes de activar facturación | Una página |
| 6 | Verificar si aplica el **RNBD** ante la SIC | Con (1) | Una consulta |
| 7 | Sacar **nuestra propia habilitación y resolución** de numeración. **Ya no es preparación: siendo persona jurídica es obligación.** Ojo con hacerlo antes o después de la SAS (§1) | **Ya**, coordinado con FE-0 | Trámite |
| 8 | Facturarnos a nosotros mismos con el adaptador nuevo (§1) | FE-2 | Sale gratis |
| 9 | Exportación de documentos para el cliente que se va | FE-4 | Código |

Los puntos 1b, 3 y 7 son los que más se demoran en conseguir y los que menos dependen del código.
**Son los que hay que arrancar hoy.**

---

## 9. Fuentes

- Artículo 476 del Estatuto Tributario, numeral 21 (antes 24) — exclusión de IVA para computación en
  la nube y hosting
- Concepto Unificado DIAN 017056 de 2017 (con MinTIC) — lineamientos para determinar si un servicio
  es computación en la nube; reafirmado por la DIAN en 2024
- Artículo 616-2 del Estatuto Tributario y Resolución DIAN 227 de 2025 — quién está obligado a
  facturar; umbral de 3.500 UVT
- Artículo 632 del Estatuto Tributario — conservación de documentos (5 años)
- Ley 1581 de 2012 y Decreto 1377 de 2013 — protección de datos personales, responsable vs. encargado
- Resolución DIAN 000238 del 15-dic-2025 — UVT 2026 = $52.374
