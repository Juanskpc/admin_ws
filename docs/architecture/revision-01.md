# Revisión Arquitectónica #1 — EscalApp Intelligence

**Propósito:** congelar la arquitectura antes de la primera línea de código.
**Naturaleza:** revisión crítica del Plan Maestro. No lo reemplaza; lo corrige.
**Fecha:** 2026-07-13

**Veredicto general:** de tus diez puntos, **acepto siete tal como los planteas**, **acepto dos con una corrección importante** (el WebChat y la Consola), y **uno me lleva a eliminar un módulo entero de mi propio plan** (el Tool Registry). Además, la revisión destapó **un riesgo que ninguno de los dos estaba viendo** (§11.2) y **una tensión irreversible en `platform.persona`** que hay que resolver antes de escribir la primera migración (§7).

---

## 1. WebChat como primer canal

### Veredicto: **ACEPTADO — pero con una corrección que cambia su naturaleza**

Tienes razón, y es una mejora sobre mi plan. Telegram parecía "gratis" pero no lo es: sigue siendo un webhook externo, con su formato, sus reintentos y su cuenta que administrar. Ruido que no aporta nada a la validación del motor.

**Pero hay una trampa en tu razonamiento, y es importante.**

Las virtudes que enumeras —control absoluto, sin webhooks, sin latencia, sin límites— son exactamente **las mismas propiedades que van a ocultar los bugs que WhatsApp va a exponer**. Un WebChat construido de la forma natural (petición HTTP síncrona → el servidor procesa → devuelve la respuesta en el mismo *response*) es un canal *amable*: no tiene entregas asíncronas, ni mensajes duplicados, ni reordenamiento, ni reintentos, ni entregas fallidas.

Si construimos ese WebChat, los criterios de aceptación de la Fase 5 (el test de ráfaga, el test de continuidad, el ordenamiento FIFO) se vuelven **infalsificables**: pasarán siempre, y no porque el motor esté bien, sino porque el canal nunca lo puso a prueba. Y entonces todos esos bugs aparecerán juntos, por primera vez, el día que conectemos WhatsApp — que es exactamente el día en que menos queremos descubrirlos.

### La corrección: el WebChat no es un canal amable. Es un **simulador hostil**.

El WebChat debe atravesar **exactamente el mismo camino asíncrono** que atravesará WhatsApp:

```
Widget → ingesta (responde 202 inmediato, NO la respuesta del bot)
       → cola FIFO particionada por conversación
       → worker
       → cola de salida
       → entrega asíncrona al widget (SSE o polling)
```

Nada de request/response síncrono. Si el WebChat devuelve la respuesta del bot en el mismo HTTP, no estamos probando el motor: estamos probando una función.

Y va más allá: como es **nuestro**, podemos hacer algo que ningún canal externo nos deja hacer — **inyectar fallos a voluntad**. Ese es su verdadero valor como herramienta de desarrollo, y es un valor que Telegram no tiene:

| Fallo inyectable | Qué bug del motor caza |
|---|---|
| Duplicar un mensaje entrante | Deduplicación por `id_externo` |
| Reordenar dos mensajes | Cola FIFO por conversación |
| Ráfaga de 5 mensajes en 1 segundo | Debounce de agregación y bloqueo |
| Retrasar la entrega saliente 30 s | Continuidad; que el motor no asuma entrega inmediata |
| Fallar la entrega saliente | Reintentos y *dead letter* |
| Matar el worker a mitad de turno | Persistencia del turno; idempotencia |

**Ésta es la razón real por la que el WebChat reduce el riesgo, y es más fuerte que la que tú diste.** No es solo que evita dependencias externas: es que es el **único canal que podemos hacer *peor* que la realidad a propósito**. Un motor que sobrevive a nuestro simulador hostil sobrevivirá a WhatsApp. Un motor que solo sobrevive a un WebChat amable no ha sido probado.

**Bonus:** el WebChat no es código desechable. Es un canal de producto real (widget en el sitio web del negocio) y probablemente sea el canal donde el asistente demuestra su mejor UX, porque no tiene la ventana de 24 horas.

**Cambio al plan:** F5 usa WebChat propio como único canal. Telegram desaparece del roadmap (no aporta nada que WhatsApp no vaya a aportar mejor). El **Simulador de Fallos** es un entregable explícito de F5, no un extra.

---

## 2. Victoria temprana / Intelligence Console

### Veredicto: **ACEPTADO EL PROBLEMA — RECHAZADA LA SOLUCIÓN PROPUESTA**

El problema que señalas es real y no lo estaba tratando con suficiente seriedad. Cuatro fases sin nada visible es un riesgo de ejecución genuino, y en una startup de una persona el riesgo de ejecución mata más proyectos que el riesgo técnico.

**Pero una consola con datos simulados es una trampa, y quiero ser muy claro en por qué.**

Construir una UI contra datos que todavía no existen significa inventar las formas de esos datos. Esas formas van a cambiar en cuanto los datos sean reales — y entonces tendremos que reescribir la consola, con la sensación desmoralizante de haber trabajado para nada. Peor: una consola bonita sobre datos falsos **da una falsa sensación de progreso**, que es precisamente el fallo que dices querer evitar. No mide el avance real; lo simula.

### La victoria temprana ya está en el plan y no la habíamos visto

**La Fase 0 (Persona) produce, gratis, la funcionalidad más demo-able y comercialmente valiosa de toda la Ola A: la Ficha 360 del Cliente.**

En cuanto `platform.persona` existe y las cinco verticales apuntan a ella, el panel admin puede mostrar, para un teléfono cualquiera: *"Juan Pérez. Cliente desde marzo. 3 pedidos a domicilio en el restaurante, 2 citas en el salón, 1 no-show. Última interacción: hace 6 días."*

Eso:
- Es **valor real**, no andamiaje. Se puede vender hoy.
- Es **demo-able ante un cliente** sin mencionar la palabra IA.
- Es **prueba visible de que la Fase 0 funcionó**, y su calidad se ve de un vistazo (si la ficha está vacía o duplicada, el backfill falló).
- **No altera la arquitectura** en absoluto: es una vista de lectura.

Ésa es la victoria temprana. Es mejor que una consola simulada porque es *cierta*.

### Y la Consola sí se construye — pero con datos reales, y fusionada con Observabilidad

La Intelligence Console no merece una fase propia. Merece ser **la superficie de visualización del módulo de Observabilidad (§5)** — son la misma cosa vista desde dos lados. Nace en F5, cuando el bot determinista produce **conversaciones reales** (con turnos reales, capacidades reales, estados reales, decisiones reales), y crece con cada fase:

| Fase | Qué muestra la Consola |
|---|---|
| F5 | Conversaciones, mensajes, estado, turnos, capacidades ejecutadas, errores. **Sin IA: costo = $0**, y eso también se muestra. |
| F6 | + Nivel que resolvió el turno, modelo, tokens, costo, latencia, aciertos de caché |
| F7 | + Tomar el control (handoff), auditoría de lo que hizo la IA |

La Consola es, además, **la herramienta de depuración principal del desarrollador**. Sin ella, depurar una conversación fallida significa leer logs. Con ella, significa mirar una pantalla. Para un equipo de una persona, eso no es un lujo: es multiplicador de velocidad.

**Cambio al plan:**
- Nueva victoria temprana explícita: **Ficha 360 del Cliente**, entregable de F0.
- La Consola es un entregable de F5 (con datos reales), no una fase, y se fusiona con Observabilidad.
- **Prohibido construirla con datos simulados.**

---

## 3. Knowledge como bounded context

### Veredicto: **ACEPTADO SIN RESERVAS. Reservar el dominio ahora es casi gratis y no hacerlo es caro.**

Tienes toda la razón, y la distinción es más profunda de lo que planteas. No son "dos conceptos parecidos": son **dos cosas con propiedades técnicas opuestas**, y confundirlas tiene una consecuencia concreta y costosa.

| | **Business Context** (configuración) | **Knowledge** (conocimiento) |
|---|---|---|
| Naturaleza | Estructurada, pequeña, escrita a mano | No estructurada, grande, ingerida |
| Volumen | Cientos de bytes | Megabytes por inquilino |
| Cambia | Rara vez, por el dueño del negocio | Al subir un PDF, cambiar el menú… |
| **En el prompt** | **Va SIEMPRE, en el prefijo estable** | **Va SELECTIVAMENTE, recuperado por turno** |
| **Respecto al caché** | **Es parte del prefijo cacheado** | **Va DESPUÉS del punto de corte** |
| Autoridad | Es una instrucción para el asistente | Es un dato que el asistente consulta |

**La última fila es la que decide.** Si metemos el menú de un restaurante o el reglamento de un gym dentro de Business Context, ocurre una de dos cosas, ambas malas: o el prompt se infla hasta hacerse insostenible, o —peor— cada vez que el negocio suba un PDF nuevo **se invalida el prefijo cacheado de todas sus conversaciones**, y el costo se multiplica por diez sin que nadie entienda por qué.

Es un error de categoría con factura mensual.

### Qué significa "reservar el dominio" sin implementarlo

Reservar cuesta prácticamente nada, y son tres cosas:

1. **Nombrarlo.** Existe un bounded context `knowledge`. Está declarado. Nadie más puede ocupar ese terreno.
2. **Blindar Business Context.** Regla explícita: *Business Context contiene solo configuración e instrucciones. Si alguien quiere meter contenido, va a Knowledge.* Sin esta regla, el primer FAQ que aparezca se cuela en Business Context "temporalmente" y ahí se queda para siempre.
3. **Dejar el hueco en el Prompt Builder.** El ensamblador tiene una ranura de "conocimiento recuperado", **después** del punto de corte del caché. En v1 esa ranura está vacía. El día que Knowledge exista, se llena, y **no hay que rediseñar nada**.

### La v1 de Knowledge no es RAG, y probablemente no lo sea en mucho tiempo

Cuando llegue el momento (no ahora), la primera implementación de Knowledge es **una tabla de pares pregunta/respuesta aprobados por el negocio**, recuperados por coincidencia determinista (Nivel 1). Cero embeddings, cero pgvector, cero pipeline de ingesta.

Eso resuelve el 80% de los casos reales de una PyME (*"¿tienen parqueadero?"*, *"¿aceptan tarjeta?"*, *"¿cuál es la dirección?"*) a coste cero y con **respuestas aprobadas, no generadas** — que además es mejor producto, porque el negocio controla lo que se dice.

RAG con embeddings llega el día que un inquilino suba un PDF de 40 páginas. Puede que ese día no llegue nunca, y eso estaría bien.

**Cambio al plan:** `knowledge` se declara como bounded context reservado. Business Context se blinda. El Prompt Builder nace con la ranura. Cero implementación.

---

## 4. Escalera de dos niveles

### Veredicto: **CONFIRMADO. Y quiero ser preciso sobre qué cuesta exactamente "diseñar para cuatro".**

Estamos de acuerdo. Pero "diseñado para cuatro, implementado con dos" es una frase que puede significar dos cosas muy distintas, y una de ellas es sobreingeniería disfrazada de previsión.

**Lo que NO significa:** una fábrica abstracta de niveles, un registro de estrategias enchufables, una jerarquía de clases de "resolvedores". Eso es ceremonia. Si construimos eso, hemos implementado los cuatro niveles con dos vacíos.

**Lo que SÍ significa — exactamente tres cosas, ni una más:**

1. **La decisión de enrutado es una política, no un `if/else`.** El orquestador consulta una tabla de reglas (*"turno con mutación → nivel máximo"*, *"comando conocido → nivel 1"*). Añadir un nivel es añadir filas, no reescribir el orquestador.
2. **El `ModelPort` es el único camino hacia un modelo.** Ya está en el plan. Un nivel nuevo es un adaptador nuevo, no una cirugía.
3. **Cada turno registra qué nivel lo resolvió, con qué costo y con qué resultado.** Esto es lo que va a **generar la evidencia** que algún día justifique (o desmienta) el Nivel 3. Sin este registro, la decisión de añadir niveles sería una corazonada. Con él, es un dato.

Eso es todo. Si la abstracción cuesta más que esas tres cosas, es prematura.

### Un matiz que quizá no estás viendo, y que puede hacer que el Nivel 3 nunca llegue

Con el modelo de **Capacidades** (§8), el prompt del Nivel 4 es **pequeño**: unas 8 capacidades, no 40 endpoints. Y con el prefijo cacheado bien ordenado, el contexto repetido cuesta ~0.1×. La consecuencia es que el turno premium **puede resultar mucho más barato de lo que la intuición sugiere**.

Es perfectamente posible que, con los datos en la mano, el Nivel 3 nunca se justifique — y que el Nivel 2 (Ollama, con su servidor de inferencia y su costo operativo permanente) no se justifique **jamás**. Eso sería una victoria del diseño, no una carencia del roadmap.

**La inversión real no es en niveles: es en que el Nivel 1 sea genuinamente bueno.** Es el único nivel que nunca falla, nunca cuesta, nunca alucina y nunca se cae. Cada turno que el Nivel 1 resuelve es un turno perfecto. Ahí es donde hay que poner el esfuerzo.

---

## 5. Observabilidad

### Veredicto: **DOMINIO ACEPTADO — FASE PROPIA RECHAZADA. Y hay que subirle el listón de fiabilidad.**

Tienes razón en que falta como dominio de primera clase. Pero **una fase implica un principio y un fin**, y la observabilidad no termina nunca. Convertirla en fase garantiza que se haga una vez y se pudra después.

**Lo correcto es convertirla en una condición de aceptación de todas las fases:**

> **Ninguna fase se da por terminada si su comportamiento no es observable.** No hay entregable sin su métrica.

Eso es más fuerte que una fase, porque no se puede posponer ni recortar.

### Pero hay una parte que SÍ exige diseño anticipado, y es más seria de lo que parece

El **Ledger de decisiones y costos** (`turno`, `decision`, `tool_call`, `costo`) es de escritura única y lectura múltiple, alto volumen, e **irreversible**: las preguntas que no puedas responder sobre las conversaciones de hoy, no las podrás responder nunca, porque el dato no se registró. No hay forma de reconstruirlo retroactivamente.

Así que su esquema se diseña **antes del primer turno**, en F5, tomando tu lista de doce preguntas como especificación literal. Si el esquema no responde a las doce, está mal diseñado.

### La observación que eleva esto de "telemetría" a "contabilidad"

Aquí hay algo importante que quiero que consideres: **el costo por conversación no es una métrica de operaciones. Es un insumo de facturación.**

Determina el margen por inquilino, alimenta los límites del plan (`Básico` / `Avanzado`), y decide si un cliente es rentable o te está costando dinero. Eso significa que el ledger de costos **no puede ser telemetría de mejor esfuerzo** — con muestreo, con pérdidas aceptables, con reintentos que se descartan. Tiene el **listón de fiabilidad de la contabilidad**: se escribe transaccionalmente, no se pierde, y cuadra.

Esa distinción cambia dónde vive y cómo se escribe: el ledger de costos va en `intelligence`, se escribe en la misma transacción que el turno, y **no es un log**. Los logs se pueden perder. Esto no.

**Cambio al plan:** Observabilidad es un requisito transversal de aceptación, no una fase. El Ledger se diseña en F5 contra las 12 preguntas. El costo se trata con estándar contable, no de telemetría.

---

## 6. Agnosticismo de vertical

### Veredicto: **ACEPTADO, y tu prueba es buena — pero le falta un artefacto para ser accionable**

Tienes razón en que el roadmap huele a reservas. Pero quiero separar dos cosas que se confunden fácilmente:

- **El núcleo debe ser agnóstico.** Innegociable. ✅
- **El piloto debe ser una vertical concreta.** Eso no es acoplamiento: es validación. **No se puede validar un contrato de capacidades en abstracto.** Un núcleo agnóstico que nunca se ha ejercitado contra un dominio real es un núcleo no probado.

Así que la pregunta correcta no es *"¿el roadmap menciona reservas?"* — es *"¿el núcleo contiene código que sabe qué es una cita?"*

### El artefacto que falta: el **Contrato de Adopción de una Vertical**

Esto es lo que convierte tu principio en algo ejecutable. En vez de fases con nombre de vertical, definimos **el peaje** que cualquier vertical debe pagar para ser adoptada por Intelligence. Se escribe una vez y sirve para las seis, para la veterinaria y para las que no existen todavía.

**Una vertical es adoptable cuando cumple las seis condiciones:**

1. **Adopta `platform.persona`** (`id_persona` nullable, poblado en registros nuevos).
2. **Protege sus invariantes en el dominio**, no en el formulario. (El test: atacar su API directamente con entradas hostiles y que las rechace.)
3. **Emite sus eventos de dominio al outbox** de `platform`, en todas sus transiciones.
4. **Publica su manifiesto de capacidades** (máx. ~10, acciones de negocio, no CRUD).
5. **Tiene su Capability Adapter** (que compensa lo que el dominio no pueda arreglar — ver Grupo 1).
6. **Aporta sus conversaciones doradas** al arnés de evaluación.

Con esto, la "Fase 3 (saneamiento de reserva)" y la "Fase 9 (restaurante)" dejan de ser fases especiales: son **dos aplicaciones del mismo contrato**. Y añadir la veterinaria en 2028 es *trabajo de vertical*, no *trabajo de plataforma*. Que es exactamente lo que querías.

### Y una prueba que podemos hacer YA, gratis, antes de escribir el Registry

Ésta es la propuesta concreta más valiosa de esta sección:

> **Antes de construir el Capability Registry, escribe en papel el manifiesto de capacidades de RESTAURANTE.** No lo implementes. Solo redáctalo, junto al de reservas, y comprueba que **el metamodelo del Registry puede expresar los dos sin cambiar**.

Es un ejercicio de dos horas que valida (o destruye) la promesa de extensibilidad **antes** de haber invertido semanas en el Registry. Si al escribir `crear_pedido` descubrimos que el metamodelo no sabe expresar "una capacidad que puede ejecutarse muchas veces en la misma conversación acumulando estado" (que es un pedido, y no es una cita), **es mucho mejor descubrirlo en papel que en producción.**

Reservas y restaurante son deliberadamente distintos —cita puntual e idempotente vs. carrito acumulativo y mutable— y esa diferencia es justo la que va a estresar el metamodelo. Hazlo con esos dos.

**Cambio al plan:** se define el Contrato de Adopción de una Vertical. El manifiesto de restaurante se redacta en papel **antes** de construir el Registry.

---

## 7. `platform.persona` como pilar de la plataforma

### Veredicto: **CONFIRMADO — pero hay una tensión irreversible que debemos resolver AHORA**

Estás en lo correcto y es la decisión más importante del proyecto. La IA usa Persona; Persona no pertenece a la IA. Congelado.

Pero al someterla a la prueba de los diez años que pides, **aparece una grieta**, y quiero ponerla sobre la mesa antes de que escribamos la primera migración, porque después es carísima.

### La grieta: mencionaste "Portal del cliente", "app móvil" y "marketplace"

Mi diseño hacía a Persona **única por negocio**: el mismo teléfono en dos negocios son dos personas. Esa regla existe por una razón de peso (impedir la fuga de datos entre inquilinos, que es el peor incidente posible en un SaaS multi-tenant) y **no la voy a relajar**.

Pero es incompatible con lo que tú mismo listaste como futuro:

> Un **Portal del Cliente** donde Juan entra una vez y ve *sus* citas del salón, *sus* pedidos del restaurante y *su* membresía del gym — de tres negocios distintos.

Si Persona es estrictamente por negocio, Juan son tres personas que no se conocen, y **ese portal no puede existir**. Nunca. Y descubrirlo en 2028, con las seis verticales ya apuntando a `persona`, significa migrar la identidad de toda la plataforma.

### La resolución: dos niveles (el modelo Party / Party-Role)

Es un patrón clásico y resuelve la tensión sin sacrificar el aislamiento:

```
platform.identidad          ← el SER HUMANO. Global. TRANSVERSAL a inquilinos.
  · id_identidad
  · telefono_e164 (único GLOBAL), email
  · SOLO IDENTIFICADORES. Cero PII. Cero historial. Cero nombre.
        │
        │ 1:N
        ▼
platform.persona            ← la RELACIÓN de ese humano con UN negocio.
  · id_persona                 (Es lo que las verticales referencian.)
  · id_negocio                 Aquí SÍ viven: nombre, notas, etiquetas,
  · id_identidad (nullable)    consentimiento, historial.
  · nombre_mostrado, ...       Un negocio JAMÁS ve la persona de otro.
        │
        ▼
   reserva_cita.id_persona · pedid_orden.id_persona · gym_miembro.id_persona ...
```

**La clave del aislamiento es la línea que dice "SOLO IDENTIFICADORES".** `identidad` es una **llave de resolución**, no un perfil. No contiene ningún dato que se pueda filtrar, porque no contiene ningún dato. Sirve para responder una sola pregunta: *"¿el humano detrás de la persona A del negocio 1 es el mismo que el de la persona B del negocio 2?"* — y esa pregunta **solo la puede hacer el Portal del Cliente, autenticado por el propio Juan**, jamás un negocio.

Un negocio nunca puede navegar de su `persona` hacia `identidad` y de ahí a otro negocio. Esa ruta simplemente no existe en su nivel de autorización.

### Mi recomendación, sopesando el costo

Tengo que ser honesto sobre el riesgo de generalidad especulativa aquí. Pero el criterio es claro: **¿es el portal un futuro *declarado* o un futuro *imaginado*?** Tú lo declaraste explícitamente en la sección 7 de tu revisión. Entonces no es especulación: es hoja de ruta.

**Recomendación: modelar los dos niveles ahora, activar solo uno.**

- `platform.persona` (por negocio) es la entidad **operativa** desde el día uno. Todo lo que construimos la usa.
- `platform.identidad` **existe como tabla y como columna nullable `persona.id_identidad`**, y **no se puebla**. Cero lógica, cero funcionalidad, cero coste de ejecución.
- El día que llegue el Portal, se puebla y se activa. **Sin migrar seis esquemas.**

El costo hoy: una tabla vacía y una columna nullable. El costo de no hacerlo: la migración más dolorosa imaginable, sobre la entidad más referenciada de la plataforma, con clientes en producción.

**Es la asimetría más favorable de todo el proyecto. Pero es tu decisión, y es irreversible.**

### Otra decisión irreversible escondida: `persona` ≠ `gener_usuario`

Cuando llegue el Portal del Cliente, Juan necesitará autenticarse. La tentación será darle un registro en `general.gener_usuario`.

**No lo hagas.** `gener_usuario` está diseñado para el **personal** del negocio: tiene roles, niveles, permisos, pertenencia a negocios. Meter ahí a millones de clientes finales rompe todas sus suposiciones, infla la tabla más crítica de `general` (que está congelado) y mezcla dos poblaciones con ciclos de vida y modelos de seguridad opuestos.

La autenticación del cliente final vive en `platform`, no en `general`. Se decide ahora, aunque se implemente en tres años.

**Nombre:** `persona`, no `contacto`. Un "contacto" es un *rol* de una persona (alguien a quien contactas). "Persona" es el sustantivo durable. Si el vocabulario es correcto desde el principio, el modelo tiende a mantenerse correcto.

---

## 8. Capability Registry

### Veredicto: **FORMALIZAR LA CAPACIDAD, SÍ. Y ELIMINAR EL TOOL REGISTRY DEL PLAN.**

Ésta es mi mayor simplificación, y va contra mi propio documento anterior.

Tu instinto es correcto: la IA debe pensar en capacidades de negocio. Pero al llevarlo hasta el final, la conclusión es más radical de lo que planteas:

> **El Tool Registry no debe existir.**

### El razonamiento

En mi Plan Maestro hablé de Capability Registry **y** Tool Registry, como si fueran dos catálogos. Al revisarlo, esa dualidad no se sostiene. Pregunté: *¿quién consulta el Tool Registry?*

- ¿El modelo? **No** — el modelo solo ve capacidades. Ésa es la decisión que ya tomamos.
- ¿El orquestador? **No** — orquesta capacidades.
- ¿El Policy Gate? **No** — autoriza capacidades.
- ¿Otra capacidad? **No** — las herramientas no se comparten entre capacidades; si dos capacidades necesitan el mismo paso, eso es una **función compartida**, no una herramienta registrada.

Nadie lo consulta. Un registro que nadie consulta no es un registro: es ceremonia. Registro, descubrimiento, esquemas y políticas para unas "herramientas" que solo se llaman a sí mismas desde dentro de una capacidad.

**Las "herramientas" son detalles de implementación privados de una capacidad.** `reservar_turno` internamente busca disponibilidad, toma un *hold*, crea la cita y emite un evento — pero eso es **un guion transaccional**, código normal, no un sistema de plugins. No necesita registro, ni esquema, ni política, ni descubrimiento. Necesita una transacción.

### Lo que sí se gana con esta eliminación

1. **Un solo catálogo, un solo vocabulario.** No hay que explicarle a nadie (ni a un desarrollador futuro, ni a mí dentro de un año) la diferencia entre dos registros.
2. **La superficie de riesgo es exactamente el catálogo de capacidades.** Auditar la seguridad del sistema = leer una lista de ~10 entradas por vertical. Con dos registros, la pregunta *"¿qué puede hacer la IA?"* tiene una respuesta ambigua.
3. **Menos código, menos abstracción, menos mantenimiento.** Para un equipo de una persona, eso es decisivo.

### La colisión de vocabulario que hay que resolver de una vez

Los proveedores de LLM llaman "tools" a su mecanismo de *function calling*. Eso crea confusión permanente. La resolución, y quiero que quede fijada:

> **Nuestras Capacidades se *renderizan como* las "tools" del proveedor, dentro del adaptador del `ModelPort`. La palabra "tool" pertenece exclusivamente a la capa del adaptador de proveedor. En el resto del sistema, la palabra no existe.**

Si en el núcleo aparece la palabra "tool", es un síntoma de que una abstracción se filtró.

**Cambio al plan: el Tool Registry se elimina.** Existe un único **Capability Registry**. La Fase 4 se simplifica en consecuencia.

---

## 9. Roadmap para una startup de una persona

### Sobreingeniería que elimino (además del Tool Registry)

| Elemento | Veredicto | Razón |
|---|---|---|
| **Tool Registry** | **ELIMINADO** | §8. Nadie lo consulta. |
| **Planner como módulo** | **ELIMINADO** como subsistema | Con capacidades bien cortadas, un plan son 1–3 capacidades. El bucle del LLM *ya es el planner*. Se promueve a módulo solo con evidencia de fallos multi-paso. |
| **Niveles 2 y 3** | **APLAZADOS** | §4. Solo la política de enrutado y el registro del nivel usado. |
| **Ollama en producción** | **APLAZADO, posiblemente para siempre** | Es un sistema nuevo (inferencia en el EC2, un modelo que versionar, algo más que monitorizar) a cambio de un ahorro hipotético. |
| **pgvector / embeddings** | **APLAZADO** | §3. La v1 de Knowledge son pares pregunta/respuesta. |
| **Adaptadores multi-proveedor** | **UNO** | El puerto es la abstracción; una implementación es la realidad. |
| **Extracción de `intelligence` a servicio propio** | **APLAZADO** | La costura está diseñada (sin FKs a verticales). Se ejecuta si la carga lo pide. |
| **Telegram** | **ELIMINADO** | §1. El WebChat hostil lo sustituye con ventaja. |
| **Backfill de gym / parqueadero / tienda** | **ELIMINADO** | **No tienen datos en producción.** No hay nada que rellenar: simplemente adoptan `id_persona` desde el nacimiento. El backfill real es solo `restaurante` (y `reserva`, si tuviera datos). Esto reduce la Fase 0 sustancialmente. |

Ese último punto es un error que arrastraba mi Plan Maestro: hablé de "backfill desde las cinco fuentes" cuando **tres de esas fuentes están vacías**. La Fase 0 es bastante más pequeña de lo que la pinté.

### Lo que NO recorto, aunque sea tentador

| Elemento | Por qué se queda |
|---|---|
| **Fase 5 (bot determinista)** | Es la fase que retira el 70% del riesgo. Recortarla mezcla los bugs de infraestructura con los de IA y los hace indistinguibles. **Es la fase que más se va a querer recortar y la que menos debería.** |
| **Arnés de evaluación** | Sin él, cambiar un prompt es superstición. Pero **acotado**: 20–30 conversaciones doradas en un archivo, no una "plataforma de evaluación". |
| **Modo dry-run de las capacidades** | Es barato y es el cimiento del arnés y de la depuración para siempre. |
| **Particionado de `intelligence`** | Gratis hoy con la tabla vacía. Un proyecto entero con 300 millones de filas. |
| **Consola de Handoff** | Es la válvula de escape que hace aceptable el riesgo de todo lo demás. Sin ella, ningún negocio real conecta su WhatsApp a esto — y con razón. |
| **Ledger de costos** | §5. Es contabilidad, no telemetría. Y determina si el negocio es rentable. |

### El coste real de la evaluación, que no había considerado

Correr 30 conversaciones doradas contra el modelo premium en **cada** *commit* cuesta dinero de verdad. Mitigación: el arnés corre por defecto en **dry-run** (capacidades simuladas, sin tokens); la evaluación completa con modelo real corre **bajo demanda y una vez al día**, no en cada push.

---

## 10. Principio fundamental: Intelligence nunca es dependencia de las verticales

### Veredicto: **ES EL PRINCIPIO MÁS IMPORTANTE DEL DOCUMENTO. Y valida dos decisiones anteriores.**

Al auditar el Plan Maestro contra este principio, encontré que **lo respeta**, pero que su cumplimiento depende de cosas que no estaban dichas explícitamente. Ahora lo están.

### La aparente contradicción que hay que resolver: ¿dónde vive el Capability Adapter?

Aquí hay una trampa lógica que quiero desactivar, porque parece que los principios 6 y 10 se contradicen:

- Si el adapter vive **dentro de la vertical**, entonces la vertical tiene un módulo cuya única razón de existir es servir a Intelligence → **la vertical depende de Intelligence. Viola el principio 10.**
- Si el adapter vive **dentro de Intelligence**, entonces Intelligence contiene código que sabe qué es una cita → *¿viola el principio 6 (agnosticismo)?*

**Resolución: el adapter vive en Intelligence, y NO viola el agnosticismo.** La respuesta hexagonal es que el **núcleo** es agnóstico y los **adaptadores son, por definición, el lugar donde vive el acoplamiento**. Para eso existen.

```
intelligence/
  core/        ← Engine, Orchestrator, Registry, Prompt Builder, Policy Gate
               ← JAMÁS sabe qué es una cita. El `git diff = 0` aplica AQUÍ.
  adapters/
    reserva/   ← Sabe qué es una cita. Consume el contrato público de reserva.
    restaurante/ ← Sabe qué es un pedido.
```

La dirección de la dependencia es **Intelligence → Vertical**, siempre. La vertical no sabe que Intelligence existe. Exactamente lo que pides.

### Las tres reglas que hacen cumplir el principio (y son verificables automáticamente)

**Regla 1 — Una vertical NUNCA llama a Intelligence. Jamás.**
Si `reserva` quiere que se envíe una confirmación por WhatsApp al crear una cita, **no llama a Intelligence**. Emite `cita.creada.v1` al outbox de `platform` y **se olvida**. Intelligence se suscribe y decide qué hacer. La vertical no sabe que hay un asistente, ni le importa.
*Verificable en CI:* cero imports y cero llamadas HTTP desde el código de una vertical hacia `intelligence`. Un `grep` lo comprueba.

**Regla 2 — El outbox vive en `platform`, NUNCA en `intelligence`.**
Ésta es la razón profunda por la que la separación en dos esquemas era correcta y no cosmética. Si el outbox viviera en `intelligence`, entonces **las verticales tendrían que escribir en el esquema de la IA para emitir sus eventos** — y ahí, exactamente ahí, la IA se volvería una dependencia obligatoria del dominio. El principio 10 **valida la decisión del §6 del Plan Maestro**.

**Regla 3 — `id_persona` es SIEMPRE nullable en las verticales.**
No es solo una comodidad de migración: es el enforcement del principio. Una vertical debe poder crear una cita, una orden o una venta **sin Persona y sin Intelligence**, y funcionar perfectamente. Un `NOT NULL` convertiría a `platform` en dependencia dura. Nullable = la vertical existe por sí misma.

### El corolario que hay que aceptar con todas sus consecuencias

> **Si mañana apagamos EscalApp Intelligence entera, las seis verticales deben seguir funcionando exactamente igual. Ni un endpoint roto, ni un formulario caído, ni una migración pendiente.**

Ése es el test definitivo del principio 10, y es un test que se puede *ejecutar de verdad*: apagar el módulo en un entorno de pruebas y correr la suite de las verticales. Si algo falla, hay una violación.

Y ese test también es la mejor defensa comercial que tenemos: **si la apuesta por la IA sale mal, no perdemos EscalApp.**

---

## 11. Riesgos que NO estábamos viendo

Me pediste que buscara lo que se nos escapa. Encontré cuatro. El segundo me parece el más grave y no está en ninguno de los dos documentos.

### 11.1 — Los datos del dominio cambian **mientras** la conversación está en curso

El cliente está hablando con el asistente para reagendar su cita de las 3. A mitad de la conversación, **la recepcionista cancela esa cita desde el panel de Angular**.

El asistente tiene el estado viejo en su contexto y sigue razonando sobre una cita que ya no existe.

**Es un fallo real, es frecuente, y es invisible en las pruebas** (porque en las pruebas nadie toca la base a mano mientras corre el test).

**Regla que hay que fijar:** *el contexto conversacional es una **pista**, nunca un **hecho**. La única fuente de verdad del dominio son las capacidades, y se consultan en el momento de actuar.* Una capacidad de mutación **relee y revalida** el estado dentro de su transacción; nunca confía en lo que el modelo cree recordar de tres turnos atrás.

### 11.2 — El asistente puede **prometer** algo que la capacidad no respalda ⚠️

Éste es el que más me preocupa y no lo habíamos visto ninguno de los dos.

Nuestro diseño garantiza que la IA **no puede hacer** nada fuera de las capacidades. Pero **no le impide *decir* cualquier cosa**:

> *"Claro, te hago un 20% de descuento por ser cliente frecuente."*

Ninguna capacidad se ejecutó. Ningún dato se corrompió. El Policy Gate está impecable. Y sin embargo **el negocio tiene ahora un cliente que llegará mañana esperando su descuento**, con una promesa por escrito de un agente que actuaba en nombre del negocio.

Toda nuestra arquitectura de seguridad protege la **base de datos**. Ninguna protege la **palabra del negocio** — que es, literalmente, el producto que estamos vendiendo ("un empleado virtual").

**Mitigaciones a considerar (no resuelto, y hay que decidirlo antes de F7):**
- Política dura en el Business Context (*"nunca ofrezcas descuentos, precios o condiciones que no vengan de una capacidad"*). Necesario, pero es una instrucción — y las instrucciones se pueden eludir con inyección.
- **Guardarraíl de salida:** una comprobación posterior a la generación que detecta compromisos (cifras, descuentos, promesas de tiempo) no respaldados por el resultado de una capacidad de este turno, y los bloquea o escala a humano. Es la única defensa *estructural*.
- Registro de todo lo prometido, para que el negocio pueda auditar qué dijo su empleado virtual.

Es un riesgo de **producto y de responsabilidad legal**, no de datos. Y es específico del producto que queremos vender.

### 11.3 — PII colombiana saliendo hacia un proveedor extranjero

Las conversaciones contienen datos personales de ciudadanos colombianos (Ley 1581 de 2012), y se envían a un proveedor de LLM en el extranjero. Esto exige, como mínimo: base legal para la transferencia internacional, consentimiento informado, y un acuerdo de tratamiento de datos con el proveedor.

**No es un riesgo técnico: es un riesgo de negocio que puede detener el producto.** Y es exactamente el tipo de cosa que se descubre tarde. Conviene resolverlo antes del MVP comercial, no después del primer cliente empresarial que lo pregunte.

*Nota:* esto es también el argumento **no económico** a favor del Nivel 2 local — no por costo, sino por soberanía del dato. Si algún día es la ley la que empuja hacia Ollama, será una razón mucho mejor que el ahorro.

### 11.4 — El handoff a un humano que está durmiendo

La válvula de escape asume que hay alguien al otro lado. A las 11 de la noche, en una barbería de un solo dueño, no lo hay.

El handoff necesita un **comportamiento definido cuando nadie responde**: un mensaje honesto al cliente (*"le respondemos por la mañana"*), una expectativa clara, y una cola para el humano. Un handoff que deja al cliente en silencio es peor que un bot que se equivoca.

---

## 12. Cambios concretos al Plan Maestro

| # | Cambio | Impacto |
|---|---|---|
| 1 | **WebChat propio como único canal de desarrollo**, construido como **simulador hostil asíncrono** con inyección de fallos. Telegram eliminado. | F5 |
| 2 | **Ficha 360 del Cliente** como victoria temprana visible. | F0 |
| 3 | **Intelligence Console fusionada con Observabilidad**, con datos reales. Prohibidos los datos simulados. | F5+ |
| 4 | **`knowledge` reservado** como bounded context. Business Context blindado a configuración. Ranura vacía en el Prompt Builder. | Transversal |
| 5 | **Escalera: solo Niveles 1 y 4.** "Diseñado para cuatro" = política de enrutado + `ModelPort` + registro del nivel usado. Nada más. | F6 |
| 6 | **Observabilidad = criterio de aceptación de toda fase**, no una fase. **Ledger de costos con estándar contable.** | Transversal |
| 7 | **Contrato de Adopción de una Vertical** (6 condiciones). Reemplaza las fases con nombre de vertical. | Transversal |
| 8 | **Manifiesto de restaurante en papel ANTES de construir el Registry.** | Antes de F4 |
| 9 | **`platform.identidad`** (global, solo identificadores) + **`platform.persona`** (por negocio). La primera se modela y no se puebla. | F0 — **IRREVERSIBLE** |
| 10 | **Autenticación del cliente final NUNCA en `gener_usuario`.** | F0 — **IRREVERSIBLE** |
| 11 | **Tool Registry ELIMINADO.** Solo Capability Registry. | F4 |
| 12 | **Planner eliminado** como subsistema. | F6 |
| 13 | **Backfill solo de `restaurante`.** Las otras tres verticales no tienen datos. | F0 (reduce alcance) |
| 14 | **Regla:** una vertical nunca llama a Intelligence. Solo emite eventos. Verificable en CI. | Transversal |
| 15 | **Regla:** el contexto conversacional es una pista, nunca un hecho. Las capacidades revalidan. | F4 |
| 16 | **Guardarraíl de salida** contra promesas no respaldadas. | F7 — sin resolver |
| 17 | **Test del apagón:** apagar Intelligence y correr la suite de las verticales. Debe pasar. | Transversal |

---

## 13. Las decisiones que hay que tomar ANTES de la primera línea de código

Son cuatro. Todas irreversibles. Ninguna requiere código para decidirse.

1. **¿Existe `platform.identidad` (global) desde el día uno, aunque esté vacía?**
   Mi recomendación: **sí**. Cuesta una tabla vacía y una columna nullable. No hacerlo condena el Portal del Cliente, que tú mismo declaraste como futuro. Es la asimetría de riesgo más favorable del proyecto — pero es tu llamada, y es definitiva.

2. **¿Confirmamos que el cliente final nunca vivirá en `gener_usuario`?**
   Mi recomendación: **sí, confirmado**. Poblaciones distintas, modelos de seguridad distintos, y `general` está congelado.

3. **¿Se elimina el Tool Registry?**
   Mi recomendación: **sí**. Nadie lo consulta. Un catálogo, un vocabulario.

4. **¿Aceptamos el riesgo 11.2 (promesas no respaldadas) como pendiente hasta F7, o lo diseñamos ahora?**
   Mi recomendación: **decidirlo antes de F7, pero anotarlo hoy como riesgo abierto y aceptado.** No debe descubrirse en producción, con un cliente reclamando un descuento que nadie autorizó.

Y una tarea de media hora, la más barata y la más informativa de todas: **medir la calidad de los teléfonos en `restaurante`**. Si el 40% es irrecuperable, la Ficha 360 nace coja justo en la única vertical con clientes reales, y prefiero saberlo antes de prometerla.

---

## 14. Estado de la arquitectura tras esta revisión

**Más simple que ayer.** Un registro en vez de dos. Un canal en vez de dos. Dos niveles en vez de cuatro. Sin planner, sin embeddings, sin Ollama, sin backfills fantasma.

**Y más sólida.** Con la identidad resuelta a diez años, con un contrato de adopción que hace que la séptima vertical cueste lo mismo que la segunda, con un principio de independencia que es *ejecutable* (el test del apagón), y con dos riesgos de producto identificados que ninguno de los dos veía.

Yo la congelaría aquí.
