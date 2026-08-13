# EscalApp Intelligence — estado y cómo continuar

**Última actualización:** 2026-08-12
**Propósito:** que retomar el trabajo no cueste una sesión de arqueología. Si vuelves a este
proyecto después de semanas, **lee este documento primero** y sigue por donde diga.

> **Documento vivo.** Actualízalo al terminar cada fase. Si contradice al `roadmap.md`, gana
> el roadmap: esto es un resumen operativo, no una fuente de verdad arquitectónica.

---

## 1. Dónde vive el trabajo

| Repo | Rama | Qué contiene |
|---|---|---|
| `admin_ws` | `feature/escalapp_intelligence` | Todo el backend + el corpus de arquitectura en `docs/` |
| `admin_app-v21` | `feature/escalapp_intelligence` | La Ficha 360 y la **Intelligence Console** |
| `reserva_app` | *(sin rama propia)* | Un cambio pequeño de F3: mostrar el motivo del rechazo del dominio en vez de un texto fijo |

Ninguna rama está fusionada a `master`.

### Todo commiteado (2026-08-12)

La advertencia de trabajo sin commitear que vivía aquí está **resuelta**: F3, F4, F5-A..E
tienen su commit propio en `feature/escalapp_intelligence`, en ambos repos, y el árbol está
limpio. El troceado siguió la sugerencia original —un commit por bloque— así que el histórico
cuenta el orden real en que se descubrieron las cosas.

⚠️ **Sigue pendiente `reserva_app`:** su cambio de F3 (mostrar el motivo del rechazo del
dominio en vez de un texto fijo) está sin rama y sin commitear, mezclado con 11 archivos
sucios de la migración de identidad visual de las verticales. Solo
`src/app/reserva/citas/citas.ts` pertenece a F3; un `git add .` ahí mezclaría dos trabajos
sin relación.

---

## 2. Estado por fase

| Fase | Qué | Estado |
|---|---|---|
| **F0** | Identidad: `platform.persona*`, backfill, camino de escritura, Ficha 360 | ✅ **Completa en local** |
| **F1** | Outbox transaccional + relay | ✅ **Completa en local** |
| **F2** | AuthZ multi-inquilino | ✅ **Completa en local** |
| **F4-A** | Capability Registry + Policy Gate + adaptador piloto **de consulta** | ✅ **Completa en local** |
| **F3** | Saneamiento de invariantes de `reserva` | ✅ **Completa en local** |
| **F4-B** | Mutaciones de `reserva` + idempotencia + capa económica | ✅ **Completa en local** |
| **F5-A** | Esquema `intelligence` + Ledger (particionado, retención, las 12 preguntas) | ✅ **Completa en local** |
| **F5-B** | Conversation Engine (FIFO + lock + debounce) | ✅ **Completa en local** |
| **F5-C** | Channel Gateway + WebChat hostil | ✅ **Completa en local** |
| **F5-D** | Motor determinista + Identity Resolver | ✅ **Completa en local** |
| **F5-E** | Intelligence Console → **MVP interno** | ✅ **Completa en local** (API + vista Angular) |
| F6–F10 | Ver [`architecture/roadmap.md`](architecture/roadmap.md) | ⬜ |

**F5 se partió en cinco.** Es la fase más grande del plan y su parte irreversible es el
Ledger: ADR-022 dice que su esquema debe nacer completo porque lo que no se registre hoy no
se podrá responder nunca. Por eso F5-A va primero, aunque no haya todavía nada que escriba
en él.

**Ola A cerrada en local, y la Ola B a medio camino.** Se puede agendar, reagendar y cancelar
una cita entera desde una CLI, sin IA, sin frontend y sin gastar un token; y ya hay un motor
conversacional que ordena, agrupa y aísla los mensajes, con su rastro completo en el Ledger.
Y desde F5-C hay un canal de verdad: se abre `http://localhost:3000/intelligence/webchat/`, se
escribe, y la respuesta llega **por el camino asíncrono completo**. Desde F5-D **decide de
verdad**: agenda una cita entera con menús y sin un token de LLM. Y desde F5-E se puede mirar
lo que hizo, turno a turno, desde el panel.

**► El MVP INTERNO está cerrado en local.** La Ola B termina aquí; lo siguiente es F6, que es
donde entra el primer modelo — y solo de lectura.

**Por qué F3 se hizo después de F4-A.** Se había saltado porque `reserva` tiene 0 filas en
producción, pero al implementar F4 apareció que el adaptador piloto *es* de `reserva` y sus
mutaciones necesitan el *hold* con TTL y las invariantes en el dominio, ambos entregables de
F3. Compensarlas en el adaptador sería correcto para `restaurante` (Grupo 1) e incorrecto
para `reserva` (Grupo 2). Las consultas no dependían de nada de eso, así que F4-A salió
primero y F3 después.

### ⚠️ NADA está desplegado en producción

Los once bloques funcionan y están probados **solo contra la base local** (222 tests entre
`intelligence` y `platform`; ver la nota del flake de `reportes` en §8). Producción sigue exactamente como estaba. Ver §5 para el
procedimiento de despliegue.

---

## 3. Cómo volver a tener un entorno que funcione

> ## ⚠️ REGLA INNEGOCIABLE: nunca contra producción
>
> Todo lo de Intelligence **crea esquemas y tablas** (`platform`, `intelligence`), hace
> backfills y escribe en un Ledger particionado. No es código que consulta: modifica la forma
> de la base. Antes de lanzar cualquier comando de esta sección, comprueba a dónde apuntas:
>
> ```bash
> grep -E '^DB_(HOST|PORT|NAME)=' .env
> ```
>
> Hay **dos** bases de desarrollo válidas: la **local** (`DB_PORT=5432`, para tests y
> experimentos destructivos) y la **compartida en el VPS** (`DB_PORT=5433` vía túnel SSH, para
> trabajar en equipo sobre los mismos datos). **El puerto es lo único que las distingue**:
> nombre y usuario son idénticos. Detalle en [`desarrollo-local.md`](desarrollo-local.md).
>
> Para la compartida hay que abrir antes el túnel, o todo falla con `ECONNREFUSED`:
> `ssh -f -N -o ExitOnForwardFailure=yes -L 5433:localhost:5432 escalapp`

```bash
cd admin_ws

# 1. Base de desarrollo (si ya existe, saltar) — detalle en docs/desarrollo-local.md
#    ⚠️ Los fixtures van ANTES de las migraciones: si no, el backfill de personas
#    corre sobre tablas vacías y hay que repetirlo.
npm run migrate
node scripts/seed_dev_local.js
psql -U escalapp_dev -h localhost -d escalapp_dev -f scripts/fixtures/dev_segundo_negocio.sql
psql -U escalapp_dev -h localhost -d escalapp_dev -f scripts/fixtures/dev_ordenes_restaurante.sql
psql -U escalapp_dev -h localhost -d escalapp_dev -f scripts/fixtures/dev_reserva.sql

# 2. Migraciones de Intelligence, en este orden
npm run migrate:platform-persona
npm run migrate:platform-backfill-restaurante
npm run migrate:platform-outbox
npm run migrate:platform-capacidades
npm run migrate:reserva-hold
npm run migrate:platform-idempotencia
npm run migrate:intelligence-ledger
npm run migrate:intelligence-canal

# 3. Comprobar que todo sigue verde
npx jest --runInBand                           # 200 tests (menos el flake de reportes, §8)

# 4. Levantar
npm run dev                                    # backend  :3000
cd ../admin_app-v21 && npm start               # admin app :4002
```

Login: super admin `1000000001` / `Admin123*`. Ficha 360 en `/admin/personas`.

**Si un cambio "no aparece":** comprueba quién tiene el puerto antes de dudar del código.
Matar el proceso de `npm run dev` deja vivo el hijo `node`, que sigue sirviendo código viejo.

```powershell
(Get-NetTCPConnection -LocalPort 3000 -State Listen).OwningProcess | Stop-Process -Force
```

---

## 4. Qué se construyó, en una línea cada cosa

**F0 — Identidad**
- `platform.persona` y `platform.persona_identificador` existen **vacías a propósito**: el
  nivel global no se puebla hasta el Portal del Cliente ([ADR-006](adr/ADR-006-persona.md),
  [ADR-025](adr/ADR-025-identificadores-nivel-global-vacio.md)). No es código muerto.
- `platform.persona_negocio` es la tabla operativa; ahí vive el teléfono, único por
  `(id_negocio, telefono_e164)`.
- `restaurante.pedid_orden.id_persona_negocio` (FK nullable) + backfill + resolución
  **best-effort** al crear la orden: si la identidad falla, la orden se crea con `NULL`.
- Ficha 360 en `admin_app-v21` → `/admin/personas`, solo Super Admin.

**F1 — Outbox**
- `platform.outbox` + `outboxDao.emitir()` (exige transacción) + relay con backoff y dead
  letter.
- **Ninguna vertical emite todavía y el relay arranca inactivo.** Es deliberado: un evento
  se define cuando hay productor *y* consumidor ([ADR-013](adr/ADR-013-catalogo-eventos.md),
  regla 4). El primer consumidor llega en F5.

**F2 — AuthZ**
- `Principal` + middleware de pertenencia montado en las 6 verticales.
- Cerró una fuga real entre inquilinos (ver §6).
- Arranca en `AUTHZ_MODO=observacion`: audita, **no bloquea**.

**F4-A — Capacidades**
- Todo el código nuevo vive en `intelligence/`, **fuera de `app.js`**: ninguna vertical lo
  importa y borrar el directorio deja el backend igual. El test del apagón sigue pasando.
- `intelligence/core/` es agnóstico de vertical (Registry, Policy Gate, `estaHabilitado`,
  validación de argumentos). El único archivo que nombra a `reserva` es
  `intelligence/index.js`, que es composición, no núcleo.
- El **catálogo es código** (el manifiesto del adaptador); lo que es dato por inquilino es
  la **habilitación**, en `platform.capacidad_habilitada`. **Sin fila = denegado.**
- Único cliente hoy: `scripts/capacidad.js`. Sin IA, sin frontend, sin tokens.

```bash
# Ejercitarlo en local (ningún plan incluye la feature todavía)
$env:FEATURES_FORZADAS='asistente_ia'
node scripts/capacidad.js listar --negocio 1
node scripts/capacidad.js habilitar consultar_servicios --negocio 1
node scripts/capacidad.js ejecutar consultar_disponibilidad --negocio 1 --usuario 2 `
     --args '{"id_servicio":1,"fecha":"2026-08-10"}'
```

`FEATURES_FORZADAS` se ignora si `NODE_ENV=production`: una variable de entorno que pudiera
regalar features de pago en producción no es una escotilla de desarrollo, es un agujero de
facturación esperando a que alguien copie un `.env`.

**F3 — Invariantes de `reserva`**
- `services/reglasAgenda.js` es **la** definición de la agenda. Disponibilidad y creación
  consumen sus dos primitivas (`intervalosLaborales`, `intervalosOcupados`), así que no
  pueden volver a divergir. Antes cada uno tenía su versión y **divergieron**.
- `crearCita` ahora rechaza fuera de horario (`FUERA_DE_HORARIO`) y sobre bloqueos
  (`SOBRE_BLOQUEO`). Antes no miraba ninguno de los dos.
- El anti-doble-reserva pasó de `SELECT ... FOR UPDATE` a `pg_advisory_xact_lock` por
  profesional: el `FOR UPDATE` no protegía nada cuando **no existía todavía** ninguna fila
  conflictiva, que es justo el caso de dos peticiones simultáneas sobre un hueco vacío.
- `services/estadoCita.js` declara las transiciones válidas. `completada`, `cancelada` y
  `no_show` son terminales.
- `reserva.reserva_hold`: TTL sin cron. Un hold caducado deja de contar porque el predicado
  incluye `expira_en > now()`; nadie tiene que borrarlo.
- **Cambio visible en el formulario web:** con un buffer configurado se ofrecerán *menos*
  horas que antes. Son exactamente las que nunca se pudieron confirmar.

**F4-B — Mutaciones**
- Seis capacidades en `reserva`, de un techo de diez. El ciclo `propose → hold → confirm`
  son dos: `proponer_turno` aparta y `reservar_turno` confirma.
- Los parámetros usan `codigo_*` (uuid), nunca `id_cita`. Con un entero secuencial, quien
  hable con el asistente podría cancelar la cita de otro cliente del mismo negocio contando
  hacia arriba: el Gate impone el negocio, pero dentro del negocio no distingue clientes.
- Como falta `consultar_mis_citas`, el asistente **solo toca citas cuyo código ya conoce**.
  No puede enumerar. Es el límite correcto hasta que `reserva` adopte `persona`.
- **No hay `platform.business_policy`.** `ventana_cancelacion_horas` ya vive en
  `reserva_config` y la vertical la aplica; duplicarla serían dos fuentes de verdad. La capa
  3 del Gate declara y audita; el enforcement se queda donde ADR-011 lo puso.
- Las capacidades **siguen sin emitir eventos**: regla 4 de ADR-013, el consumidor llega en F5.

```bash
# Ciclo completo desde la CLI, sin IA
node scripts/capacidad.js ejecutar proponer_turno  --negocio 1 --usuario 2 --args '{"id_servicio":1,"inicio":"2026-08-24T10:00:00"}'
node scripts/capacidad.js ejecutar reservar_turno  --negocio 1 --usuario 2 --clave turno-42 `
     --args '{"codigo_hold":"<uuid>","cliente_nombre":"Ana Perez"}'
```

**F5-A — Esquema `intelligence` + Ledger**
- Seis tablas: `conversacion`, `turno`, `paso`, `mensaje`, `invocacion_capacidad`, `costo`,
  más `ingesta_recibida` para deduplicar. **Todas vacías**: nada escribe en ellas todavía.
- Se construyó primero porque es lo **irreversible**. El esquema no se diseñó a ojo: se
  diseñó contra **las doce preguntas** de ADR-022, que viven como SQL ejecutable en
  `scripts/ledger_doce_preguntas.js` y como test en `__tests__/intelligence/ledger.test.js`.
- `intelligence.costo` es la única tabla del proyecto que se salta el test de simplicidad
  (no tiene productor), y lo hace con un ADR explícito detrás.
- **Particiones mensuales hasta 2027-10.** Una tabla particionada sin la partición del mes
  rechaza *todo* INSERT: revisar con `node scripts/intelligence_mantenimiento.js estado`.
- La retención está documentada y es ejecutable, pero **no hay cron**: `costo` no caduca
  nunca (factura); el resto va de 6 a 24 meses.

```bash
node scripts/ledger_doce_preguntas.js --negocio 1
node scripts/intelligence_mantenimiento.js estado
node scripts/intelligence_mantenimiento.js retencion          # simula
node scripts/intelligence_mantenimiento.js particiones --meses 12
```

**F5-B — Conversation Engine**
- Todo en `intelligence/engine/`: `motor.js` (orquestación), `cola.js` (FIFO + debounce),
  `repositorio.js` (el único sitio con SQL del esquema), `manejadorEco.js` (andamio).
  **Sin migración**: el esquema entero ya lo creó F5-A.
- Los tres mecanismos de [ADR-014](adr/ADR-014-conversation-engine.md), y cada uno se verificó
  **rompiéndolo** antes de darlo por bueno: sin debounce la ráfaga produce 5 turnos, sin lock
  produce 2, sin savepoint el turno fallido desaparece del Ledger.
- **El motor no decide qué se contesta.** El manejador se inyecta (`arrancarMotor(fn)`); hoy
  el único es el eco. La FSM es F5-D y el LLM F6, y ninguno debería obligar a tocar el motor.
- **No hay estado del motor en memoria.** Variables y tarea viven en la fila de
  `conversacion`, que es lo que hace que la continuidad sobreviva a un reinicio sin más.
- **La cola es en memoria, no BullMQ**, y da igual para la corrección: lo que impide que dos
  procesos pisen una conversación es el lock en la base, no el reparto del trabajo. Ver la
  nota de F5-B en el [`roadmap.md`](architecture/roadmap.md).
- Sigue sin haber consumidores del outbox. El primero es la confirmación proactiva por canal,
  que necesita el Channel Gateway. F5-C tampoco los activó —seguía sin haber con qué
  decidir—, así que la decisión es de F5-D y ahí ya no hay excusa (ver §4-bis).

**F5-C — Canales**
- `core/mensajeCanonico.js` es el contrato de ADR-017 y vive en el núcleo, no junto a los
  adaptadores: si viviera allí, el primer canal acabaría dictando su forma.
- `channels/gateway.js` entrega **en asíncrono**, con reintentos y dead letter, sondeando la
  cola de salida. Es la corrección que ADR-016 llama «la que cambia la naturaleza del
  WebChat»: si la ingesta devolviera la respuesta del bot, los criterios de aceptación del
  motor se volverían infalsificables.
- `channels/webchat/` es el primer adaptador **y el simulador de fallos**, que es entregable
  explícito. Cada interruptor caza un bug concreto, y se verificó rompiendo los mecanismos.
- Dos columnas nuevas (`migrate:intelligence-canal`): `mensaje.opciones` (respuestas en
  abstracto, cada canal las renderiza) y `mensaje.enviado_en` (la hora **del canal**, que es
  lo que permite leer un turno en el orden en que se escribió y no en el que llegó).
- **Primera vez que Intelligence se expone por HTTP**, detrás de dos guardas en `app.js`. El
  test del apagón se comprobó de verdad: se movió `intelligence/` fuera y el backend arrancó.
- **Sin autenticar.** Ver §6, decisión 9.

```bash
# El canal entero, con el simulador
INTELLIGENCE_HTTP_ENABLED=true FEATURES_FORZADAS=asistente_ia npm run dev
#  → http://localhost:3000/intelligence/webchat/

# El ciclo entero, sin canal y sin IA
node scripts/conversacion.js rafaga --negocio 1 --de ana    # 5 mensajes en 2 s → UN turno
node scripts/conversacion.js ver    --negocio 1 --de ana    # turnos, mensajes y pasos
node scripts/conversacion.js enviar --negocio 1 --de ana --texto "pausa"
node scripts/conversacion.js enviar --negocio 1 --de ana --texto "seguimos"
node scripts/conversacion.js recuperar                      # turnos colgados de un proceso muerto
```

---

## 4-bis. Por dónde se sigue: F5-D (motor determinista + Identity Resolver)

Lo siguiente es **F5-D**, y es **la última pieza del MVP interno**: lo único que falta para
que un cliente agende una cita entera hablando con la máquina. Antes de escribir una línea,
leer [ADR-015](adr/ADR-015-mvp-determinista.md) y la sección F5 del
[`master-plan.md`](architecture/master-plan.md) — es el método de §7 y ya ha destapado tres
contradicciones que solo se ven al implementar.

**Qué entrega:** el Nivel 1 de la escalera de costo —FSM, regex, comandos, menús— y el
Identity Resolver enchufado. **Cero IA**, sigue vigente: F5 entero cuesta $0.00 en tokens y
eso es un criterio de aceptación, no una casualidad.

**Todo lo que necesita ya está esperando, y con la forma correcta:**

1. **El punto de extensión existe y está probado.** `intelligence.arrancarMotor(manejador)`
   instala la función que decide. El contrato está documentado en
   `engine/motor.js#registrarManejador` y el andamio de eco es un ejemplo completo: devuelve
   `pasos`, `respuestas`, `variables` y `tarea`, y el motor los escribe. **El manejador no
   toca la base de datos**, y ésa es la frontera que hay que respetar.
2. **Los menús ya tienen dónde ir.** `respuestas` acepta `{ texto, opciones }` y el WebChat
   ya pinta las opciones como chips. Un menú numerado NO se escribe en el texto: se manda en
   `opciones` y cada canal lo renderiza (ADR-017). Hay un test que lo vigila.
3. **La continuidad ya funciona.** `conversacion.variables` es la memoria de sesión y
   `tarea_actual` / `tarea_datos` la tarea retomable. La FSM solo tiene que decidir; guardar
   ya está resuelto y sobrevive a un reinicio.
4. **Las capacidades están listas desde F4.** El manejador invoca al Policy Gate con la
   **clave de idempotencia = id del turno**, que es justo para lo que se construyó: un turno
   reintentado no crea dos citas. Ojo: el Gate abre **su propia** transacción y confirma; no
   es la del turno, y eso es correcto (una cita creada no debe deshacerse porque falle una
   escritura del Ledger).

**El outbox: por qué sigue sin consumidor, y esta vez con la razón concreta.** Lleva tres
fases construido y sin consumidores. F5-B lo aplazó a F5-C y F5-C a F5-D. Al implementar F5-D
apareció el motivo real, que no es falta de ganas ni de FSM:

El consumidor propuesto era la **confirmación proactiva** de `cita.creada.v1` («tu cita quedó
agendada»), una conversación que **el negocio inicia**. Pero:

- Si la cita se crea **dentro** de la conversación, la confirmación es la respuesta del propio
  turno. No hace falta outbox para contestar algo que acabas de hacer.
- El outbox solo aporta cuando la cita se crea **fuera** —el negocio la agenda desde
  `reserva_app`—, y entonces hay que saber **a qué conversación escribir**. Eso exige un enlace
  persona↔cita que **no existe**: `reserva.reservar_turno` recibe `cliente_nombre` y
  `cliente_telefono` como texto suelto, no un `id_persona_negocio`.

O sea: el consumidor está bloqueado por la misma costura que deja fuera a
`consultar_mis_citas`. **Lo que lo desbloquea es que `reserva` adopte `persona`**, no una fase
más de espera. Hasta entonces, activar el outbox con un consumidor que solo escribe en el
Ledger cumpliría la letra del roadmap sin aportar nada, y dejaría un consumidor falso que
alguien tendría que borrar después.

Decidido el 2026-08-12: **se documenta el bloqueo y no se activa**. Cuando `reserva` adopte
`persona`, el consumidor proactivo y `consultar_mis_citas` salen juntos, que es como debían
haber salido siempre. Revisar entonces
[`domain-events.md`](architecture/domain-events.md).

**Dos avisos de lo que se acaba de construir:**

- ~~El manejador es lo único que no está probado a fondo~~ → **resuelto en F5-D**: 45 tests,
  todos hostiles (hold caducado, entrada fuera de menú en cada paso, cancelar desde cualquier
  sitio, paso de otra versión, idempotencia).
- **`consultar_mis_citas` sigue sin existir**, así que el asistente solo puede tocar citas
  cuyo código ya conoce. Es el límite correcto hasta que `reserva` adopte `persona`, y la FSM
  se diseñó **sabiéndolo**: guarda `variables.ultima_cita` al crear la cita, que es la única
  forma de poder reagendarla o cancelarla después.

---

### ✅ Lo que F5-D entregó (2026-08-12)

`intelligence/engine/identidad.js` + `manejadorDeterminista.js`, 45 tests que corren **sin
Postgres** (el Gate y el resolver se inyectan). El motor no se tocó: la frontera que fijó F5-B
aguantó, que era justo lo que había que comprobar.

**Lo que apareció al implementar, y no estaba previsto:**

1. **El Principal `contacto` no tenía productor.** `principal.js` lo reservaba desde F4 con esa
   nota, y resultó ser un bloqueo duro: el Policy Gate no ejecuta nada sin Principal, y un
   cliente anónimo de WebChat no tiene usuario. Sin resolverlo, la FSM no podía invocar ni
   `consultar_servicios`. Por eso el Identity Resolver se hizo **primero**, aunque el roadmap
   lo listara segundo. Se emite con **un solo negocio y sin roles**, para que la frontera
   multi-inquilino de F2 valga igual en un canal público, por el mismo código.
2. **La clave de idempotencia = id del turno impone una regla que el plan no decía.** El Gate
   guarda por `(negocio, capacidad, clave)`: si un turno invocara dos veces la misma capacidad,
   la segunda recibiría el resultado de la primera. De ahí que la FSM avance **un paso por
   turno** y no encadene mutaciones. Hay un test que lo vigila en los cuatro pasos.
3. **El hold caducado es conversación, no avería.** `reservar_turno` lanza `HOLD_NO_VIGENTE`
   cuando el cliente tarda en confirmar. Se trata volviendo al paso de fecha. Cualquier **otro**
   error sí se propaga: tragárselos convertiría una avería real en un mensaje amable y el
   Ledger no registraría nada.
4. **El orden de las preguntas lo decide el TTL del hold.** El nombre se pide **antes** de
   apartar la hora. Al revés, el formulario se come los minutos del hold y caduca justo cuando
   el cliente iba a confirmar.

### ✅ Criterios de aceptación de F5, verificados de extremo a extremo

`__tests__/intelligence/e2e_agendar.test.js` recorre el camino entero contra Postgres, **sin
dobles**: widget → gateway → motor → identidad → Policy Gate → adaptador → dominio.

| Criterio (master-plan, FASE 5) | Estado |
|---|---|
| 1. Cita completa por WebChat con menú determinista, y la cita queda correcta | ✅ fila real en `reserva.reserva_cita`, con su código y su hora |
| 2. Ráfaga de 5 mensajes en 2 s → **un** turno y **una** cita | ✅ 1 turno, 5 entrantes agrupados, 1 respuesta |
| 3. Continuidad: abandonar, matar el proceso, volver → la tarea se retoma | ✅ y además se completa hasta crear la cita |
| 4. Costo en tokens: **$0.00** | ✅ `nivel = determinista` en todos los turnos, 0 filas en `intelligence.costo` |

**Y encontró dos bugs que los tests unitarios no podían encontrar**, que es exactamente para
lo que está:

- **`SLOT_NO_DISPONIBLE` sobre una hora que el propio bot acababa de ofrecer.**
  `consultar_disponibilidad` funde las agendas de varios profesionales y devuelve, por cada
  hora, **cuál** la tiene libre. La FSM tiraba ese dato y `proponer_turno` volvía a elegir
  profesional por su cuenta, cayendo a veces en uno recién ocupado. Solo aparece con **dos
  profesionales y una cita previa**: con un solo profesional el bug es invisible.
- **La ráfaga rompía la confirmación.** Al bot no le llega «sí» sino «sí\nsí\nsí», porque el
  debounce agrupa. La comparación era contra el bloque entero, así que no casaba y la cita no
  se creaba. Regla nueva: dentro de un turno manda la **última línea** — lo último que dijo la
  persona es su intención actual. El nombre es la excepción y se une con espacios.

**Dos avisos para quien corra esta suite:**

- Necesita `FEATURES_FORZADAS=asistente_ia`. **Ningún plan comercial incluye el asistente**, a
  propósito: todavía no se vende. `features.js` lee la variable **al cargar el módulo**, así que
  el test la fija antes de los `require`. Sin ella, el Gate deniega con `FEATURE_NO_HABILITADA`
  y el bot no contesta nada.
- Barre los holds `activo` del día antes y después. `proponer_turno` no es idempotente y una
  ejecución cortada a mitad deja holds vivos con minutos de TTL: **la primera pasada va bien y
  las siguientes fallan**, que parece intermitencia y no lo es.

---

---

## 4-ter. F5-E — Intelligence Console

Tres endpoints de **solo lectura** bajo `requireSuperAdmin`, en
`app_admin_api/controllers/intelligenceConsolaController.js`:

| Endpoint | Para qué |
|---|---|
| `GET /admin/intelligence/conversaciones` | La tabla de entrada. Filtros por negocio, canal, estado, fecha y **`con_error=true`**, que es el que más se usa depurando |
| `GET /admin/intelligence/conversaciones/:id` | El rastro completo: mensajes, turnos, **pasos** (el porqué) e **invocaciones** (el qué hizo, con argumentos) |
| `GET /admin/intelligence/metricas` | Las doce preguntas de ADR-022 hasta donde F5 llega: tasa de resolución, ratio determinista, errores, reintentos, latencias p95, capacidades y costo |

Sigue el patrón de la Ficha 360: **lee el esquema con SQL y no importa `intelligence/`**, así
que el test del apagón de ADR-005 sigue siendo literal. Si el esquema no está migrado responde
503 con el motivo, en vez de reventar con un error de SQL — un panel que se cae porque una fase
no está desplegada es un panel que nadie abre.

Los tests **no insertan filas a mano**: conversan de verdad por el WebChat y luego comprueban
que la consola enseña eso. Es lo que exige `revision-01.md` §2 («prohibido datos simulados»), y
además es lo que hace que el test valga: con filas inventadas seguiría pasando sin probar nada.

### ⚠️ Lo que destapó: `intelligence.invocacion_capacidad` no tenía productor

F5-A creó la tabla, F5-E la leyó, y estaba **vacía**. «Capacidades ejecutadas» es una de las
doce preguntas de ADR-022 y el Ledger no podía responderla.

La causa no era un olvido: **el Policy Gate no sabe que lo llaman desde una conversación**. No
recibe `id_turno` ni `id_conversacion`, y encima lo usa la CLI fuera de todo turno. Lo que sí
hace es auditar en `auditoria.audit_evento`, que responde otra pregunta — forense de plataforma,
no observabilidad de conversación.

Se resolvió con la frontera que ya existía: **el manejador devuelve lo que invocó y el motor lo
escribe**, igual que con los pasos. El contrato de `motor.js#registrarManejador` gana un campo
`invocaciones`, y el Gate devuelve además la `vertical` en su sobre. El manejador sigue sin
tocar la base.

**Límite conocido y aceptado:** si el manejador lanza, la decisión no vuelve y esas invocaciones
no llegan al Ledger. El turno queda con su `error_codigo` y `error_detalle`, y el Gate ya auditó
la invocación fallida con argumentos completos. El Ledger cuenta la conversación; la auditoría,
los hechos. Las que fallan **pero se manejan** —el hold caducado— sí quedan registradas.

### Lo que falta de F5-E

La **vista Angular** en `admin_app-v21` (rama `feature/escalapp_intelligence`, donde ya vive la
Ficha 360): listado con el filtro de error, detalle con la línea de tiempo del turno, y la tira
de métricas. Con eso se cierra el **MVP interno**.

---

## 5. Pendiente de despliegue (en este orden)

**Lo más urgente es F2**, porque es lo único que arregla algo que está roto en producción
ahora mismo. F0 y F1 son funcionalidad nueva y pueden esperar.

1. **F2 primero, en modo observación.** Desplegar el código con `AUTHZ_MODO=observacion`
   (o sin la variable: es el valor por defecto).
2. **Medir una semana.** Panel Admin → Auditoría → Eventos, módulo `authz`. O bien:
   ```sql
   SELECT * FROM auditoria.audit_evento WHERE modulo = 'authz' ORDER BY fecha DESC;
   ```
   Cada fila es una petición que en modo bloqueo habría sido rechazada. Revisar si alguna es
   tráfico legítimo (rutas que sacan el `id_negocio` de otro sitio) y corregirla.
3. **Activar `AUTHZ_MODO=bloqueo`** solo cuando la medición esté limpia.
4. **Migraciones de F0/F1**, en orden:
   `migrate:platform-persona` → `migrate:platform-backfill-restaurante` → `migrate:platform-outbox`.
   El segundo hace un `ALTER TABLE` sobre `pedid_orden`, que es tabla activa del POS: toma un
   lock breve, **hacerlo fuera de hora punta**.
5. **Desplegar `admin_app-v21`** para que la Ficha 360 sea visible.
6. **F4 (A y B) al final, y sin prisa.** No lo usa nadie: no está montado en `app.js` y su
   único cliente es una CLI. Desplegarlo solo aporta dos migraciones de tablas vacías
   (`platform-capacidades`, `platform-idempotencia`). Puede ir con lo siguiente que se
   despliegue. **No definir `FEATURES_FORZADAS` en el `.env` de producción** — se ignora,
   pero no debería estar ahí para empezar.
7. **F3 puede ir cuando quieras: `reserva` tiene 0 filas en producción.** No hay datos que
   violen las invariantes nuevas, así que el riesgo que el `master-plan` pedía auditar antes
   de activar no existe aquí. Requiere `migrate:reserva-hold` y desplegar `reserva_app`
   (muestra el motivo del rechazo en vez de un texto fijo). Lo único que un negocio notaría
   es que el formulario ofrece menos horas cuando tiene buffer configurado — las que antes
   daban 409.
8. **F5-A: solo la migración, y es inofensiva.** `migrate:intelligence-ledger` crea un
   esquema nuevo con siete tablas vacías y 75 particiones. No toca nada existente y nada
   escribe en él. **Lo único que hay que anotar en el calendario:** las particiones llegan
   hasta **2027-10**; antes de agotarse hay que ejecutar
   `node scripts/intelligence_mantenimiento.js particiones --meses 12`, porque una tabla
   particionada sin la partición del mes rechaza todo INSERT.
9. **F5-B: código y nada más. No hay migración y no hay nada que encender.** El motor no está
   montado en `app.js`, no lo arranca nadie, y sin un canal no puede entrarle un solo mensaje.
   Desplegarlo es inerte hasta F5-C. Las variables `CONVERSACION_*` del `.env.example` tienen
   valores por defecto razonables: **no hace falta ponerlas** en producción.
10. **F5-C: la migración es inofensiva; la bandera NO se enciende.**
    `migrate:intelligence-canal` añade dos columnas a `intelligence.mensaje`, que está vacía.
    Pero **`INTELLIGENCE_HTTP_ENABLED` se queda en `false` en producción** hasta que el
    WebChat tenga autenticación propia (ver §6, decisión 9): hoy esas rutas aceptarían
    mensajes de cualquiera para cualquier negocio con la feature encendida. Con la bandera
    apagada no existe ni la ruta, así que desplegar el código es inerte.

Los conteos reales del backfill (≈621 personas, ≈1.056 órdenes) solo se materializan al
ejecutarlo en producción. Lo verificado en local fueron 2 personas sintéticas.

---

## 6. Decisiones abiertas (te tocan a ti, no al código)

1. ~~**¿F3 o F4?**~~ **Cerrada (2026-08-03): se hicieron las dos**, en el orden
   F4-A → F3 → F4-B. Se eligió F4 porque `reserva` tiene 0 filas en producción, pero al
   construir apareció que el adaptador piloto de F4 *es* de `reserva`, así que F3 volvió a
   ser prerequisito — de las **mutaciones**, no de las consultas.
2. **¿Se commitea el trabajo acumulado?** Cinco bloques (F4-A, F3, F4-B, F5-A, F5-B) siguen
   en el árbol de trabajo, sin un solo commit. Ver §1.
3. **Confirmar formalmente las 6 decisiones de `architecture/freeze.md` §D.** ADR-006 y
   ADR-024 ya las tratan como aceptadas, pero el acta pide confirmación explícita.
4. **Repetir la medición de teléfonos cuando un segundo negocio tenga volumen.** Hoy el 98%
   de las personas está en un solo negocio, así que el "cero solapamiento entre inquilinos"
   es *ausencia de evidencia*, no evidencia de ausencia. Ver
   [`mediciones/2026-07-31-calidad-telefonos-restaurante.md`](mediciones/2026-07-31-calidad-telefonos-restaurante.md).
5. **La Ficha 360 nunca se vio renderizada.** El build compila y el guard responde, pero la
   extensión de Chrome no estaba conectada. Mírala tú antes de darla por buena.
6. **Ni el WebChat ni la Console existen todavía**, así que sigue sin haber nada de F5 que
   *mirar* en una pantalla. Es lo que ADR-015 avisa que pasaría: «semanas sin nada de IA
   demo-able». Está previsto, no es que se haya torcido algo. Lo que sí se puede ver ya es la
   conversación entera desde la terminal: `node scripts/conversacion.js rafaga --negocio 1
   --de ana` y después `ver`.
7. **`reserva_app` no se ha ejecutado con los cambios de F3.** Compila y el typecheck pasa,
   pero nadie ha visto un rechazo del dominio pintado en la pantalla. Mismo caso que la
   Ficha 360.
8. **El manejador de eco (`intelligence/engine/manejadorEco.js`) es un andamio.** Cuando F5-D
   traiga la FSM hay que decidir si se borra o se queda como manejador de pruebas. Los tests
   del motor lo usan, así que borrarlo sin más obliga a reescribirlos.
9. ⚠️ **El WebChat no está autenticado, y esto te toca decidirlo a ti.** Un widget lo usa un
   cliente final anónimo: no hay JWT que pedir y el `Principal` de tipo `contacto` sigue
   reservado sin implementar. Hoy lo único que separa un negocio de otro en esa superficie es
   la feature comercial `asistente_ia`, así que **cualquiera podría escribirle al asistente de
   cualquier negocio que la tenga**. Mitigado a base de tenerlo apagado
   (`INTELLIGENCE_HTTP_ENABLED=false` por defecto) y no desplegarlo. Lo que falta —clave
   pública por negocio, orígenes permitidos, límite por sesión— es trabajo del día en que el
   WebChat sea producto, y ADR-016 dice que lo será. **No encenderlo en producción antes.**
10. **El widget nunca se vio renderizado.** Se sirve (HTTP 200) y su API está probada extremo
    a extremo por HTTP, pero la extensión de Chrome no estaba conectada. Tercer entregable en
    la misma situación, con la Ficha 360 y `reserva_app`. Ábrelo tú:
    `INTELLIGENCE_HTTP_ENABLED=true FEATURES_FORZADAS=asistente_ia npm run dev` y entra a
    `http://localhost:3000/intelligence/webchat/`.

---

## 7. Cómo se trabaja aquí

El rol no es diseñar arquitectura, es **preservarla** (ver
[`architecture/architecture-principles.md`](architecture/architecture-principles.md)).

**Orden de precedencia** — lo de arriba gana: Principios → ADRs → `freeze.md` → `roadmap.md` →
implementación. Una implementación nunca modifica implícitamente una decisión: primero se
revisa el ADR, después el código.

**Antes de escribir una línea de una fase nueva:** leer sus ADRs, el `roadmap.md` y la sección
correspondiente del `master-plan.md`. Dos veces esto ha destapado contradicciones que solo se
ven al implementar — y una de ellas obligó a escribir ADR-025.

**Los ADR son inmutables.** Si una decisión cambia, se escribe uno nuevo que la reemplaza.

**Test de simplicidad** antes de crear cualquier componente: ¿quién lo usa? ¿qué problema
resuelve? ¿qué pasa si no existe? Si falla alguna, no se crea. Por eso el outbox no lleva
estado por consumidor y la Ficha 360 no agrega verticales vacías.

---

## 8. Trampas ya pagadas (no volver a tropezar)

| Trampa | Detalle |
|---|---|
| **`uuidv7()` no existe en producción** | Es nativo en PostgreSQL 18 (local) pero **no** en el 17.9 de la RDS. Por eso existe `platform.uuid_generate_v7()` en PL/pgSQL. Un `DEFAULT uuidv7()` pasa en local y revienta al desplegar. |
| **Sequelize descarta columnas no declaradas** | Si el modelo no declara el atributo, `create()` lo ignora **sin error**. Al añadir una columna, actualizar también `app_core/models/<schema>.<tabla>.js`. |
| **`QueryTypes.SELECT` + desestructuración** | `const [filas] = await query(sql, {type: SELECT})` devuelve la **primera fila**, no el array. O una cosa o la otra. |
| **Transacciones en tests** | Envolver siempre en `try/finally`. Una aserción fallida dejó una transacción abierta que bloqueó la suite entera con `idle in transaction`. |
| **Best-effort necesita SAVEPOINT** | En Postgres cualquier error aborta la transacción entera. Un `try/catch` a secas atrapa el error pero deja la transacción envenenada y el commit falla igual. |
| **Migrar desde cero ≠ esquema de producción** | Hay ~44 archivos en `migrations/` y solo 26 registrados como `migrate:*`. El esquema local se carga con `pg_dump --schema-only` de producción, nunca corriendo las migraciones. |
| **Fan-out de JOIN inflando dinero** | Las preguntas 1 y 2 del Ledger unían `conversacion`, `turno` y `costo` en un solo `GROUP BY`: el producto cartesiano multiplicaba el costo por el número de turnos (3×) y de conversaciones (2×). Un `count(DISTINCT ...)` arregla el conteo y **deja el importe inflado**, que es la mitad peor. Cada agregado, en su propia subconsulta escalar. |
| **Una partición que falta tumba el sistema entero** | Una tabla particionada sin la partición del mes rechaza *todo* INSERT. Ocurre a medianoche del día 1, sin aviso. Hay particiones hasta 2027-10 y `intelligence_mantenimiento.js estado` avisa; no hay cron. |
| **`pg_inherits` lista también los índices** | Al enumerar particiones salen las de los índices particionados como si fueran tablas. Filtrar por `relkind = 'r'`. |
| **Un servicio que confirma su propia transacción rompe el dry-run** | `crearCita` y `holdService.tomar` abrían y confirmaban su transacción, así que el rollback del Policy Gate no deshacía nada: «ejecutar en seco» ejecutaba de verdad. Lo destaparon dos tests de F4-B. Ahora todos aceptan `{ transaction }` y, si viene de fuera, **no confirman** — ni notifican, porque un correo enviado no se deshace con un rollback. |
| **Idempotencia: comprobar-y-actuar tiene ventana** | El Gate mira si la clave existe y luego ejecuta. En una carrera, la perdedora casi nunca choca contra la clave primaria: antes se topa con el efecto de la ganadora (`SLOT_NO_DISPONIBLE`). Por eso, ante **cualquier** error se vuelve a mirar la clave. Filtrar solo por violación de unicidad dejaba fuera justo el caso real. |
| **Una clave de idempotencia vive para siempre** | Reutilizar una clave semanas después devuelve el resultado viejo sin ejecutar nada. Es correcto por diseño (en F5 las claves son ids de turno, únicos), pero convierte cualquier guion de prueba que reutilice claves en algo que parece roto. |
| **`FOR UPDATE` no bloquea lo que no existe** | El anti-doble-reserva de `crearCita` hacía `SELECT ... FOR UPDATE` sobre las citas que solapan. Si el hueco está **vacío** no hay ninguna fila que bloquear, así que dos peticiones simultáneas pasaban las dos. Un lock de rango necesita `pg_advisory_xact_lock` o una `EXCLUDE` constraint, no un `FOR UPDATE`. |
| **Un test verde puede no probar nada** | La suite de F3 pasó a la primera. Antes de darla por buena se comprobó al revés: se reejecutó el guion que **reproducía** el bug del buffer y pasó de `RECHAZA` a `ACEPTA`. Un test que nunca se vio fallar no es evidencia. |
| **Flake en `reportes`** | `reporteExportService.test.js` falló 1 de 5 corridas de la suite completa, dentro de `exceljs` al construir un `PassThrough`. Aislado siempre pasa. No es de F3 (no toca `reportes`), pero está ahí. |
| **Lecturas que escriben** | `disponibilidadService.getConfig` **crea** la config del negocio si falta. Es razonable para un formulario y venenoso para un dry-run: la escritura ocurre fuera de la transacción del Policy Gate, así que el rollback no la deshace. El adaptador comprueba la precondición antes en vez de tocar la vertical. Sospechar de cualquier `get*` que haga `create`. |
| **Un `timestamptz` no cabe en un `Date`** | Postgres guarda microsegundos y `Date` de JS solo milisegundos, así que el valor que devuelve el driver **está truncado**. Con las tablas particionadas la PK es `(id, creado_en)`, y devolver ese `Date` en un `WHERE creado_en = ...` no casa con ninguna fila: el `UPDATE` afecta a cero filas **sin error** y el turno se queda en `procesando` para siempre. Se arregla devolviendo también `creado_en::text`. Cualquier escritura futura contra `intelligence` tiene el mismo problema. |
| **`Number(env) \|\| defecto` se traga el cero** | `CONVERSACION_TURNO_COLGADO_MIN=0` daba 10, así que `recuperar` decía haber revisado y no revisaba nada. Es el idioma habitual del repo y es correcto donde cero no significa nada, pero aquí «sin debounce» y «da por colgado cualquier turno» son justo lo que un test necesita pedir. Hay un `numeroDeEntorno()` en `intelligence/engine/cola.js`. |
| **`ON CONFLICT DO NOTHING` no sirve para deduplicar** | La entrega perdedora no recibe fila **ni espera**, y el `SELECT` posterior no ve la de la ganadora porque aún no ha confirmado: el duplicado se procesa como nuevo. Hay que usar `DO UPDATE` (aunque no actualice nada), que sí toma el lock y espera, con `(xmax = 0)` para distinguir insert de update. |
| **Un test de concurrencia puede ser probabilístico sin que se note** | El test de «dos turnos simultáneos» pasaba **también con el lock quitado**: con un manejador rápido, el primer turno a veces confirma antes de que el segundo lea los pendientes. ADR-014 descartó por escrito el aislamiento probabilístico; un test probabilístico de ese aislamiento es el mismo error una capa más arriba. Se arregla con un manejador deliberadamente lento, que mete al segundo dentro de la ventana con seguridad. |
| **El manejador no puede envenenar la transacción… pero su decisión sí** | El SAVEPOINT de `decidir()` no protege de las consultas del manejador —esas van por otra conexión del pool—, sino de **lo que devuelve**: un `tipo` de paso fuera del CHECK aborta la transacción del turno, y sin savepoint el `UPDATE` que lo marca como fallido revienta también y el turno desaparece del Ledger justo cuando hace falta verlo. El primer test que se escribió para esto (un `SELECT 1/0` dentro del manejador) **no probaba nada**. |
| **Cambiar un `ORDER BY` puede romper un `WHERE` que dependía de él** | `mensajesPendientes` pasó a ordenar por la hora del canal (`enviado_en`), y `asignarMensajesATurno` usaba `mensajes[0].creado_en` como cota inferior para podar particiones. Desde el cambio, el primero de la lista puede ser el que **llegó el último**: la cota dejaba fuera del `UPDATE` a los demás, que se quedaban pendientes y se reprocesaban en cada turno. Ahora se calcula el mínimo. Sospechar de cualquier cota derivada del «primer elemento» de una lista cuyo orden no es el de esa columna. |
| **Asertar sobre contadores de lote hace un test rehén de todos los demás** | `gateway.entregarUnaVez()` reclama **todos** los salientes pendientes del sistema, así que `expect(resultado.fallidos).toBe(1)` fallaba en cuanto otra sesión, otro canal o los restos de una CLI dejaban algo pendiente. Da 8 donde esperabas 1 y parece un bug del código. Los asertos van sobre **la fila** del mensaje concreto. |
| **Un test que agrega por negocio se rompe cuando alguien usa ese negocio** | Cuatro de las doce preguntas del Ledger son agregados por `(negocio, ventana)`. Mientras las tablas estuvieron vacías bastó limpiar por canal; en cuanto F5-B escribió turnos de verdad en el negocio 1, la suite de F5-A se cayó. La consulta no estaba mal: estaba mal suponer que nadie más usaría el negocio de desarrollo. Ahora el test crea su propio negocio desechable. |
| **`reserva` está vacía también en local** | El esquema local sale de un `pg_dump` de producción, y en producción `reserva` tiene 0 filas. Sin `scripts/fixtures/dev_reserva.sql` la vertical responde "no hay nada" a todo y parece que el código falla. |
| **Procesos zombis en el puerto** | Ver §3. |

---

## 9. Mapa de documentos

| Documento | Para qué |
|---|---|
| `architecture/architecture-principles.md` | La constitución. Máxima precedencia. |
| `adr/README.md` | Índice de los 25 ADRs. Empezar por ADR-001→006. |
| `architecture/freeze.md` | Qué se congeló y por qué. |
| `architecture/roadmap.md` | Plan de construcción, fase a fase. **El estado real de cada fase está anotado ahí.** |
| `architecture/domain-events.md` | Catálogo de eventos (todos `Planificado` todavía). |
| `architecture/capability-language.md` | Metamodelo de capacidades y estado real de cada una. |
| `architecture/glossary.md` | La lengua ubicua. |
| `desarrollo-local.md` | Montar el entorno local desde cero. |
| `mediciones/` | Mediciones sobre datos reales que condicionaron decisiones. |

## 10. Dónde está cada cosa que se construyó

| Qué | Dónde |
|---|---|
| Núcleo de capacidades (agnóstico) | `intelligence/core/` — Registry, Policy Gate, features, validación |
| Adaptador de la vertical piloto | `intelligence/adapters/reserva/` |
| Composición (el único sitio que nombra verticales) | `intelligence/index.js` |
| Conversation Engine (F5-B) | `intelligence/engine/` — `motor.js` · `cola.js` · `repositorio.js` · `manejadorEco.js` |
| Mensaje Canónico (F5-C) | `intelligence/core/mensajeCanonico.js` — el contrato de ADR-017, en el núcleo |
| Canales y entrega (F5-C) | `intelligence/channels/` — `gateway.js` · `webchat/adaptador.js` · `webchat/simuladorFallos.js` |
| Superficie HTTP + widget | `intelligence/http.js` · `intelligence/channels/webchat/publico/index.html` |
| Arnés sin IA | `scripts/capacidad.js` (capacidades) · `scripts/conversacion.js` (motor) |
| Las doce preguntas del Ledger | `scripts/ledger_doce_preguntas.js` |
| Particiones y retención | `scripts/intelligence_mantenimiento.js` |
| Reglas de la agenda (F3) | `app_reserva_api/services/reglasAgenda.js` · `estadoCita.js` · `holdService.js` |
| Tests | `__tests__/platform/` (5) · `__tests__/reserva/` (1) · `__tests__/intelligence/` (3) |

**Desde F5-C `intelligence` sí se monta en `app.js`, pero detrás de dos guardas.** Una es que
el directorio exista, y es la que mantiene **literal** el test del apagón: se comprobó de
verdad —moviendo `intelligence/` fuera— que el backend arranca igual. La otra es
`INTELLIGENCE_HTTP_ENABLED=true`, apagada por defecto. Con la bandera apagada, Intelligence
sigue sin tener más clientes que las dos CLI y los tests.

**El motor tampoco arranca solo.** `intelligence.arrancarMotor(manejador)` es explícito y va
aparte de `arrancar()`: registrar el catálogo de capacidades es gratis, pero arrancar el motor
recupera trabajo de la base y empieza a abrir turnos, y quien solo quiera capacidades no debe
pagar eso por importar el módulo.
