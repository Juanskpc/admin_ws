/**
 * Acceso al esquema `intelligence`. Es el ÚNICO sitio del motor que escribe SQL.
 *
 * ## Por qué SQL crudo y no modelos de Sequelize
 *
 * El resto del backend declara un modelo por tabla en `app_core/models/<esquema>.<tabla>.js`
 * y deja que `conection.js` los cargue solos. Aquí no, por tres razones concretas:
 *
 *   1. **ADR-004: `intelligence` debe poder extraerse a su propio servicio.** Un modelo en
 *      `app_core/models/` lo ataría al arranque del monolito y lo pondría al alcance de
 *      cualquier vertical con un `require`. Todo el acceso pasa por este archivo.
 *   2. **Cinco de las siete tablas están particionadas.** Sequelize no sabe nada de la clave
 *      de partición: su `update({where: {id_turno}})` recorrería las quince particiones.
 *      Aquí las escrituras llevan siempre `creado_en`, que es lo que permite podar.
 *   3. La PK es compuesta (`id, creado_en`) por exigencia del particionado, y eso convierte
 *      cualquier `findByPk` en una trampa.
 *
 * ## Convenio de transacción
 *
 * Ninguna función abre transacción propia. Todas aceptan `{ transaction }` y lo exigen
 * cuando escriben algo que debe ser atómico con el turno. Quien manda es `motor.js`. Es la
 * misma regla que ya sigue `outboxDao.emitir()`.
 */
'use strict';
const Models = require('../../app_core/models/conection');

const sequelize = Models.sequelize;
const SELECT = { type: sequelize.QueryTypes.SELECT };

/**
 * Estados de conversación en los que el motor trabaja.
 *
 * Los otros cuatro de ADR-014 son deliberadamente pasivos: en `handoff_humano` responde una
 * persona y un bot que contesta encima es peor que uno mudo; `bloqueada` y `suspendida` son
 * decisiones del negocio; `cerrada` se reabre sola al llegar un mensaje (ver
 * `asegurarConversacion`). En todos ellos el mensaje **se guarda igual**: no procesarlo no
 * es razón para perderlo.
 */
const ESTADOS_PROCESABLES = ['activa', 'dormida'];

/** Código de Postgres para «no pude tomar el lock y me dijiste que no esperara». */
const LOCK_NO_DISPONIBLE = '55P03';

function esErrorDeLock(error) {
    const codigo = error?.parent?.code || error?.original?.code || error?.code;
    return codigo === LOCK_NO_DISPONIBLE;
}

async function unaFila(sql, replacements, transaction) {
    const filas = await sequelize.query(sql, { replacements, transaction, ...SELECT });
    return filas[0] ?? null;
}

// ── Ingesta ─────────────────────────────────────────────────────────────────────────────

/**
 * Reserva el id de un mensaje entrante, o descubre que ya se recibió.
 *
 * La deduplicación necesita una garantía **global**, por eso `ingesta_recibida` es la única
 * tabla del Ledger sin particionar (ver la migración F5-A). Aquí se convierte en la primera
 * línea de defensa contra lo que ADR-016 promete inyectar: entregas duplicadas del canal.
 *
 * Si el canal no aporta un identificador propio no hay nada que deduplicar y se devuelve un
 * uuid nuevo. Es una degradación consciente: el Mensaje Canónico de ADR-017 exige ese
 * identificador, así que un canal que no lo trae es un canal a medio adaptar, no un caso
 * normal que haya que soportar para siempre.
 *
 * @returns {Promise<{idMensaje: string, duplicado: boolean}>}
 */
async function reservarIngesta({ idNegocio, canal, idExternoMensaje }, { transaction }) {
    if (!idExternoMensaje) {
        const fila = await unaFila('SELECT platform.uuid_generate_v7() AS id;', {}, transaction);
        return { idMensaje: fila.id, duplicado: false };
    }

    // `DO UPDATE` que no actualiza nada, y no `DO NOTHING`, por una carrera concreta: con
    // `DO NOTHING` la entrega perdedora no recibe fila ni espera, y el `SELECT` posterior no
    // ve la fila de la ganadora porque todavía no ha confirmado. Resultado: la duplicada se
    // procesaría como si fuera nueva, que es justo lo que esta tabla existe para impedir.
    // `DO UPDATE` sí toma el lock, espera a la ganadora y devuelve su fila.
    //
    // `xmax = 0` distingue el INSERT del UPDATE: en una fila recién insertada xmax es cero.
    const fila = await unaFila(
        `
        INSERT INTO intelligence.ingesta_recibida (id_negocio, canal, id_externo, id_mensaje)
        VALUES (:idNegocio, :canal, :idExterno, platform.uuid_generate_v7())
        ON CONFLICT (id_negocio, canal, id_externo) DO UPDATE
           SET id_mensaje = ingesta_recibida.id_mensaje
        RETURNING id_mensaje, (xmax = 0) AS insertado;
        `,
        { idNegocio, canal, idExterno: idExternoMensaje },
        transaction
    );

    return { idMensaje: fila.id_mensaje, duplicado: !fila.insertado };
}

// ── Conversación ────────────────────────────────────────────────────────────────────────

/**
 * Devuelve la conversación de este interlocutor en este canal, creándola si es su primer
 * mensaje. La unicidad `(id_negocio, canal, id_externo)` es lo que hace que el segundo
 * mensaje de alguien caiga en su hilo y no abra otro.
 *
 * Una conversación `dormida` o `cerrada` se reactiva: escribir de nuevo *es* reabrirla. Los
 * otros tres estados no se tocan, porque los decidió alguien —un humano que tomó el control,
 * el negocio que bloqueó a un contacto— y el motor no está para deshacerlo.
 */
async function asegurarConversacion({ idNegocio, canal, idExterno }, { transaction }) {
    return unaFila(
        `
        INSERT INTO intelligence.conversacion (id_negocio, canal, id_externo, ultimo_mensaje_en)
        VALUES (:idNegocio, :canal, :idExterno, now())
        ON CONFLICT (id_negocio, canal, id_externo) DO UPDATE
           SET ultimo_mensaje_en = now(),
               estado = CASE WHEN conversacion.estado IN ('dormida', 'cerrada')
                             THEN 'activa' ELSE conversacion.estado END,
               cerrado_en = CASE WHEN conversacion.estado = 'cerrada'
                                 THEN NULL ELSE conversacion.cerrado_en END
        RETURNING id_conversacion, id_negocio, canal, id_externo, estado,
                  variables, tarea_actual, tarea_datos;
        `,
        { idNegocio, canal, idExterno },
        transaction
    );
}

/**
 * Toma el lock pesimista de la conversación (ADR-014, mecanismo 2).
 *
 * `NOWAIT` y no una espera: si otro proceso tiene la conversación, este vuelve a encolarla y
 * se ocupa de otra. Esperar bloquearía una conexión del pool durante todo el turno ajeno —y
 * con `pool.max = 10`, unas pocas esperas dejan el backend entero sin conexiones.
 *
 * **Aquí `FOR UPDATE` sí sirve**, a diferencia de lo que ocurrió con la agenda en F3: allí se
 * intentaba bloquear un hueco vacío —filas que aún no existían, luego no había nada que
 * bloquear— y hubo que ir a `pg_advisory_xact_lock`. La conversación, en cambio, es una fila
 * que ya existe cuando se toma el lock, que es exactamente la condición que `FOR UPDATE` pide.
 *
 * @returns {Promise<Object|null>} la conversación bloqueada, o `null` si está ocupada.
 */
async function bloquear(idConversacion, { transaction }) {
    try {
        return await unaFila(
            `
            SELECT id_conversacion, id_negocio, canal, id_externo, estado,
                   variables, tarea_actual, tarea_datos
              FROM intelligence.conversacion
             WHERE id_conversacion = :idConversacion
               FOR UPDATE NOWAIT;
            `,
            { idConversacion },
            transaction
        );
    } catch (error) {
        if (esErrorDeLock(error)) return null;
        throw error;
    }
}

/**
 * Guarda el estado conversacional al cerrar el turno.
 *
 * `variables` es la memoria de sesión; `tarea_actual` / `tarea_datos` son la tarea en curso.
 * ADR-014 los separa a propósito: la conversación es infinita y la tarea es acotada y
 * retomable días después. Escribirlos aquí, dentro de la transacción del turno, es lo que
 * hace que la continuidad sobreviva a un reinicio: no hay estado del motor en memoria.
 */
async function guardarEstado(
    idConversacion,
    { variables, tareaActual, tareaDatos, estado },
    { transaction }
) {
    await sequelize.query(
        `
        UPDATE intelligence.conversacion
           SET variables    = CAST(:variables AS jsonb),
               tarea_actual = :tareaActual,
               tarea_datos  = CAST(:tareaDatos AS jsonb),
               estado       = :estado,
               cerrado_en   = CASE WHEN :estado = 'cerrada' THEN now() ELSE NULL END
         WHERE id_conversacion = :idConversacion;
        `,
        {
            replacements: {
                idConversacion,
                variables: JSON.stringify(variables ?? {}),
                tareaActual: tareaActual ?? null,
                tareaDatos: JSON.stringify(tareaDatos ?? {}),
                estado,
            },
            transaction,
        }
    );
}

// ── Mensajes ────────────────────────────────────────────────────────────────────────────

async function insertarMensajeEntrante(
    { idMensaje, idConversacion, idNegocio, canal, idExternoMensaje, contenido, crudo, enviadoEn },
    { transaction }
) {
    return unaFila(
        `
        INSERT INTO intelligence.mensaje
            (id_mensaje, id_conversacion, id_negocio, direccion, canal, id_externo, contenido,
             crudo, enviado_en)
        VALUES
            (:idMensaje, :idConversacion, :idNegocio, 'entrante', :canal, :idExterno,
             :contenido, CAST(:crudo AS jsonb), :enviadoEn)
        RETURNING id_mensaje, creado_en;
        `,
        {
            idMensaje,
            idConversacion,
            idNegocio,
            canal,
            idExterno: idExternoMensaje ?? null,
            contenido,
            crudo: crudo ? JSON.stringify(crudo) : null,
            // Nulo si el canal no lo trae o si venía fuera de una ventana creíble: lo sanea
            // `core/mensajeCanonico.js`, porque este valor **ordena la conversación**.
            enviadoEn: enviadoEn ?? null,
        },
        transaction
    );
}

/**
 * Los mensajes entrantes que todavía no pertenecen a ningún turno. Son los que el debounce
 * agrupó: «hola» + «quiero cita» + «para mañana» salen de aquí como tres filas de **un** turno.
 *
 * La ventana no es cosmética. Sin una cota inferior sobre `creado_en`, la consulta recorre
 * las quince particiones de `mensaje`; con ella Postgres poda todas menos una o dos. Y de
 * paso evita que un mensaje que lleva semanas sin procesar —el motor estuvo caído— resucite
 * dentro de una conversación que ya siguió su curso.
 *
 * ## El orden es el del canal, no el de llegada
 *
 * `COALESCE(enviado_en, creado_en)` y no `creado_en` a secas: si la red entrega «para mañana»
 * antes que «quiero cita», ordenar por llegada le da al asistente la frase del revés. Es uno
 * de los fallos que el WebChat hostil inyecta a propósito (ADR-016). Cuando el canal no
 * aporta su marca —o aporta una que no se sostiene—, se cae en la hora de llegada, que es
 * peor pero es nuestra.
 */
async function mensajesPendientes(idConversacion, { ventanaDias, transaction }) {
    return sequelize.query(
        `
        SELECT id_mensaje, creado_en, contenido, id_externo, enviado_en
          FROM intelligence.mensaje
         WHERE id_conversacion = :idConversacion
           AND direccion = 'entrante'
           AND id_turno IS NULL
           AND creado_en > now() - (:ventanaDias || ' days')::interval
         ORDER BY COALESCE(enviado_en, creado_en), creado_en, id_mensaje;
        `,
        { replacements: { idConversacion, ventanaDias: String(ventanaDias) }, transaction, ...SELECT }
    );
}

async function asignarMensajesATurno(mensajes, idTurno, { transaction }) {
    if (mensajes.length === 0) return;

    // La cota es el MÍNIMO `creado_en`, no el del primero de la lista. Desde que los mensajes
    // se ordenan por la hora del canal (`enviado_en`), el primero de la lista puede haber
    // llegado el último: usar el suyo dejaría fuera del `UPDATE` a los que llegaron antes y
    // esos mensajes se quedarían pendientes para siempre, reprocesándose en cada turno.
    // La cota existe solo para podar particiones; el `IN` es quien selecciona.
    const desde = mensajes.reduce(
        (minimo, m) => (m.creado_en < minimo ? m.creado_en : minimo),
        mensajes[0].creado_en
    );

    await sequelize.query(
        `
        UPDATE intelligence.mensaje
           SET id_turno = :idTurno
         WHERE id_mensaje IN (:ids)
           AND creado_en >= :desde;
        `,
        { replacements: { idTurno, ids: mensajes.map((m) => m.id_mensaje), desde }, transaction }
    );
}

/**
 * Deja preparado un mensaje de salida. Nace `pendiente`: quien lo entrega es el Channel
 * Gateway de F5-C, que todavía no existe. En F5-B el arnés (`scripts/conversacion.js`) los
 * lee de aquí, que es lo que permite ver una conversación entera sin un canal real.
 */
async function insertarMensajeSaliente(
    { idConversacion, idNegocio, idTurno, canal, contenido, opciones = [] },
    { transaction }
) {
    return unaFila(
        `
        INSERT INTO intelligence.mensaje
            (id_conversacion, id_negocio, id_turno, direccion, canal, contenido, opciones,
             estado_entrega)
        VALUES
            (:idConversacion, :idNegocio, :idTurno, 'saliente', :canal, :contenido,
             CAST(:opciones AS jsonb), 'pendiente')
        RETURNING id_mensaje, creado_en;
        `,
        {
            idConversacion,
            idNegocio,
            idTurno,
            canal,
            contenido,
            opciones: JSON.stringify(opciones ?? []),
        },
        transaction
    );
}

/**
 * Reclama mensajes salientes pendientes para entregarlos.
 *
 * `FOR UPDATE SKIP LOCKED` es lo que permite que haya más de un entregador sin que dos
 * manden el mismo mensaje: el segundo simplemente salta las filas que el primero tiene
 * cogidas. Es el mismo patrón que `outboxDao.reclamarPendientes`.
 *
 * El `JOIN` con `conversacion` trae el `id_externo`, que es a **quién** hay que entregarle:
 * el mensaje sabe de qué conversación es, pero no a qué número o sesión del canal apunta.
 *
 * La ventana acota a las particiones recientes. Un saliente más viejo que eso ya no se
 * entrega: mandar la respuesta a algo que se preguntó hace una semana es peor que callar.
 */
async function reclamarSalientesPendientes({ lote, ventanaHoras, transaction }) {
    return sequelize.query(
        `
        SELECT m.id_mensaje, m.creado_en, m.creado_en::text AS creado_en_clave,
               m.id_conversacion, m.id_negocio, m.id_turno, m.canal, m.contenido, m.opciones,
               m.intentos_entrega,
               c.id_externo
          FROM intelligence.mensaje m
          JOIN intelligence.conversacion c ON c.id_conversacion = m.id_conversacion
         WHERE m.direccion = 'saliente'
           AND m.estado_entrega = 'pendiente'
           AND m.creado_en > now() - (:ventanaHoras || ' hours')::interval
         ORDER BY m.creado_en
         LIMIT :lote
           FOR UPDATE OF m SKIP LOCKED;
        `,
        {
            replacements: { lote, ventanaHoras: String(ventanaHoras) },
            transaction,
            ...SELECT,
        }
    );
}

/**
 * Anota el desenlace de un intento de entrega.
 *
 * `entregado` es final. `fallido` es el *dead letter*: se llega ahí solo tras agotar los
 * intentos, y entonces nadie lo reintenta — un mensaje que lleva cinco fallos seguidos no se
 * arregla insistiendo, y seguir insistiendo tapa el problema real.
 */
async function marcarEntrega(mensaje, { entregado, maxIntentos }, { transaction }) {
    const intentos = (mensaje.intentos_entrega || 0) + 1;
    const estado = entregado ? 'entregado' : intentos >= maxIntentos ? 'fallido' : 'pendiente';

    await sequelize.query(
        `
        UPDATE intelligence.mensaje
           SET estado_entrega = :estado,
               intentos_entrega = :intentos,
               entregado_en = CASE WHEN :estado = 'entregado' THEN now() ELSE entregado_en END
         WHERE id_mensaje = :idMensaje AND creado_en = CAST(:creadoEn AS timestamptz);
        `,
        {
            replacements: {
                estado,
                intentos,
                idMensaje: mensaje.id_mensaje,
                // El texto, no el Date: ver el comentario de `abrirTurno`.
                creadoEn: mensaje.creado_en_clave,
            },
            transaction,
        }
    );

    return { estado, intentos, agotado: estado === 'fallido' };
}

// ── Turnos y pasos ──────────────────────────────────────────────────────────────────────

/**
 * Abre un turno. `secuencia` se calcula con un `max()+1` que solo es seguro porque quien
 * llama tiene el lock de la conversación; sin él, dos turnos simultáneos elegirían el mismo
 * número.
 *
 * `intentos` llega de fuera y no siempre vale 1: cuando `recuperarTurnosColgados` revive el
 * trabajo de un proceso que murió a mitad, el turno nuevo hereda la cuenta del viejo. Es la
 * columna con la que el Ledger responde a la pregunta 9.
 *
 * ## `creado_en_clave` no es redundante
 *
 * La PK es `(id_turno, creado_en)` porque el particionado obliga a incluir la clave de
 * partición. Y `creado_en` es un `timestamptz`, que en Postgres tiene **microsegundos**,
 * mientras que un `Date` de JavaScript solo llega al milisegundo: el valor que devuelve el
 * driver está truncado, y volver a mandarlo en un `WHERE creado_en = ...` no casa con
 * ninguna fila. El `UPDATE` no falla —afecta a cero filas en silencio— y el turno se queda
 * en `procesando` para siempre.
 *
 * Por eso se devuelve también el texto: es el único valor que reconstruye el instante exacto.
 */
async function abrirTurno(
    { idConversacion, idNegocio, nivel = 'determinista', intentos = 1 },
    { transaction }
) {
    return unaFila(
        `
        INSERT INTO intelligence.turno (id_conversacion, id_negocio, secuencia, nivel, estado, intentos)
        VALUES (
            :idConversacion, :idNegocio,
            COALESCE((SELECT max(secuencia) FROM intelligence.turno
                       WHERE id_conversacion = :idConversacion), 0) + 1,
            :nivel, 'procesando', :intentos
        )
        RETURNING id_turno, creado_en, creado_en::text AS creado_en_clave, secuencia, intentos;
        `,
        { idConversacion, idNegocio, nivel, intentos },
        transaction
    );
}

async function cerrarTurno(
    turno,
    { resultado, errorCodigo = null, errorDetalle = null, latenciaMs },
    { transaction }
) {
    // Se comprueba el número de filas porque el modo en que esto falla es **en silencio**:
    // un `WHERE` que no casa deja el turno en `procesando` y a nadie quejándose. La primera
    // vez costó una hora encontrarlo (ver `creado_en_clave` en `abrirTurno`).
    const [, resultadoSql] = await sequelize.query(
        `
        UPDATE intelligence.turno
           SET estado = 'terminado',
               resultado = :resultado,
               error_codigo = :errorCodigo,
               error_detalle = :errorDetalle,
               latencia_ms = :latenciaMs,
               terminado_en = now()
         WHERE id_turno = :idTurno AND creado_en = CAST(:creadoEn AS timestamptz);
        `,
        {
            replacements: {
                idTurno: turno.id_turno,
                // El texto, no el Date: ver el comentario de `abrirTurno`.
                creadoEn: turno.creado_en_clave,
                resultado,
                errorCodigo,
                errorDetalle: errorDetalle ? String(errorDetalle).slice(0, 2000) : null,
                latenciaMs,
            },
            transaction,
        }
    );

    if (resultadoSql?.rowCount === 0) {
        throw new Error(
            `No se pudo cerrar el turno ${turno.id_turno}: el UPDATE no afectó ninguna fila. ` +
                'Casi seguro es la clave de partición (creado_en) mal reconstruida.'
        );
    }
}

/**
 * Un paso del turno: qué decidió el motor y por qué (ADR-022, la «decision» del Ledger).
 *
 * Un turno determinista suele tener dos —la regla que casó y la respuesta—; uno con LLM
 * tendrá varios. Se modela en plural desde hoy porque los pasos que no se registren no se
 * pueden inventar después.
 */
async function registrarPaso(
    { idTurno, idNegocio, secuencia, tipo, decision, motivo, latenciaMs = null },
    { transaction }
) {
    await sequelize.query(
        `
        INSERT INTO intelligence.paso (id_turno, id_negocio, secuencia, tipo, decision, motivo, latencia_ms)
        VALUES (:idTurno, :idNegocio, :secuencia, :tipo, :decision, CAST(:motivo AS jsonb), :latenciaMs);
        `,
        {
            replacements: {
                idTurno,
                idNegocio,
                secuencia,
                tipo,
                decision: decision ?? null,
                motivo: JSON.stringify(motivo ?? {}),
                latenciaMs,
            },
            transaction,
        }
    );
}

/**
 * Registra en el Ledger que un turno invocó una capacidad (F5-E).
 *
 * ## Por qué lo escribe el motor y no el Policy Gate
 *
 * «Capacidades ejecutadas» es una de las doce preguntas de ADR-022, y hasta F5-E nadie
 * llenaba esta tabla: el Gate audita en `auditoria.audit_evento`, que es forense de
 * plataforma —quién hizo qué, para responder después de un incidente— y no observabilidad de
 * conversación. Son dos preguntas distintas y por eso son dos tablas distintas.
 *
 * El Gate no puede escribir aquí aunque quisiera: **no sabe que lo llaman desde una
 * conversación**. No recibe `id_turno` ni `id_conversacion`, y además lo usa la CLI de
 * capacidades fuera de todo turno. Enseñarle esos ids solo para el Ledger lo ataría a
 * Intelligence sin necesidad.
 *
 * Así que se resuelve con la frontera que ya existía: **el manejador devuelve lo que hizo y
 * el motor lo escribe**, igual que con los pasos. El manejador sigue sin tocar la base.
 */
async function registrarInvocacion(
    {
        idTurno,
        idConversacion,
        idNegocio,
        capacidad,
        vertical = null,
        argumentos = null,
        resultado,
        errorCodigo = null,
        dryRun = false,
        latenciaMs = null,
    },
    { transaction }
) {
    await sequelize.query(
        `
        INSERT INTO intelligence.invocacion_capacidad
            (id_turno, id_conversacion, id_negocio, capacidad, vertical, argumentos,
             resultado, error_codigo, dry_run, latencia_ms)
        VALUES (:idTurno, :idConversacion, :idNegocio, :capacidad, :vertical,
                CAST(:argumentos AS jsonb), :resultado, :errorCodigo, :dryRun, :latenciaMs);
        `,
        {
            replacements: {
                idTurno,
                idConversacion,
                idNegocio,
                capacidad,
                vertical,
                argumentos: JSON.stringify(argumentos ?? {}),
                resultado,
                errorCodigo,
                dryRun: Boolean(dryRun),
                latenciaMs,
            },
            transaction,
        }
    );
}

/**
 * Turnos que se quedaron en `procesando`: el proceso murió con la transacción abierta, así
 * que Postgres deshizo sus escrituras pero la fila del turno —escrita y confirmada al
 * abrirlo— quedó huérfana.
 *
 * Se marcan `abandonado` y se **sueltan sus mensajes** (`id_turno = NULL`) para que el turno
 * siguiente los vuelva a agrupar. Es el criterio de aceptación 3 de F5 (master-plan): matar
 * el proceso a mitad y que la conversación siga donde estaba.
 *
 * El umbral tiene que ser mayor que el turno más lento imaginable: marcar como colgado un
 * turno que sigue vivo duplicaría el trabajo. Con el lock por conversación el daño estaría
 * acotado —el segundo turno no podría entrar hasta que el primero suelte—, pero el resultado
 * sería un turno abandonado que en realidad terminó bien, y eso ensucia la pregunta 11.
 */
async function recuperarTurnosColgados({ umbralMinutos, transaction }) {
    const turnos = await sequelize.query(
        `
        UPDATE intelligence.turno
           SET estado = 'abandonado',
               resultado = COALESCE(resultado, 'sin_respuesta'),
               error_codigo = COALESCE(error_codigo, 'TURNO_COLGADO'),
               terminado_en = now()
         WHERE estado = 'procesando'
           AND creado_en < now() - (:umbralMinutos || ' minutes')::interval
        RETURNING id_turno, id_conversacion, id_negocio, intentos;
        `,
        { replacements: { umbralMinutos: String(umbralMinutos) }, transaction, ...SELECT }
    );

    if (turnos.length > 0) {
        await sequelize.query(
            `UPDATE intelligence.mensaje SET id_turno = NULL WHERE id_turno IN (:ids);`,
            { replacements: { ids: turnos.map((t) => t.id_turno) }, transaction }
        );
    }

    return turnos;
}

/** Conversaciones con mensajes entrantes sin turno. Se usa al arrancar, para no perder nada. */
async function conversacionesConPendientes({ ventanaDias, transaction = null }) {
    return sequelize.query(
        `
        SELECT DISTINCT m.id_conversacion
          FROM intelligence.mensaje m
          JOIN intelligence.conversacion c ON c.id_conversacion = m.id_conversacion
         WHERE m.direccion = 'entrante'
           AND m.id_turno IS NULL
           AND m.creado_en > now() - (:ventanaDias || ' days')::interval
           AND c.estado IN (:procesables);
        `,
        {
            replacements: { ventanaDias: String(ventanaDias), procesables: ESTADOS_PROCESABLES },
            transaction,
            ...SELECT,
        }
    );
}

module.exports = {
    ESTADOS_PROCESABLES,
    esErrorDeLock,
    reservarIngesta,
    asegurarConversacion,
    bloquear,
    guardarEstado,
    insertarMensajeEntrante,
    insertarMensajeSaliente,
    reclamarSalientesPendientes,
    marcarEntrega,
    mensajesPendientes,
    asignarMensajesATurno,
    abrirTurno,
    cerrarTurno,
    registrarPaso,
    registrarInvocacion,
    recuperarTurnosColgados,
    conversacionesConPendientes,
};
