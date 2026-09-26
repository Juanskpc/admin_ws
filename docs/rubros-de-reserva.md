# Los rubros del módulo `reserva`: qué aguanta el motor y qué no

**Estado:** análisis y plan, **nada implementado** · **Fecha:** 2026-09-15 ·
**Relacionado:** [ADR-003](adr/ADR-003-madurez-esquemas.md) (la ventana que se está cerrando) ·
[ADR-005](adr/ADR-005-independencia-verticales.md) · [`mejoras-flujo-agenda.md`](mejoras-flujo-agenda.md)

> **Actualización 2026-09-17:** el plan que sale de este diagnóstico está en
> [`perfiles-de-reserva.md`](perfiles-de-reserva.md). Corrige dos cosas de aquí: alojamientos
> **sí entra** en `reserva`, como un segundo motor (`ESTANCIA`) separado del de citas (§3.6 sigue
> valiendo como razón para esa separación), y mascotas se modela con `reserva_mascota` concreta, no
> con un `reserva_sujeto` genérico (§9.2).

> Pregunta de origen: «`reserva_app` hoy se usa para barberías. ¿Qué hace falta para venderla a
> salones de belleza, guarderías de mascotas, alojamientos, spas, tatuadores y centros de estética?»
>
> **Respuesta corta:** cuatro de los seis ya caben casi sin tocar nada —y el trabajo que parecía
> pendiente (des-barberizar la app) **está hecho**. Uno necesita una entidad nueva. Y uno de ellos
> no es un rubro de `reserva`: es otra vertical, y meterlo aquí rompe el motor.

---

## 1. Lo que ya está resuelto (y conviene saber antes de planear nada)

Tres cosas que el código ya hace y que cambian el tamaño del problema:

**1.1 — El oficio y el módulo ya están separados.** La migración `migrate_rubros_negocio.js`
(2026-09-10) partió `gener_tipo_negocio` en dos trabajos: `id_rubro` en `gener_negocio` es lo que el
cliente dice ser, `id_tipo_negocio` es el módulo que lo atiende. Bajo el módulo `RESERVA` ya hay
**siete rubros sembrados**: Barbería, Salón de belleza, Peluquería, Spa / Estética, Uñas, Masajes,
Consultorio. Encender un rubro nuevo es **una fila** (`INSERT ... ON CONFLICT`), no un cambio de
código — `getRubros()` lo deriva solo. De los seis que preguntas, tres ya están ofrecidos.

**1.2 — La app no está escrita en idioma de barbería.** Lo comprobé contando ocurrencias en
`reserva_app/src`: `profesional` 435, `servicio` 378, `cita` 755, `cliente` 229… y `barber` **7**,
todas en comentarios, specs o un placeholder (`usuarios.html:389`, «Barbería, colorimetría…»).
`peluquer` y `sede`: **cero**. El vocabulario ya es el genérico de agenda. **No hay un trabajo de
re-etiquetado pendiente.** Esto invalida la hipótesis más natural del planteamiento.

**1.3 — Ya existe el sitio donde van las perillas por inquilino.** `reserva.reserva_config` es una
fila por negocio con `anticipacion_min_horas`, `buffer_limpieza_min`, `ventana_cancelacion_horas`,
`paso_slot_min`, `cobro_adelantado`, `permite_cobro_profesional`, `permite_multipago`,
`exige_caja_abierta`. Es la tabla correcta para todo lo que viene. **No repitas aquí la ruta de
5 puntos de los flags de `gener_negocio`** que se usó en restaurante: esa ruta cuesta cinco ficheros
por interruptor y aquí harían falta diez o quince. `reserva_config` ya viaja entera.

Y una cuarta, menor pero útil: los clientes **no** tienen tabla propia, son
`platform.persona_negocio` (ver `clienteService.js`). Ese es exactamente el gancho que necesita el
rubro de mascotas.

---

## 2. El eje que decide todo: los cinco supuestos del motor

`reglasAgenda.js` es un módulo bien hecho —dos primitivas, `intervalosLaborales()` e
`intervalosOcupados()`, y tanto ofrecer una hora como aceptarla pasan por las mismas. Esa calidad
importa: significa que ampliarlo es tocar **dos funciones**, no diez. Pero tiene cinco supuestos
cableados, y **cada rubro nuevo se juzga contra ellos**:

| # | Supuesto | Dónde vive |
|---|---|---|
| **S1** | Una cita pertenece a **un profesional**, obligatoriamente | `reserva_cita.id_profesional NOT NULL`; `calcularSlots` exige `idProfesional` |
| **S2** | Una cita **cabe dentro de un día** | `intervalosLaborales({fechaISO})` arma los huecos desde `reserva_horario.dia_semana` + `hora_inicio/fin` |
| **S3** | Un servicio tiene **duración fija y precio único** | `reserva_servicio.duracion_min`, `.precio` |
| **S4** | El profesional está **ocupado todo el rato** que dura la cita | `intervalosOcupados` expande el intervalo completo ± buffer |
| **S5** | El **sujeto** del servicio es el cliente que reserva | `reserva_cita.cliente_nombre/telefono/email`, sin más |

Capacidad > 1 no existe: un hueco lo consume una cita. Recurso distinto de persona (sala, cabina,
silla, camilla) tampoco existe.

---

## 3. Los seis rubros contra esos supuestos

| Rubro | S1 | S2 | S3 | S4 | S5 | Veredicto |
|---|:--:|:--:|:--:|:--:|:--:|---|
| **Salón de belleza** | ✅ | ✅ | ⚠️ | ❌ | ✅ | Cabe hoy; cojea en color/mechas |
| **Spa** | ⚠️ | ✅ | ✅ | ✅ | ⚠️ | Cabe hoy; le falta la cabina |
| **Centro de estética** | ⚠️ | ✅ | ⚠️ | ✅ | ⚠️ | Cabe hoy; le falta ficha y consentimiento |
| **Tatuador** | ✅ | ⚠️ | ❌ | ✅ | ✅ | Cabe hoy; le falta depósito y presupuesto |
| **Cuidado de mascotas** | ✅ | ⚠️ | ❌ | ✅ | ❌ | Necesita entidad nueva |
| **Alojamientos** | ❌ | ❌ | ❌ | ❌ | ⚠️ | **No es este módulo** |

### 3.1 Salón de belleza — ya vendible, con un agujero real

Ya es un rubro sembrado y el demo (`id_negocio=10`) se llama «Salón Demo EscalApp». Funciona.

**El agujero es S4, y no es cosmético.** Una coloración son 30 min de aplicación, **45 de espera con
el tinte puesto** y 30 de lavado y peinado. Durante esos 45 minutos la estilista está libre y atiende
a otra clienta —es así como un salón gana dinero—. Hoy el motor le bloquea los 105 minutos enteros,
así que el sistema **le vende menos capacidad de la que tiene**. Ese es el momento en que el dueño
deja de usar la app y vuelve al cuaderno: no porque falte una pantalla, sino porque el software le
miente sobre su propia agenda.

Esto es **tiempo de proceso**, y es el cambio de más valor de todo el documento.

### 3.2 Spa — cabe, pero el recurso escaso no es la persona

En un spa la restricción real suele ser **la cabina**, no la masajista: tres terapeutas y dos salas
significan dos citas simultáneas, no tres. Hoy no hay forma de decirlo. Funciona igual si el negocio
tiene tantas salas como profesionales, que es el caso pequeño —y el caso pequeño es tu mercado—, así
que **no bloquea la venta**, pero se rompe en cuanto el spa crece.

Segundo detalle: los paquetes y bonos («10 masajes»). Existe `tiqueteras-y-fiado.md` para
restaurante; aquí no hay nada. Lo dejaría fuera de la primera ronda.

### 3.3 Centro de estética — cabe, pero es el que más papel mueve

Técnicamente igual que un spa. La diferencia es de **obligación, no de agenda**: láser, peelings y
aparatología piden **consentimiento informado firmado**, contraindicaciones y ficha con historial por
sesión. Hoy `reserva_cita.notas` es un `TEXT` suelto y no hay nada por cliente.

Vale la pena ser franco aquí: un negocio que hace procedimientos con riesgo va a comparar tu app con
software específico que ya trae eso. Puedes venderle la agenda, pero **no le vendas la ficha clínica
hasta que exista**, y ojo con lo que promete el copy — el mismo criterio de
[`obligaciones-escalapp.md`](obligaciones-escalapp.md).

### 3.4 Tatuador — el más fácil de los que faltan, y el que más pide depósito

No está sembrado como rubro. Añadirlo es una fila. Estructuralmente es una barbería con sesiones
largas, y encaja en S1/S4/S5 sin tocar nada.

Lo que sí necesita:

- **Depósito / anticipo parcial.** `cobro_adelantado` hoy es un booleano y `reserva_cita` guarda
  `monto_total` con `requiere_pago`, `pago_estado` y `comprobante_pago_url`. Es todo-o-nada: no hay
  «abona $50.000 de un trabajo de $400.000». Un tatuador **no agenda sin seña**, porque el hueco que
  pierde son seis horas. Sin esto el rubro no se sostiene.
- **Precio y duración no fijos (S3).** El precio sale de un presupuesto, no del catálogo. Hoy
  `duracion_min` y `precio` son obligatorios en el servicio y se copian a `reserva_cita_servicio`
  como snapshot. Hace falta permitir servicio «a presupuestar»: duración y precio se fijan en la
  cita, no en el catálogo.
- **Sesiones múltiples** (un trabajo grande son 3 citas). Se puede vivir sin ello al principio.

### 3.5 Cuidado de mascotas — la única que pide una entidad nueva

Rompe **S5**, y no se puede fingir. Quien reserva es el dueño; **el sujeto del servicio es el
animal**, y el animal tiene especie, raza, tamaño, temperamento y vacunas. Meter «Firulais, French
Poodle, 8 kg» en `cliente_nombre` o en `notas` es la clase de atajo que parece barato el primer mes y
hace inservibles los informes el tercero: no podrás responder «¿cuántos baños de perro grande
hicimos?», que es justo lo que el negocio quiere saber.

La buena noticia es que el sitio existe: los clientes ya son `platform.persona_negocio`, así que la
mascota es una **dependiente** de esa fila, y `reserva_cita` gana una FK nullable. Nullable importa:
los otros cinco rubros no la usan y no deben enterarse.

También rompe S3 de forma dura: el precio de un baño depende del **tamaño del perro**, no del
servicio. Es la misma necesidad de «variantes» que pide el tatuador y que pide el salón (largo de
cabello), y por eso conviene resolverla **una vez**.

Y roza S2: la guardería de día («lo dejo a las 8, lo recojo a las 6») cabe porque es intradía. La
guardería **con pernoctación** no cabe, y es el mismo problema que alojamientos (§3.6).

### 3.6 Alojamientos — el que hay que dejar fuera, y por qué

Este es el punto en el que conviene que sea antipático, porque parecen el mismo producto —«una
agenda»— y no lo son.

| | Cita | Estancia |
|---|---|---|
| Unidad de tiempo | slot de minutos dentro de una jornada | **noche**, fuera de jornada |
| Recurso | una persona | una **habitación** (inventario, no agenda) |
| Precio | del catálogo | **por noche y variable** (temporada, ocupación, mínimo de noches) |
| Disponibilidad | huecos = horario − bloqueos − citas | ¿hay alguna habitación **de este tipo** libre las 3 noches? |
| Cierre | se completa y se cobra | check-in, consumos, check-out, factura |

`intervalosLaborales()` arranca con `inicioDelDia(fechaISO)` y arma los huecos del día a partir de
`reserva_horario.dia_semana`: **una reserva de tres noches no se puede expresar**, porque el
algoritmo no sabe mirar más allá de la medianoche. Y el buffer de limpieza —que en alojamiento sí
existe de verdad— no se mide en minutos entre citas sino en «la habitación se libera a las 11 y se
entrega a las 15».

Se puede forzar: una habitación como «profesional», una noche como «servicio» de 1440 minutos.
Funcionaría una semana y luego convertiría `reglasAgenda.js` en dos algoritmos disfrazados de uno,
que es **exactamente el error del que ese archivo nació para salir** (léelo: existe porque la misma
regla estaba escrita dos veces y divergió). El coste no lo pagaría alojamientos; lo pagarían las
barberías que ya facturan.

**Recomendación: alojamientos es una vertical nueva (`app_hospedaje_api` + esquema `hospedaje`), no
un rubro de `reserva`.** Y no es la siguiente: es la más cara de las seis y la que menos reusa. Si
quieres validar demanda antes de construirla, véndela como lista de espera.

---

## 4. Lo que hace falta de verdad, ordenado por lo que desbloquea

Siete capacidades. Ninguna es una pantalla nueva; todas son el motor.

| # | Capacidad | Rubros que la piden | Dónde toca | Tamaño |
|---|---|---|---|---|
| **C1** | **Tiempo de proceso** — el profesional se libera en medio de la cita | Salón, estética | `reserva_servicio` (+2 col), `intervalosOcupados`, `calcularSlots` | M |
| **C2** | **Depósito parcial** — abono a cuenta, no todo-o-nada | Tatuador, spa, estética | `reserva_cita`, `cobroService`, vitrina | M |
| **C3** | **Variantes de servicio** — precio/duración por tamaño, largo, zona | Mascotas, tatuador, salón | tabla nueva `reserva_servicio_variante` | M |
| **C4** | **Sujeto del servicio** — la mascota (mañana, el paciente) | Mascotas | tabla nueva colgada de `persona_negocio` + FK nullable en `reserva_cita` | M |
| **C5** | **Recurso además del profesional** — cabina, sala, silla | Spa, estética | tabla nueva + tercer término en `intervalosOcupados` | **L** |
| **C6** | **Ficha e historial por cliente/sujeto** | Estética, mascotas, tatuador | tabla nueva, sin tocar el motor | M |
| **C7** | **Consentimiento informado** archivado | Estética, tatuador | se apoya en C6 + `uploads/` | S |

Dos observaciones críticas sobre esta lista:

- **C1, C2 y C3 son las que deciden si el rubro se puede vender.** C4 abre un rubro entero. C5, C6 y
  C7 son «lo hace mejor», no «lo hace posible». Si el tiempo es escaso: las tres primeras y parar.
- **C5 es la única grande**, y es la única que toca el corazón de `reglasAgenda`: hoy los intervalos
  ocupados se calculan **por profesional**; con recursos pasan a ser la unión de dos disponibilidades
  distintas. Es un cambio de forma, no de tamaño. Y es la que menos urge: un spa de dos cabinas no la
  necesita.

### 4.1 La perilla que NO hay que añadir

La tentación es un booleano por diferencia (`permite_tiempo_proceso`, `usa_mascotas`,
`exige_consentimiento`…). No lo hagas. Quince booleanos son quince decisiones que el dueño de una
barbería tiene que entender para llegar a su pantalla de configuración, y ninguna le importa.

Lo correcto es un **preset por rubro**: al crear el negocio, `id_rubro` decide los valores de partida
de `reserva_config`, las categorías, los servicios de ejemplo y qué columnas se muestran. El negocio
puede cambiarlo todo después; el rubro solo elige el punto de partida. Es una tabla de semilla, no
una rama en el código — el mismo principio que ya aplicó `getRubros()`: encender algo es una fila en
la base.

---

## 5. Tipos de usuario

Hoy `migrate_reserva.js` siembra **tres roles** para `RESERVA`: `ADMINISTRADOR`, `RECEPCIONISTA`,
`PROFESIONAL`, con 16 acciones finas (`migrate_reserva_subniveles.js`) y ajuste por negocio que
**puede añadir**, no solo recortar.

**Ese modelo aguanta los seis rubros sin un rol nuevo.** Lo que cambia entre rubros es el reparto, no
el catálogo:

| Rubro | Reparto real | ¿Rol nuevo? |
|---|---|---|
| Salón, spa, estética | Dueño + recepción + N profesionales. Es el caso para el que se diseñó | No |
| Tatuador | A menudo **una sola persona** = las tres cosas. Sobra recepcionista, no estorba | No |
| Mascotas | Recepción + bañadores. Un «auxiliar» sin caja = `PROFESIONAL` + acciones añadidas | No |

Hay **una** cosa que sí falta y no es un rol: el profesional que trabaja por **comisión** quiere ver
lo suyo y nada más. `permite_cobro_profesional` ya liquida por persona al cerrar caja, pero no hay
una acción tipo `informes_ver_propios`. Es una fila en el catálogo de acciones (la migración es
idempotente, se vuelve a correr). Cuesta poco y lo van a pedir los tres rubros de belleza.

⚠️ Y un aviso operativo que ya mordió una vez: **los roles son por tipo de negocio**. Cambiar el
`id_tipo_negocio` de un negocio existente deja a sus usuarios con el rol del tipo viejo y la sesión
llega vacía — está documentado en `tipoNegocioOperativo.js` y resuelto por `remapearRolesDeNegocio`,
que **aborta** si algún rol no tiene homónimo. Con rubros esto ya no debería pasar (el módulo no
cambia), pero los negocios creados **antes** del 2026-09-10 tienen `id_tipo_negocio = BARBERIA`, no
`RESERVA`. Eso es deuda viva, y aparece otra vez en §6.

---

## 6. Dos puntos donde esto ya está roto hoy

Encontrados mirando el código, no son hipótesis:

**6.1 — El asistente de WhatsApp tiene una lista blanca de tipos.**
`intelligence/adapters/reserva/index.js:593`:

```js
const TIPOS_NEGOCIO = ['RESERVA', 'BARBERIA', 'SALON DE BELLEZA'];
```

El enrutado de flujos (`intelligence/engine/flujos.js:97`) resuelve por ese nombre. Para los negocios
nuevos funciona —su `id_tipo_negocio` es `RESERVA`—, pero la lista es una segunda fuente de verdad
que nadie va a acordarse de tocar, y **falla en silencio**: el negocio simplemente no tiene
asistente. Con el rubro ya separado del módulo, esta lista debería reducirse a `['RESERVA']` más el
legado de `BARBERIA`.

**6.2 — El asistente le dice al cliente que el negocio es un «RESERVA».**
`intelligence/core/contextoNegocio.js:78` hace `JOIN gener_tipo_negocio ON t.id_tipo_negocio =
n.id_tipo_negocio` — es decir, lee **el módulo**, no el rubro. El propio archivo dice que existe
porque «no se habla igual en una barbería que en un consultorio»; con el join actual, ambos reciben
la misma palabra vacía. Debe leer `id_rubro` y caer al módulo solo si es `NULL`. Es un cambio de dos
líneas y mejora los seis rubros a la vez.

---

## 7. La restricción de calendario que manda sobre el plan

[ADR-003](adr/ADR-003-madurez-esquemas.md) dice que `reserva` está en Grupo 2 —evolución libre— y que
**«la ventana de libertad se cierra con el primer cliente en producción»**.

Ese cliente entró el **2026-09-09**. Hace seis días.

O sea: los cambios estructurales de §4 (C3 variantes, C4 sujeto, C5 recurso) son **ahora** cambios
normales, y dentro de poco serán migraciones con datos vivos y aditivas a la fuerza. No es una razón
para hacerlo todo de golpe — es una razón para **hacer primero lo estructural y después lo cómodo**,
que es el orden inverso al que apetece.

Concretamente, si algo de esto se va a hacer alguna vez, la forma de `reserva_cita` y
`reserva_servicio` conviene fijarla ya, aunque las pantallas lleguen después.

---

## 8. Plan por fases

**Fase 0 — Gratis, esta semana.** Sembrar `TATUAJE Y PERFORACIONES` y `PELUQUERIA CANINA` como rubros
(dos filas en `migrate_rubros_negocio.js`, que es idempotente). Arreglar §6.1 y §6.2. Cambiar el
placeholder de `usuarios.html:389`. Resultado: dos rubros más ofrecibles y el asistente hablando el
idioma del cliente. **Sin cambios de esquema.**

**Fase 1 — Lo que decide ventas (C1 + C2).** Tiempo de proceso y depósito parcial. Con esto, salón de
belleza deja de mentir sobre la agenda y tatuador se vuelve vendible. Toca `reserva_servicio`,
`reserva_cita`, `intervalosOcupados`, `calcularSlots`, `cobroService`, la vitrina y el formulario de
cita. Es donde está el grueso del trabajo y también el grueso del retorno.

**Fase 2 — Variantes y sujeto (C3 + C4), con el preset por rubro.** Abre mascotas entero y limpia el
precio variable de los otros tres. Aquí es donde entra la tabla de presets de §4.1: hacerla antes no
tiene sobre qué decidir, hacerla después significa retocar negocios ya creados.

**Fase 3 — Ficha, consentimiento y recurso (C5 + C6 + C7).** Convierte estética y spa de «les sirve»
a «es para ellos». Empezaría por C6, que no toca el motor, y dejaría C5 para cuando un spa real se
queje de las cabinas.

**Fuera de plan — Alojamientos.** Vertical propia. Decisión aparte, con su ADR.

---

## 9. Lo que hay que decidir antes de escribir código

1. **¿Alojamientos entra o no entra?** Si la respuesta es «entra ya», este documento cambia de forma:
   deja de ser un plan de rubros y pasa a ser un plan de dos verticales. Mi recomendación es que no, y
   que se valide la demanda antes.
2. **¿Mascotas es un rubro o el ensayo de un patrón?** «Sujeto del servicio» sirve igual para un
   consultorio (paciente) y una veterinaria. Si se modela como `reserva_sujeto` genérico en vez de
   `reserva_mascota`, cuesta lo mismo y sirve para tres rubros. Yo lo haría genérico.
3. **¿Se persigue estética de verdad?** Es el rubro con más competencia especializada y el único con
   exposición legal. Vender solo la agenda es legítimo; hay que decidirlo a propósito y escribir el
   copy en consecuencia.
4. **¿Precios?** [`precios-y-planes.md`](precios-y-planes.md) razona sobre costo externo por
   inquilino. Estos rubros **no añaden costo externo** —es el mismo VPS—, así que no justifican un
   plan nuevo. Entran en Básico/Avanzado como están.

---

## 10. Riesgos

- **El más probable: hacer las pantallas antes que el motor.** Una pantalla de «mascotas» sobre un
  `notas TEXT` demuestra bien en dos días y es irrecuperable después.
- **Dispersión.** Seis rubros a la vez con 2 devs es no terminar ninguno. El orden de §8 existe para
  eso.
- **La ventana de ADR-003 (§7).** No se cierra con un aviso; se cierra sola.
- **Prometer en la landing lo que el motor no hace.** Los chips de rubro salen de `getRubros()`, así
  que sembrar una fila **publica el rubro**. Sembrar `PELUQUERIA CANINA` antes de C4 pone un chip que
  lleva a un producto que no sabe qué es una mascota.
