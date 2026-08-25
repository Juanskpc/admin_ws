# Mejoras del flujo de agendamiento (pedidas el 2026-08-24)

**Origen:** la primera prueba real del asistente por WhatsApp, el día que el canal se encendió en
producción. No salen del roadmap ni de una revisión de código: salen de agendar citas de verdad y
ver dónde el flujo se siente mal. Eso las hace más valiosas que cualquier lista escrita de
antemano, y también más concretas.

**Alcance:** las tres son de **producto**, no de arquitectura. Ninguna necesita un ADR ni toca el
Policy Gate, el Ledger ni el canal. Viven en el manejador determinista de la conversación y en el
adaptador de `reserva`.

---

## 1. Elegir profesional — y poder no elegirlo

**Hoy:** el flujo asigna profesional sin preguntar. `consultar_disponibilidad` ya devuelve
`id_profesional` en cada hueco, así que la información está; simplemente no se ofrece.

**Lo que se pide:** un paso de selección, **con una opción explícita de «me da igual»**.

Lo segundo no es un adorno. La mayoría de la gente no tiene preferencia y para esa mayoría preguntar
es fricción: un paso más entre «quiero un corte» y tenerlo agendado. Si se añade el menú sin la
salida rápida, el flujo empeora para casi todos para mejorar para unos pocos. La opción de azar
—«el primero que haya»— tiene que ser la primera de la lista y la más fácil de elegir.

**Dónde mirar:**
- `intelligence/adapters/reserva/index.js` — `consultar_disponibilidad` y `proponer_turno`.
- El manejador determinista, que es quien decide qué se pregunta y en qué orden.
- Límite del canal: **una lista de WhatsApp admite 10 filas**, título ≤ 24 caracteres. Un salón con
  más de 9 profesionales no cabe con la opción de azar incluida. Hay que decidir qué se hace ahí
  (paginar, o filtrar por los que prestan ese servicio — que es lo natural y además reduce mucho).

---

## 2. El código de la cita no puede ser un UUID

**Hoy:** el cliente recibe `6b82eea2-f35d-48ae-b2ab-79009fc6b44a`. Es imposible de dictar por
teléfono, de leer en voz alta o de reconocer en una pantalla. Un código de cita se usa **hablando**.

**Lo que se pide:** algo corto, legible y humano. Del tipo `SALON-4K7Q` o `A7K2M9`.

**⚠️ Esto no es cambiar un formato en un sitio.** `codigo_publico` es la llave que atraviesa medio
sistema:

| Quién lo usa | Para qué |
|---|---|
| `reagendar_cita` | Identificar la cita a mover |
| `cancelar_cita` | Identificar la cita a anular |
| `recordatorios.js` | Construye la referencia como `cita:<codigo_publico>` y la parte con `slice(PREFIJO.length + 1)` |
| Las citas ya creadas | Tienen UUID y hay que decidir qué pasa con ellas |

Antes de tocarlo hay que decidir tres cosas:

1. **Alfabeto.** Sin caracteres ambiguos: fuera `O`/`0`, `I`/`1`/`l`. Quien dicta un código por
   teléfono se equivoca justo ahí.
2. **Unicidad y colisiones.** Un código corto colisiona. ¿Único por negocio (probable, y suficiente)
   o global? ¿Qué pasa al chocar — reintentar? Necesita índice único y un camino de reintento.
3. **Las citas existentes.** ¿Se migran, o `codigo_publico` admite los dos formatos durante un
   tiempo? Lo segundo es más seguro y no cuesta casi nada si la búsqueda es por igualdad.

> ### ⚠️ Requisito duro, verificado el 2026-08-24: hoy el código ES la autorización
>
> Se revisó `cancelar_cita` en `intelligence/adapters/reserva/index.js`. Autoriza **solo** con
> `codigo_cita` + `id_negocio`:
>
> ```js
> await buscarCitaPorCodigo(args.codigo_cita, idNegocio, contexto.transaction);
> const cita = await citaService.cancelarPorCliente(args.codigo_cita, ...);
> ```
>
> **En ningún punto comprueba que quien cancela sea quien reservó.** Lo mismo aplica a
> `reagendar_cita`. Hoy eso no se explota porque un UUID v4 no se adivina: la seguridad la está
> dando, sin que nadie lo decidiera, la longitud del código.
>
> **Acortar el código sin arreglar esto abre un agujero real**: probar combinaciones hasta cancelar
> la cita de un desconocido. Y `cancelar_cita` es, en palabras del propio catálogo, «la irreversible
> de las cuatro» — una cita cancelada por error no se descancela.
>
> Así que atar la cita al **teléfono que la pidió** (el `id_externo` de la conversación) **no es un
> extra de esta tarea: es su prerrequisito.** Se hace antes de acortar nada, y tiene valor por sí
> solo aunque el código siga siendo un UUID.

---

## 3. Poder retroceder

**Hoy:** el flujo solo avanza. Si el cliente elige día, ve las horas y quiere otro día, o se da
cuenta de que pidió el servicio equivocado, no hay vuelta atrás dentro de la conversación.

**Lo que se pide:** al listar opciones, poder **cambiar de día, de servicio o de profesional** sin
empezar de cero.

**Lo que hay que pensar antes de programar:** esto convierte el flujo en una máquina de estados con
aristas hacia atrás, y hay una pregunta que no es obvia — **qué se conserva al retroceder**. Si el
cliente cambia de servicio, la hora que había elegido probablemente ya no vale (las duraciones
difieren: 15 min contra 180). Si cambia de día, el profesional elegido puede no trabajar ese día. El
retroceso tiene que **invalidar lo que dejó de ser cierto** y decirlo, en vez de arrastrar una
selección imposible hasta que falle al reservar.

Ojo también a los `reserva_hold`: si hay un hueco reservado temporalmente y el cliente retrocede,
hay que soltarlo. Si no, el cliente se bloquea a sí mismo el hueco al que quiere volver.

---

## 4. Después: el adaptador de restaurante

No es una mejora del flujo de citas, es la siguiente pieza de producto — y está anotada aquí para
que no se pierda el orden.

Los dos clientes activos de producción (`6` ZONA BURGER, `14` LA ESQUINA DEL BARRIL) son
**restaurantes**, y el asistente solo sabe agendar citas: las seis capacidades son de `reserva` y el
único adaptador es `reserva`. Conectarles el número hoy les daría un bot que ofrece cortes de pelo.

Lo bueno: **el andamiaje ya está hecho y no se toca.** Policy Gate, Registry, Ledger, canal, ventana
de 24 h, confirmación humana, escalera de niveles — todo eso es transversal. Lo que falta son
capacidades nuevas sobre una vertical que ya existe, siguiendo el mismo patrón que
`adapters/reserva/`.

Esto va **antes** que el alta de números de clientes por Embedded Signup: la fontanería
multi-inquilino solo rinde cuando hay producto que entregar. Ver
[`canal-whatsapp.md`](canal-whatsapp.md) §«Dar de alta el número de un CLIENTE».
