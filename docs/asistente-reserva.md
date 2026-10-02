# El asistente de `reserva`, oficio por oficio

**Estado:** análisis, sin implementar · **Fecha:** 2026-09-29 ·
**Parte de:** [`perfiles-de-reserva.md`](perfiles-de-reserva.md) (los siete oficios) ·
[`mejoras-flujo-agenda.md`](mejoras-flujo-agenda.md) (las tres mejoras de 2026-08-24) ·
**Hermano de:** [`asistente-restaurante.md`](asistente-restaurante.md)

> **El problema, en una frase.** `reserva` pasó de ser una barbería a ser siete oficios, y el
> asistente se quedó en la barbería: pregunta servicio → profesional → día → hora → nombre, que es
> exactamente lo que hacía antes de que existieran los perfiles. En tres oficios ya no solo se
> queda corto: **la cita falla al confirmar**, después de que el cliente dijo que sí.

> **Alcance de este documento.** Cómo debe comportarse el bot en cada oficio. El cobro —abono,
> comprobantes, confirmación de pago— queda **fuera a propósito**: es otra decisión y otro
> documento. Aquí solo se registra qué hace el bot hoy cuando el negocio cobra por adelantado,
> porque hoy lo que hace es caerse (§5.4).

---

## 1. El principio: un flujo, no siete

La tentación es escribir un flujo por oficio. Sería un error, y es exactamente el riesgo que
`perfiles-de-reserva.md` §10 ya anotó para la vertical:

> «Que el perfil degenere en `if (rubro === …)`. Regla de revisión: el código pregunta por
> **capacidades y datos**, nunca por el nombre del perfil.»

El bot hereda esa regla sin cambiarla. **Un solo flujo de citas, con pasos que se encienden según
las funciones que el negocio tiene activas.** Siete FSM serían siete sitios donde arreglar el
mismo fallo, y el octavo oficio costaría lo mismo que el primero.

La consecuencia práctica de escribirlo así: **la barbería queda protegida por construcción**. Con
todas las funciones apagadas —que es el perfil `BASE`— el flujo es, paso por paso, el de hoy.

`ALOJAMIENTO` es la única excepción legítima, y por el mismo motivo por el que `services/estancia/`
es otro motor: no tiene servicios ni profesionales ni horas. Ya tiene su flujo aparte
(`flujoEstancia.js`).

---

## 2. Lo que ya funciona solo, y por qué no hay que tocarlo

Esto es la mitad de la buena noticia. Tres de las capacidades de los perfiles son **transparentes
para el bot**: el motor las resuelve por debajo y el flujo ni se entera.

| Capacidad | Quién la resuelve | Qué ve el bot |
|---|---|---|
| **Tiempo de proceso** (salón) | `composicionCita.componer` calcula los tramos; `calcularSlots` y `holdService` los pasan a `reglasAgenda` | Más horas libres en la lista. Nada más. |
| **Cabinas y equipos** (spa, estética) | `holdService.tomar` aparta la cabina junto al profesional; `calcularSlots` no ofrece horas sin una libre | Menos horas libres. Nada más. |
| **Config del oficio** (anticipación, buffer, paso de 30 min, ventana de cancelación) | `reserva_config`, sembrada desde el perfil | Horas cada 30 min en vez de cada 15. Nada más. |

Que esto ya funcione no es casualidad: `composicionCita` existe precisamente para que los cuatro
sitios que componen una cita —ofrecer horas, apartar, crear, reagendar— no puedan divergir. El bot
entra por esos mismos sitios, así que hereda el trabajo hecho.

**Regla que sale de aquí:** antes de añadir un paso al flujo, comprobar si el motor ya lo resuelve.
Un paso de conversación que pregunta algo que el motor ya sabe es fricción pura.

---

## 3. Lo que sí obliga al bot a hacer algo distinto

Solo cuatro cosas. Y de las cuatro, **solo dos son un paso nuevo de conversación**:

| Qué | Qué es para el bot | Oficios |
|---|---|---|
| **Variantes** | Un **paso nuevo**: ¿largo corto, medio o largo? | Salón (de fábrica), mascotas (de fábrica), y quien la encienda |
| **Mascotas** | Un **paso nuevo**: ¿para cuál de tus mascotas? | Cuidado de mascotas (fija) |
| **A cotizar** | Un **desvío**, no un paso: eso no se agenda por chat | Tatuajes (de fábrica) |
| **Consentimiento** | Un **aviso** al confirmar, no un paso | Estética, tatuajes |

### 3.1 Variantes: va después del servicio y antes de las horas

El orden no es estético: **la variante cambia la duración**, y la duración decide qué horas caben.
Preguntarla después de elegir hora obligaría a recalcular la disponibilidad y a retirar una hora
que el bot ya ofreció.

Solo se pregunta si el servicio elegido **tiene** variantes activas. Un salón con variantes
encendidas pero un servicio sin variantes (el corte de caballero) no pregunta nada.

### 3.2 Mascotas: preguntar la mascota resuelve también la variante

Éste es el hallazgo que simplifica el oficio entero. `reserva_servicio_variante.clave` guarda
`PEQUENO | MEDIANO | GRANDE | GIGANTE`, que son **exactamente** los valores de
`reserva_mascota.tamano`. El modelo lo dice en su propio comentario, y el catálogo de arranque de
mascotas siembra las variantes con esas claves.

O sea: **elegir la mascota fija la variante sola.** El bot pregunta una vez —«¿para cuál?»— y
obtiene dos respuestas. Preguntar el tamaño aparte sería pedirle al cliente un dato que el sistema
ya tiene sobre su propio perro.

Y hay un segundo regalo: el teléfono del cliente ya identifica a su `persona_negocio`, así que
quien vuelve ve **sus mascotas como botones** («Firulais», «Michi») en vez de teclear nada. Quien
llega por primera vez da nombre y tamaño, y `mascotaService.resolverOCrear` la registra.

### 3.3 A cotizar: el bot agenda la valoración, no la sesión

En un tatuador la mayoría de servicios son «a cotizar»: el precio y la duración los fija el artista
después de ver qué quiere el cliente. `citaService.crearCita` **lo prohíbe explícitamente** desde
el portal público, con un mensaje que ya está escrito para un cliente:

> «Ese servicio se cotiza antes de agendarlo. Escríbenos por WhatsApp y te damos precio y fecha.»

Que es, literalmente, lo que el cliente está haciendo cuando habla con el bot. Así que el bot no
puede repetir esa frase: sería mandar a alguien al sitio donde ya está.

**Lo correcto son dos caminos, y el flujo elige según el servicio:**

- **Servicio con precio** (la valoración, el retoque, la perforación): se agenda normal.
- **Servicio a cotizar** (el tatuaje): el bot **no agenda**. Ofrece agendar la valoración —que es el
  primer paso real del oficio— y, si el cliente insiste en la sesión, **pasa la conversación al
  negocio** por la bandeja, que es el mecanismo que ya existe para «esto no lo sé hacer».

Eso no es una limitación del bot: es cómo trabaja un tatuador.

### 3.4 Consentimiento: se avisa, no se firma

Un consentimiento informado se firma en el local, con documento. El bot no lo gestiona y no debe
intentarlo. Lo único que tiene que hacer es **decirlo al confirmar**: «trae tu documento, firmarás
un consentimiento antes de empezar». Una línea en el mensaje de confirmación, condicionada a que el
servicio la pida.

---

## 4. Matriz: qué hace el bot en cada oficio

| Oficio | Pasos del flujo | Idioma | Particular |
|---|---|---|---|
| **Barbería / Consultorio** (`BASE`) | servicio → profesional → día → hora → nombre | Profesional · Servicio · Cita | **Nada cambia.** Es la referencia. |
| **Salón** (`SALON`) | servicio → **variante** → estilista → día → hora → nombre | **Estilista** | El tinte libera a la estilista durante la espera: salen más horas, sin tocar el bot |
| **Spa** (`SPA`) | tratamiento → terapeuta → día → hora → nombre | **Terapeuta · Tratamiento** | La cabina se aparta sola; horas cada 30 min |
| **Estética** (`ESTETICA`) | tratamiento → especialista → día → hora → nombre | **Especialista · Tratamiento** | Aviso de consentimiento al confirmar; empujar la **valoración** primero |
| **Tatuajes** (`TATUAJE`) | Valoración: normal. Sesión: **no agenda**, pasa al artista | **Artista · Sesión** | Enlace al portafolio del artista cuando pregunten por estilos |
| **Mascotas** (`MASCOTAS`) | servicio → **mascota** (fija la variante) → groomer → día → hora | **Groomer** | Quien vuelve ve sus mascotas como botones |
| **Hospedaje** (`ALOJAMIENTO`) | Flujo propio: fechas → personas → tipos con precio → portal | **Reserva · Huésped** | No tiene servicios ni horas. Hoy solo manda el enlace |

---

## 5. Los cuatro desajustes que hoy rompen una cita

Todos verificados en el código, no supuestos. Los tres primeros terminan igual: el cliente eligió
servicio, día y hora, dio su nombre, dijo **sí**, y ahí se cae.

### 5.1 Mascotas: `MASCOTA_REQUERIDA`

`crearCita` exige mascota cuando la función está activa, y el bot nunca la pregunta. **Una
peluquería canina no puede agendar ni una sola cita por WhatsApp hoy.**

### 5.2 Tatuajes: `SERVICIO_A_COTIZAR`

El bot ofrece el servicio con su precio de lista —porque `consultar_servicios` no dice que sea «a
cotizar»— y al confirmar la vertical lo rechaza. Lo peor no es el fallo: es que antes de fallar le
enseñó al cliente un precio que no era.

### 5.3 Variantes: la cita queda con el precio y la duración equivocados

Éste **no falla**, que es lo que lo hace peor. El bot agenda el tinte con el precio y la duración
base; la clienta de pelo largo aparece esperando pagar lo que el bot le dijo y ocupando menos silla
de la que necesita.

Y debajo hay un desajuste **dentro de la propia vertical**, que el bot destaparía en cuanto pase
variantes: `crearCita` las acepta, pero `holdService.tomar` **no** —compone la duración sin ellas—.
El hold apartaría 40 minutos para una cita de 90. Hay que arreglarlo antes.

> **Dato que reduce el riesgo:** `holdService` **solo lo usa el bot**. El portal web no toma holds.
> Extender su firma para aceptar variantes no puede romper a nadie más.

### 5.4 Cobro adelantado: `COMPROBANTE_REQUERIDO` (fuera de alcance, pero hay que saberlo)

El bot crea la cita como si fuera el portal público, así que si el negocio pide abono —spa,
estética y tatuajes lo traen **de fábrica**— la confirmación falla pidiendo un comprobante que por
WhatsApp nadie puede adjuntar. Le pasa igual a cualquier barbería con cobro adelantado.

Decidir qué hace el bot ahí es harina de otro costal y queda para después. Lo que no puede quedarse
es el estado actual: **caerse después del sí.** Como mínimo, el bot tiene que reconocer la
situación y decir algo cierto en vez de un error técnico.

> Nota para esa decisión futura: la vertical ya tiene el concepto de **usuario asistente** por
> negocio (`auditActor.fijarActorAsistente`, usado al cancelar y al reagendar), pero `crearCita` no
> lo usa. Ahí está la costura por la que esto se resuelve sin inventar nada.

---

## 6. El idioma del oficio

El bot dice «cita», «profesional» y «servicio» en los siete oficios. En un spa hay que decir
**tratamiento** y **terapeuta**; en un tatuador, **sesión** y **artista**; en una peluquería canina,
**groomer**.

No es cosmética: `perfiles-de-reserva.md` §2.5 ya decidió que los términos se aplican **donde el
cliente final lee primero**, y nombra explícitamente «los mensajes de WhatsApp». El bot es el único
sitio de esa lista que todavía no cumple.

`contextoNegocio` ya lee `perfil_reserva` del negocio y no hace nada con él. El diccionario son
cinco palabras y ya existe en `perfiles/definiciones.js`. **Es el cambio con mejor relación entre
esfuerzo y cuánto se nota.**

---

## 7. Lo transversal: tres cosas que valen para los siete oficios

Salen de mirar qué le preguntan de verdad a un negocio por WhatsApp.

### 7.1 Los datos del negocio — lo más preguntado, y hoy no lo sabe

«¿Dónde quedan?», «¿a qué hora abren?», «¿abren el domingo?». El bot contesta que no lo sabe.

`contextoNegocio.leerAtencion()` devuelve `null` **siempre**, y su comentario explica por qué se
descartaron los dos atajos: leer `reserva_horario` desde el núcleo rompería ADR-005, y una capacidad
`consultar_horario` contradice ADR-020 (el horario es configuración, va en el prefijo del prompt).

**Las dos objeciones son correctas y ninguna aplica a un adaptador.** El acoplamiento con el
esquema de una vertical vive en su adaptador — es literalmente para lo que existe. Y ahí está el
dato: las filas de `reserva_horario` con `id_profesional NULL` son el horario **del negocio**, no el
de una persona; `vitrinaService.horarioEfectivo` ya las usa así para la página pública.

Dirección, teléfono y redes ya están en `gener_negocio`. Esto es barato y se nota en el primer
mensaje.

### 7.2 «Mis citas» — quita el «dime el código»

Hoy el bot solo puede tocar citas cuyo código conoce **de esa misma conversación**. Quien vuelve al
día siguiente tiene que dictar un código.

Lo que bloqueaba esto ya no bloquea: `reserva_cita.id_persona_negocio` existe desde el 2026-09-09, y
el teléfono verificado del canal identifica a la persona. Con eso, el bot enseña las citas del
cliente **como botones** y cancelar o mover deja de necesitar que nadie dicte nada.

Beneficio secundario que no es menor: hoy «cancela mi cita» se va al **modelo** (cuesta dinero)
porque la FSM no sabe hacerlo. Con esto lo resuelve el Nivel 1, gratis.

### 7.3 Fechas de persona

El bot entiende «hoy», «mañana» y `2026-08-20`. No entiende «el viernes», «el 15» ni «pasado
mañana» — y esas son las tres formas en que la gente escribe una fecha.

Hoy eso cae al modelo. Es de las cosas que un puñado de reglas resuelve mejor y gratis, sin entrar
en el terreno donde adivinar sale caro.

---

## 8. Dónde vive cada cosa

Un detalle de arquitectura que conviene arreglar de paso. El flujo de citas vive en
`engine/manejadorDeterminista.js` —el **núcleo**— y sabe qué es un servicio y qué es un
profesional. Su propia cabecera lo reconoce: *«sigue viviendo aquí por historia —era el único que
había»*.

Eso contradice ADR-009: el conocimiento de dominio va en el adaptador. Y estorba justo ahora, porque
todo lo de este documento es conocimiento de `reserva`: variantes, mascotas, cotizaciones, términos.
Meterlo en el núcleo haría que el núcleo supiera de peluquerías caninas.

**Propuesta:** mover el flujo a `adapters/reserva/flujoCita.js` junto a `flujoEstancia.js`, dejando
en `engine/` lo genérico (leer «sí», retroceder, reintentar, la memoria de la conversación). Es un
movimiento mecánico, con los tests delante, y mejor hacerlo **antes** de añadirle pasos que después
habría que mover.

---

## 9. Orden propuesto

| | Qué | Por qué en ese orden | Abre |
|---|---|---|---|
| **A** | Mover el flujo al adaptador. Sin cambios de comportamiento, con los tests actuales de guardia | Todo lo demás se apoya aquí | nada visible |
| **B** | **Lo que hoy se cae:** variantes (con el arreglo de `holdService`), mascota, a cotizar | Tres oficios pasan de «falla al confirmar» a funcionar | **Mascotas, Tatuajes, Salón correcto** |
| **C** | Idioma del oficio + aviso de consentimiento | Cambio pequeño, se nota en cada mensaje | los siete |
| **D** | Datos del negocio (horario, dirección) | Lo más preguntado | los siete |
| **E** | «Mis citas» por teléfono | Quita el dictado de códigos y deja de pagar modelo | los siete |
| **F** | Fechas de persona | Mejora la comprensión sin tocar el flujo | los siete |
| **G** | Hospedaje: fechas y precio real en vez de solo el enlace | Es otro motor; conviene tenerlo con un cliente real delante | Hospedaje |

**B es lo urgente**: es la diferencia entre un oficio que se puede vender y uno que no. Una
peluquería canina con el bot conectado hoy no agenda ni una cita.

---

## 10. Lo que queda por decidir

1. **Cobro adelantado (§5.4).** Fuera del alcance de hoy, pero el bot no puede seguir cayéndose
   después del sí. Aunque sea, que lo diga bien.
2. **Productos.** Los siete oficios pueden vender productos desde el 2026-09-28 y el bot no lo sabe.
   ¿Informa y manda al portal, o toma el pedido como en restaurante?
3. **Estética y la valoración.** ¿El bot empuja siempre a la valoración cuando piden un tratamiento
   fuerte, o agenda lo que le pidan?
4. **Hospedaje.** ¿Hasta dónde llega el chat antes de mandar al portal? Conviene decidirlo con un
   alojamiento real usándolo, no antes.

---

## 11. Verificación (cuando se implemente)

- **La barbería no se mueve.** Igual que `motor_dorado.test.js` congela el motor, el flujo `BASE`
  tiene que quedar congelado: misma secuencia de pasos, mismos textos. Si cambia, falla.
- **Una conversación de extremo a extremo por oficio**, sobre los fixtures de perfiles que ya
  existen. Es lo que hoy no hay: `e2e_agendar.test.js` prueba la barbería y nada más.
- **El flujo no nombra perfiles.** Un grep en las pruebas: si aparece `'SALON'` o `'MASCOTAS'` fuera
  del registro de perfiles, la regla de §1 ya se rompió.

---

## 12. Flujo guiado por menús (implementado 2026-09-29)

Pedido del negocio: que el cliente **no tenga que escribir**, solo pulsar.

1. **El primer mensaje siempre lo atiende la FSM.** Regla `apertura` en `model/orquestador.js`:
   el flujo de reserva se registra con `abreConversacion: true` (`flujos.abreLaConversacion`) y la
   escalera marca `primerMensaje` cuando `variables.turnos` está en cero y no hay tarea. Antes, un
   «buenas, ¿cuánto vale un corte?» iba al modelo y conversaba sin ofrecer los servicios. El
   restaurante no lo declara y sigue igual.
2. **Saludo + tipos o servicios.** Con más de 8 servicios (`UMBRAL_CATEGORIAS`) y al menos dos
   categorías, primero las categorías (los servicios sin categoría van en «Otros»); si no, la lista
   de servicios. Las listas se paginan con «Ver más» para no pasar de las 10 filas de WhatsApp.
   Dentro de una categoría hay una fila `← Otro tipo` («Elegir otro tipo de servicio»).
3. **Servicio → día → hora → nombre → profesional → resumen.** El nombre solo se pregunta si no se
   conoce (memoria de la conversación o ficha del cliente) y se guarda en cuanto se da. El
   profesional se elige **después** de la hora y solo entre quienes la tienen libre
   (`consultar_disponibilidad` devuelve `id_profesionales` por hora); con uno solo, no se pregunta.
4. **Resumen con todos los datos y dos botones: «Sí» / «No».** «No» vuelve a las horas del día.

Tareas abiertas con el orden anterior (profesional antes que el día) siguen funcionando: sin hora
guardada, elegir profesional lleva al día como antes.

---

## 13. Menos mensajes por cita (implementado 2026-10-02)

> **Lo que lo obliga.** Desde el 1 de octubre de 2026 Meta cobra los mensajes de servicio pasada una
> asignación de 1.000 por número y mes (ver [`whatsapp-costo-mensajes.md`](whatsapp-costo-mensajes.md)).
> El flujo de §12 estaba diseñado cuando contestar era gratis: partía los menús sin pensarlo porque
> partirlos no costaba nada. Medido sobre el catálogo real de D'ALEX —17 servicios en 4 categorías,
> 10 profesionales, 09:00 a 19:00 cada 30 min— una cita costaba **9 o 10 mensajes**.
>
> Ahora cuesta **6 por el camino del menú y 3 si el cliente escribe lo que quiere.**

### 13.1 El atajo: no tirar lo que el cliente acaba de escribir

El agujero más grande no eran los menús: era que **el contenido del primer mensaje se descartaba**.
`ofrecerServicios` no miraba `ctx.texto`, así que «quiero un corte de cabello mañana a las 10» recibía
el menú de categorías y las cuatro cosas dichas se perdían.

Y los lectores ya existían, todos gratis: `resolverServicio`, `interpretarFecha` (que desde el
2026-09-29 entiende «el viernes» y «el 15»), `resolverHora`. Solo no se usaban sobre el primer mensaje.

`intentarAtajo` llena los huecos en el orden del flujo —servicio → variante → día → hora— y para en el
primero que no resuelve; lo que falte lo pregunta el paso de siempre. **El peor caso del atajo es el
comportamiento de antes.** Tres reglas lo hacen seguro:

1. **Cada dato se exige explícito.** `servicioEnElTexto` no acepta números y exige que no haya empate
   (gana el nombre más largo: «Corte y barba» no es «Corte»); `interpretarFecha` recibe
   `diaSueltoVale: false`, porque un «2» suelto es cualquier cosa menos el día 2.
2. **Nunca se auto-confirma.** El atajo acaba, como el menú, en el resumen con Sí / No. Un dato leído
   mal cuesta un «No», no una cita equivocada.
3. **Se dice lo que se entendió** («Anoto *Corte de cabello*.»), pegado al mensaje siguiente, para que
   el malentendido se cace en el primer mensaje y no en el resumen.

Un saludo o un «menú» pedido a mano **no** pasan por el atajo: el primero no tiene nada que
aprovechar y el segundo está pidiendo justamente la lista.

### 13.2 Menú desplegable o listado enumerado, según cuántas opciones haya

La pregunta que lo abrió: *«cuando hay muchos servicios u horarios, ¿no es mejor listarlos todos en
un mensaje?»*. Sí, en el tramo de en medio, y la regla es `seEnumera`:

| Filas | Forma | Por qué |
|---|---|---|
| ≤ 10 | lista interactiva | La mejor del canal: un toque, sin escribir. Nada cambia |
| ≤ 24 | **un mensaje enumerado** | Antes eran dos o tres menús. El cliente ve todo de una vez |
| > 24 | se agrupa (tipos, jornadas) | Veinticinco líneas no se leen; ahí partir sí ayuda |

El tope son 24 porque es lo que mide un día entero de media en horas (8 a 20 cada media hora): que la
cota la fije el caso real más largo evita que el día más ocupado sea justo el que vuelve a partirse.

Consecuencias en D'ALEX: los 17 servicios caben en un mensaje, así que **el paso de categorías
desaparece** (`UMBRAL_CATEGORIAS` pasó de 8 a `MAX_LISTADO - 1`); las 19 horas de un día caben, así que
**el paso de la jornada desaparece**; y los 10 profesionales se enseñan todos — antes se recortaban a
8 y dos quedaban invisibles sin que nadie lo supiera.

⚠️ **El número lo pone el núcleo, no el canal.** Es el asa con la que vuelve la respuesta: si cada
canal numerara a su manera, «3» querría decir una cosa en WhatsApp y otra en el WebChat. Viaja en la
opción (`atajo`, aditivo como `detalle`, ADR-017) y se traduce **una sola vez**, en la entrada del
manejador, así que ningún resolvedor ni el retroceso saben que existe la numeración.

Y la numeración **está atada al paso que preguntó** (`atajos_de`). Sin eso se heredaría —los pasos se
escriben con `{ ...datos, paso: otro }`— y un «3» contestado al paso de la fecha se habría traducido al
tercer servicio de un menú de cuatro mensajes antes.

### 13.3 El nombre ya venía en el webhook

Cada webhook de Meta trae `contacts[].profile.name` y se tiraba, así que el bot preguntaba «¿a nombre
de quién?» a alguien cuyo nombre tenía delante: un mensaje por cada cliente nuevo.

Es una **pista, no un hecho** —lo escribe el cliente en su teléfono y puede ser «Mamá»—, así que:

- viaja en `crudo` (lo que dijo el canal), no como un dato del núcleo;
- `identidad.resolver` lo pone **último**: lo dicho en esta conversación manda sobre la ficha del
  negocio, y la ficha sobre el perfil, con `nombreEsPista` para quien lo consuma;
- un perfil que no sirve como nombre («🔥») se trata como si no hubiera (`nombreLegible`);
- **no se guarda en `variables.nombre` hasta confirmar**: guardarlo lo convertiría en «lo que dijo» y
  le quitaría para siempre la oportunidad de corregirlo;
- y el resumen ofrece una tercera opción, «Otro nombre», que pide el nombre **sin volver a apartar la
  hora** (el resumen se repinta desde `datos.propuesta`). Cero mensajes de más para el 95 %, uno para
  quien lo quiera corregir.

### 13.4 Dos mensajes que podían ser uno

`unirRespuestas`, en `conRastro`, junta hacia delante lo que cabe: el aviso + la pregunta, el saludo +
el menú, el aviso de consentimiento + el resumen. Una respuesta **con** opciones no absorbe a la
siguiente, porque el menú tiene que quedar al final. Afecta a `sinAgenda`, `cederAlNegocio`,
`horaRechazada`, el consentimiento y el aviso de tarea caducada.

### 13.5 El horario y la dirección, por fin

`contextoNegocio.leerAtencion()` devolvía `null` siempre, y la nota que había ahí descartaba los dos
atajos con razón: leer `reserva_horario` desde el núcleo rompe ADR-005, y una capacidad
`consultar_horario` contradice ADR-020. **Ninguna de las dos objeciones aplica a un adaptador**, que es
donde vive ese acoplamiento.

Así que el núcleo pone una costura (`registrarProveedor`) y `adapters/reserva/contexto.js` la llena
leyendo las filas con `id_profesional IS NULL`, que son el horario del negocio y no el de una persona
—la misma distinción que hace `vitrinaService.horarioEfectivo` para la web, y conviene que digan lo
mismo—. Dirección y teléfono salían de `gener_negocio`, en la fila que ya se leía; nadie los pedía.

Van al **prefijo estable** del prompt, que es lo que los hace casi gratis, con la frase que impide que
el modelo rellene el hueco: *«ése es el horario completo y es el único que conoces»*. Antes, «¿a qué
hora abren?» se pagaba al modelo **y** se contestaba que no se sabía.

### 13.6 El bug que estaba delante del cliente

El servicio 26 de D'ALEX («Tatuajes», `precio = 0`, `a_cotizar = false`) se ofrecía como
**«30 min — $0»**: el bot prometía un tatuaje gratis y lo desmentía el mostrador. `formatearPrecio`
solo protegía `null`. Ahora cero no es un precio (`seCotiza`): sale «precio a convenir», y el resumen
omite la línea del precio en vez de escribir `$0`.

### 13.7 `consultar_mis_citas`, por fin (y lo que obligó a tocar con ella)

Era §7.2 y el punto E de §9: lo más valioso que quedaba. **Ya existe.**

La capacidad devuelve las citas próximas y vivas de quien escribe, con su código, y su descripción
le dice al modelo lo único que importa: **nunca pidas el código, sácalo de aquí**. Antes, «cancélame
la cita del martes» acababa en un «dime el código de tu cita» sobre un código que nadie guarda, y el
cliente llamaba por teléfono.

**Dos formas de reconocer al cliente, y hacen falta las dos.** `id_persona_negocio` (desde el
2026-09-09) cubre a quien ya era persona del negocio; el **teléfono** cubre las citas que el negocio
apuntó a mano desde el panel, que son muchas y pueden no tener persona asociada. Con solo la primera,
media agenda real quedaría invisible.

Y el teléfono se compara por sus **últimos diez dígitos**, porque en la base conviven
`3001234567`, `+573001234567` y `57 300 123 4567` según quién creó la cita. Comparar las cadenas tal
cual dejaba fuera a casi todas.

> ⚠️ **El desajuste que esto habría creado, y que se cerró con ella.** `buscarCitaPorCodigo`
> comprobaba la pertenencia **solo** por `cliente_telefono` normalizado a E.164. O sea que la
> capacidad nueva habría listado citas que `cancelar_cita` después rechazaba: el bot diciendo
> «tienes una cita el sábado» y, al pedir anularla, «no puedo comprobar que sea tuya». Peor que no
> tener la función.
>
> Las dos preguntas —qué citas **enseñar** y qué citas se pueden **tocar**— viven ahora en una sola
> función, `esDeQuienPide`, con las tres pruebas (persona, E.164, últimos diez dígitos). Sigue
> fallando **cerrada**: sin teléfono probado por el canal no hay ninguna prueba que valer. Nunca
> contra `args.cliente_telefono` ni contra las variables de la conversación, que los rellena el
> modelo o el propio cliente.

**Y «¿qué citas tengo?» se contesta gratis.** Esa pregunta caía en `intencion_agendar` —la palabra
«cita» está en las dos cosas— y el cliente recibía el menú de servicios. Ahora la resuelve el Nivel 1
con la lista, en un mensaje, sin un token: no hay nada que redactar.

Se exigen **dos señales**, como en el retroceso: un posesivo («mi», «mis», «tengo») y la palabra cita.
Más una exclusión para el caso que las dos señales no separan — «quiero reservar mi turno» tiene las
dos y es alguien que viene a agendar—, que se descarta cuando hay intención explícita de pedir algo
nuevo **salvo** que además pregunte o quiera anular: «quiero ver mis citas» y «quiero cancelar mi
cita» son las dos cosas a la vez, y en las dos la lista es la respuesta útil.

Verificado contra la base de producción: el SQL devuelve las dos citas reales del `3188887013` en
D'ALEX y el mensaje sale en uno, con el día y la hora y **sin el código**, que a nadie le dice nada y
ocupa la línea que debería decir «el sábado a las 2:30».

### 13.8 Lo que sigue sin hacer

- **Cancelar y mover siguen yendo al modelo.** Es correcto —«muéveme la del sábado a las 5» es
  conversación, no un formulario— y ahora funciona de verdad, porque el modelo tiene la lista. Lo que
  no hay es un flujo de Nivel 1 para anular, y mientras cancelar sea raro comparado con agendar, no
  lo merece.
- **`e2e_agendar.test.js` no se pudo correr** (necesita Postgres). Lo cubierto es
  `manejadorDeterminista.test.js`, que corre sin base y pasó de 74 a 103 pruebas, más
  `cuota_whatsapp.test.js`.
- **`LLM_MODELO` sigue sin fijar en el `.env` de producción.** Hoy corre `gpt-5.6-terra` porque solo
  hay `OPENAI_API_KEY`, pero el respaldo del código es `claude-opus-5`: el día que alguien ponga una
  clave de Anthropic ahí, la factura se multiplica en silencio.
- **El idioma del oficio** (§6) ya estaba; el punto G de §9 (hospedaje) sigue pendiente.
