# Políticas de EscalApp

**Estado: VIGENTES desde el 2026-09-03, versión 1.0.** · Redactados el 2026-09-01, publicados
con los datos del titular el 2026-09-03. · **Sin revisión de abogado todavía.**

> ### Por qué se publicaron sin abogado, y qué riesgo se aceptó
>
> No fue impaciencia: lo pidió **Meta**. El App Review de Embedded Signup exige una URL de política
> de privacidad y otra de términos que el revisor abre, y un texto con huecos entre corchetes o con
> un cartel de «borrador» encima es un rechazo seguro. Sin App Review no hay Proveedor de
> Tecnología, y sin eso no hay alta de clientes por Embedded Signup.
>
> **El riesgo que se asume está acotado y conviene entenderlo:** en Colombia una cláusula abusiva
> en un contrato de adhesión **se tiene por no escrita**. O sea que lo que puede fallar no es que
> el documento sea ilegal, sino que alguna limitación de responsabilidad **no proteja lo que
> promete**. Publicar la política de datos, en cambio, es lo contrario de un riesgo: sin ella el
> tratamiento no tiene autorización informada, que es lo que exige la Ley 1581.
>
> **Sigue pendiente que un abogado los revise.** Cuando lo haga: subir `VERSION` y `VIGENTE_DESDE`
> en `legal-content.ts` y avisar a los clientes.

> ## ⚠️ Léelo antes de usar nada de esta carpeta
>
> Esto lo redactó Claude, no un abogado. Sirve para **llegar donde un abogado con el trabajo
> hecho** —con las cláusulas que este producto necesita de verdad, ya identificadas y
> justificadas— y no para publicarlo tal cual. Un contrato de adhesión mal redactado no protege:
> en Colombia las cláusulas abusivas en contratos de adhesión se tienen por no escritas, así que
> una limitación de responsabilidad mal puesta es una limitación que no existe.
>
> **Qué hacer con esto:** llevárselo a un abogado, decirle «esto es lo que hace mi producto y
> estos son los riesgos que identifiqué», y que él redacte la versión que se firma.

## Qué hay aquí

| Documento | Qué es | Quién lo acepta |
|---|---|---|
| [`terminos-y-condiciones.md`](terminos-y-condiciones.md) | El contrato de uso del servicio | El negocio que contrata EscalApp |
| [`politica-tratamiento-datos.md`](politica-tratamiento-datos.md) | Cómo se tratan los datos personales (Ley 1581 de 2012) | Se publica; la aceptan usuarios y titulares |
| [`anexo-encargado-tratamiento.md`](anexo-encargado-tratamiento.md) | El reparto de papeles: el negocio es Responsable, EscalApp es Encargado | El negocio, como anexo al contrato |
| [`eliminacion-de-datos.md`](eliminacion-de-datos.md) | Cómo pedir la supresión: a quién, con qué datos y en cuánto tiempo | Se publica; nadie lo «acepta» |

## Los datos del titular — rellenados el 2026-09-03

Salen del **certificado de matrícula mercantil** de la Cámara de Comercio de Pasto (expedido el
2026-08-28, código de verificación `Bt5bj4V9fA`). Es persona natural, no sociedad, y eso cambia
qué va en cada casilla:

| Campo | Valor |
|---|---|
| Titular | **NICOLÁS PANTOJA PÁEZ** — persona natural comerciante, matrícula 233177 |
| Establecimiento de comercio | **ESCALAPP**, matrícula 233178 (23 de octubre de 2023) |
| NIT | **1193035399-6** (CC 1193035399) |
| Domicilio | CR 3 E 19 A 49, Barrio Betania, Pasto, Nariño |
| Correo de contacto | `nicolasppaez00@gmail.com` |
| Ciudad para controversias | Pasto (Nariño) |

⚠️ **No existe `[REPRESENTANTE LEGAL]` y no es un olvido.** Una persona natural comerciante *es*
el titular; el representante legal solo existe si hay sociedad. Por eso el certificado que sirve
aquí es el de **matrícula mercantil** y no el de «existencia y representación legal», que para
este caso no existe.

**El nombre comercial va junto al del titular en los dos documentos, a propósito.** Quien lea
«EscalApp» tiene que poder llegar a una persona identificable: el establecimiento de comercio es
el vínculo que aparece en el registro mercantil, y es también lo que Meta cruzó para aprobar la
verificación de negocio.

**Deuda pendiente:** el correo publicado es personal, no corporativo. Se decidió así el 2026-09-03
para no bloquear el App Review, pero un `@escalapp.cloud` da mejor impresión al revisor y es lo que
pide `../obligaciones-escalapp.md`. Cambiarlo es tocar una constante y volver a desplegar.

## Los plazos son decisiones de negocio, no valores de plantilla

Tomados el 2026-09-03. Si alguno se cambia, cambia el contrato:

| Plazo | Valor | Dónde |
|---|---|---|
| Mora antes de poder suspender el acceso | **5 días** | Términos §4 |
| Aviso previo de cambios materiales | **15 días** | Términos §13 |
| Preaviso para terminar el contrato | **30 días** | Términos §12 |
| Ventana para pedir copia de los datos al terminar | **30 días** | Términos §12 |
| Tope de responsabilidad | **lo pagado en los 3 meses anteriores** | Términos §11 |

## Las tres cláusulas que motivaron esto, y de dónde salen

No son genéricas: salen de decisiones concretas del producto.

1. **Lo que el cliente declara es responsabilidad del cliente.** La pantalla
   `/admin/facturacion` le pregunta al negocio si está registrado en Cámara de Comercio, si es
   persona natural o jurídica y si está obligado a facturar. **EscalApp no verifica nada de eso**
   —no tiene cómo— y guarda quién lo declaró y cuándo. Esa firma solo sirve de algo si el
   contrato dice que la declaración es suya. Ver `../facturacion-electronica.md` §4.
2. **El obligado a facturar es el negocio, no nosotros.** EscalApp no es proveedor tecnológico
   habilitado por la DIAN ni asesor tributario. Si el cliente debía facturar y no lo hizo, o
   declaró mal su régimen, la sanción es suya.
3. **Qué se promete de disponibilidad.** El servicio corre en **un VPS de 1 vCPU sin alta
   disponibilidad**, con respaldo diario a las 3:30 a.m. Prometer 99,9% sería mentir. Decir la
   verdad es defendible; una promesa incumplida, no.

## Dos hallazgos del 2026-09-01 que cambian el contenido

**Estados Unidos no es país con nivel adecuado de protección** según la Circular Externa 5 de
2017 de la SIC. Y esto no es un detalle del modelo de IA: **el VPS está en Miami**, así que
*todos* los datos personales que trata EscalApp ya están fuera del país. Eso obliga a autorización
expresa e informada del titular, y a que la política lo diga con claridad en vez de esconderlo.
Ver [`politica-tratamiento-datos.md`](politica-tratamiento-datos.md) §7.

**El RNBD no aplica.** La inscripción en el Registro Nacional de Bases de Datos obliga a
sociedades con activos totales superiores a **100.000 UVT** ($5.237.400.000 en 2026). EscalApp
está muy por debajo. Queda descartado como pendiente — pero conviene revisarlo si la empresa
crece.

## Publicación en la web — hecho el 2026-09-01

> ⚠️ **La URL pública NO es `escalapp.cloud/terminos`.** La app de administración se sirve con
> `baseHref = /admin/`, así que las direcciones reales son
> **`escalapp.cloud/admin/terminos`** y **`escalapp.cloud/admin/privacidad`**. Si se quiere la URL
> corta —y para un documento legal público conviene— hay que añadir una regla al `Caddyfile` del
> VPS, que es trabajo de infraestructura por SSH.

Las páginas ya existen y se prerenderizan:

- **`/terminos`** y **`/privacidad`** en `admin_app-v21`, **sin guardia** (quien quiere ejercer
  sus derechos como titular no tiene por qué tener cuenta).
- El contenido publicado vive en `src/app/legal/legal-content.ts`; el componente
  (`legal-page.component`) es uno solo para los dos documentos.
- **`BORRADOR = false` desde el 2026-09-03**, con `VERSION = '1.0'` y `VIGENTE_DESDE`. El aviso
  amarillo de «versión preliminar» ya no sale. Los tres valores viven en `legal-content.ts` y hay
  que subirlos en cada cambio material.
- Enlazados desde: la **barra legal del pie** de la landing (donde los enlaces estaban muertos,
  con `href="#"`), el **pie de marca**, y el **modal de registro de prueba**, con la frase de
  aceptación pegada al botón.
- **Identidad visual de la landing** (2026-09-01): banda oscura con `--es-gradient-hero`, logo
  invertido, pastilla de marca y una tarjeta blanca que monta la banda con margen negativo. El
  número de cada cláusula va en una pastilla con el degradado morado. Tokens `--es-*`, nunca los
  `--color-*` del admin: son dos sistemas distintos a propósito. Lo que **no** se copia de la
  landing es el ritmo — aquí hay que leer, así que medida corta e interlineado generoso.

**⚠️ Hay que mantener a mano el markdown de esta carpeta y `legal-content.ts` en sintonía.** Lo
que ve el público es el TypeScript; este markdown es donde se redacta y donde van las notas para
el abogado. Cuando el abogado apruebe la versión definitiva, el TypeScript pasa a ser la fuente de
verdad y estos markdown quedan como histórico de la redacción.

## ⚠️ Lo que todavía falta para el App Review de Meta

Rellenar estos documentos era **el primero de tres** requisitos de contenido. Siguen faltando:

1. ~~Una URL de instrucciones de eliminación de datos.~~ ✅ **Hecho el 2026-09-04**:
   [`eliminacion-de-datos.md`](eliminacion-de-datos.md), publicado en
   **`escalapp.cloud/admin/eliminacion-datos`**. Es la URL que va en la ficha de la app.
2. **Desplegar.** El bundle que hay hoy en producción **no contiene las rutas legales** —se
   escribieron el 2026-09-01 y nunca se subieron—, así que `escalapp.cloud/admin/privacidad`
   devuelve el cascarón vacío de la app. Un revisor que abra esa URL no ve nada.
3. **La URL corta.** Sigue siendo `/admin/privacidad`. Para un formulario legal conviene la regla
   en el `Caddyfile`, que es trabajo por SSH.

## Lo que falta

1. **Rellenar los corchetes** y que lo revise un abogado.
2. **Enlazarlo desde el menú digital público**, que está en **otro repo** (`restaurante_app`) y es
   donde un comensal deja su teléfono sin ser cliente nuestro. Es el punto más expuesto y el que
   falta.
3. **Guardar la aceptación**: quién aceptó, **qué versión** y cuándo. Hoy la frase se muestra pero
   no se registra nada; «aceptó los términos» sin decir cuáles no prueba gran cosa. Es una tabla y
   un campo, y por eso `VERSION` ya es una constante exportada.
4. **Versionarlos**: cada cambio material con fecha y aviso a los clientes.

## Fuentes consultadas (2026-09-01)

- Ley 1581 de 2012 y Decreto 1074 de 2015 (que compiló el Decreto 1377 de 2013)
- Circular Externa 5 de 2017 de la SIC — países con nivel adecuado de protección
- Artículo 26 de la Ley 1581 — régimen de transferencias internacionales
- Artículo 632 del Estatuto Tributario — conservación de documentos por 5 años
- Artículos 615, 616-1 y 616-2 del Estatuto Tributario — obligación de facturar
- SIC — umbral de inscripción en el RNBD (100.000 UVT)


## El documento de eliminación de datos (2026-09-04)

Nació de un requisito de Meta —el App Review pide esa URL, y es un campo distinto del de la
política— pero **la pregunta que contesta ya estaba sin responder**: la política reconocía el
derecho de supresión y decía por dónde ejercerlo, y no decía **a quién**. En EscalApp eso no es
obvio, porque somos Responsables de los datos del negocio y Encargados de los de sus clientes; la
tabla del §1 es el documento entero, el resto es procedimiento.

Dos cosas que salieron de mirar el código y no de una plantilla:

- **`STOP` es real y está documentado como lo que es.** `intelligence/engine/optout.js` bloquea la
  conversación y el bot no vuelve a escribir *ni para confirmar la baja*. El documento dice las dos
  consecuencias que muerden: **darse de baja no borra nada**, y **la baja no se deshace escribiendo
  otra vez** (hace falta una persona). Prometer lo contrario habría sido mentir sobre código que
  está ahí.
- **La sección de Meta existe porque el revisor la busca.** Quien llega desde WhatsApp puede creer
  que borrando aquí borra su cuenta de WhatsApp. Se dice explícitamente que no tenemos acceso a
  eso.

**En código:** el componente legal dejó de ser «dos documentos y el otro». `RUTAS_LEGALES` en
`legal-content.ts` es ahora la única lista de documentos publicados, y el componente calcula
`otros()` filtrándose a sí mismo — añadir un cuarto documento es tocar **un** archivo. Se añadieron
además estilos de `table` y `code` bajo el `::ng-deep` acotado, con las tablas envueltas en un
`div.lg__tabla` con scroll propio: sin él, en un móvil no se desplaza la tabla, se desplaza la
página entera en horizontal.

**Verificado:** `npm run build` prerenderiza **21 rutas** (antes 20) y
`dist/admin_app-v21/browser/eliminacion-datos/index.html` sale con los datos del titular y sin el
aviso de borrador.
