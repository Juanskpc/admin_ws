/**
 * Conversation Engine (F5-B — ADR-014).
 *
 * ADR-014 no promete «que normalmente vaya bien»: descartó explícitamente el aislamiento
 * probabilístico —«"rara vez" es exactamente el bug que aparece en producción y no en las
 * pruebas»— y eligió tres mecanismos que o se cumplen siempre o no sirven. Así que esta
 * suite no comprueba que el motor conteste: comprueba que **no se le pueda hacer contestar
 * dos veces, ni perder un mensaje, ni cruzar dos turnos**.
 *
 * Los cuatro criterios de aceptación de F5 (master-plan) que dependen del motor:
 *
 *   2. Cinco mensajes en dos segundos producen UN turno coherente. → `agrupa la ráfaga`
 *   3. Matar el proceso a mitad y volver: la tarea se retoma. → `continuidad`
 *   4. Costo en tokens: $0.00. → no hay LLM en ninguna parte de este archivo.
 *
 * (El primero —agendar una cita entera por un canal— necesita el motor determinista de F5-D
 * y el canal de F5-C. Aquí el manejador es un andamio.)
 *
 * Requiere:  npm run migrate:intelligence-ledger
 * Correr con:  npx jest __tests__/intelligence/ --runInBand
 */
require('dotenv').config();
const Models = require('../../app_core/models/conection');
const motor = require('../../intelligence/engine/motor');
const repositorio = require('../../intelligence/engine/repositorio');
const { ColaParticionada, CONFIG: COLA_CONFIG } = require('../../intelligence/engine/cola');
const { manejarEco } = require('../../intelligence/engine/manejadorEco');

const sequelize = Models.sequelize;
const SELECT = { type: sequelize.QueryTypes.SELECT, logging: false };

/** Canal sintético: nada real usará este nombre, así que la limpieza es inequívoca. */
const CANAL = 'test_motor';

let idNegocio;

/** El debounce real es de 2,5 s y aquí no se está midiendo la paciencia de nadie. */
const DEBOUNCE_TEST = 250;

const consulta = (sql, replacements = {}) => sequelize.query(sql, { replacements, ...SELECT });
const unaFila = async (sql, replacements = {}) => (await consulta(sql, replacements))[0] ?? null;

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

let contador = 0;
const nuevoInterlocutor = (prefijo) => `${prefijo}_${Date.now()}_${contador++}`;

async function conversacionDe(idExterno) {
    return unaFila(
        `SELECT * FROM intelligence.conversacion
          WHERE id_negocio = :idNegocio AND canal = :canal AND id_externo = :idExterno;`,
        { idNegocio, canal: CANAL, idExterno }
    );
}

async function turnosDe(idConversacion) {
    return consulta(
        `SELECT * FROM intelligence.turno WHERE id_conversacion = :id ORDER BY secuencia;`,
        { id: idConversacion }
    );
}

async function mensajesDe(idConversacion, direccion) {
    return consulta(
        `SELECT * FROM intelligence.mensaje
          WHERE id_conversacion = :id AND direccion = :direccion ORDER BY creado_en;`,
        { id: idConversacion, direccion }
    );
}

async function pasosDe(idTurno) {
    return consulta(`SELECT * FROM intelligence.paso WHERE id_turno = :id ORDER BY secuencia;`, {
        id: idTurno,
    });
}

/** Un mensaje entrante ya guardado, sin pasar por la cola. Para controlar el momento exacto. */
async function guardarMensaje(idExterno, contenido) {
    return motor.recibir({
        idNegocio,
        canal: CANAL,
        idExterno,
        texto: contenido,
        despertar: false,
    });
}

beforeAll(async () => {
    const negocio = await unaFila(
        `SELECT id_negocio FROM general.gener_negocio WHERE estado = 'A' ORDER BY id_negocio LIMIT 1;`
    );
    if (!negocio) throw new Error('No hay ningún negocio activo. Corre scripts/seed_dev_local.js.');
    idNegocio = negocio.id_negocio;

    COLA_CONFIG.debounceMs = DEBOUNCE_TEST;
    COLA_CONFIG.debounceMaxMs = DEBOUNCE_TEST * 4;
});

beforeEach(() => {
    motor._reiniciar();
    motor.registrarManejador(manejarEco);
});

afterEach(() => {
    motor.detener();
});

afterAll(async () => {
    // El orden importa: los hijos antes que la conversación, porque `mensaje` y `turno` no
    // tienen FK hacia ella (son particionadas; ver la migración F5-A) y no hay cascada.
    const ids = (
        await consulta(
            `SELECT id_conversacion FROM intelligence.conversacion WHERE canal = :canal;`,
            { canal: CANAL }
        )
    ).map((f) => f.id_conversacion);

    if (ids.length > 0) {
        await sequelize.query(
            `DELETE FROM intelligence.paso WHERE id_turno IN
                (SELECT id_turno FROM intelligence.turno WHERE id_conversacion IN (:ids));`,
            { replacements: { ids }, logging: false }
        );
        await sequelize.query(`DELETE FROM intelligence.mensaje WHERE id_conversacion IN (:ids);`, {
            replacements: { ids },
            logging: false,
        });
        await sequelize.query(`DELETE FROM intelligence.turno WHERE id_conversacion IN (:ids);`, {
            replacements: { ids },
            logging: false,
        });
    }
    await sequelize.query(`DELETE FROM intelligence.ingesta_recibida WHERE canal = :canal;`, {
        replacements: { canal: CANAL },
        logging: false,
    });
    await sequelize.query(`DELETE FROM intelligence.conversacion WHERE canal = :canal;`, {
        replacements: { canal: CANAL },
        logging: false,
    });
    await sequelize.close();
});

// ── Mecanismo 3: debounce ───────────────────────────────────────────────────────────────

describe('debounce de agregación', () => {
    test('agrupa la ráfaga: cinco mensajes seguidos son UN turno con UNA respuesta', async () => {
        const quien = nuevoInterlocutor('rafaga');

        for (const texto of ['hola', 'quiero cita', 'para mañana', 'con Laura', 'gracias']) {
            await motor.recibir({ idNegocio, canal: CANAL, idExterno: quien, texto });
            await dormir(40);
        }
        await motor.drenar();

        const conversacion = await conversacionDe(quien);
        const turnos = await turnosDe(conversacion.id_conversacion);
        const salientes = await mensajesDe(conversacion.id_conversacion, 'saliente');
        const entrantes = await mensajesDe(conversacion.id_conversacion, 'entrante');

        // Es el criterio de aceptación 2 de F5, literal: un turno, una respuesta.
        expect(turnos).toHaveLength(1);
        expect(salientes).toHaveLength(1);
        expect(entrantes).toHaveLength(5);
        // Y los cinco pertenecen a ese turno: ninguno se quedó por el camino.
        expect(entrantes.every((m) => m.id_turno === turnos[0].id_turno)).toBe(true);
        // El manejador vio el texto agrupado, no solo el primero.
        expect(salientes[0].contenido).toContain('con Laura');
    }, 20000);

    test('el techo del debounce impide que una ráfaga continua congele la conversación', async () => {
        // Sin techo, cada mensaje reinicia la espera y el turno no arranca nunca: mientras la
        // persona siga escribiendo, el bot calla. Es una inanición, no una optimización.
        const quien = nuevoInterlocutor('techo');

        for (let i = 0; i < 8; i++) {
            await motor.recibir({ idNegocio, canal: CANAL, idExterno: quien, texto: `msg ${i}` });
            // Menos que el debounce: sin techo, esto reiniciaría la espera ocho veces.
            await dormir(DEBOUNCE_TEST * 0.6);
        }
        await motor.drenar();

        const conversacion = await conversacionDe(quien);
        const turnos = await turnosDe(conversacion.id_conversacion);

        expect(turnos.length).toBeGreaterThan(1);
        const agrupados = await mensajesDe(conversacion.id_conversacion, 'entrante');
        expect(agrupados).toHaveLength(8);
        expect(agrupados.every((m) => m.id_turno !== null)).toBe(true);
    }, 20000);
});

// ── Ingesta ─────────────────────────────────────────────────────────────────────────────

describe('deduplicación de la ingesta', () => {
    test('el canal reentrega el mismo mensaje y no se procesa dos veces', async () => {
        const quien = nuevoInterlocutor('dup');
        const idExternoMensaje = `ext_${quien}`;

        const primera = await motor.recibir({
            idNegocio, canal: CANAL, idExterno: quien, texto: 'hola', idExternoMensaje,
        });
        const segunda = await motor.recibir({
            idNegocio, canal: CANAL, idExterno: quien, texto: 'hola', idExternoMensaje,
        });
        await motor.drenar();

        expect(primera.duplicado).toBe(false);
        expect(segunda.duplicado).toBe(true);
        // El id de la primera entrega, no uno nuevo: quien llame puede responder con él.
        expect(segunda.id_mensaje).toBe(primera.id_mensaje);

        const conversacion = await conversacionDe(quien);
        expect(await mensajesDe(conversacion.id_conversacion, 'entrante')).toHaveLength(1);
        expect(await turnosDe(conversacion.id_conversacion)).toHaveLength(1);
    }, 20000);

    test('dos entregas simultáneas de un duplicado: solo una gana', async () => {
        // La carrera real. Con `ON CONFLICT DO NOTHING` la perdedora no ve la fila de la
        // ganadora (aún sin confirmar) y el mensaje se procesaría dos veces.
        const quien = nuevoInterlocutor('dup_carrera');
        const idExternoMensaje = `ext_carrera_${quien}`;
        const entrada = {
            idNegocio, canal: CANAL, idExterno: quien, texto: 'hola', idExternoMensaje,
            despertar: false,
        };

        const [a, b] = await Promise.all([motor.recibir(entrada), motor.recibir(entrada)]);

        expect([a.duplicado, b.duplicado].sort()).toEqual([false, true]);
        expect(a.id_mensaje).toBe(b.id_mensaje);

        const conversacion = await conversacionDe(quien);
        expect(await mensajesDe(conversacion.id_conversacion, 'entrante')).toHaveLength(1);
    }, 20000);
});

// ── Mecanismos 1 y 2: FIFO y lock pesimista ─────────────────────────────────────────────

describe('aislamiento por conversación', () => {
    test('dos turnos simultáneos sobre la misma conversación: solo uno entra', async () => {
        const quien = nuevoInterlocutor('lock');
        const { id_conversacion } = await guardarMensaje(quien, 'quiero cita');

        // El manejador tarda a propósito. Sin esta pausa el test es **probabilístico**: con
        // un manejador rápido, el primer turno a veces confirma antes de que el segundo lea
        // los mensajes pendientes, y entonces pasa aunque no haya lock ninguno. Se comprobó
        // quitando el `FOR UPDATE`: unas veces salían dos turnos y otras uno.
        //
        // ADR-014 descartó el aislamiento probabilístico por escrito; un test probabilístico
        // de ese aislamiento es el mismo error una capa más arriba. Con la pausa, el segundo
        // procesamiento cae con seguridad dentro de la ventana del primero.
        motor.registrarManejador(async (contexto) => {
            await dormir(300);
            return manejarEco(contexto);
        });

        const [a, b] = await Promise.all([
            motor.procesarConversacion(id_conversacion),
            motor.procesarConversacion(id_conversacion),
        ]);

        const conseguidos = [a, b].filter((r) => r.id_turno);
        const omitidos = [a, b].filter((r) => r.omitido);

        expect(conseguidos).toHaveLength(1);
        expect(omitidos).toHaveLength(1);
        // Da igual cuál de los dos motivos: o no pudo tomar el lock, o lo tomó después y ya
        // no quedaba nada que hacer. Lo que no puede pasar es que haya dos turnos.
        expect([motor.OMITIDO.OCUPADA, motor.OMITIDO.SIN_MENSAJES]).toContain(omitidos[0].omitido);
        expect(await turnosDe(id_conversacion)).toHaveLength(1);
    }, 20000);

    test('el lock es NOWAIT: una conversación ocupada no bloquea al que llega', async () => {
        const quien = nuevoInterlocutor('nowait');
        const { id_conversacion } = await guardarMensaje(quien, 'hola');

        const t = await sequelize.transaction();
        try {
            const tomada = await repositorio.bloquear(id_conversacion, { transaction: t });
            expect(tomada).not.toBeNull();

            const arranque = Date.now();
            const resultado = await motor.procesarConversacion(id_conversacion);

            expect(resultado.omitido).toBe(motor.OMITIDO.OCUPADA);
            // No esperó: si el lock fuera bloqueante, esto tardaría lo que dure el turno ajeno
            // y, con el pool en 10 conexiones, unas pocas esperas dejarían el backend seco.
            expect(Date.now() - arranque).toBeLessThan(1000);
        } finally {
            await t.rollback();
        }
        motor.detener();
    }, 20000);

    test('conversaciones distintas avanzan en paralelo', async () => {
        const cola = new ColaParticionada({
            procesar: async (clave) => {
                enVueloAhora++;
                maximoEnVuelo = Math.max(maximoEnVuelo, enVueloAhora);
                await dormir(60);
                enVueloAhora--;
                procesadas.push(clave);
            },
            config: { debounceMs: 0, debounceMaxMs: 0, concurrencia: 4 },
        });
        let enVueloAhora = 0;
        let maximoEnVuelo = 0;
        const procesadas = [];

        for (const clave of ['a', 'b', 'c', 'd']) cola.despertar(clave);
        await cola.drenar();

        expect(procesadas.sort()).toEqual(['a', 'b', 'c', 'd']);
        expect(maximoEnVuelo).toBeGreaterThan(1);
        cola.detener();
    });

    test('la misma clave nunca se procesa dos veces a la vez', async () => {
        let enVuelo = 0;
        let solapamientos = 0;
        let vueltas = 0;

        const cola = new ColaParticionada({
            procesar: async () => {
                if (enVuelo > 0) solapamientos++;
                enVuelo++;
                vueltas++;
                await dormir(30);
                enVuelo--;
            },
            config: { debounceMs: 0, debounceMaxMs: 0, concurrencia: 4 },
        });

        for (let i = 0; i < 6; i++) cola.despertar('la-misma');
        await cola.drenar();

        expect(solapamientos).toBe(0);
        // Los despertares que llegan mientras se procesa se agrupan en una segunda vuelta,
        // no en seis: es la misma idea del debounce aplicada a lo que llega tarde.
        expect(vueltas).toBeGreaterThanOrEqual(1);
        expect(vueltas).toBeLessThan(6);
        cola.detener();
    });
});

// ── Continuidad ─────────────────────────────────────────────────────────────────────────

describe('continuidad', () => {
    test('las variables de sesión sobreviven entre turnos', async () => {
        const quien = nuevoInterlocutor('variables');

        await motor.recibir({ idNegocio, canal: CANAL, idExterno: quien, texto: 'uno' });
        await motor.drenar();
        await motor.recibir({ idNegocio, canal: CANAL, idExterno: quien, texto: 'dos' });
        await motor.drenar();

        const conversacion = await conversacionDe(quien);
        expect(conversacion.variables.turnos).toBe(2);
        expect(conversacion.variables.mensajes_vistos).toBe(2);
    }, 20000);

    test('una tarea a medias se retoma tras reiniciar el proceso', async () => {
        // Criterio de aceptación 3 de F5. El «reinicio» se simula tirando todo el estado en
        // memoria del motor: si algo dependiera de él, la tarea se perdería aquí.
        const quien = nuevoInterlocutor('tarea');

        await motor.recibir({
            idNegocio, canal: CANAL, idExterno: quien,
            texto: 'necesito una cita pero pausa que me llaman',
        });
        await motor.drenar();

        const aMedias = await conversacionDe(quien);
        expect(aMedias.tarea_actual).toBe('eco_pendiente');
        expect(aMedias.tarea_datos.texto).toContain('cita');

        // ── Aquí muere el proceso y arranca otro ────────────────────────────────────────
        motor._reiniciar();
        motor.registrarManejador(manejarEco);
        await motor.recuperar();
        await motor.drenar();

        await motor.recibir({ idNegocio, canal: CANAL, idExterno: quien, texto: 'seguimos' });
        await motor.drenar();

        const retomada = await conversacionDe(quien);
        expect(retomada.tarea_actual).toBeNull();

        const salientes = await mensajesDe(retomada.id_conversacion, 'saliente');
        expect(salientes[salientes.length - 1].contenido).toContain('Retomamos');
    }, 30000);

    test('un turno colgado se marca, sus mensajes se liberan y el reintento se cuenta', async () => {
        const quien = nuevoInterlocutor('colgado');
        const { id_conversacion } = await guardarMensaje(quien, 'hola');
        const conversacion = await conversacionDe(quien);

        // Un proceso que murió con el turno abierto: la fila quedó en `procesando` y sus
        // mensajes, atrapados en un turno que nunca terminará.
        const t = await sequelize.transaction();
        let colgado;
        try {
            colgado = await repositorio.abrirTurno(
                { idConversacion: id_conversacion, idNegocio: conversacion.id_negocio },
                { transaction: t }
            );
            await repositorio.asignarMensajesATurno(
                await repositorio.mensajesPendientes(id_conversacion, { ventanaDias: 7, transaction: t }),
                colgado.id_turno,
                { transaction: t }
            );
            await t.commit();
        } catch (error) {
            await t.rollback();
            throw error;
        }

        const umbralOriginal = motor.CONFIG.turnoColgadoMinutos;
        motor.CONFIG.turnoColgadoMinutos = 0;
        try {
            const { colgados } = await motor.recuperar();
            expect(colgados).toBeGreaterThanOrEqual(1);
            await motor.drenar();
        } finally {
            motor.CONFIG.turnoColgadoMinutos = umbralOriginal;
        }

        const turnos = await turnosDe(id_conversacion);
        const abandonado = turnos.find((x) => x.id_turno === colgado.id_turno);
        const nuevo = turnos.find((x) => x.id_turno !== colgado.id_turno);

        expect(abandonado.estado).toBe('abandonado');
        expect(abandonado.error_codigo).toBe('TURNO_COLGADO');
        // El mensaje no se perdió: lo recogió un turno nuevo, que además sabe que es reintento.
        expect(nuevo).toBeDefined();
        expect(nuevo.resultado).toBe('resuelto');
        expect(nuevo.intentos).toBe(2);
    }, 30000);
});

// ── Estados de la conversación ──────────────────────────────────────────────────────────

describe('estados que no se procesan', () => {
    test('en handoff humano el mensaje se guarda pero el bot no contesta', async () => {
        const quien = nuevoInterlocutor('handoff');
        const { id_conversacion } = await guardarMensaje(quien, 'sigo aquí');

        await sequelize.query(
            `UPDATE intelligence.conversacion SET estado = 'handoff_humano' WHERE id_conversacion = :id;`,
            { replacements: { id: id_conversacion }, logging: false }
        );

        const resultado = await motor.procesarConversacion(id_conversacion);

        expect(resultado.omitido).toBe(motor.OMITIDO.ESTADO_NO_PROCESABLE);
        expect(await turnosDe(id_conversacion)).toHaveLength(0);
        // No procesarlo no es razón para perderlo: sigue ahí para quien lo atienda.
        expect(await mensajesDe(id_conversacion, 'entrante')).toHaveLength(1);
    }, 20000);

    test('una conversación dormida se reactiva al llegar un mensaje', async () => {
        const quien = nuevoInterlocutor('dormida');
        await guardarMensaje(quien, 'hola');
        const conversacion = await conversacionDe(quien);

        await sequelize.query(
            `UPDATE intelligence.conversacion SET estado = 'cerrada', cerrado_en = now()
              WHERE id_conversacion = :id;`,
            { replacements: { id: conversacion.id_conversacion }, logging: false }
        );

        await motor.recibir({ idNegocio, canal: CANAL, idExterno: quien, texto: 'volví' });
        await motor.drenar();

        const reabierta = await conversacionDe(quien);
        expect(reabierta.estado).toBe('activa');
        expect(reabierta.cerrado_en).toBeNull();
        expect((await turnosDe(reabierta.id_conversacion)).length).toBeGreaterThanOrEqual(1);
    }, 20000);
});

// ── Ledger ──────────────────────────────────────────────────────────────────────────────

describe('el turno queda registrado', () => {
    test('un turno normal deja latencia, resultado y pasos', async () => {
        const quien = nuevoInterlocutor('ledger');

        await motor.recibir({ idNegocio, canal: CANAL, idExterno: quien, texto: 'hola' });
        await motor.drenar();

        const conversacion = await conversacionDe(quien);
        const [turno] = await turnosDe(conversacion.id_conversacion);

        expect(turno.estado).toBe('terminado');
        expect(turno.resultado).toBe('resuelto');
        expect(turno.nivel).toBe('determinista');
        expect(turno.latencia_ms).toBeGreaterThanOrEqual(0);
        expect(turno.terminado_en).not.toBeNull();

        const pasos = await pasosDe(turno.id_turno);
        expect(pasos.map((p) => p.tipo)).toEqual(['regla', 'respuesta']);
    }, 20000);

    test('un manejador que revienta deja el turno registrado como error, no lo borra', async () => {
        // Es la pregunta 8 del Ledger: «qué falló». Si el fallo se llevara por delante la
        // transacción entera, el turno desaparecería justo cuando más falta hace verlo.
        const quien = nuevoInterlocutor('error');

        motor.registrarManejador(() => {
            const error = new Error('el manejador explotó');
            error.code = 'MANEJADOR_DE_PRUEBA';
            throw error;
        });

        await motor.recibir({ idNegocio, canal: CANAL, idExterno: quien, texto: 'hola' });
        await motor.drenar();

        const conversacion = await conversacionDe(quien);
        const [turno] = await turnosDe(conversacion.id_conversacion);

        expect(turno.estado).toBe('terminado');
        expect(turno.resultado).toBe('error');
        expect(turno.error_codigo).toBe('MANEJADOR_DE_PRUEBA');
        expect(turno.error_detalle).toContain('explotó');
        expect(turno.latencia_ms).toBeGreaterThanOrEqual(0);

        expect((await pasosDe(turno.id_turno)).map((p) => p.tipo)).toContain('error');
        // No hubo respuesta, y el mensaje se queda con el turno fallido: reintentar sin fin
        // algo que falla por una razón determinista es un bucle, no una recuperación.
        expect(await mensajesDe(conversacion.id_conversacion, 'saliente')).toHaveLength(0);
        const entrantes = await mensajesDe(conversacion.id_conversacion, 'entrante');
        expect(entrantes[0].id_turno).toBe(turno.id_turno);
    }, 20000);

    test('una decisión malformada envenena la transacción y aun así el turno se registra', async () => {
        // Éste es el caso que justifica el SAVEPOINT, y no es hipotético: el manejador no
        // toca la base —su contrato no le da la transacción—, pero **lo que devuelve sí se
        // escribe en ella**. Un `tipo` de paso fuera del CHECK, un texto imposible: cualquiera
        // aborta la transacción del turno.
        //
        // En Postgres, tras ese error toda la transacción queda envenenada: sin SAVEPOINT, el
        // UPDATE que marca el turno como fallido revienta también y el turno desaparece del
        // Ledger justo cuando hace falta verlo (pregunta 8). Comprobado quitando el savepoint:
        // este test falla y el turno no existe.
        const quien = nuevoInterlocutor('error_sql');

        motor.registrarManejador(() => ({
            pasos: [{ tipo: 'este_tipo_no_existe', decision: 'x', motivo: {} }],
            respuestas: ['no debería llegar a guardarse'],
        }));

        await motor.recibir({ idNegocio, canal: CANAL, idExterno: quien, texto: 'hola' });
        await motor.drenar();

        const conversacion = await conversacionDe(quien);
        const [turno] = await turnosDe(conversacion.id_conversacion);

        expect(turno).toBeDefined();
        expect(turno.estado).toBe('terminado');
        expect(turno.resultado).toBe('error');
        expect(turno.error_detalle).toMatch(/chk_paso_tipo|constraint/i);
        // El rollback hasta el savepoint se llevó por delante la respuesta a medio escribir.
        expect(await mensajesDe(conversacion.id_conversacion, 'saliente')).toHaveLength(0);
    }, 20000);
});
