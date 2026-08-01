# Congelación de la Arquitectura — Acta de Decisiones

**Propósito:** cerrar la fase de diseño. Es el acta a la que se apunta dentro de dos años
para saber qué se decidió y por qué. No es un plan ni una revisión: es un registro de decisiones.
**Fecha:** 2026-07-14
**Estado:** CONGELADO salvo los 6 puntos de §D, que se deciden hoy.

---

## A. Terminología congelada (la lengua ubicua del proyecto)

| Concepto | Nombre | Regla |
|---|---|---|
| El ser humano, global | **`platform.persona`** | Identificadores vía `persona_identificador`. NUNCA visible a un inquilino. Cero perfil de negocio. |
| La relación persona↔negocio | **`platform.persona_negocio`** | Lo que las verticales referencian. Aquí viven nombre-conocido, consentimiento, notas, historial. |
| Identificadores de una persona | **`platform.persona_identificador`** | `(id_persona, tipo, valor, verificado_en)`. Muchos por persona. Es la clave de resolución. |
| Acción de negocio que la IA puede ejecutar | **Capacidad** | Único catálogo. La palabra "tool" solo existe en el adaptador de proveedor. |
| Hecho de dominio ya ocurrido | **Evento** | `<agregado>.<hecho-pasado>.v<n>`, en español. Contrato versionado y aditivo. |
| Interruptor comercial de un plan | **Feature / entitlement** | Se consulta con `estaHabilitado(id_negocio, feature)`. Nadie consulta el plan directamente. |
| Límite económico que acota una capacidad | **Business Policy** | DATO por inquilino, aplicado por la capacidad. No es un motor de reglas. |

**Idioma de la lengua ubicua: español.** Capacidades, eventos y agregados se nombran en español,
coherente con el código existente (`gener_negocio`, `reserva_cita`). Si algún día existe un producto
de webhooks para terceros, ése tendrá su propia traducción a inglés en su adaptador — nunca se
contamina el catálogo interno.

---

## B. Modelo de identidad — congelado

```
platform.persona                     ← el humano. Global. Transversal a inquilinos.
  · id_persona (UUID)
  · (sin PII de perfil, sin nombre, sin historial)
      │  1:N
      ▼
platform.persona_identificador       ← teléfonos/emails. Muchos, con historia.
  · tipo (telefono|email), valor, verificado_en, activo
      ▲
      │  la resolución busca AQUÍ, no en una columna de persona
platform.persona_negocio             ← la relación con UN negocio. Party-Role.
  · id_persona_negocio (UUID)
  · id_negocio, id_persona (nullable)
  · nombre_mostrado, notas, etiquetas, consentimiento_*, preferencias_canal
      │
      ▼
reserva_cita.id_persona_negocio · pedid_orden.id_persona_negocio · ...   (SIEMPRE nullable)
```

**Invariantes congelados:**
1. Las verticales referencian `persona_negocio`, nunca `persona`. Esto hace **imposible** por
   construcción que una cita de un negocio apunte a la relación de otro negocio.
2. El identificador de canal (teléfono E.164) es **global** y vive en `persona_identificador`.
   El **permiso** para mensajear ese teléfono en nombre de un negocio es **por inquilino** y vive
   en `persona_negocio.consentimiento_*`. Identidad-de-canal ≠ permiso-de-canal.
3. Ningún inquilino puede navegar de su `persona_negocio` hacia `persona` y de ahí a otro inquilino.
   Esa ruta no existe en su nivel de autorización. Es el enforcement del aislamiento.
4. El cliente final NUNCA vive en `general.gener_usuario` (eso es personal del negocio, con roles y
   permisos). Su autenticación futura vive en `platform`.
5. `platform.persona` (nivel global) se **modela** desde el día uno y **no se puebla** hasta que
   exista el Portal del Cliente. Coste hoy: una tabla vacía y una columna nullable.

---

## C. Decisiones irreversibles ya congeladas

| # | Decisión | Por qué es cara de cambiar después |
|---|---|---|
| 1 | Modelo persona / persona_negocio / identificador (§B) | Es la entidad más referenciada de la plataforma. |
| 2 | Verticales FK a `persona_negocio`, siempre nullable | Toca todas las tablas transaccionales. |
| 3 | `intelligence` NUNCA tiene FK a verticales (solo refs lógicas) | Es la única garantía de extractibilidad. |
| 4 | Outbox vive en `platform`, no en `intelligence` | Si viviera en intelligence, las verticales dependerían de la IA. |
| 5 | Particionado mensual de las tablas de alto volumen de `intelligence` | Particionar 300M filas en caliente es brutal. |
| 6 | Convención de nombres de eventos (`agregado.hecho.vN`, español, aditiva) | Renombrar eventos con consumidores vivos rompe contratos. |
| 7 | Un único Capability Registry; "tool" solo en el adaptador de proveedor | Dos vocabularios envenenan el diseño para siempre. |
| 8 | Grupo 1 (`general`, `restaurante`): solo cambios aditivos | Ya están en producción. |

---

## D. Las últimas 6 decisiones a tomar HOY (con recomendación)

1. **Nombre del nodo global: `persona` (no `identidad`).**
   Recomendación: **sí, `persona`.** "Identidad" arrastra connotación de autenticación; este objeto
   no autentica, resuelve. El humano es una *persona* en lenguaje natural; la relación es lo derivado.
   Rechazados: Party (polimorfismo persona/organización que no necesitamos, y torpe en español),
   Principal/Subject/Actor (todos con carga de auth o demasiado genéricos), CustomerRoot (el humano no
   siempre es cliente — ése es justo el error que evitamos).

2. **Identificadores en tabla hija `persona_identificador`, no columna en `persona`.**
   Recomendación: **sí.** Un humano tiene varios teléfonos/emails a lo largo del tiempo y los cambia.
   Una columna `telefono_e164` en `persona` es una migración latente el día del primer cambio de número.
   **Éste es el único hallazgo que bloquea la congelación.**

3. **PK de `intelligence` y `persona`: UUID (v7), no bigserial.**
   Recomendación: **sí, UUID.** Son las dos piezas candidatas a extraerse a su propio servicio y a
   respaldar un portal público (riesgo de enumeración). bigserial ata la generación de IDs a una sola BD.
   Las FK a `id_negocio` siguen siendo enteras (clave existente de la plataforma).

4. **Timestamps de `intelligence`: `timestamptz` (UTC), no wall-time -05:00.**
   Recomendación: **sí, timestamptz.** La convención wall-time existe para fechas de negocio
   humanas (la cita de las 3pm). Los datos de intelligence son máquina (orden, costo, latencia),
   críticos en ordenamiento y posiblemente cruzan husos. Es seguro divergir porque **intelligence
   nunca hace JOIN con las verticales** (no hay FKs). Es el último momento barato para elegirlo.

5. **Business Policy = datos, no motor.** Empieza con 3–4 límites que una capacidad real aplique
   (descuento máximo, piso de precio, ventana cancelable, ¿reembolsable?). No se enumera la lista completa.

6. **Features = costura, no dominio pesado.** Existe `estaHabilitado(id_negocio, feature)` desde que la
   IA necesita gating (F5/F6). Detrás, el mapeo plan→features más simple posible. Nada de CRUD de features
   ni overrides por-feature ahora.

---

## E. Qué queda PROVISIONAL hasta F5 (y por qué está bien)

Se congela la capa **cara de cambiar**: esquema, fronteras, nombres, contratos. Todo lo demás
—prompts, política de enrutado, textos, umbrales de debounce, el guardarraíl de promesas, el
comportamiento de handoff sin humano— queda **deliberadamente suelto**, porque es lógica, no esquema,
y la arquitectura (puertos, adaptadores, capacidades) lo aísla para que evolucione sin migraciones.

El MVP determinista (F5) existe precisamente para validar barato toda la espina dorsal antes de
comprometer comportamiento. "Congelar" significa fijar lo irreversible y sostener el resto con
la mano abierta.

---

## F. Veredicto de congelación

Tras resolver el punto D.2 (`persona_identificador`), **no queda ninguna decisión que sea a la vez
probable-de-cambiar y cara-de-migrar.** Las cosas caras de cambiar son todas de esquema/contrato, y
cada una está fijada en §C. Las cosas probables de cambiar son todas de comportamiento, y la
arquitectura las aísla. Ésa es la definición de una arquitectura lista para congelar.

Listo para implementar F0 en cuanto se confirmen las 6 decisiones de §D.
