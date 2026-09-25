# El asistente en un restaurante, y el pedido desde el menú digital

**Estado al 2026-08-27:** en producción, atendiendo `Restaurante pregonchos` (`id_negocio` 12) en
el número `+57 315 281 2484`. Cuatro capacidades, flujo propio y el pedido armado desde la carta.

---

## Por qué existe esta vertical

Los dos clientes activos de producción —`6` ZONA BURGER y `14` LA ESQUINA DEL BARRIL— son
**restaurantes**, y hasta el 2026-08-24 el asistente solo sabía agendar citas. Conectarles el
número les habría dado un bot que ofrece cortes de pelo.

Lo que **no** hizo falta tocar: Policy Gate, Registry, Ledger, canal, ventana de 24 h,
confirmación humana, escalera de niveles. Todo eso es transversal y funcionó tal cual. Añadir una
vertical costó un adaptador y un flujo — que es exactamente lo que ADR-009 perseguía y hasta hoy
no se había podido comprobar con una segunda vertical.

---

## Las cuatro capacidades

| Capacidad | Tipo | Qué hace |
|---|---|---|
| `consultar_carta` | consulta | Los productos con su precio; acotable a una categoría |
| `buscar_producto` | consulta | Por nombre («¿tienen hamburguesa doble?») |
| `consultar_estado_pedido` | consulta | En qué va un pedido, por su número |
| `tomar_pedido` | **mutación** | Crea la orden a domicilio |

### Se usan las consultas PÚBLICAS de `cartaService`, no las de administración

Filtran por `visible` **además** de por `disponible`, y son dos cosas distintas: lo primero es lo
que el negocio oculta a propósito (el menú del personal), lo segundo lo que hoy está agotado. El
segundo filtro es el que siempre se olvida, y un bot que ofrece algo agotado hace quedar mal al
negocio con su cliente. Hay una prueba que falla si alguien las cambia por las de admin.

### `consultar_estado_pedido` comprueba de quién es el pedido

Por el mismo motivo que `cancelar_cita` —y aquí es **más** urgente: el número de orden es corto y
secuencial (`ORD-12`), así que recorrerlo **sí** es una estrategia. Sin la comprobación, cualquiera
leería el teléfono y el total de los pedidos ajenos.

Falla cerrada: sin teléfono probado (WebChat) o sin teléfono en el pedido (uno de mesa), se
deniega.

---

## Los tres obstáculos de `tomar_pedido`, y cómo se resolvieron

No eran prudencia genérica. Salieron de leer `pedidoService.crearOrden`.

### 1. No aceptaba una transacción externa

Abría la suya con `Models.sequelize.transaction()`. El Policy Gate envuelve **toda** ejecución en
una transacción propia para que el `dry-run` sea genérico y no algo que cada capacidad deba
implementar (y olvidar). Con una transacción anidada dentro, ni el dry-run deshacía nada ni el
rollback del Gate alcanzaba a la orden.

`reserva` no lo sufría porque **F3 ya lo había resuelto allí**: `citaService.crearCita` sí recibe
`{ transaction }`. Era el punto 2 del Contrato de Adopción, pendiente en esta vertical.

Resuelto: `crearOrden` y `getOrdenById` aceptan `{ transaction }`. **Quien la abre, la cierra** —
si viene de fuera, esta función no confirma ni deshace. El POS llama sin opciones y se comporta
exactamente igual que antes.

> Detalle que costó encontrar: con transacción ajena **sin confirmar**, releer la orden recién
> creada desde fuera de ella no la encuentra. Por eso `getOrdenById` recibe la transacción.

### 2. Exige caja abierta

Una orden no existe fuera de un turno de caja. Es una regla correcta que hay que **respetar, no
rodear** — pero significa que quien escriba a las 3 de la mañana no puede pedir.

Se comprueba con `requireCajaAbierta` (no `getCajaAbierta`): es la que acepta transacción **y toma
el lock**, de modo que la caja no pueda cerrarse entre la comprobación y la creación. Su error se
traduce a uno que un cliente entienda — el original habla de turnos de caja, que no significa nada
para quien quiere una hamburguesa.

### 3. `pedid_orden.id_usuario` es NOT NULL

Comprobado contra el esquema, no supuesto. Una orden la toma siempre alguien del negocio, y un
pedido de WhatsApp no tiene empleado detrás.

**Decisión (2026-08-24): un usuario «Asistente» por negocio** (`app_core/dao/usuarioAsistenteDao.js`),
no el administrador. El motivo es medible, no estético: `reporteService` tiene un informe de
**ventas por usuario** que agrupa por `o.id_usuario`. Con el administrador, sus cifras quedarían
infladas por cada pedido del bot y ese informe dejaría de ser cierto. Con uno propio, el dueño ve
una fila «Asistente — 34 pedidos — $1.2M», que es justo lo que quiere saber.

Se crea **sin rol** y con contraseña aleatoria que no se guarda en ninguna parte: no puede iniciar
sesión ni hacer nada aunque alguien lo intentara.

### El precio sale del catálogo, nunca de la conversación

`tomar_pedido` relee los productos y toma de ahí el `precio_unitario`. Si viniera del modelo, un
pedido podría cobrarse a lo que el bot recordara de hace veinte turnos, y esa diferencia se
descubre **en la puerta del cliente, con el domiciliario delante**.

> ⚠️ La primera tanda de pruebas **no cazaba esto**: se rompió el código a propósito y los 17
> tests siguieron en verde. Hubo que añadir una prueba que mete un precio falso en la petición y
> comprueba que en la base quedó el del catálogo. Sin el ejercicio de romper, se habría entregado
> una protección que nadie vigilaba.

---

## El flujo de restaurante

Vive en `intelligence/adapters/restaurante/flujo.js` — **en el adaptador, no en el motor**, porque
un flujo conversacional sabe que existen categorías y productos, y eso es dominio.

Es corto a propósito. El de `reserva` es una máquina de estados larga porque agendar **es** un
formulario: servicio, profesional, día, hora, nombre. Pedir comida no se parece: «dos bandejas,
una sin chicharrón, y una limonada sin azúcar» es una frase, no cinco pulsaciones. Un menú rígido
convierte un pedido de tres cosas en doce mensajes y sigue sin entender «sin cebolla».

Así que el flujo hace **solo lo que un guion hace mejor que un modelo**: recibir, enseñar el
enlace del menú y poner delante los platos que más piden **con su precio** — una lectura de
tabla, no una conversación. En cuanto el cliente elige pedir por chat, **se aparta y
no deja tarea abierta**, y el comodín de la política de enrutado (`pregunta_libre` → Nivel 4) manda
el resto al modelo. Es literalmente para lo que existe la escalera de ADR-018.

### Detalles del canal que costaron una iteración cada uno

- **Un botón de WhatsApp no abre una URL**: devuelve un id al bot. El enlace del menú va **en el
  texto**, donde WhatsApp lo hace pulsable solo. Como opción costaba un turno de ida y vuelta.
- **Con `detalle`, el canal pinta una LISTA**; sin él y con pocas opciones, botones
  (`adaptador.js`: `<= LIMITES.botones && !conDetalle`). Una lista de una sola entrada obliga a
  desplegar un menú para pulsar lo único que hay dentro.
- **La carta la pinta el flujo, no el modelo.** Leer una tabla no merece un turno de modelo.
  Hasta el 2026-08-26 lo que pintaba eran las **categorías**, para que el modelo no se
  inventara un id; ahora pinta productos con precio, que además quita la ronda entera (ver
  «Que no suene a bot»).

---

## Domicilio o recoger, y el filtro del despacho (2026-09-07)

Del dueño, ese día: «en mi municipio, o al menos nuestra familia, suele hacer pedidos para ir a
recoger, para no gastar el valor del domicilio».

Hasta entonces el asistente **daba por hecho que todo pedido era un domicilio**. No es que lo
prefiriera: `tipoPedido: 'DOMICILIO'` estaba escrito a fuego dentro de `tomar_pedido`, y el flujo
pedía la dirección siempre. Un cliente que iba a pasar por el local tenía que dar su casa para
que nadie fuera a ella.

### El paso nuevo, y por qué va donde va

Entre el nombre y todo lo demás:

```
nombre → ENTREGA → (teléfono + dirección | teléfono)
```

Va **antes** que la dirección porque es la respuesta que decide si la dirección hace falta, y no
puede ir dentro de la pregunta combinada por lo mismo: preguntarla junto a la dirección obligaría
a pedir la dirección sin saber todavía si sobra.

El teléfono se sigue pidiendo a quien llegó sin número, pero **el motivo cambia y el texto
también**: en un domicilio es para que el domiciliario llame desde la puerta; para recoger es
para poder avisarle cuando esté listo. Es un `MOTIVO_DEL_TELEFONO` de dos entradas, no una frase
genérica que valga para las dos y no signifique nada en ninguna.

### Se pregunta con BOTONES (2026-09-08)

La primera versión pedía escribir *domicilio* o *recoger*. Funciona, pero es pedirle a alguien
que teclee lo único de esta conversación donde equivocarse cuesta comida. Ahora van **dos
botones** —*A domicilio 🛵* / *Paso a recogerlo 🛍️*—, sin `detalle` para que el canal los pinte
como botones y no como una lista que hay que desplegar.

Lo que llega de vuelta por el webhook es el **id**, no la etiqueta, así que `leerEntrega`
reconoce las dos cosas: el id de quien pulsa y las palabras de quien escribe. **Los dos caminos
siguen abiertos a propósito**, y no por prudencia genérica: el botón no viaja si alguien reenvía
el mensaje o responde citándolo, y un canal sin botones solo recibe texto. Por eso las dos
palabras siguen escritas en el mensaje aunque haya botones.

### La palabra que significa las dos cosas

`leerEntrega` es la única lectura de todo el flujo donde equivocarse **cuesta comida**: leerlo al
revés manda una moto a una dirección que nadie dio, o deja a alguien esperando en el mostrador un
pedido que salió hace veinte minutos. Los demás pasos, mal leídos, dejan un dato feo; éste, no.

Y tiene una trampa idiomática de verdad: **«llevar» significa las dos cosas**. «Para llevar» es
como se pide en el mostrador y quiere decir que pasa por él; «me lo llevan» quiere decir justo lo
contrario. Así que:

- la **frase** «para llevar» se acepta y vale por *recoger*;
- la **palabra suelta** «llevar» **no decide**: se repregunta;
- si aparecen las dos familias de palabras a la vez, o ninguna, tampoco: se repregunta.

**No hay valor por defecto en ninguna capa.** Ni en el flujo ni en la capacidad, donde
`tipo_entrega` es un `enum` **obligatorio**. La tentación era que ausente significara domicilio
—hasta hoy todo lo era, y así ninguna llamada vieja se rompe—, pero un valor por defecto ahí es
un domiciliario saliendo a una dirección que nadie dio cada vez que el modelo olvide preguntar.
Que lo rechace el Gate y el modelo pregunte cuesta un turno.

`direccion` pasó a `requerido: false`, y la regla «obligatoria solo si es domicilio» la comprueba
`ejecutar`, que es quien ve los dos argumentos a la vez: `argumentos.js` mira uno cada vez y no
sabe expresar una condición entre dos.

> El nombre interno de la tarea **sigue siendo `pedido_domicilio`** aunque ya no sea solo eso.
> Ese valor está guardado en `tarea_actual` de las conversaciones abiertas: renombrarlo dejaría a
> quien esté a mitad de un pedido con una tarea que ningún manejador reclama. Un nombre impreciso
> cuesta menos.

### La confirmación enumera lo que se pidió (2026-09-08)

«¿Confirmo tu pedido de 2 productos?» es abstracto: el cliente **no puede comprobar que sea el
suyo**, que es lo único que esa frase tiene que dejarle hacer. Ahora dice:

```
¿Confirmo tu pedido a nombre de Ana, para recogerlo en el local?

• 2 × Hamburguesa clásica — $36.000
• 1 × Limonada de coco — $9.000

Total: $45.000
El total es aproximado: puede variar por desechables.
```

**Los productos y el total se releen del catálogo**, por lo mismo que los relee `ejecutar`: si la
frase en la que el cliente se compromete dijera un precio que no es el que se le va a cobrar,
la confirmación estaría certificando una cifra falsa — peor que no enseñar ninguna.

Eso obligó a que **`confirmacion.pregunta` pueda ser asíncrona**: la redacción de la pregunta
ahora hace E/S. Y por eso mismo se blindó: cualquier fallo —la consulta caída, un `id_producto`
que llega como cadena, un producto que ya no está en la carta— cae al `catch` y se contesta con
la frase de siempre, la del recuento. Se degrada **el detalle, nunca la confirmación**, que es lo
que ADR-010 no negocia. Ya costó un turno mudo en producción el 2026-08-27 por no tener ese
blindaje.

Si un producto del pedido ya no aparece en la carta se cae al recuento **entero**, no se enumeran
los que sí están: un pedido de tres líneas confirmado con dos es peor que uno sin detalle.

#### El aviso de que el total es aproximado

Pedido por el dueño el 2026-09-08, y no es un formalismo: quien ve «$45.000» y paga $48.000 en la
puerta siente que le cobraron de más, aunque los desechables siempre se hayan cobrado.

El domicilio **solo se nombra cuando lo hay** — avisar de un recargo imposible a quien va a pasar
por el local es ruido que le resta credibilidad al resto del mensaje. En la **carta digital** se
nombran los dos, porque allí todavía no se ha elegido cómo se recibe el pedido.

### El filtro de WhatsApp en el despacho

Un chip más al lado de «Todos / Para llevar / Domicilio», con su contador. **No es una pestaña
aparte**: LLEVAR y DOMICILIO filtran por el *tipo* de pedido y WhatsApp por su *origen*, así que
se cruzan — un pedido del bot es además de uno de los dos tipos y aparece en los dos sitios.

`getOrdenesDespacho` devuelve ahora `de_whatsapp` por orden, y **no hay columna nueva**: se deduce
de `id_usuario`, porque los pedidos del bot ya nacen a nombre del usuario «Asistente» del negocio
(`usuarioAsistenteDao`, que existe desde el 2026-08-24 para que el informe de ventas por usuario
diga la verdad). Una columna `origen` sería una segunda verdad sobre lo mismo, que hay que
rellenar en cada sitio que cree una orden y que se queda callada el día que alguien lo olvide. El
día que haga falta separar el chat del menú digital —hoy los dos entran por el bot— sí hará falta
el dato aparte; ese día se añade, con un motivo.

Dos detalles de la pantalla que no son adorno:

- El chip **solo aparece si hay alguno**. Un «(0)» permanente en un restaurante que no usa el
  asistente es ruido en la única barra que se mira con prisa.
- Y si se despacha el último, el chip desaparece **y el filtro vuelve a «Todos»**: sin eso la
  pantalla se queda vacía con un filtro puesto en algo que ya no se ve, o sea sin manera de
  volver.

### El botón «avisar que está listo»

`POST /restaurante/despacho/:id/avisar-listo`. Lo aprieta quien vigila el despacho y al cliente le
llega, literalmente:

> Hola Nicolás, tu pedido ORD-0042 de Pregonchos ya está listo y puedes pasar a recogerlo.
> Si necesitas algo, respóndenos a este mensaje.

**Lo que NO necesita es la pantalla de cocina**, y ahí está lo bueno del diseño. Un pedido del bot
nunca entra al KDS (`crearOrden` no toca `estado_cocina`, ver «Lo que queda pendiente»), así que no
existe ningún momento automático de «está listo» del que colgar un aviso. Como aquí lo dispara una
persona que está mirando, el problema abierto deja de estorbar en vez de haber que resolverlo
antes.

#### Por qué es una plantilla

Entre que alguien pide y el pedido está listo pasan treinta o cuarenta minutos; en un restaurante
lleno, dos horas. La ventana de 24 h **suele** seguir abierta, pero *suele* no es una garantía
sobre la que construir un botón. Con plantilla, el mensaje sale igual el día que se cierre.

La plantilla es `pedido_listo` [es] `UTILITY`, y hay dos detalles del contrato con Meta metidos en
su texto: **no termina en variable** (una plantilla cuyo último carácter es un hueco se rechaza) y
la frase de cierre invita a responder, porque esa respuesta reabre la ventana de 24 h y deja que el
bot siga atendiendo.

> ⚠️ **Antes de que esto sirva en producción hay que crearla en WhatsApp Manager**, con el nombre,
> el idioma y el texto **idénticos** a los de `intelligence/core/plantillas.js`. Una plantilla no se
> puede enviar ni una vez antes de que Meta apruebe su texto. Mientras no exista, el botón deja el
> saliente en `pendiente` y la entrega falla — que es, de paso, el **video 2 del App Review**: hay
> que grabar la creación de una plantilla, y ésta hace falta de todos modos
> ([`meta-app-review.md`](meta-app-review.md) §3).

#### Solo para recoger, y solo con conversación

Tres condiciones, y ninguna es cosmética:

- **`de_whatsapp`** — hace falta una conversación a la que escribir.
- **`LLEVAR`** — a un domicilio lo que le llega es el domiciliario, no un aviso. El «va en camino»
  será **otra plantilla** el día que alguien la pida, no ésta con otro texto.
- **sin avisar todavía**.

Y dos negativas que son de política, no de programa: si no existe conversación se rechaza —escribir
a un número que apareció en una casilla no es lo mismo que contestarle a quien nos escribió, y
estrenar un hilo desde un botón es justo lo que no se hace—, y a quien pidió la baja no se le
escribe **ni siquiera algo que le interesa**.

#### «Se intentó» no es «llegó» (2026-09-08)

El primer aviso real de producción **quedó marcado como hecho y nunca llegó**. La Cloud API
contestó `(#132001) Template name does not exist in the translation` —la plantilla todavía no
está creada en Meta—, el mensaje murió en *dead letter*, y el despacho siguió diciendo «Avisado».
El negocio creyendo que avisó y el cliente esperando: el fallo silencioso que este sistema trata
como el caro.

Dos cosas lo arreglan, y ninguna es la plantilla:

- **La orden guarda cuál fue el mensaje** (`aviso_listo_mensaje`). Con eso el despacho lee su
  estado de entrega real y dice la verdad: *Avisado*, *Enviando…*, o un botón rojo de
  **«No salió — reintentar»**. La marca sigue cerrando el candado del doble clic —un aviso **en
  cola** no se reintenta, que serían dos cobros—, pero uno que murió sí deja volver a intentarlo.
- **`marcarEntrega` guarda el motivo del fallo** en `crudo`. Ya se tenía y solo se imprimía:
  averiguar lo de arriba costó entrar por SSH a mirar `journalctl`, y eso solo funciona mientras
  el log siga ahí y alguien sepa a qué minuto mirar.

Un aviso anterior **sin** id de mensaje —los de antes de este cambio, o uno cuya partición del
Ledger ya se podó— se respeta y no se reintenta: ante la duda, no se le vuelve a cobrar al negocio.

#### El candado, que es la mitad del trabajo

Cada envío de plantilla **se le cobra al negocio**: dos clics son dos cobros y dos mensajes al
cliente, y en una pantalla que se mira con la cocina llena el doble clic no es teórico. Hacen falta
las tres cosas:

1. **`SELECT … FOR UPDATE`** sobre la orden, desde la primera lectura. Entre un `SELECT` normal y
   su `UPDATE` cabe entera la segunda petición, y las dos verían `aviso_listo_en` nulo.
2. **`aviso_listo_en` se escribe en la misma transacción** que crea el saliente. Si falla una, no
   queda ni mensaje ni marca, y se puede reintentar sin miedo.
3. El botón se apaga en el despacho — pero eso es comodidad, no garantía: el frontend siempre puede
   venir de otra pestaña.

Se guarda el **instante** y no un booleano porque «sí» no dice cuándo, y la primera pregunta de
quien mira un pedido que nadie recogió es a qué hora le avisaron.

#### Dónde vive cada cosa

| Pieza | Dónde | Por qué ahí |
|---|---|---|
| La plantilla | `intelligence/core/plantillas.js` | El texto aprobado es parte del programa, no configuración de un inquilino |
| El aviso | `intelligence/adapters/restaurante/avisoPedido.js` | Saber qué es una orden es dominio de la vertical (ADR-005, ADR-009). Hermano de `adapters/reserva/recordatorios.js` |
| La marca | `restaurante.pedid_orden.aviso_listo_en` | `npm run migrate:restaurante-aviso-listo` |
| El endpoint | `app_restaurante_api` | Donde vive el despacho |

`avisoPedido.js` lee la orden con **SQL en crudo** en vez de llamar a `pedidoService`, y no es
pereza: ese servicio ya depende de este adaptador para crear pedidos, y hacerlo al revés cerraría
un ciclo. La consulta son cinco columnas; el ciclo, para siempre. El controlador, por lo mismo,
hace el `require` **dentro** de la función: así un despliegue sin el esquema `intelligence` falla en
esa ruta y solo en ella, en vez de tumbar el arranque de toda la vertical.

---

## El saludo que a veces no saludaba (2026-09-08)

Señalado por el dueño usándolo: *«cuando escribo "buenas" no me muestra el mensaje completo»*. Y
lo raro era que **a veces sí**.

### La causa estaba en el enrutado, no en el flujo

Había **dos lecturas del mismo texto**, y no coincidían:

| Dónde | Cómo leía |
|---|---|
| `flujo.js` | `esComando`, que se queda con la última línea y **quita los signos** |
| La tabla de enrutado (`orquestador.js`) | `TODOS_LOS_COMANDOS.has(normalizar(texto))` — el texto crudo, **con signos** |

Con la misma lista de palabras en los dos sitios, «buenas» llegaba al Nivel 1 y **«Buenas!» se
iba al modelo**. El modelo contestaba un saludo perfectamente plausible **y sin el enlace del
menú**, que es lo único que ese primer mensaje tiene que hacer. Parecía una versión vieja del
bot; era la IA improvisando. Dos lecturas del mismo texto siempre acaban así.

### `esSaludo`, y por qué exige que el mensaje ENTERO sea saludo

La lista exacta no daba para más: la gente escribe «holaa», «buens», «hola buenas», «que más». El
lector nuevo tolera signos, vocales repetidas y faltas.

Lo que **no** hace es buscar un saludo dentro de la frase, que es la trampa: *«buenos días,
¿están abiertos?»* empieza igual y **no** es un saludo, es una pregunta. Se parten las palabras y
se exige que **todas** sean de saludar; en cuanto aparece una que no lo es, el turno sigue su
camino hacia quien pueda contestarla. Medido después del cambio:

```
determinista  ← "buenas"  "Buenas!"  "holaa"  "buens"  "hola buenas"  "buenos dias"  "que mas"
llm           ← "buenos dias, estan abiertos?"   "tienen hamburguesa"
```

### El contador de turnos mentía, y de paso se arregló

`variables.turnos` lo incrementaba `conMemoria`, que solo corre en el Nivel 1. O sea que contaba
**los turnos deterministas**, no los turnos: para quien caía al modelo se quedaba en cero para
siempre. Ahora lo lleva la escalera, en un solo sitio y para todos los niveles.

Importa porque la regla «el primer mensaje ve la bienvenida» lee justamente ese contador.

> **Lo que se intentó y se retiró:** una fila de enrutado que mandara al Nivel 1 **cualquier**
> primer mensaje, para que la bienvenida saliera con cualquier palabra. Se quitó porque el
> contador no es de fiar hacia atrás —las conversaciones anteriores a este cambio tienen
> `variables: {}` aunque lleven meses hablando—, y la regla disparaba con ellas: alguien con un
> pedido a medias de anteayer preguntaba algo y recibía el saludo inicial. Con los saludos ya
> arreglados, casi todo primer contacto real ve la bienvenida igual. Si se quiere forzar de
> verdad, hace falta una señal nueva en la base, no este contador.

---

## Pedir desde el menú digital

**La idea es del dueño (2026-08-24), y es mejor que la alternativa que se había propuesto.**

El plan anterior era un WebChat en la página. Tenía un problema sin solución limpia: un pedido a
domicilio desde un chat anónimo **no trae identidad**. Este diseño no lo mitiga, lo **elimina**: el
carrito se arma en el navegador, pero el pedido entra por WhatsApp, donde Meta firma el número.

Y de paso evita todo lo que el WebChat necesitaría para ser producto —clave pública por negocio,
sesión emitida por el servidor, límite por sesión, no exponer el simulador de fallos—. **No hay
superficie nueva que proteger:** el menú sigue siendo una página pública que no escribe nada.

### El contrato entre los dos repos

El mensaje que se abre lleva **dos mitades**:

```
Hola, quiero pedir:

• 2 × Bandeja paisa
• 1 × Limonada de coco

Total aproximado: $78.000

#P12-4x2,9x1        ← esta línea la lee el bot
```

| Lado | Archivo |
|---|---|
| Escribe | `restaurante_app/src/app/restaurante/features/menu-publico/carrito.service.ts` |
| Lee | `admin_ws/intelligence/adapters/restaurante/codigoPedido.js` |

**Sin el código habría que entender la prosa.** Eso lo hace bien el modelo, pero cuesta dinero por
turno y puede equivocarse: «dos bandejas», «2 bandejas» y «un par de bandejas» son lo mismo para un
humano y tres problemas para una expresión regular. Con el código, leer el pedido es determinista,
gratis y no falla.

Van **ids y no nombres** porque el mensaje viaja dentro de una URL (`wa.me/...?text=`) y los
nombres se comen el largo disponible.

> ⚠️ **Es un contrato entre dos repositorios distintos.** Cambiarlo en uno sin el otro hace que el
> cliente mande un pedido que nadie entiende, y no se entera hasta que no le llega la comida. Los
> dos archivos se citan mutuamente. Verificado rompiéndolo: cambiar el formato del parser tumba 6
> pruebas.

### Cómo pide, barrio y mesa: los modificadores del código (2026-09-24)

Antes de los productos, la carta pregunta **cómo quieres pedir**: en el local, a domicilio o
recoger. Lo elegido viaja en el mismo código, como modificadores opcionales `~<letra>=<valor>`
detrás de los productos:

```
#P12-4x2,9x1~m=D~z=7        domicilio al barrio 7
#P12-4x2,9x1~m=D~z=0        domicilio, «Otro barrio» (el restaurante confirma el valor)
#P12-4x2,9x1~m=R            recoger en el local
#P12-4x2,9x1~m=L~t=3        en el local, mesa 3
```

| Modificador | Valores | Lo lee el bot como |
|---|---|---|
| `m` | `D` · `R` · `L` | `tipo_pedido`: `DOMICILIO` · `LLEVAR` · `MESA` |
| `z` | id de `restaurante.rest_barrio_domicilio`; `0` = otro barrio | `id_barrio` (0 → sin valor de domicilio) |
| `t` | id de `restaurante.rest_mesa` | `id_mesa` |

| Lado | Archivo |
|---|---|
| Escribe | `restaurante_app/.../menu-publico/carrito.service.ts` (`codigoCompacto`, `modificadores`) |
| Lee | `admin_ws/intelligence/adapters/restaurante/codigoPedido.js` (`leer`, `leerModificadores`) |

**Reglas del contrato** (cada una tiene su prueba):

- **Retrocompatible.** Un código sin modificadores —todos los generados antes de esta fecha— se lee
  con el objeto de siempre, sin claves nuevas (`{ idNegocio, items }`), y el bot pregunta
  «¿domicilio o recoger?» como antes.
- **Lo desconocido se ignora, no se rechaza.** Un modificador que no se conoce o con valor basura
  (`~q=9`, `~z=abc`, `~m=X`) se descarta; el pedido se toma igual.
- **Es una sugerencia del cliente, nunca una verdad.** El mensaje se puede editar antes de
  enviarlo. El servidor **relee** el barrio (y con él el valor del domicilio) y la mesa desde la
  base, exige que sean de ESTE negocio y estén activos, y calcula el valor él mismo: un precio
  que venga en el mensaje no se lee en ningún sitio.
- **Errores tipados.** Barrio inválido → `ZONA_INVALIDA` (400); mesa inválida → `MESA_INVALIDA`
  (400). Cuando llegan del código, el flujo **no pierde el carrito**: vuelve a preguntar el barrio
  (o la mesa) con la lista. Si el barrio se borra entre el «sí» y la ejecución, `tomar_pedido`
  contesta `ZONA_INVALIDA` y la confirmación se cierra con ese mensaje.
- **La confirmación enseña el domicilio ANTES del «sí»**: una línea `Domicilio (Barrio) — $X` y el
  total ya sumado. Con «Otro barrio», el bot avisa que el restaurante confirma el valor y el
  domicilio entra en 0 para que el cajero lo ajuste.
- **`permite_pago_domicilio` manda.** Apagado, la carta no pide barrio y no se cobra domicilio
  (comportamiento de siempre); `barrioService.valorDomicilioDe` devuelve 0 y `crearOrden` lo
  vuelve a aplicar.
- **«En el local»** solo se ofrece si el negocio tiene mesas activas (`estado = 'A'`; que estén
  ocupadas no las descarta). Se identifica por `?mesa=<id_mesa>` en la URL (QR por mesa) o eligiendo
  de la lista. La orden entra como `MESA` con `id_mesa`, **sin dirección ni teléfono obligatorios**
  y sin aviso de «listo» ni paso por Despacho. Solo entra desde la carta: por chat el bot sigue
  ofreciendo dos opciones.
- **Mesa con cuenta abierta: se suma, y queda marcado.** Mesas y cobro asumen UNA cuenta activa por
  mesa, así que un pedido «en el local» sobre una mesa con cuenta abierta se AÑADE a ella (misma vía
  que `agregar_items_pedido`, con la mesa bloqueada para que dos comensales hagan fila) y la
  confirmación lo dice antes del «sí». Cada línea añadida lleva la nota `WhatsApp: <nombre>`; la nota
  de la orden, que es del mesero, no se toca. Al abrir una cuenta nueva la mesa pasa a OCUPADA.
  **Riesgo aceptado:** la presencia del cliente en la mesa no se verifica (quien edite `~t=` podría
  añadir a la cuenta de otra mesa); el «sí» del cliente y la visibilidad en Mesas —donde el mesero ve
  y quita la línea— son la defensa. No se muestra lo ya consumido en la confirmación: filtraría la
  cuenta de otra mesa.
- **Cerrado no se pregunta nada.** Con el negocio fuera de horario, la carta se ve y los botones
  quedan desactivados; el selector no aparece.

Barrios: tabla `restaurante.rest_barrio_domicilio` (`npm run migrate:restaurante-barrios-domicilio`),
CRUD en `GET/POST/PUT/DELETE /restaurante/barrios-domicilio` (escribe solo el administrador) y
lectura pública `GET /restaurante/public/negocios/:id/barrios` (`{habilitado, barrios[]}`). Las
mesas públicas, `GET /restaurante/public/negocios/:id/mesas` (solo id, nombre y número). Pantalla:
Configuración → Operación, visible solo con «Cobrar valor del domicilio» encendido.

> ⚠️ **Orden de despliegue: migración → backend → frontend.** Un código con `~m=…` contra un
> backend viejo no lo entiende (el patrón anclado a fin de línea no casa y el pedido cae al
> modelo). Con el backend nuevo delante, los códigos viejos siguen funcionando, así que el
> frontend puede salir después sin ventana de riesgo.

### Ingredientes que se quitan: `-r` por línea (2026-09-24)

Al agregar un producto con ingredientes que se pueden quitar, la carta abre un modal («¿quieres
quitar algún ingrediente?») y lo quitado viaja **por línea**, como ids de ingrediente separados por
punto:

```
#P12-4x1-r12.15,9x2~m=D~z=7     1 × producto 4 SIN los ingredientes 12 y 15; 2 × producto 9 con todo
```

| Lado | Archivo |
|---|---|
| Escribe | `restaurante_app/.../menu-publico/carrito.service.ts` (`codigoCompacto`, `claveLinea`) |
| Lee | `admin_ws/intelligence/adapters/restaurante/codigoPedido.js` (`leer`, `leerExclusiones`) |
| Valida | `admin_ws/intelligence/adapters/restaurante/exclusiones.js` (`resolver`) |

**Reglas del contrato** (cada una tiene su prueba, en los dos repos):

- **Retrocompatible.** Un código sin `-r` se lee con el objeto de siempre; `exclusiones` solo aparece
  en la línea que las lleva. Un `-r` con basura (`-rzz`, `-r12zz.7`) se ignora por id y el pedido se
  toma. Tope de 12 ingredientes por línea.
- **Líneas distintas.** «Una sin cebolla» y «una con todo» son dos líneas (`4x1-r12,4x1`); solo se
  suman las que coinciden en producto Y exclusiones. En el carrito la identidad es
  `claveLinea = id_producto:ids ordenados`.
- **Nunca se guarda un id que no sea removible de ese producto en ese negocio.** Válido = está en la
  receta del producto (`carta_producto_ingred`, estado `A`), `es_removible`, y el ingrediente es del
  negocio y está activo. El id que llega en el mensaje es una sugerencia editable.
- **Se relee en tres momentos.** (1) Al leer el código, el flujo deja solo las válidas y guarda los
  nombres de las descartadas. (2) La CONFIRMACIÓN vuelve a leer y muestra solo las válidas
  —`• 1 × Hamburguesa (sin cebolla, sin tomate) — $X`—; si se descartó alguna añade
  `(no pudimos quitar: X)` ANTES del «sí». (3) `tomar_pedido.ejecutar` vuelve a validar y es
  estricto: si algo de lo confirmado dejó de valer (ventana de segundos) lanza `EXCLUSION_INVALIDA`
  (400) y no crea nada. Un ingrediente desactivado no tumba el pedido entero en la confirmación;
  solo se avisa.
- **En `tomar_pedido`** el elemento de `items` lleva `sin: "12.15"` (texto, porque el motor de
  argumentos no anida listas de escalares) y hay un `sin_descartadas` informativo. `crearOrden` y
  `agregarItemsPorCliente` reciben `exclusiones: [ids]` y las guardan en `pedid_detalle_exclu`,
  igual que el POS; `consumirIngredientesPorItems` **no descuenta lo quitado**. El precio no cambia
  por quitar un ingrediente.
- **Carta pública.** `GET /public/carta/completa` lleva por producto `ingredientes_removibles:
  [{id_ingrediente, nombre}]`: solo los removibles activos, sin porciones, stock ni costos y sin los
  que no se pueden quitar. Vacío/ausente = el «+» agrega directo, sin modal.
- **Interacción.** Con removibles, el «+» abre SIEMPRE el modal (todos incluidos; se marca «quitar»;
  «Agregar» confirma con un toque; foco atrapado, Esc cierra). El «−» de la tarjeta resta de la línea
  más reciente de ese producto y el «n» es la suma de todas sus líneas; el pre-pedido ajusta cada
  línea por separado con su «sin X».
- **Texto legible.** `• 1 × Hamburguesa (sin cebolla)`. Si el texto pasa de ~1.500 caracteres se
  recorta **solo lo legible** («• … y N más»); la línea `#P…` va siempre completa. El carrito
  guardado con el formato anterior (v2, sin exclusiones) se sigue leyendo.

> ⚠️ **Orden de despliegue: backend antes que frontend.** Un código con `-r` contra un backend viejo
> no casa el patrón anclado y el pedido cae al modelo. No hay migración de base de datos.

### Datos del cliente antes de WhatsApp: un bloque legible (2026-09-25)

Para no gastar mensajes preguntando uno a uno lo que el cliente ya puede escribir en la carta, el
panel «Tu pedido» pide nombre, teléfono, dirección y nota **antes** de abrir WhatsApp, y esos
datos viajan en un bloque de etiquetas FIJAS, antes de la línea `#P…`:

```
Nombre: Ana Pérez
Teléfono: 3001234567
Dirección: Cra 3 #21-10, apto 201
Nota: sin cebolla en todo

#P12-4x1~m=D~z=7
```

| Lado | Archivo |
|---|---|
| Escribe | `restaurante_app/.../menu-publico/datos-cliente.ts` (`ETIQUETAS`, `lineasDelBloque`) |
| Lee | `admin_ws/intelligence/adapters/restaurante/datosCliente.js` (`leerBloque`) |
| Siembra | `intelligence/adapters/restaurante/flujo.js` (`sembrarDatosCliente`) |

Qué se pide según la modalidad (la nota es solo de domicilio):

| Modalidad | Nombre | Teléfono | Dirección | Nota |
|---|---|---|---|---|
| Domicilio | obligatorio | obligatorio | obligatoria | opcional |
| Recoger | obligatorio | opcional | — | — |
| En el local (mesa) | obligatorio | — | — | — |

**Reglas del contrato:**

- **Parser por etiqueta, determinista.** `Etiqueta: valor` solo cuenta al **principio de una
  línea**; una etiqueta que aparezca dentro del VALOR de otra —una nota con «Dirección: ...»
  pegado— no se lee como dato: no hay forma de inyectar un campo falso desde dentro de otro.
  La primera aparición de una etiqueta manda; una repetida después se ignora.
- **Una etiqueta ausente o vacía → el bot pregunta SOLO esa.** El resto de lo sembrado no se
  vuelve a pedir. Un mensaje sin el bloque (el código de siempre) se comporta exactamente igual
  que antes.
- **Es una SUGERENCIA editable, como el barrio o la mesa.** Con el bloque completo, el bot no
  pregunta nada y pasa directo a la CONFIRMACIÓN —camino feliz: carrito → confirmación → «sí», dos
  intercambios—; el «sí» del cliente sigue siendo obligatorio (ADR-010), y es ahí donde puede
  corregir lo que haya venido mal.
- **El teléfono se normaliza con el país del negocio** (`normalizarE164`, `gener_negocio.pais`).
  Si no da un móvil válido, se ignora: se sigue usando el que probó el canal, o se pregunta.
  **Nunca pisa un teléfono que el canal ya probó** — ese es el que autoriza; decir uno distinto en
  el formulario no lo cambia.
- **Se sanea:** se recortan longitudes, se quitan saltos de línea y caracteres de control dentro
  de cada valor, y no hay forma de repetir una etiqueta con un valor distinto.
- **Nada de esto viaja dentro de la línea `#P`.**
- El panel recuerda nombre, teléfono y dirección en el navegador (`localStorage`, 90 días,
  `isPlatformBrowser` + `try/catch`) para que quien repite no vuelva a escribirlos. La nota no se
  recuerda: es de ese pedido.
- **El bloque solo se lee en el mismo mensaje que trae el código del carrito.** `sembrarDatosCliente`
  vive dentro de `recibirPedidoDelMenu`, que solo se invoca cuando `codigoPedido.leer(texto)`
  encuentra un `#P…` en ESE mensaje. Un «Nombre: …» escrito a mano en cualquier otro punto de la
  conversación (contestando una pregunta del flujo, o por curiosidad) nunca pasa por este lector:
  lo trata `seguirPedido` como el texto libre de siempre, tal cual —incluidas las etiquetas, si las
  escribió—.
- **⚠️ El bloque va ANTES de la línea `#P…`, y eso importaba para el lector del código
  (2026-09-25).** `codigoPedido.leer` usaba `PATRON.exec` (primera coincidencia); con datos libres
  por delante, una dirección o una nota que contuviera algo con forma `#P12-9x9` se habría leído
  como el pedido en lugar del real. Arreglado en las dos puntas: el lector ahora recorre TODAS las
  coincidencias del mensaje (`buscarUltimo`) y se queda con la ÚLTIMA —el código de verdad es
  siempre la última línea—; y `sanear` (front) borra cualquier `#P<dígito>` de lo que escribe el
  cliente, así el mensaje que ve una persona tampoco muestra un código falso.

### Tres decisiones del lado del bot

1. **El código se lee lo PRIMERO.** El mensaje empieza por «Hola, quiero pedir», y si se mirara
   después del saludo, el cliente recibiría la bienvenida en vez de su pedido.
2. **No se crea la orden al recibirlo.** Se anotan los productos en las variables y se pide la
   dirección. Pulsar un botón en una página es **abrir un chat, no confirmar un pedido**, y la
   mutación exige el sí del cliente (ADR-010, paso 5).
3. **Se comprueba el negocio del código.** Alguien puede armar el carrito en la carta de un
   restaurante y mandarlo al WhatsApp de otro; sin comprobarlo, el pedido se crearía con ids que
   aquí son otra cosa — o no existen.

### Y en el navegador

- **Todo en `localStorage`, por negocio.** Quien mire dos cartas no debe encontrarse los platos de
  una en el carrito de la otra. Todo detrás de `isPlatformBrowser` y `try/catch`: esto se
  renderiza en SSR, donde `localStorage` no existe, y en modo privado puede lanzar.
- **El total dice «aproximado» y no es una excusa:** el asistente relee el catálogo al crear la
  orden. Si algo cambió de precio o se agotó entre que el cliente miró y escribió, manda el
  catálogo. Prometer aquí un total exacto sería prometer por cuenta de otro.
- **El botón solo aparece con `url_whatsapp` puesto.** Sin número, el menú sigue siendo un menú
  útil y no se ofrece un botón que no lleva a ningún sitio.

---

---

## La dirección de broma y el pago que nunca se preguntó (2026-08-27)

Dos cosas que salieron de que el dueño probara el pedido de verdad. Las dos son de producto y
ninguna era un fallo de código — que es lo que las hace interesantes.

### El pago no se preguntó porque no había nada que preguntar

Seis pedidos seguidos llegaron a la confirmación sin pasar por el paso del pago. La primera
sospecha fue un fallo del flujo; el Ledger dijo otra cosa:

```
17:25:41  pedido_del_menu_recibido    (3 items)
17:26:16  pedido_dato_recibido        (paso: direccion)
17:26:16  confirmacion_solicitada     ← se salta el pago
```

La regla es `if (!datos.id_metodo_pago && (datos.metodos || []).length > 0)`, o sea **solo se
pregunta si el negocio tiene métodos**. Y `rest_metodo_pago.fecha_creacion` lo zanjó: los dos
métodos del negocio 12 se crearon a las **17:29:39** y **17:29:45**, tres minutos *después* del
último pedido. El código hizo exactamente lo que estaba escrito.

**Correcto y malísimo.** Un domicilio en el que nadie dice cómo se paga es una discusión en la
puerta con el domiciliario delante. Así que ahora hay **métodos por defecto**: `migrate:restaurante-datos-pago`
siembra `Efectivo` y `Transferencia` en todo restaurante que no tenga ninguno.

> **Por qué el defecto son filas y no un valor en el código.** Un `|| ['Efectivo', 'Transferencia']`
> escondido en el flujo habría arreglado el síntoma y creado uno peor: el dueño vería su pantalla
> de configuración vacía mientras el bot ofrece cosas que él no puso, no podría quitar la
> transferencia el día que deje de aceptarla, y la orden guardaría un nulo donde va un
> `id_metodo_pago`. Sembrando filas, lo que el bot dice es exactamente lo que el dueño ve y edita.

Lo que la migración **no** hace es tocar a quien ya configuró los suyos: sembrar «Efectivo» en un
negocio que solo acepta transferencia sería ponerle al bot en la boca algo que nadie dijo.

> ⚠️ **Queda un hueco:** un restaurante **nuevo** sigue naciendo sin métodos. La migración cubre a
> los que ya existen. Lo natural es sembrarlos al crear el negocio, y no está hecho.

### A dónde se paga

`rest_metodo_pago.datos_pago` (200 caracteres, opcional) — el Nequi, la cuenta del banco, lo que
el cliente necesita para poder pagar. Texto libre y no columnas por banco: cada negocio lo dice a
su manera y ninguna estructura sobrevive al segundo cliente.

El bot lo dice **junto a las opciones**, no después de elegir:

```
¿Cómo vas a pagar? 💵

• *Físico*
• *Transferencia* — Nequi 315 281 2484 a nombre de Pregonchos

[Físico]  [Transferencia]
```

Es decisión del dueño (2026-08-27) y tiene un motivo que la sostiene: preguntar primero y enseñar
la cuenta después obliga a quien no tiene Nequi a elegirlo para descubrirlo, y a volver atrás —
que en un flujo determinista es donde se pierde la gente. Un método sin datos sale solo con su
nombre, sin guión suelto.

Las opciones estructuradas siguen viajando aparte en `opciones[]`: esto es solo el texto que las
acompaña, y cada canal las pinta como sepa (ADR-017).

Se administra en **Configuración → Opciones de pago** del `restaurante_app`, con un aviso debajo
del campo diciendo que eso es lo que va a leer el cliente por WhatsApp — porque no es una nota
interna.

### La dirección: el guardarraíl avisa, no manda

El dueño escribió una broma donde iba la dirección y **el pedido se creó con ella**. No había
comprobación, y había un motivo escrito para no tenerla:

> «quien sabe si "Carrera 3e 19 a" es una dirección real es el domiciliario, no una expresión
> regular»

Ese motivo **sigue siendo bueno**, así que lo que se añadió no es una validación. `pareceDireccion`
pide una de dos señales —un número, o una palabra tipo *calle / carrera / barrio / km*— más tres
letras y seis caracteres. Si no la ve, **repregunta una vez**. Si el cliente insiste, se apunta lo
que diga y se marca `direccion_forzada` en la tarea.

| Entra | Qué pasa |
|---|---|
| `Calle 45 #12-30` · `Cra 3e 19 a` · `el conjunto de siempre, casa blanca` | pasa a la primera |
| `jajaja` · `😂` · `no te lo pienso decir jaja` | repregunta una vez, y acepta a la segunda |

**Aceptar a la segunda no es una concesión, es el diseño.** Bloquear un pedido porque una
expresión regular no reconoce un barrio es cambiar una venta por una discusión, y hay barrios
enteros donde la nomenclatura no existe. Queda el rastro (`pedido_direccion_dudosa`,
`direccion_forzada`) para que un domicilio que salga mal se pueda explicar.

**21 pruebas** en `__tests__/intelligence/pedido_direccion_y_pago.test.js`, con las direcciones
raras-pero-reales listadas explícitamente: rechazar una de ésas sería peor que aceptar una broma.

---

---

## Dos caminos, un solo cliente (2026-08-27, tarde)

### El pago seguía sin preguntarse — y esta vez sí era el código

Con los métodos ya sembrados, el dueño hizo otro pedido y **tampoco le preguntaron**. El Ledger
enseñó por qué, y es distinto de la vez anterior:

```
pregunta_libre → prompt_armado → clasificacion/capacidades → confirmacion_solicitada
```

Ni un `pedido_dato_recibido`, ni un `tarea_en_curso`. **El pedido lo tomó el modelo entero**, no
el flujo determinista — porque no vino del carrito del menú sino de conversar. Y el paso del pago
vivía **solo** en el flujo determinista.

Mirado de cerca, el modelo no tenía forma de hacerlo bien:

| | Flujo determinista | Modelo |
|---|---|---|
| ¿Sabe qué métodos hay? | sí, lee `rest_metodo_pago` | **no había herramienta** |
| ¿Está obligado a mandarlo? | sí, es un paso | `id_metodo_pago` es **opcional** |
| ¿Alguien le dice que pregunte? | el paso lo obliga | **nada, en ningún sitio** |

> **La forma del fallo, que ya se repitió tres veces esta semana:** dos caminos hacia lo mismo y
> uno solo de ellos mantenido. El del carrito preguntaba, el del chat no, y el cliente no sabe
> por cuál entró.

Se cerró con lo mínimo: una capacidad de consulta **`consultar_metodos_pago`** (devuelve nombre,
id y `datos_pago`) y una línea en la descripción de `tomar_pedido` que la exige antes de tomar el
pedido. `id_metodo_pago` sigue siendo opcional a propósito: un negocio sin métodos configurados
tiene que poder vender igual.

### Los datos del cliente, en un solo mensaje

Petición del dueño: *«está pidiendo nombre, en ocasiones teléfono, dirección… ¿hay manera de
pedir todo lo necesario en un solo mensaje, excepto el nombre?»*.

Cambia una decisión que estaba escrita —«pide **uno cada vez**»— y el argumento de entonces era
bueno: un cuestionario de cinco campos es lo que se hace cuando al otro lado hay alguien leyendo a
mano. Lo que no se midió es el otro lado: **cuatro turnos y cuatro esperas para tres datos que el
cliente tiene en la cabeza a la vez.**

```
Para mandártelo necesito dos cositas. Puedes contestarme todo junto 👇

📍 La dirección, con el barrio o alguna indicación para llegar

💵 Cómo vas a pagar:
• *Físico*
• *Transferencia* — Nequi 315 281 2484 a nombre de Pregonchos
```

**El nombre se queda aparte**, y no por capricho: se contesta con una palabra, va primero, y es lo
que convierte el trámite en una conversación. Mezclarlo con la dirección lo volvería la primera
casilla de un formulario.

**Sin botones en el mensaje combinado.** Un botón «Transferencia» al lado de «mándame tu
dirección» invita a pulsarlo y dejar el resto sin contestar. Los botones vuelven si hay que
repreguntar el pago a solas.

#### Lo difícil no es preguntar, es leer la respuesta

Una respuesta suelta trae las tres cosas mezcladas, y **una dirección está llena de números**.
`interpretarDatos` reconoce solo lo inequívoco y trata la dirección como **lo que sobra**:

1. **Teléfono**: un celular colombiano —diez dígitos empezando por 3, con o sin `+57`—. Un fijo de
   siete dígitos se queda fuera **a propósito**: es indistinguible de un número de calle, y un
   domiciliario llamando a un número inventado es peor que un domiciliario sin número.
2. **Método de pago**: se busca el nombre real dentro del texto («pago con *Nequi*»). El más
   largo gana, para que «Nequi Bancolombia» no pierda contra «Nequi».
3. **Dirección**: lo que queda, con los bordes limpios.

| Llega | Se lee |
|---|---|
| `Calle 45 #12-30, barrio El Prado. Mi cel es 3152812484 y pago con transferencia` | los tres, y la dirección **sin** el «Mi cel es y pago con» colgando |
| `Calle 45 #12-30, barrio El Prado` | la dirección; se repregunta **solo** el pago, ya con botones |
| `jajaja adivina` | nada; se repregunta entero **sin perder el carrito** |

**Lo que llegó bien nunca se tira.** Hacerle repetir la dirección porque no se entendió el pago
sería castigarle por haber contestado.

> ### La regresión que cazó un test viejo
>
> La limpieza de bordes quita el relleno que queda al recortar el teléfono y el método («mi cel
> es», «y pago con»). La primera versión se comió la «a» de **`Carrera 3e 19 a`** —el ejemplo
> canónico de este proyecto, la frase que justifica que las direcciones casi no se validen— y
> devolvió `Carrera 3e 19`: **otra casa**.
>
> Lo cazó un test que ya existía. La regla que lo arregla no es una excepción sino una
> observación sobre la nomenclatura: **una letra suelta detrás de un número es parte de la
> dirección** (19 a, 3 e); una palabra entera, no («Av. Boyacá 100, tel» → sobra el «tel»).

El modelo hace lo mismo por su lado: prompt **`sistema.v5`** pide los datos del cliente juntos,
se queda con lo que llegue y repregunta solo lo que falte. Y deja claro que esto vale para los
datos **del cliente**, no para el pedido: qué quiere comer se conversa plato por plato si hace
falta.

**22 pruebas nuevas** (`__tests__/intelligence/pedido_un_solo_mensaje.test.js`). **664 en verde.**

---

## El método de pago, retirado del asistente (2026-08-27, noche)

**Decisión del dueño, tras probarlo:** el asistente deja de preguntar cómo se paga. No convence,
y cada pieza que se añade al camino del pedido es una pieza que puede fallar delante de un
cliente real. Se documenta aquí entero porque **el trabajo está hecho y volver a ponerlo es
revertir un commit**, no rehacerlo.

### Qué se quita

| Pieza | Dónde estaba |
|---|---|
| Paso `PAGO` del flujo determinista | `adapters/restaurante/flujo.js` |
| `consultar_metodos_pago` | `adapters/restaurante/index.js` |
| Parámetro `id_metodo_pago` de `tomar_pedido` | ídem |
| Instrucción de preguntar el pago | prompt `sistema.v5` → **`v6`** |
| Campo «A dónde se paga» en Configuración | `restaurante_app` |
| `datos_pago` en modelo, servicio, controlador y rutas | `admin_ws` |

El flujo del pedido queda: **carrito → nombre → \[teléfono\] → dirección → confirmación**, con el
teléfono aún condicionado a que el canal no haya probado ninguno.

### Qué NO se quita, y por qué

- **La tabla `restaurante.rest_metodo_pago` y su CRUD.** Son de antes y las usa el POS: la caja
  cobra con ellas y `pedid_orden.id_metodo_pago` las referencia. Tocarlas sería romper el negocio
  para arreglar el asistente.
- **La columna `datos_pago`.** Se queda **vacía y sin usar**. Borrarla es un `ALTER TABLE` sobre
  una base de producción viva a cambio de nada: no estorba, no se lee, y el día que esto vuelva
  ya está puesta. Está aquí anotada para que dentro de seis meses nadie se pregunte de dónde salió.
- **Los métodos sembrados** en los negocios **9, 11 y 13** (`Efectivo` y `Transferencia`, ids 21
  a 26). Ninguno tiene órdenes, así que borrarlos sería seguro — pero son formas de pago
  perfectamente válidas en el POS de esos negocios, y nadie ha pedido quitarlas. **Se dejan.** Si
  molestan, se borran desde Configuración de cada negocio.
  Los del negocio 12 (`Físico` e ids 19/20) los creó el dueño y uno ya tiene una orden: **no se
  tocan bajo ningún concepto.**

### Lo que sí conviene recordar de todo esto

Aunque la funcionalidad se retire, los dos hallazgos que salieron por el camino siguen valiendo, y
son de arquitectura, no de producto:

1. **Dos caminos hacia lo mismo y uno solo mantenido.** El pedido se podía tomar por el carrito
   del menú (flujo determinista) o conversando (modelo), y el paso del pago vivía **solo** en el
   primero. El cliente no sabe por cuál entró. Cada vez que se añada algo al pedido hay que
   preguntarse *«¿y por el otro camino?»* — pasó tres veces en la misma semana.
2. **Una capacidad opcional que nadie obliga a usar, no se usa.** `id_metodo_pago` era opcional,
   no había herramienta para listar los métodos y nada en el prompt lo pedía. El modelo no fue
   descuidado: hizo lo único que podía hacer.

> **Para volver a ponerlo:** revertir el commit de esta retirada. La migración
> `migrate:restaurante-datos-pago` ya corrió y la columna sigue ahí, así que no hace falta tocar
> la base.

---

## Dos correcciones de una conversación real (2026-08-27, noche)

El dueño leyó su propia conversación y señaló dos cosas. Las dos tenían causa concreta.

### 1. El bot no encontraba lo que acababa de ofrecer

```
21:55:42  BOT      Para desayuno tenemos *empanadas de carne (x3)* por $9.000…
21:56:11  CLIENTE  perfecto, las empanadas y el jugo está bien
21:57:55  BOT      No encuentro las empanadas de carne en la carta ahora mismo.
21:58:24  CLIENTE  por qué no lo encuentras? si me lo acabas de dar como opcion...
```

No era alucinación. El producto 103 se llama **`Empanadas (x3)`** y su descripción dice **`De
carne, con ají`**. El modelo lo ofreció fusionando los dos campos —que es como lo diría
cualquiera— y luego buscó esa frase. `cartaService.buscarProductos` compara la **frase entera**
contra el nombre y contra la descripción, **cada uno por su lado**, y «empanadas de carne» no
está completa en ninguno de los dos.

Arreglado por las dos caras, y en ese orden de importancia:

1. **Segunda pasada por palabras** en `buscar_producto` (adaptador). Si la frase entera no casa,
   se busca por la palabra más larga —la más selectiva— y sobre esos candidatos se exige que
   **todas** las demás aparezcan en el nombre o en la descripción. Una consulta más, y solo
   cuando la primera devolvió vacío. **Ésta es la que no depende de que el modelo obedezca.**
2. **Prompt `sistema.v7`**: llama a cada producto como se llama en la carta; la descripción se
   cuenta, no se pega al nombre.

> **Por qué en el adaptador y no en `cartaService`:** ese servicio es el contrato de la vertical y
> lo usa también el panel del negocio. Ensanchar su búsqueda desde aquí sería cambiarle el
> comportamiento a una pantalla que nadie ha pedido tocar (ADR-009). Es el mismo razonamiento por
> el que el filtro de `visible` vive ahí y no en el servicio.

La segunda pasada **ensancha la búsqueda, no la convierte en adivinanza**: exige todas las
palabras, así que «bandeja de sushi» no devuelve la bandeja paisa. Y sigue sin sacar lo que el
negocio esconde (`visible: false`), que fue un agujero real el día 26.

### 2. Quería programar un pedido para el día siguiente

```
21:55:40  CLIENTE  quisiera algo para desayunar mañana, tienes alguna otra cosa?
…
22:01:15  BOT      Para enviártelas mañana necesito dos cositas…
```

**Los pedidos son para el momento.** `tomar_pedido` crea una orden en la caja abierta y sale de
cocina enseguida; no existe programar un domicilio. El bot prometió algo que el sistema no puede
cumplir —y el prompt ya decía «nunca ofrezcas plazos», que resultó demasiado abstracto—.

Y el malentendido de fondo importa más que la promesa: el cliente **no** pedía una entrega para
mañana. Pedía comprar ahora algo que se iba a **guardar** para el desayuno. Es la lectura normal
de esa frase y el modelo eligió la otra.

Ahora está dicho en los dos sitios donde el modelo lo va a ver:

- **`tomar_pedido`**: «el pedido entra a la cocina AHORA y sale de inmediato: no existe
  programarlo para más tarde ni para otro día».
- **`sistema.v7`**, con el caso concreto: «que alguien diga *quiero algo para desayunar mañana*
  casi nunca significa que quiera recibirlo mañana».

**7 pruebas** en `__tests__/intelligence/buscar_producto.test.js`, con un doble que replica la
semántica **exacta** del servicio real —si el doble fuera más listo que el servicio, la suite
probaría un mundo que no existe—. **661 en verde.**

> ⚠ **Queda un detalle sin arreglar, y es deliberado.** En ese mismo día, a las 21:18, el
> cliente contestó «Es en la manzana 3 casa 4 del barrio nogales, voy a pagar cuando llegue el
> domiciliario» y **la frase del pago entró dentro de la dirección**, que es lo que se imprime en
> la comanda. Recortarla exigiría partir por comas o por frases, y ahí es donde ya se perdió una
> vez la «a» de «Carrera 3e 19 a». Ensuciar una dirección es feo; cortarla es mandar al
> domiciliario a otra casa.

## Cómo activar el asistente en otro restaurante

1. **Plan Avanzado** — es donde vive `asistente_ia` (`intelligence/core/features.js`). Sin él, el
   Gate deniega antes de llegar a la capacidad.
2. **Habilitar las capacidades**:
   `node scripts/capacidad.js habilitar <capacidad> --negocio <id>` para las cuatro.
3. **Que tenga carta.** Sin productos el bot dirá «no hay nada» — correctamente, y sin servir de
   nada.
4. **`url_whatsapp`** del negocio, para que aparezca el botón en el menú digital.
5. **`WHATSAPP_NEGOCIO_ID`** en el `.env` del VPS… y aquí está el techo: **un número, un negocio**.
   Apuntarlo a otro deja de atender al anterior. El alta multi-inquilino es Embedded Signup, y
   está descrito en [`canal-whatsapp.md`](canal-whatsapp.md).

---

## Que no suene a bot (2026-08-26)

El dueño leyó las conversaciones reales y dijo la frase que resume el problema: **«ahora mismo el
bot es eso, un bot»**. Y puso el dedo en el sitio exacto: *«no me gusta que diga "tenemos las
siguientes categorías". Los encargados del restaurante lo entienden porque así hay más orden, pero
¿qué le importa a un cliente? Él quiere ver los productos, lo que valen…»*.

Tenía razón, y el fallo no estaba en la redacción: estaba en la **forma de los datos**.

### La causa: la capacidad devolvía un índice, no una carta

`consultar_carta` sin argumentos devolvía **solo la lista de categorías**. Se hizo así con un
motivo razonable —«la carta entera no cabe en un mensaje y abruma»— y el modelo hizo lo único
sensato que se podía hacer con ese dato: leerlo en voz alta y preguntar por cuál empezar.

El flujo determinista hacía lo mismo un paso antes: al pulsar «Pedir por aquí» pintaba las tres
categorías como botones. Eso se añadió el 24 para que el modelo no se inventara un id de
categoría, y **funcionó**; pero resolvió un problema nuestro pasándole al cliente un problema de
organización interna del restaurante.

Las categorías existen para que el negocio ordene su carta. Quien pide comida quiere ver platos y
precios. Cada pregunta intermedia es un turno entero gastado en no decir nada, y en un chat cada
turno de más es una oportunidad de que se vaya.

### Lo que cambió

| Antes | Ahora |
|---|---|
| `consultar_carta` sin args → lista de categorías | → **productos con precio**, agrupados, hasta 30, con `hay_mas` |
| «Pedir por aquí» → tres botones de categoría | → los **8 más pedidos con su precio**, y el enlace a la carta completa |
| «¡Hola! Te comunicas con X.» | Saludo por la hora del día, el nombre en `*negrita*` y qué más sabe hacer |
| Prompt `sistema.v2` | `sistema.v3` |

El fallo del 2026-08-24 —el modelo pidiendo la categoría «2», un ordinal— sigue cubierto, y por
una vía mejor que la de entonces: **si nadie tiene que elegir una categoría, no hay id que
inventar**. La validación estricta de `id_categoria` se queda igual, para cuando el cliente sí
nombre una parte de la carta («¿qué bebidas tienen?»).

`hay_mas` no es cosmético: sin él, una carta recortada le enseña al modelo a decir «esto es todo
lo que tenemos», que es mentira. Es el mismo principio que ya obligó a que una categoría
inexistente fallara en vez de devolver vacío.

### El prompt: `sistema.v3`, y por qué es una versión nueva

Los prompts son artefactos versionados (ADR-019), así que un cambio de comportamiento se ve en un
`git diff` como un archivo nuevo, no como una edición encima. La `v2` sigue en el repositorio: es
lo que permite al arnés comparar.

`v3` **solo cambia el estilo**, y ahí estaban dos contradicciones que explicaban medio problema:

1. **Pedía «cercano y breve» y a la vez prohibía toda lista.** En una barbería eso está bien. En
   un restaurante, que enumera platos con precio, obligaba a escribir párrafos. Ahora: lista corta
   **solo cuando se enumeran cosas** —platos con precio, horas libres—, y frases para todo lo demás.
2. **No decía nada sobre la organización interna del negocio.** Ahora lo dice explícitamente: las
   categorías, secciones y códigos internos existen para que el negocio se ordene, al cliente no le
   importan y **no se le preguntan**.

Y tres cosas más: un emoji de vez en cuando está permitido (rellenar de emojis, no); la negrita de
WhatsApp es **un** asterisco, no dos, que es un detalle que se ve feo en el móvil en cuanto se
escapa; y se pide **un dato cada vez** en vez de un cuestionario.

### Lo que NO se copió del ejemplo del dueño

El bot que le atendió en otro restaurante manda un formulario: «Dirección y Barrio: / Número de
celular: / Nombres: / Medio de pago:», y remata con *«por favor enviar los datos en un solo
mensaje»*. Ese negocio lo necesita porque al otro lado hay **una persona** leyendo mensajes a mano
y quiere recibirlo todo de una vez.

Aquí no hay nadie leyendo. Pedirle al cliente que rellene un formulario, cuando el asistente puede
preguntar lo que falte justo cuando falte, sería añadirle trabajo para no usar lo único que
tenemos de más. Lo que sí se tomó de ese ejemplo es el tono: saludar por la hora, decir quién eres,
y poner el enlace del menú donde se ve.

### Un agujero encontrado por el camino

`cartaService.buscarProductos` **no filtra `visible`** —es la misma búsqueda que usa el panel del
negocio, donde ver lo oculto es justo lo que se quiere—, así que `buscar_producto` podía enseñarle
a un cliente un producto que el negocio esconde a propósito: escribir «personal» sacaba el «Menú
del personal». Se filtra ahora en el adaptador, no en el servicio: el contrato de la vertical es
suyo, y cambiárselo desde `intelligence/` es la flecha al revés.

La prueba se comprobó **rompiendo el código a propósito** antes de darla por buena.

### Y el saludo de citas, por lo mismo

La `reserva` arrancaba con «¡Hola! Te comunicas con X». Se cambió igual el mismo día:
`saludoPorLaHora` vive en `intelligence/engine/texto.js` —no en un flujo— porque un restaurante y
una barbería saludan igual, y dos copias serían dos relojes.

---

## El rastro que mataba la conversación (2026-08-26, segunda vez)

El dueño probó el flujo nuevo, llegó a «¿a qué dirección te lo enviamos?», contestó — y **no
recibió nada**. En el Ledger, `MANEJADOR_FALLO`:

```
null value in column "vertical" of relation "invocacion_capacidad_2026_08"
violates not-null constraint
```

Es **el mismo fallo del 24**, en otro sitio del mismo archivo. Entonces se arregló el `catch`
general del manejador de modelo; los dos `push` del **camino de confirmación** —el de las
mutaciones que exigen un sí— seguían sin poner `vertical`.

### Lo que pasó de verdad, turno a turno

La auditoría del Gate lo cuenta entero. El modelo llamó a `tomar_pedido` **tres veces**:

| # | `items` que mandó | Resultado |
|---|---|---|
| 1 | `"106x1,109x1,111x2"` | `ARGUMENTOS_INVALIDOS` — es el código compacto del carrito, copiado tal cual |
| 2 | `"[{\"id_producto\":106,…}]"` | `ARGUMENTOS_INVALIDOS` — la lista correcta, pero **serializada** |
| 3 | `[{id_producto:106,…}]` | `CONFIRMACION_REQUERIDA` ✅ — el camino bueno |

O sea: **el modelo se corrigió solo y el pedido era válido**. La conversación estaba salvada. Lo
que la mató fue apuntar los dos errores: las invocaciones se escriben todas juntas al cerrar el
turno, así que el INSERT de la primera reventó la transacción entera y se llevó por delante la
pregunta de confirmación que ya estaba lista.

> **Un rastro que no se puede escribir puede perderse. Lo que no puede es llevarse por delante la
> conversación que estaba contando.**

### Los dos arreglos

1. **La red, en un solo sitio.** `repositorio.registrarInvocacion` resuelve la vertical desde el
   Registry cuando no se la pasan, y escribe `'desconocida'` como último recurso. Dos veces el
   mismo fallo en dos sitios distintos significa que el sitio equivocado era el *call site*: por
   este punto pasan todos, presentes y futuros. Los tres sitios que la omitían la ponen igual,
   porque decirlo donde se sabe sigue siendo mejor que deducirlo.
2. **La lista serializada se acepta.** Es un tropiezo conocido del *function-calling*. Rechazar
   el código compacto es correcto —no es una lista, es otra cosa—; rechazar la lista bien formada
   por venir entre comillas costaba dos llamadas al modelo, ~2,5 s y sus tokens, por nada. Se
   acepta **solo** si el texto parsea a un array; el contenido se valida igual de estricto.

Las dos pruebas se comprobaron rompiendo el código a propósito: la del Ledger reproduce el error
de Postgres palabra por palabra.

---

## El pedido del menú nunca llegaba al flujo (2026-08-26, tercera vuelta)

Arreglado lo del rastro, el dueño volvió a probar: mandó el carrito, dijo su nombre — y el bot le
contestó **«¿Qué quieres pedir hoy?»**. Se le había olvidado el pedido que acababa de recibir.

### La causa: el mensaje nunca llegó a quien sabía leerlo

`recibirPedidoDelMenu` existe desde el 25, está probado y lee el código perfectamente. Pero **el
mensaje no le llegaba nunca.** El pedido del menú no es un comando conocido ni abre una tarea, así
que la política de enrutado lo mandaba al Nivel 4 por el comodín `pregunta_libre`.

El modelo se apañaba: **decodificaba el código a mano** (por eso su primer intento mandó
`items: "106x1,109x1,111x2"`, que es el código tal cual). Funcionó dos veces y a la tercera se le
olvidó el carrito. Culpar al modelo sería mirar al sitio equivocado — nadie debería estar
pidiéndole que recuerde un dato exacto que una expresión regular lee sin fallar.

Los unitarios no lo vieron porque llaman al flujo **directamente**. El enrutado nunca estuvo en el
camino de una prueba: es exactamente el punto 2 de los pendientes —«probar el círculo completo con
gente de verdad»— cobrándose lo suyo.

### El arreglo: el flujo reclama lo suyo, y lo lleva hasta el final

**1. Una fila más en la tabla de enrutado.** El núcleo no puede saber qué es un código de carrito
—eso es dominio (ADR-009)— pero sí puede *preguntar*. Un flujo declara opcionalmente
`reclama(texto)` al registrarse, y la política tiene una fila `flujo_reclama` que lo consulta. El
de restaurante reclama solo el pedido del menú: un «¿tienen sopa?» tiene que poder irse al modelo.

**2. El pedido lo termina el guion, no el modelo.** La cabecera del flujo defendía que pedir comida
no es un formulario, y es verdad *para quien pide escribiendo*. Un carrito ya armado es lo
contrario: los productos están elegidos, exactos y con su id; faltan dos datos. Eso es un
formulario de dos campos, y dárselo a un modelo era pagar por que lo hiciera peor.

```
← [carrito del menú]   → ¡Listo, ya tengo tu pedido! Son 3 productos. ¿A nombre de quién lo dejo? 📝
← Nicolás Pantoja      → Gracias, Nicolás. ¿A qué dirección te lo llevamos? 🛵
← Carrera 3e 19 a      → ¿Confirmo tu pedido a nombre de Nicolás Pantoja para Carrera 3e 19 a?
← sí                   → ¡Listo! Tu pedido quedó tomado. El número es ORD-77
```

Cuatro turnos, **cero tokens**, y nada que recordar. Los productos van en la **tarea** (ADR-014: lo
acotado y retomable) y no en `variables`, que es donde estaban antes — donde, dicho sea, **nadie
los leía nunca**: ni el modelo, que no ve las variables, ni el flujo, que cerraba sin tarea.

El sí sigue siendo del cliente: con los datos completos no se crea nada, se pide la confirmación
por el mismo camino que usa el modelo, y es el Policy Gate quien se niega a ejecutar sin la prueba
(ADR-010). Este flujo no tiene puerta trasera a `tomar_pedido`.

### Dos agujeros más que salieron al tirar del hilo

- **El «sí» del cliente se habría perdido igual.** Con una confirmación pendiente, la política
  manda el turno al Nivel 1 — y desde el 24 «Nivel 1» significa *el flujo de esta vertical*, que no
  sabía resolverla y caía en `delegar`: turno sin respuesta. Nadie lo vio porque hasta ahora
  ninguna confirmación de restaurante había llegado a abrirse. El flujo la atiende ahora, antes que
  nada.
- **`tarea_en_curso` comparaba contra la tarea de agendar**, literal, de cuando era la única que
  existía. La primera tarea de cualquier otra vertical se habría ido al modelo a mitad de camino.
  Ahora: cualquier tarea abierta es del flujo determinista.

### Y una decisión de producto

Si en vez del nombre llega una pregunta («¿y cuánto sale el domicilio?»), **no se apunta como
nombre** — un pedido a nombre de una pregunta manda al domiciliario a buscar a alguien que no
existe. Se repregunta, y el mensaje **siempre lleva la salida** («escríbeme *cancelar*»). La tarea
no se suelta sola: soltarla dejaría el carrito huérfano y habría que armarlo otra vez. Callarse
tampoco era opción — en este sistema el modo de fallo caro es el silencio, no la insistencia.

---


---

## El teléfono y el método de pago (2026-08-26)

El flujo del pedido pasó de tres huecos a cinco, y uno de ellos **solo aparece a veces**:

```
carrito → nombre → [teléfono] → dirección → [cómo paga] → confirmación
```

### `teléfono`: solo a quien llegó sin número

Es la consecuencia directa del BSUID. Un cliente que escribe por su nombre de usuario no trae
teléfono, y `tomar_pedido` guardaba `contacto_telefono` nulo: **el restaurante recibía un
domicilio sin nadie a quien llamar** cuando el domiciliario no encuentra la casa. No fallaba
nada; salía mal en la puerta.

Para todos los demás —hoy, casi todos— **no hay paso de más**: el teléfono ya lo probó el canal y
preguntarlo sería pedir dos veces lo que ya tienes.

Se dice **para qué** se pide: *«Es para que el domiciliario pueda llamarte cuando esté cerca.»*
Un bot que pide un teléfono sin explicarse parece que está recogiendo datos, y el motivo es real.

> ⚠️ **La línea que no se cruza:** ese número es **dato de contacto, nunca identidad**. Viaja en
> `cliente_telefono` y se guarda en `contacto_telefono`, pero la pertenencia de un pedido se
> sigue comprobando contra `principal.telefono_verificado` — que para este cliente sigue siendo
> nulo. **Decir un número no prueba que sea el tuyo**, y si valiera, cualquiera podría consultar
> el pedido de cualquiera diciendo su número. Hay una prueba que falla si alguien los mezcla.

### `cómo paga`: los métodos del negocio, con sus ids reales

Salen de `restaurante.rest_metodo_pago` (los mismos del POS) y se ofrecen como opciones, que el
canal pinta como botones o lista según cuántos haya. Los ids son los reales — la lección de la
categoría «2» del 24: no son ordinales.

La respuesta se resuelve **contra la lista que se enseñó**, en tres pasadas: id exacto (lo que
manda un botón), nombre exacto, y que uno contenga al otro («transferencia» ↔ «Transferencia
Nequi»). Si no se reconoce, **se repregunta**: un método de pago adivinado es una discusión en la
puerta con el domiciliario delante.

**Si el negocio no tiene métodos configurados, el paso se salta.** Quedarse sin poder vender
porque nadie llenó una tabla de catálogo sería cambiar un dato que falta por una venta que no se
hace.

La validación de que el método sea **de este negocio** no se repite aquí: ya la hace
`pedidoService.validarMetodoPagoParaNegocio`, con su error tipado. Una segunda versión de esa
comprobación es la que se queda vieja el día que la vertical cambie la regla.

### Un solo sitio decide el orden

`loQueFalta(datos, ctx)` devuelve el siguiente hueco, y saltarse un paso es no devolverlo. La
alternativa —cada paso decidiendo cuál va después— es donde se cuela el camino que nadie probó:
basta que dos de ellos discrepen sobre si el teléfono hace falta.

---

## Lo que queda pendiente

- **El bot va lento.** Señalado por el dueño el 2026-08-24 y aplazado. Sospecha razonable: la
  escalera sube al modelo más de lo necesario. **Se puede medir con el Ledger antes de tocar
  nada** — `intelligence.turno` tiene `nivel` y `latencia_ms`.
- **`generarNumeroOrden` es frágil.** Hace `CAST(SUBSTRING(numero_orden FROM 5) AS INTEGER)` sobre
  **todas** las órdenes del negocio: un número con otra forma deja al negocio sin poder crear
  pedidos. Los `TEST-*` que hay en la base de desarrollo sobreviven por casualidad (castean a
  negativo). No se tocó: está fuera del encargo, pero es una bomba de relojería.
- **La carta de pregonchos son datos de demo** («(demo)» en las descripciones) en un negocio real
  con caja abierta. Borrarla o reemplazarla si se usa de verdad.
- **`tomar_pedido` no pregunta exclusiones** («sin cebolla»). El dominio las soporta
  (`pedid_detalle_exclu`); la capacidad todavía no. El método de pago **ya se pregunta** desde el
  2026-08-26.
- **⚠️ Un pedido del bot NO entra en la pantalla de cocina.** `crearOrden` no toca
  `estado_cocina`, y el KDS filtra por `PENDIENTE|EN_PREPARACION|LISTO`: la orden queda `ABIERTA`
  y visible en el POS, pero **nadie en la cocina la ve** hasta que alguien le da a «enviar a
  cocina». Mientras eso no se decida, el seguimiento que consulta el cliente no se mueve.
- ~~No existe endpoint para asignar un domiciliario a un pedido ya creado.~~ **Resuelto
  2026-09-22**: `PATCH /pedidos/:id/domiciliario` (`pedidoService.asignarDomiciliario`), botón en
  el detalle del pedido en Despacho. Y desde el mismo día el pedido del bot **ya no nace sin
  domiciliario**: `tomar_pedido` lo asigna siempre (en turno primero, al azar si no hay nadie en
  turno) — ver "El resto de la petición" más abajo.
- **El arnés de evaluación no tiene ni una conversación de restaurante.** Sus tres suites son
  todas de `reserva`, así que un cambio de prompt como el de la `v3` no se puede medir donde
  más se nota. `enrutado` es gratis; `respuestas` cuesta unos centavos por tanda.

---

## `cancelar_pedido` y `consultar_cuenta` (2026-09-21)

Barrido de qué le falta al bot frente a lo que un cliente le pediría a un restaurante por
WhatsApp. De la lista completa, estas dos eran las únicas que no necesitaban construir nada
nuevo en el dominio — el resto (repetir pedido, modificar uno ya hecho, horario de atención,
promociones) sí lo necesita, y no se tocó. La tercera candidata, **consultar métodos de pago**,
se descartó a propósito: ver más abajo.

| Capacidad | Tipo | Qué hace |
|---|---|---|
| `cancelar_pedido` | **mutación** | Cancela un pedido del cliente, con confirmación |
| `consultar_cuenta` | consulta | Saldo de su tiquetera o de su cuenta fiada |

### `cancelar_pedido` no reutiliza `cancelarOrden`

`pedidoService.cancelarOrden` —la que usa Despacho— exige un `idUsuario` con permiso de rol
(`usuarioPuedeCancelarPedidoNoPagado`): la comprobación correcta para un empleado, sin sentido
para un cliente por WhatsApp, que no tiene ningún rol que darle. Tampoco acepta `{ transaction }`,
así que un dry-run del Gate la habría confirmado igual — el mismo obstáculo #1 que ya tuvo
`tomar_pedido`.

Se escribió `pedidoService.cancelarPorCliente(idOrden, { idNegocio, transaction })` aparte, con su
propia ventana de negocio: **la cocina no puede haber empezado a prepararlo**
(`estado_cocina IN (NULL, 'PENDIENTE')`). Pasado ese punto se rechaza con `ORDEN_EN_PREPARACION` y
el mensaje remite al restaurante — cancelar solo no debe poder tirar comida ya hecha. La
pertenencia se comprueba en el adaptador, igual que en `consultar_estado_pedido`, antes de llamar
al servicio.

### `consultar_cuenta` busca por teléfono, no por `id_cuenta`

El cliente no sabe su `id_cuenta`; lo único que tiene es su número. `cuentaService.buscarCuentaPorTelefono`
resuelve la fila de `platform.persona_negocio` por `telefono_e164` y de ahí la cuenta — el
mismo principio que `personaNegocioDao`, aplicado a un caso nuevo. Es opt-in por
`gener_negocio.permite_cuentas_cliente`, comprobado dentro de la capacidad y no solo con la
habilitación del Registry: son dos apagadores distintos (uno de dominio/Gate, otro del propio
negocio) que se pueden accionar en momentos distintos.

### Lo que se descartó: `consultar_metodos_pago`

Ya existió una capacidad con ese nombre exacto, retirada el 2026-08-27 (ver más abajo) porque
preguntar el método de pago dentro del flujo de pedido no convencía. Se construyó una versión
distinta —pasiva, sin tocar `tomar_pedido`, solo para cuando el cliente pregunta suelto— pero el
dueño prefirió no reabrir el tema todavía: el domiciliario cobra en la puerta, y así se queda por
ahora. Se retiró antes de desplegar; queda anotado por si alguna vez se retoma, para no repetir la
pregunta desde cero.

### Falta antes de que sirvan en producción

Como con toda capacidad nueva, `platform.capacidad_habilitada` no trae fila para negocios
existentes (por diseño: la ausencia deniega). Hace falta, por negocio real:

```bash
node scripts/capacidad.js habilitar cancelar_pedido --negocio <id>
node scripts/capacidad.js habilitar consultar_cuenta --negocio <id>
```

`consultar_cuenta` además solo sirve donde `permite_cuentas_cliente` esté encendido en
Configuración — hoy eso es un negocio a la vez, a mano.

### Seguimiento (mismo día): la cancelación dejó de ser muda

Un compañero preguntó, sin haber visto el código: *«si se cancela un pedido, ¿cómo aparece al
negocio?»*. La respuesta era: no aparece — la orden simplemente desaparece de Despacho, Cocina y
Mesas en tiempo real (el mismo aviso SSE que ya existía), sin dejar ningún rastro visible en
ninguna pantalla ni reporte. Para uno que cancela el propio empleado desde el panel, mirando la
pantalla, es correcto. Para uno que cancela **el cliente** por WhatsApp sin que nadie del negocio
tocara nada, es un hueco: el negocio solo nota que ya no está, nunca que pasó ni por qué.

Se cerró en tres piezas:

- **`pedid_orden.cancelado_por`** (`'cliente' | 'negocio'`, migración `restaurante-cancelado-por`).
  `cancelarOrden` (panel) escribe `'negocio'`; `cancelarPorCliente` (bot) escribe `'cliente'`.
- **`pedidoService.getOrdenesCanceladasRecientes`** — los cancelados de LLEVAR/DOMICILIO de
  **hoy**, con el mismo filtro de visibilidad por domiciliario que `getOrdenesDespacho`. Aparte
  y no mezclado con los activos: esto es una alerta de lo que acaba de pasar en el turno, no un
  historial — el historial ya existe, es la fila que nunca se borra.
- **`GET /despacho/cancelados`**, endpoint nuevo y no un campo más del `/despacho` de siempre,
  para no cambiarle la forma de la respuesta a quien ya lo consume. En `restaurante_app`, un
  chip «Cancelados hoy (N)» —mismo patrón que el chip de WhatsApp, solo aparece si hay
  alguno— abre un panel chico con quién lo canceló.

No se tocó nada de lo que ya existía: `getOrdenesDespacho` sigue devolviendo exactamente lo mismo
que devolvía, y un pedido cancelado sigue desapareciendo de la vista principal al instante — eso
seguía siendo correcto. Lo que cambió es que ahora hay un sitio, aparte, donde no se pierde.

### El resto de la lista del compañero (2026-09-21)

Las otras tres preguntas que hizo por WhatsApp, en el mismo hilo, con lo que se encontró y lo
que se cerró de cada una:

**«¿El sistema valida los domiciliarios?»** No, casi nada: `id_domiciliario` solo pasaba por
`isInt({ min: 1 })` en el controlador y por la FK a `gener_usuario` en la base — que exista un
usuario con ese id EN CUALQUIER PARTE del sistema, nunca que sea domiciliario **de este
negocio**. `pedidoService.esDomiciliarioValido` cierra el hueco: reutiliza la misma regla de dos
caminos de `listarDomiciliarios` (personal propio o rol DOMICILIARIO) pero comprobando un
candidato, y `crearOrden` la exige antes de crear la orden (`DOMICILIARIO_INVALIDO`, 422).

**«¿Cómo el negocio puede bloquear un número?»** No existía — solo el cliente podía llegar a
`estado = 'bloqueada'`, escribiendo STOP/BAJA, y eso es irrevocable salvo por un super admin
desde la Consola (ADR-023). Ahora la Bandeja (`/admin/bandeja`, la del propio negocio, no la
Consola) tiene `bloquear`/`desbloquear`. La pieza que lo hace seguro:
`intelligence.conversacion.bloqueada_por` (`'cliente' | 'negocio'`, migración
`intelligence-bloqueada-por`) distingue quién lo puso, para que el negocio pueda deshacer **su
propio** bloqueo sin que eso le abra una puerta trasera a deshacer la baja legal de un STOP real
— `desbloquear` se niega en seco si `bloqueada_por` no es `'negocio'`.

**«¿Se puede editar un pedido ya realizado?»** Desde el panel (POS), sí, desde siempre
(`agregarItemsOrden`/`quitarItemsOrden`). Desde WhatsApp, no podía — el cliente solo podía
cancelar. Se cerró la mitad que pedía el compañero: **`agregar_items_pedido`**, para un
"también quiero..." sobre un pedido que ya puso. No reutiliza `agregarItemsOrden` — esa conoce
método de pago, cuenta, multipago, descuento y domicilio, y nada de eso es una decisión que el
cliente deba tocar por WhatsApp, y tampoco acepta transacción externa (el mismo obstáculo #1 de
siempre) — sino `pedidoService.agregarItemsPorCliente`, con la MISMA ventana que
`cancelar_pedido`: la cocina no puede haber empezado a prepararlo. **Quitar** ítems por WhatsApp
se dejó fuera a propósito: `quitarItemsOrden` empareja por producto + exclusiones + nota para
decidir qué detalle reducir, y exponer esa ambigüedad a un modelo que interpreta lenguaje
natural — "quítame la hamburguesa" ¿cuál, si pidió dos distintas? — es más riesgo del que vale
la pena para la primera tanda. Se puede añadir después si hace falta de verdad.

Las tres, con sus tests, corridas contra la base local: 1020 pruebas en verde.

### Falta antes de que sirvan en producción (actualizado)

```bash
node scripts/capacidad.js habilitar cancelar_pedido --negocio <id>
node scripts/capacidad.js habilitar consultar_cuenta --negocio <id>
node scripts/capacidad.js habilitar agregar_items_pedido --negocio <id>
```

Y las migraciones nuevas, en cualquier entorno donde no se hayan corrido:

```bash
npm run migrate:restaurante-cancelado-por
npm run migrate:intelligence-bloqueada-por
```

### Cuatro ajustes pedidos tras el primer uso real (2026-09-21, tarde)

- **Domicilio del bot sin nadie que lo lleve.** `tomar_pedido` ahora elige un domiciliario AL
  AZAR (`pedidoService.elegirDomiciliarioAlAzar`, mismo criterio arbitrario que
  `elegirProfesional` en `reserva`) antes de crear un pedido a DOMICILIO. Si el negocio no tiene
  ningún domiciliario registrado, se rechaza (`SIN_DOMICILIARIO_DISPONIBLE`) en vez de crear un
  domicilio que nadie va a llevar. **Ojo con esto al habilitar en un negocio nuevo**: sin
  domiciliarios cargados, ese negocio no podrá tomar NINGÚN pedido a domicilio por WhatsApp
  hasta que registre al menos uno.
- **El error crudo de stock llegaba después de que el cliente ya había pedido.** Ahora
  `consumirIngredientesPorItems` apaga solo (`disponible = false`) cualquier producto —no solo
  el que se acaba de pedir, cualquiera que comparta el ingrediente que se quedó sin stock— cuya
  receta ya no alcance para una unidad más. Es de una sola vía a propósito: no vuelve a
  encenderse solo al reabastecer, eso lo decide el negocio a mano desde la carta, por si lo
  había apagado por otra razón.
- **Los textos de cancelar y agregar, reescritos a pedido del dueño**: la confirmación de
  `cancelar_pedido` ahora nombra los productos del pedido, no el número («¿Estás seguro de
  cancelar tu pedido de: 2 Hamburguesa doble?»); el aviso de hecho es «Tu pedido fue
  cancelado.», sin el número. `agregar_items_pedido` avisa en el mismo mensaje que el precio
  puede variar por empaques y domicilio.

1034 tests en verde contra la base local.

### El resto de la petición: horarios, reasignar domiciliario, y el aviso de domicilio (2026-09-22)

- **El Policy Gate ahora prueba en seco ANTES de preguntar.** El fallo real: el cliente decía
  que sí a "¿confirmo tu pedido?" y ahí se enteraba de que el restaurante estaba cerrado —
  `requireCajaAbierta` vive dentro de `ejecutar`, y sin confirmación el Gate nunca llegaba a
  llamarlo. Ahora, cuando `dryRun: true` y falta confirmar, el Gate deja seguir la ejecución en
  seco (se deshace siempre) y solo AL FINAL, si todo iría bien, deniega por falta de
  confirmación. `manejadorLlm.js` ya hacía esa llamada de prueba antes de preguntar; solo hacía
  falta que el Gate la dejara llegar hasta el dominio.
- **`restaurante.rest_horario`** (`migrate:restaurante-horario`): mismo patrón que
  `reserva.reserva_horario` pero en tabla propia (ADR-005). `id_usuario NULL` = horario del
  negocio; con valor = de ese domiciliario. Sin nada cargado, no restringe nada — ni al negocio
  ni a la asignación de domiciliarios.
  - `tomar_pedido` ahora comprueba el horario ANTES que la caja, con tres mensajes distintos:
    fuera de horario (invita a mirar la carta mientras tanto), en horario pero caja cerrada
    ("aún no abre"), y normal.
  - `elegirDomiciliarioAlAzar` ahora prefiere a quien esté EN TURNO ahora mismo
    (`horarioService.usuariosEnTurnoAhora`); si nadie lo está, cae al azar entre todos, como
    antes.
  - Pantalla nueva `/horarios` en `restaurante_app` (`ADMINISTRADOR` únicamente por ahora):
    mismo editor semanal que ya existía en `reserva_app`, sin los bloqueos puntuales — no se
    pidieron, y un restaurante que cierra un día concreto simplemente no abre la caja ese día.
- **`pedidoService.asignarDomiciliario`** — `PATCH /pedidos/:id/domiciliario`: hasta ahora
  `id_domiciliario` solo se podía fijar al CREAR la orden. Reutiliza `esDomiciliarioValido`.
  Botón nuevo en el detalle de un pedido en Despacho (selector, solo para DOMICILIO).
- **`pedido_en_camino`**, plantilla nueva para el aviso de domicilio («el domiciliario va en
  camino», en vez de «puedes pasar a recogerlo»). `avisoPedido.plantillaParaTipo` elige la
  correcta según `tipo_pedido`; `puede_avisar_listo` ahora es cierto para LLEVAR y DOMICILIO,
  antes solo para LLEVAR. **⚠️ Esta plantilla NO está aprobada en Meta todavía** — hace falta
  someterla al WhatsApp Manager antes de que el envío funcione en producción, exactamente como
  pasó con `pedido_listo` el 2026-09-10. Hasta entonces, un intento de avisar un domicilio
  fallará en el envío (`dead letter`), no en el código.

1061 tests en verde contra la base local (más los que ya había).

### El primer mensaje y la carta escrita (2026-09-22)

Tres ajustes chicos, vistos en una conversación real de producción (`Restaurante pregonchos`):

- **«Qué dice»** —un saludo colombiano tan corriente como «qué más» o «qué tal», que ya
  funcionaban— no abría la bienvenida: `esSaludo` exige que TODAS las palabras sean de saludar,
  y «dice» no estaba en la lista (`intelligence/engine/texto.js`). Se agregó.
- **El botón «Pedir por aquí» del saludo se quitó.** El propio texto del saludo ya dice «dime
  por aquí qué se te antoja»; el botón repetía la misma oferta al lado. El camino de texto
  libre sigue abierto igual (`pedir por aquí` / `por chat` se reconocen sueltos).
- **`consultar_carta` sin argumentos ya NO devuelve el catálogo completo — devuelve el enlace y
  un índice de categorías (nombre, id, cuántos productos), sin productos.** Antes el modelo se
  llevaba la carta entera y la transcribía en el chat como una lista de "Entradas / Platos /
  Bebidas" con precio por línea: literalmente peor que el menú digital, que ya tiene fotos.
  El fallo del 2026-08-24 que motivó devolver el catálogo completo —el modelo adivinando un
  id_categoria para no tener que preguntar— sigue resuelto por otra vía: el índice le sigue
  dando los ids reales, y ahora hay un tercer camino que entonces no existía (el enlace), así
  que ya no hace falta preguntarle al cliente «¿cuál categoría?» para evitar inventar un id.
  Preguntar por una categoría o un producto concreto (`id_categoria`, `buscar_producto`) sigue
  devolviendo el detalle completo de esa parte — eso no es "el menú escrito", es contestar lo
  que se preguntó.

1068 tests en verde contra la base local (más los que ya había).

### El saludo ya dice si el negocio está atendiendo (2026-09-22, mismo día)

Reportado en producción: el bot seguía conversando normal aunque el negocio estuviera fuera de
horario. La causa: el horario y la caja solo se comprobaban DENTRO de `tomar_pedido` —el cliente
tenía que llegar hasta intentar confirmar un pedido para enterarse de que estaba cerrado, y un
«hola» a las 3 de la tarde recibía «arma tu pedido» aunque el negocio abriera a las 5.

- **`horarioService.estadoDeAtencion({ idNegocio, ahora })`** — nueva función que cruza horario y
  caja en un solo sitio, devolviendo uno de cuatro estados: `fuera_de_horario`, `aun_no_abre`,
  `cerrado_sin_horario`, `abierto`. Vive en `horarioService` (no en el adaptador) para que
  `tomar_pedido` y el saludo lean la misma clasificación — dos copias de esta decisión son
  exactamente la clase de cosa que diverge (ver `gener_rol_nivel` en `CLAUDE.md`).
  - **No** reemplaza el chequeo de `tomar_pedido`: ese sigue usando
    `cajaService.requireCajaAbierta` con su transacción y su lock, porque ahí sí importa que la
    caja no pueda cerrarse entre la comprobación y la creación de la orden. `estadoDeAtencion` es
    una lectura informativa sin transacción — para decidir qué DECIR, no para crear nada.
- **`bienvenida()` en `flujo.js` ahora es async** y llama a `estadoAtencion` (inyectable, como
  `gate`/`identidad`) antes de saludar. Cuatro variantes de texto, una por estado — la de
  `abierto` es la de siempre.
- Confirmado contra producción: `Restaurante pregonchos` (id 12) sí tenía el horario cargado
  (17:00–23:59 casi todos los días); el bug no era falta de configuración, era que el saludo
  nunca la leía.

1076 tests en verde contra la base local (más los que ya había).

### El menú digital también respeta el horario (2026-09-22, mismo día)

Reportado por el dueño: la carta pública seguía dejando armar un carrito y abrir el modal de
WhatsApp aunque el negocio estuviera fuera de horario — el bot era el único que lo comprobaba, y
el cliente solo se enteraba después de escribir.

- `GET /restaurante/public/negocios/:id` ahora incluye `atencion: { estado }`, la misma
  clasificación que ya usa el saludo (`horarioService.estadoDeAtencion`). Si falla la lectura,
  se responde `abierto` (falla abierto): es un gesto de la carta, no la comprobación que de
  verdad protege la creación de la orden — esa sigue siendo `requireCajaAbierta` dentro de
  `tomar_pedido`, con su transacción y su lock.
- `menu-publico.ts`: `puedePedir` ahora exige también `atendiendoAhora()`. Un solo computed
  gobierna todos los botones de "agregar" y el FAB de "ver mi pedido" — no hubo que tocarlos uno
  a uno. La carta se sigue viendo entera; solo se avisa con una franja (`avisoAtencion`) que
  ahora mismo no se puede pedir, con un texto distinto para cada uno de los tres estados
  cerrados.

1079 tests en verde contra la base local (más los que ya había).

---

## Cierre de la sesión del 2026-09-22

Todo lo de esta fecha (horarios de atención, domiciliario siempre asignado, reasignarlo desde
Despacho, saludo consciente del horario, "qué dice", menú público sin transcribir la carta, y
el menú digital respetando el horario) quedó **desplegado y verificado en producción**, no solo
commiteado: commit real confirmado con `git log` en el VPS después de cada `pull` (nunca el
mensaje del comando), servicio reiniciado sin errores en los logs, y para el frontend los
hashes de los chunks comparados byte a byte entre el build local y `/var/www/html/restaurante`.

**Lo único que sigue bloqueado por fuera del código:**

- **La plantilla de WhatsApp `pedido_en_camino` no está aprobada por Meta.** El botón de avisar
  "va en camino" ya aparece en Despacho para pedidos a domicilio, pero el envío real fallará
  (controladamente, no revienta nada) hasta que se someta esa plantilla al WhatsApp Manager —
  mismo trámite pendiente que `pedido_listo` en su momento.

**Para retomar:** este archivo tiene la historia completa en orden; la sección "Lo que queda
pendiente" (arriba) es la lista viva de deuda técnica conocida y no específica de una sola
sesión — conviene revisarla antes de tocar el bot de restaurante otra vez.
