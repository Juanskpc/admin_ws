# Principios de Arquitectura y Gobierno — EscalApp

**Estado:** fuente de verdad de **máxima precedencia**. Documento vivo, pero el que menos debe cambiar
de todo el proyecto.

Este documento es la **constitución** de EscalApp. Los ADRs son la legislación: deciden casos
concretos aplicando estos principios. Si alguna vez un ADR contradice un principio, esa contradicción
es una **señal de error** — se reconcilia (arreglando el ADR o el principio) **antes** de escribir
código, nunca después.

---

## Orden de precedencia

Toda decisión respeta este orden. Lo de arriba gana a lo de abajo, siempre.

1. **Principios de Arquitectura** (este documento)
2. **ADRs aceptados**
3. **Congelación de Arquitectura** (`freeze.md`)
4. **Roadmap** (`roadmap.md`)
5. **Implementación** (el código)

**Una implementación nunca modifica implícitamente una decisión arquitectónica.** Si durante el
desarrollo descubrimos que un ADR ya no es correcto: primero se revisa el ADR, después se cambia el
código. Nunca al revés.

---

## Los principios (invariantes por encima de los ADRs)

Cada principio viene con su **test de violación**: la pregunta que, si se responde "sí", detiene la
implementación.

| # | Principio | Se viola si… | Origen |
|---|---|---|---|
| **P1** | La conversación es el centro; las verticales son herramientas; los canales, adaptadores. | …una vertical o un canal empieza a contener lógica conversacional. | ADR-001 |
| **P2** | Las verticales existen sin IA. **Intelligence depende de las verticales, nunca al revés.** | …una vertical importa, llama o conoce a Intelligence. (El *test del apagón* debe pasar.) | ADR-005 |
| **P3** | La IA solo ejecuta **capacidades registradas**. Nunca SQL, endpoints, repositorios ni servicios internos. | …una capacidad ejecuta SQL arbitrario o expone un endpoint genérico al modelo. | ADR-007 |
| **P4** | Las capacidades son **acciones de negocio**, no CRUD. | …aparece `crear_registro`, `actualizar_campo` o una vertical necesita 40 capacidades. | ADR-007/008 |
| **P5** | El `id_negocio` lo **inyecta la plataforma**, nunca el modelo. | …el `id_negocio` llega como parámetro que el modelo rellena. | ADR-002/010 |
| **P6** | El acoplamiento con un dominio vive en los **adaptadores**; el núcleo de Intelligence es agnóstico. | …`intelligence/core` sabe qué es una cita o un pedido. | ADR-009 |
| **P7** | La **identidad (Persona) pertenece a la plataforma**, no a la IA. | …la identidad del cliente se ata al subsistema de IA o vive en `intelligence`. | ADR-004/006 |
| **P8** | **Un solo catálogo** de capacidades. La palabra "tool" solo existe en el adaptador de proveedor. | …se crea un segundo registro, o "tool" aparece en el núcleo. | ADR-008 |
| **P9** | **Business Context es *advisory*; Business Policy es *enforced*.** No se mezclan. | …se imponen reglas vía prompt, o se mete contenido/knowledge en Business Context. | ADR-011/019/020 |
| **P10** | La comunicación vertical → resto es **solo por eventos** (outbox en `platform`), delgados y versionados. | …una vertical llama directo a un consumidor, o un evento carga estado copiado. | ADR-012/013 |
| **P11** | **Intelligence nunca tiene FK hacia las verticales** (solo refs lógicas). Es lo que la hace extraíble. | …aparece una FK de `intelligence` a un esquema de vertical. | ADR-004 |
| **P12** | Se construye **determinista antes que con IA**. | …se conecta el LLM antes de que la espina dorsal esté probada sin él. | ADR-015 |
| **P13** | **Reservar** un nombre/una frontera es barato; **implementar** se hace bajo presión real. | …se implementa un módulo por un escenario imaginado, no por un requisito presente. | ADR-018/020, Persona global |
| **P14** | La documentación es parte del producto, no un entregable opcional. | …una decisión arquitectónica se toma sin reflejarse en su doc. | (este documento) |
| **P15** | **Menos conceptos que resuelvan más problemas.** | …se añade complejidad sin beneficio proporcional. | La última regla |

---

## El test de simplicidad (antes de crear cualquier componente)

Todo componente nuevo justifica su existencia respondiendo las cuatro. Si alguna falla, no se crea.

1. **¿Quién lo usa?** (Si la respuesta es "nadie todavía" → no se crea.)
2. **¿Qué problema resuelve?**
3. **¿Qué ocurriría si no existiera?** (Si la respuesta es "casi nada" → no se crea.)
4. **¿Elimina complejidad o solo la mueve?** (Mover no es eliminar.)

Un componente sin responsabilidad claramente diferenciada, o del que nadie depende de verdad, no se
crea. Precedente de referencia: la eliminación del Tool Registry ([ADR-008](../adr/ADR-008-capability-registry.md))
se decidió con la pregunta 1 — nadie lo consultaba.

---

## Arquitectura evolutiva

No se diseña para escenarios imaginarios; se diseña para escenarios probables.

- Ante un requisito nuevo: **primero** intentar resolverlo con la arquitectura existente.
- **Solo si** eso rompe claramente un principio, considerar modificar la arquitectura.
- La arquitectura crece por **presión de requisitos reales**, no por anticipación.

La excepción son las decisiones **irreversibles y baratas hoy / carísimas mañana** (P13): ahí se
*reserva* la frontera (un nombre, una tabla vacía, una columna nullable, una ranura), pero **no se
implementa** hasta que el requisito real llega. Reservar ≠ implementar.

---

## Disciplina de documentación

Si una decisión… | …entonces se actualiza…
---|---
introduce o cambia un principio | `architecture-principles.md` (este)
modifica una decisión | el **ADR** correspondiente (nuevo ADR que reemplaza; los ADRs son inmutables)
cambia el lenguaje del dominio | `glossary.md`
modifica o añade una capacidad | `capability-language.md`
introduce un evento | `domain-events.md`
mueve una frontera entre contextos | `bounded-contexts.md`

La actualización del doc es parte de la tarea, no un paso posterior opcional.

---

## Revisión arquitectónica (antes de dar una tarea por terminada)

Además de errores, estilo y rendimiento, toda implementación se revisa contra:

- **Límites entre bounded contexts** — ¿la dependencia apunta en la dirección permitida (P2, P6, P11)?
- **Dependencias** — ¿alguien conoce algo que no debería?
- **Responsabilidades** — ¿se duplica una responsabilidad que ya existe (P15)?
- **Acoplamiento** — ¿el acoplamiento está en el adaptador, no en el núcleo (P6)?
- **Contratos** — ¿capacidades y eventos respetan su forma congelada (P4, P8, P10)?
- **Cumplimiento de ADRs y de principios** — recorrer los tests de violación de arriba.

**Cuándo detener:** si una implementación rompe un principio, un ADR o un límite de contexto, se
**detiene** y se explica por qué, aunque la petición venga del propio dueño del proyecto. Se prefiere
perder una hora revisando una decisión que seis meses corrigiendo deuda técnica.

---

## El rol de Guardián

A partir de F0, el rol principal deja de ser *diseñar* la arquitectura y pasa a ser *preservarla*.
El Guardián:

- Verifica cada implementación contra esta constitución **antes** de considerarla terminada.
- Detiene lo que rompa un principio y lo explica, en vez de dejarlo pasar.
- Cuestiona activamente la complejidad sin beneficio proporcional — es el primero en hacerlo.
- Mantiene la documentación al día como parte del trabajo.

## La última regla

> La mejor arquitectura no es la que tiene más componentes. Es la que resuelve más problemas con
> menos conceptos.

Las tecnologías, los frameworks, los proveedores de IA, los modelos y los canales pueden cambiar. Las
**decisiones fundamentales del dominio** permanecen estables. Ese es el objetivo a diez años.
