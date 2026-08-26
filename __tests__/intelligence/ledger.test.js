/**
 * El Ledger responde a las doce preguntas (F5-A — ADR-022).
 *
 * ADR-022 pone una regla dura sobre este esquema: **«si el esquema no responde a las doce,
 * está mal diseñado»**. Y añade por qué importa tanto acertar a la primera: el Ledger es de
 * escritura única e irreversible — lo que no se registre hoy no se podrá responder nunca.
 *
 * Así que esta suite no comprueba que las consultas «no fallen»: monta un escenario
 * sintético con respuestas conocidas y comprueba que **cada pregunta devuelve el número
 * correcto**. Una consulta que corre pero miente sería peor que una que revienta.
 *
 * El escenario, a propósito, es feo: hay un turno que falló, uno derivado a un humano, uno
 * reintentado, una entrega que necesitó tres intentos y una capacidad denegada. Un Ledger
 * solo demuestra su valor sobre lo que salió mal.
 *
 * Requiere:  npm run migrate:intelligence-ledger
 * Correr con:  npx jest __tests__/intelligence/ --runInBand
 */
require('dotenv').config();
const Models = require('../../app_core/models/conection');
const { PREGUNTAS, responder } = require('../../scripts/ledger_doce_preguntas');

const sequelize = Models.sequelize;

/** Canal sintético: nada real usará este nombre, así que la limpieza es inequívoca. */
const CANAL = 'test_ledger';

let idNegocio;
let convA;
let convB;

const pregunta = (n) => PREGUNTAS.find((p) => p.n === n);
const preguntar = (n) => responder(pregunta(n), { idNegocio, dias: 1 });

async function unaFila(sql, replacements = {}) {
    const [[fila]] = await sequelize.query(sql, { replacements, logging: false });
    return fila ?? null;
}

async function crearConversacion(idExterno, estado = 'activa') {
    const fila = await unaFila(
        `
        INSERT INTO intelligence.conversacion (id_negocio, canal, id_externo, estado, ultimo_mensaje_en)
        VALUES (:idNegocio, :canal, :idExterno, :estado, now())
        RETURNING id_conversacion;
        `,
        { idNegocio, canal: CANAL, idExterno, estado }
    );
    return fila.id_conversacion;
}

async function crearTurno(idConversacion, { secuencia, nivel, resultado, latencia, intentos = 1, errorCodigo = null }) {
    const fila = await unaFila(
        `
        INSERT INTO intelligence.turno
            (id_conversacion, id_negocio, secuencia, nivel, estado, resultado, error_codigo, intentos, latencia_ms, terminado_en)
        VALUES
            (:idConversacion, :idNegocio, :secuencia, :nivel,
             CASE WHEN :resultado::varchar IS NULL THEN 'procesando' ELSE 'terminado' END,
             :resultado, :errorCodigo, :intentos, :latencia,
             CASE WHEN :resultado::varchar IS NULL THEN NULL ELSE now() END)
        RETURNING id_turno;
        `,
        { idConversacion, idNegocio, secuencia, nivel, resultado, errorCodigo, intentos, latencia }
    );
    return fila.id_turno;
}

beforeAll(async () => {
    // Negocio propio y desechable, no el de desarrollo.
    //
    // Cuatro de las doce preguntas —2, 5, 11 y 12— son **agregados por negocio y ventana de
    // tiempo**: «cuánto costó este inquilino», «cuál es su tasa de resolución». Mientras las
    // tablas estuvieron vacías bastó con limpiar por canal, pero en cuanto F5-B empezó a
    // escribir turnos de verdad, cualquier conversación ajena en el mismo negocio y el mismo
    // día movía esos números y la suite se caía. Y con razón: la consulta no está mal, lo que
    // estaba mal era suponer que nadie más usaría el negocio de desarrollo.
    //
    // Un negocio que solo existe durante el test hace imposible esa interferencia. `nombre` es
    // lo único obligatorio de la tabla.
    idNegocio = (
        await unaFila(
            `INSERT INTO general.gener_negocio (nombre) VALUES (:nombre) RETURNING id_negocio;`,
            { nombre: `__test_ledger_${Date.now()}__` }
        )
    ).id_negocio;

    await limpiar();

    // ── Conversación A: sale bien. Tres turnos, uno de ellos con IA (que en F5 no ocurre,
    //    pero el esquema tiene que poder registrarlo desde hoy: es irreversible).
    convA = await crearConversacion('cliente-A');
    const a1 = await crearTurno(convA, { secuencia: 1, nivel: 'determinista', resultado: 'resuelto', latencia: 120 });
    const a2 = await crearTurno(convA, { secuencia: 2, nivel: 'determinista', resultado: 'resuelto', latencia: 200 });
    const a3 = await crearTurno(convA, { secuencia: 3, nivel: 'llm', resultado: 'resuelto', latencia: 1800 });

    // ── Conversación B: sale mal. Un turno con error (reintentado) y uno derivado a humano.
    convB = await crearConversacion('cliente-B', 'handoff_humano');
    const b1 = await crearTurno(convB, {
        secuencia: 1, nivel: 'determinista', resultado: 'error', latencia: 90,
        intentos: 2, errorCodigo: 'CAPACIDAD_NO_HABILITADA',
    });
    const b2 = await crearTurno(convB, { secuencia: 2, nivel: 'determinista', resultado: 'handoff', latencia: 60 });

    // ── Invocaciones de capacidad ───────────────────────────────────────────────────────
    for (const [idTurno, capacidad, resultado, errorCodigo] of [
        [a1, 'consultar_servicios', 'ok', null],
        [a2, 'consultar_disponibilidad', 'ok', null],
        [a2, 'proponer_turno', 'ok', null],
        [a3, 'reservar_turno', 'ok', null],
        [b1, 'cancelar_cita', 'denegado', 'CAPACIDAD_NO_HABILITADA'],
    ]) {
        await sequelize.query(
            `
            INSERT INTO intelligence.invocacion_capacidad
                (id_turno, id_conversacion, id_negocio, capacidad, vertical, resultado, error_codigo, latencia_ms)
            VALUES (:idTurno, :idConversacion, :idNegocio, :capacidad, 'reserva', :resultado, :errorCodigo, 40);
            `,
            {
                replacements: {
                    idTurno,
                    idConversacion: idTurno === b1 ? convB : convA,
                    idNegocio, capacidad, resultado, errorCodigo,
                },
                logging: false,
            }
        );
    }

    // ── Pasos ───────────────────────────────────────────────────────────────────────────
    await sequelize.query(
        `
        INSERT INTO intelligence.paso (id_turno, id_negocio, secuencia, tipo, decision, motivo, latencia_ms)
        VALUES (:t, :n, 1, 'regla', 'menu_principal', '{"regex":"^hola$"}'::jsonb, 5);
        `,
        { replacements: { t: a1, n: idNegocio }, logging: false }
    );

    // ── Costo: solo el turno con IA. Los deterministas cuestan $0 y eso también es un dato.
    await sequelize.query(
        `
        INSERT INTO intelligence.costo
            (id_turno, id_conversacion, id_negocio, proveedor, modelo,
             tokens_entrada, tokens_salida, tokens_cache_lectura, tokens_cache_escritura, costo_usd, latencia_ms)
        VALUES (:t, :c, :n, 'anthropic', 'claude-haiku-4-5', 300, 150, 700, 0, 0.00123456, 1800);
        `,
        { replacements: { t: a3, c: convA, n: idNegocio }, logging: false }
    );

    // ── Mensajes: uno saliente que necesitó tres intentos de entrega.
    await sequelize.query(
        `
        INSERT INTO intelligence.mensaje
            (id_conversacion, id_negocio, id_turno, direccion, canal, contenido, estado_entrega, intentos_entrega, entregado_en)
        VALUES (:c, :n, :t, 'saliente', :canal, 'Listo, te agendé', 'entregado', 3, now());
        `,
        { replacements: { c: convA, n: idNegocio, t: a1, canal: CANAL }, logging: false }
    );
    await sequelize.query(
        `
        INSERT INTO intelligence.mensaje
            (id_conversacion, id_negocio, id_turno, direccion, canal, contenido)
        VALUES (:c, :n, :t, 'entrante', :canal, 'hola');
        `,
        { replacements: { c: convA, n: idNegocio, t: a1, canal: CANAL }, logging: false }
    );
});

async function limpiar() {
    // El orden importa poco (no hay FK entre las particionadas), pero las conversaciones van
    // al final porque turno y mensaje sí la referencian lógicamente.
    const convs = `(SELECT id_conversacion FROM intelligence.conversacion WHERE canal = '${CANAL}')`;
    for (const tabla of ['costo', 'invocacion_capacidad', 'mensaje']) {
        await sequelize.query(`DELETE FROM intelligence.${tabla} WHERE id_conversacion IN ${convs};`, { logging: false });
    }
    await sequelize.query(
        `DELETE FROM intelligence.paso WHERE id_turno IN (SELECT id_turno FROM intelligence.turno WHERE id_conversacion IN ${convs});`,
        { logging: false }
    );
    await sequelize.query(`DELETE FROM intelligence.turno WHERE id_conversacion IN ${convs};`, { logging: false });
    await sequelize.query(`DELETE FROM intelligence.conversacion WHERE canal = '${CANAL}';`, { logging: false });
}

afterAll(async () => {
    await limpiar();
    // Las particionadas no tienen FK hacia el negocio, así que se borran antes (`limpiar`);
    // `conversacion` e `ingesta_recibida` sí, y se van en cascada con él.
    if (idNegocio) {
        await sequelize.query(`DELETE FROM general.gener_negocio WHERE id_negocio = :idNegocio;`, {
            replacements: { idNegocio },
            logging: false,
        });
    }
    await sequelize.close();
});

// ────────────────────────────────────────────────────────────────────────────────────────
describe('El Ledger responde a las doce preguntas (ADR-022)', () => {
    it('son exactamente doce, y ninguna se ha perdido por el camino', () => {
        expect(PREGUNTAS).toHaveLength(12);
        expect(PREGUNTAS.map((p) => p.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    });

    it('1 · costo por conversación', async () => {
        const filas = await preguntar(1);
        const a = filas.find((f) => f.id_conversacion === convA);
        const b = filas.find((f) => f.id_conversacion === convB);

        expect(Number(a.turnos)).toBe(3);
        expect(Number(a.costo_usd)).toBeCloseTo(0.00123456, 8);
        // La conversación sin IA aparece con costo cero, no ausente: «sin IA el costo es
        // $0.00, y eso también se muestra» (ADR-022).
        expect(Number(b.costo_usd)).toBe(0);
    });

    it('2 · costo por negocio', async () => {
        const [fila] = await preguntar(2);
        expect(fila.id_negocio).toBe(idNegocio);
        expect(Number(fila.conversaciones)).toBe(2);
        expect(Number(fila.costo_usd)).toBeCloseTo(0.00123456, 8);
    });

    it('3 · modelo usado', async () => {
        const filas = await preguntar(3);
        expect(filas).toHaveLength(1);
        expect(filas[0].proveedor).toBe('anthropic');
        expect(filas[0].modelo).toBe('claude-haiku-4-5');
    });

    it('4 · tokens y acierto de caché', async () => {
        const [fila] = await preguntar(4);
        expect(Number(fila.entrada)).toBe(300);
        expect(Number(fila.salida)).toBe(150);
        expect(Number(fila.cache_lectura)).toBe(700);
        // 700 de 1000 salieron de caché. Sin las columnas de caché en el esquema, esta
        // pregunta sería incontestable para siempre.
        expect(Number(fila.pct_acierto_cache)).toBeCloseTo(70.0, 1);
    });

    it('5 · latencia por nivel', async () => {
        const filas = await preguntar(5);
        const det = filas.find((f) => f.nivel === 'determinista');
        const llm = filas.find((f) => f.nivel === 'llm');

        expect(Number(det.turnos)).toBe(4);
        expect(Number(det.max_ms)).toBe(200);
        expect(Number(llm.max_ms)).toBe(1800);
        // El motor determinista es un orden de magnitud más rápido, que es justo lo que
        // justifica que no desaparezca cuando llegue la IA (ADR-018, escalera de niveles).
        expect(Number(det.p95_ms)).toBeLessThan(Number(llm.p95_ms));
    });

    it('6 · cuántas invocaciones de capacidad', async () => {
        const [fila] = await preguntar(6);
        expect(Number(fila.invocaciones)).toBe(5);
        expect(Number(fila.turnos_con_invocacion)).toBe(4);
        expect(Number(fila.por_turno)).toBeCloseTo(1.25, 2);
    });

    it('7 · qué capacidades se ejecutaron', async () => {
        const filas = await preguntar(7);
        const nombres = filas.map((f) => f.capacidad);
        expect(nombres).toEqual(expect.arrayContaining(['consultar_servicios', 'reservar_turno', 'cancelar_cita']));

        const denegada = filas.find((f) => f.capacidad === 'cancelar_cita');
        expect(denegada.resultado).toBe('denegado');
    });

    it('8 · errores, separados por origen', async () => {
        const filas = await preguntar(8);
        const deTurno = filas.find((f) => f.origen === 'turno');
        const deCapacidad = filas.find((f) => f.origen === 'capacidad');

        expect(deTurno.error_codigo).toBe('CAPACIDAD_NO_HABILITADA');
        expect(Number(deTurno.veces)).toBe(1);
        expect(Number(deCapacidad.veces)).toBe(1);
    });

    it('9 · reintentos', async () => {
        const [fila] = await preguntar(9);
        expect(Number(fila.turnos_reintentados)).toBe(1);
        // Tres intentos de entrega = dos reintentos. Distinguirlo importa: el primero no es
        // un reintento y contarlo inflaría la métrica un 50%.
        expect(Number(fila.reintentos_de_entrega)).toBe(2);
    });

    it('10 · conversaciones rotas', async () => {
        const filas = await preguntar(10);
        expect(filas).toHaveLength(1);
        expect(filas[0].id_conversacion).toBe(convB);
        expect(Number(filas[0].turnos_con_error)).toBe(1);
    });

    it('11 · tasa de resolución', async () => {
        const [fila] = await preguntar(11);
        expect(Number(fila.turnos)).toBe(5);
        expect(Number(fila.resueltos)).toBe(3);
        expect(Number(fila.derivados)).toBe(1);
        expect(Number(fila.con_error)).toBe(1);
        expect(Number(fila.pct_resolucion)).toBeCloseTo(60.0, 1);
    });

    it('12 · ratio determinista vs IA', async () => {
        const filas = await preguntar(12);
        const det = filas.find((f) => f.nivel === 'determinista');
        const llm = filas.find((f) => f.nivel === 'llm');

        expect(Number(det.turnos)).toBe(4);
        expect(Number(det.pct)).toBeCloseTo(80.0, 1);
        expect(Number(llm.pct)).toBeCloseTo(20.0, 1);
    });
});

// ────────────────────────────────────────────────────────────────────────────────────────
describe('Invariantes del esquema (ADR-004, ADR-024)', () => {
    it('intelligence NO tiene ninguna FK hacia un esquema de vertical', async () => {
        const [filas] = await sequelize.query(
            `
            SELECT c.conname, n_dest.nspname AS destino
              FROM pg_constraint c
              JOIN pg_class t       ON t.oid = c.conrelid
              JOIN pg_namespace n   ON n.oid = t.relnamespace
              JOIN pg_class t_dest  ON t_dest.oid = c.confrelid
              JOIN pg_namespace n_dest ON n_dest.oid = t_dest.relnamespace
             WHERE c.contype = 'f'
               AND n.nspname = 'intelligence'
               AND n_dest.nspname IN ('reserva','restaurante','gym','parqueadero','tienda');
            `,
            { logging: false }
        );
        // Es la única garantía de que `intelligence` se pueda extraer a su propio servicio
        // (ADR-004). Una sola FK aquí la anula.
        expect(filas).toEqual([]);
    });

    it('las tablas de alto volumen están particionadas', async () => {
        const [filas] = await sequelize.query(
            `
            SELECT c.relname
              FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = 'intelligence' AND c.relkind = 'p'
             ORDER BY c.relname;
            `,
            { logging: false }
        );
        expect(filas.map((f) => f.relname)).toEqual([
            'costo', 'invocacion_capacidad', 'mensaje', 'paso', 'turno',
        ]);
    });

    it('existe la partición del mes en curso (sin ella, todo INSERT falla)', async () => {
        const sufijo = new Date().toISOString().slice(0, 7).replace('-', '_');
        const fila = await unaFila(
            `
            SELECT 1 AS existe FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = 'intelligence' AND c.relname = :nombre;
            `,
            { nombre: `turno_${sufijo}` }
        );
        expect(fila).not.toBeNull();
    });

    it('asegurar_particiones es idempotente', async () => {
        const fila = await unaFila(`SELECT intelligence.asegurar_particiones(3) AS n;`);
        expect(Number(fila.n)).toBe(0); // ya existían
    });

    it('el costo se guarda en numeric, no en coma flotante (esto factura)', async () => {
        const fila = await unaFila(
            `
            SELECT data_type, numeric_scale
              FROM information_schema.columns
             WHERE table_schema = 'intelligence' AND table_name = 'costo' AND column_name = 'costo_usd';
            `
        );
        expect(fila.data_type).toBe('numeric');
        expect(Number(fila.numeric_scale)).toBe(8);
    });

    it('la palabra "tool" no aparece en el esquema (ADR-008)', async () => {
        const [filas] = await sequelize.query(
            `
            SELECT table_name, column_name
              FROM information_schema.columns
             WHERE table_schema = 'intelligence'
               AND (table_name ILIKE '%tool%' OR column_name ILIKE '%tool%');
            `,
            { logging: false }
        );
        // ADR-022 llamaba `tool_call` a esta tabla; ADR-008 reserva la palabra para el
        // adaptador del proveedor de modelos. Este test es lo que impide que se cuele.
        expect(filas).toEqual([]);
    });
});

// ── El rastro no puede matar al turno que está contando ─────────────────────────────────

describe('registrarInvocacion siempre puede escribir la vertical', () => {
    // El fallo, dos veces en producción y las dos con el mismo final: el cliente sin respuesta.
    //
    // `invocacion_capacidad.vertical` es NOT NULL, y quien apuntaba la invocación tenía que
    // acordarse de rellenarla. El 2026-08-24 se le olvidó al `catch` del manejador de modelo; se
    // arregló ahí. El 2026-08-26 se le había olvidado también a los dos `push` del camino de
    // confirmación del MISMO archivo: un cliente dio su dirección para un pedido, el modelo mandó
    // `items` como texto en vez de como lista, y el INSERT de ese error reventó la transacción
    // del turno entero. `MANEJADOR_FALLO`, silencio — cuando el propio modelo se había corregido
    // dos llamadas después y el pedido era perfectamente válido.
    //
    // Dos veces el mismo fallo en dos sitios distintos significa que el sitio equivocado era el
    // call site. Estas pruebas van contra el único punto por el que pasa todo el mundo.
    const repositorio = require('../../intelligence/engine/repositorio');
    const registry = require('../../intelligence/core/registry');

    let idTurno;
    let convC;

    beforeAll(async () => {
        convC = await crearConversacion('cliente-vertical');
        idTurno = await crearTurno(convC, {
            secuencia: 1, nivel: 'llm', resultado: 'resuelto', latencia: 10,
        });
    });

    const apuntar = (capacidad, vertical) =>
        repositorio.registrarInvocacion(
            {
                idTurno,
                idConversacion: convC,
                idNegocio,
                capacidad,
                vertical,
                argumentos: { items: 'esto vino mal' },
                resultado: 'error',
                errorCodigo: 'ARGUMENTOS_INVALIDOS',
                latenciaMs: 5,
            },
            {}
        );

    const verticalGuardada = async (capacidad) =>
        (
            await unaFila(
                `SELECT vertical FROM intelligence.invocacion_capacidad
                  WHERE id_turno = :idTurno AND capacidad = :capacidad;`,
                { idTurno, capacidad }
            )
        ).vertical;

    it('sin vertical, la saca del Registry en vez de reventar', async () => {
        registry.registrar({
            nombre: 'probar_vertical_del_ledger',
            descripcion: 'Existe solo para esta prueba.',
            vertical: 'restaurante',
            tipo: registry.TIPO.CONSULTA,
            feature: 'asistente_ia',
            parametros: {},
            ejecutar: async () => ({ ok: true }),
        });

        await expect(apuntar('probar_vertical_del_ledger', null)).resolves.toBeUndefined();
        expect(await verticalGuardada('probar_vertical_del_ledger')).toBe('restaurante');
    });

    it('de una capacidad que ya no existe, escribe "desconocida" y NO se cae', async () => {
        // Un rastro que no se puede atribuir puede perderse o quedar a medias. Lo que no puede
        // es llevarse por delante la conversación.
        await expect(apuntar('consultar_algo_que_ya_no_existe', null)).resolves.toBeUndefined();
        expect(await verticalGuardada('consultar_algo_que_ya_no_existe')).toBe('desconocida');
    });

    it('si quien apunta SÍ la sabe, se respeta la suya', async () => {
        await expect(apuntar('consultar_con_vertical_explicita', 'reserva')).resolves.toBeUndefined();
        expect(await verticalGuardada('consultar_con_vertical_explicita')).toBe('reserva');
    });
});
