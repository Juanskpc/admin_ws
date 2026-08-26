# El asistente en un restaurante, y el pedido desde el menú digital

**Estado al 2026-08-25:** en producción, atendiendo `Restaurante pregonchos` (`id_negocio` 12) en
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
- **`tomar_pedido` no pregunta método de pago ni exclusiones** («sin cebolla»). El dominio las
  soporta (`pedid_detalle_exclu`); la capacidad todavía no.
- **El arnés de evaluación no tiene ni una conversación de restaurante.** Sus tres suites son
  todas de `reserva`, así que un cambio de prompt como el de la `v3` no se puede medir donde
  más se nota. `enrutado` es gratis; `respuestas` cuesta unos centavos por tanda.
