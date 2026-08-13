/**
 * F5 — criterios de aceptación de extremo a extremo (master-plan, FASE 5).
 *
 * Los tests del manejador prueban la FSM aislada, con el Gate inyectado. Esto es lo otro: el
 * camino entero y de verdad —widget → gateway → motor → identidad → Policy Gate → adaptador de
 * `reserva` → dominio— contra Postgres, sin dobles de ninguna clase.
 *
 * Existe porque los tres primeros criterios de aceptación de F5 **no se pueden falsear con
 * mocks**:
 *
 *   1. Un usuario agenda una cita completa por WebChat con un menú determinista, y la cita
 *      queda correcta (fila real en `reserva.reserva_cita`).
 *   2. Ráfaga: cinco mensajes en dos segundos producen UN turno y UNA cita. Ni cinco
 *      respuestas ni dos citas. Es el bug clásico de los asistentes de WhatsApp.
 *   3. Continuidad: abandonar a mitad, reiniciar el proceso, volver → la tarea se retoma.
 *   4. Costo en tokens: $0.00. Se cumple por construcción — aquí no hay ModelPort.
 *
 * Requiere la base de desarrollo con el esquema de Intelligence y el fixture de reserva:
 *   npm run migrate:intelligence-ledger && npm run migrate:intelligence-canal
 *   psql ... -f scripts/fixtures/dev_reserva.sql
 *
 * Correr con:  npx jest __tests__/intelligence/ --runInBand
 * ⚠️ Contra la base LOCAL (DB_PORT=5432), nunca contra la compartida ni producción.
 */
// ⚠️ ANTES de cualquier require de Intelligence: `features.js` evalúa FEATURES_FORZADAS al
// cargarse, no en cada llamada. Hace falta porque **ningún plan comercial incluye
// `asistente_ia`** todavía, y eso es correcto: no se vende. Sin esto el Policy Gate deniega
// con FEATURE_NO_HABILITADA y el bot no contesta nada — que fue exactamente lo que pasó la
// primera vez que se corrió esta suite. La escotilla se ignora si NODE_ENV=production.
process.env.FEATURES_FORZADAS = process.env.FEATURES_FORZADAS || 'asistente_ia';

require('dotenv').config();
const Models = require('../../app_core/models/conection');
const motor = require('../../intelligence/engine/motor');
const gateway = require('../../intelligence/channels/gateway');
const adaptador = require('../../intelligence/channels/webchat/adaptador');
const simulador = require('../../intelligence/channels/webchat/simuladorFallos');
const { CONFIG: COLA_CONFIG } = require('../../intelligence/engine/cola');
const { manejarDeterminista } = require('../../intelligence/engine/manejadorDeterminista');
const intelligence = require('../../intelligence');

const sequelize = Models.sequelize;
const SELECT = { type: sequelize.QueryTypes.SELECT, logging: false };
const CANAL = adaptador.NOMBRE;
const DEBOUNCE_TEST = 150;

let idNegocio;
let fechaConAgenda;
let contador = 0;

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
const consulta = (sql, replacements = {}) => sequelize.query(sql, { replacements, ...SELECT });
const unaFila = async (sql, r = {}) => (await consulta(sql, r))[0] ?? null;

const sesiones = new Set();
function sesion(prefijo) {
    const s = `test_e2e_${prefijo}_${Date.now()}_${contador++}`;
    sesiones.add(s);
    return s;
}

async function enviar(idSesion, texto) {
    return adaptador.recibirDelWidget({
        idNegocio,
        idSesion,
        texto,
        idMensajeCliente: `cli_${idSesion}_${contador++}`,
        enviadoEn: new Date(),
    });
}

async function conversacionDe(idSesion) {
    return unaFila(
        `SELECT * FROM intelligence.conversacion
          WHERE id_negocio = :idNegocio AND canal = :canal AND id_externo = :idSesion;`,
        { idNegocio, canal: CANAL, idSesion }
    );
}

async function salientesDe(idSesion) {
    const conv = await conversacionDe(idSesion);
    if (!conv) return [];
    return consulta(
        `SELECT contenido, opciones FROM intelligence.mensaje
          WHERE id_conversacion = :id AND direccion = 'saliente'
          ORDER BY creado_en, id_mensaje;`,
        { id: conv.id_conversacion }
    );
}

/**
 * Espera a que el bot haya contestado `cuantas` veces.
 *
 * Sondea en vez de dormir un rato fijo: un `sleep` generoso hace el test lento cuando va bien
 * y escamoso cuando la máquina va cargada, que es la peor combinación posible.
 */
async function esperarRespuestas(idSesion, cuantas, ms = 8000) {
    const limite = Date.now() + ms;
    let ultimas = [];
    while (Date.now() < limite) {
        ultimas = await salientesDe(idSesion);
        if (ultimas.length >= cuantas) return ultimas;
        await dormir(60);
    }
    // Al expirar, el motivo casi siempre está en el turno: el manejador lanzó y el motor lo
    // registró. Sin esto, el fallo se lee como «no llegó nada» y hay que salir a buscarlo a
    // mano en la base — que además la limpieza de `afterAll` ya habrá borrado.
    const conv = await conversacionDe(idSesion);
    // Se vuelcan TODOS los turnos, no solo los que fallaron: un turno que se queda en
    // `procesando` no deja error y se lee igual que uno que nunca existió. Distinguirlos es
    // la diferencia entre buscar un cuelgue y buscar una excepción.
    const turnos = conv
        ? await consulta(
              `SELECT secuencia, estado, resultado, error_codigo, error_detalle
                 FROM intelligence.turno WHERE id_conversacion = :id ORDER BY secuencia;`,
              { id: conv.id_conversacion }
          )
        : [];

    throw new Error(
        `Esperaba ${cuantas} respuestas y llegaron ${ultimas.length}: ` +
            JSON.stringify(ultimas.map((m) => m.contenido)) +
            `\nEstado de la conversación: ${conv?.estado} / tarea ${conv?.tarea_actual}` +
            `\nTurnos: ${JSON.stringify(turnos, null, 1)}`
    );
}

/** Un paso de conversación: escribe y espera la respuesta que le toca. */
async function decir(idSesion, texto, respuestaNumero) {
    await enviar(idSesion, texto);
    const todas = await esperarRespuestas(idSesion, respuestaNumero);
    return todas[respuestaNumero - 1];
}

const opcionesDe = (mensaje) => {
    const o = mensaje?.opciones;
    if (!o) return [];
    return typeof o === 'string' ? JSON.parse(o) : o;
};

beforeAll(async () => {
    const negocio = await unaFila(
        `SELECT id_negocio FROM general.gener_negocio WHERE estado = 'A' ORDER BY id_negocio LIMIT 1;`
    );
    if (!negocio) throw new Error('No hay negocio activo. Corre scripts/seed_dev_local.js.');
    idNegocio = negocio.id_negocio;

    const servicios = await consulta(
        `SELECT COUNT(*)::int n FROM reserva.reserva_servicio WHERE id_negocio = :idNegocio AND estado = 'A';`,
        { idNegocio }
    );
    if (!servicios[0].n) {
        throw new Error('Sin agenda de reserva. Corre scripts/fixtures/dev_reserva.sql.');
    }

    // Primer día con horario a partir de mañana. Se calcula en vez de fijarse porque el
    // fixture monta lunes a viernes: un test con fecha escrita a mano falla los fines de
    // semana, y un test que solo falla los sábados es peor que no tenerlo.
    const dias = (
        await consulta(
            `SELECT DISTINCT dia_semana FROM reserva.reserva_horario WHERE id_negocio = :idNegocio;`,
            { idNegocio }
        )
    ).map((f) => Number(f.dia_semana));

    const hoy = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Bogota' }));
    for (let i = 1; i <= 14 && !fechaConAgenda; i++) {
        const d = new Date(hoy);
        d.setDate(d.getDate() + i);
        const iso = d.getDay() === 0 ? 7 : d.getDay();
        if (dias.includes(iso)) fechaConAgenda = d.toISOString().slice(0, 10);
    }
    if (!fechaConAgenda) throw new Error('No hay ningún día con horario en las próximas 2 semanas.');

    // ⚠️ Barrer los holds vivos de ese día ANTES de empezar.
    //
    // `proponer_turno` no es idempotente: un hold nuevo sobre una hora ya apartada choca con
    // el que sigue vivo. Una ejecución anterior que se cortó a mitad deja holds `activo` con
    // varios minutos de TTL, así que **la primera pasada va bien y las siguientes fallan** —
    // el peor patrón posible, porque parece intermitencia y no lo es.
    await limpiarHolds();

    COLA_CONFIG.debounceMs = DEBOUNCE_TEST;
    COLA_CONFIG.debounceMaxMs = DEBOUNCE_TEST * 6;

    intelligence.arrancar(); // registra las capacidades de reserva
}, 30000);

/** Suelta los holds sin confirmar del día de pruebas. Solo los `activo`: los `confirmado` */
/** pertenecen a citas y los borra la limpieza de citas, no ésta. */
async function limpiarHolds() {
    await sequelize.query(
        `DELETE FROM reserva.reserva_hold
          WHERE id_negocio = :idNegocio
            AND estado = 'activo'
            AND fecha_hora_inicio::date = CAST(:fecha AS date);`,
        { replacements: { idNegocio, fecha: fechaConAgenda }, logging: false }
    );
}

beforeEach(() => {
    motor._reiniciar();
    motor.registrarManejador(manejarDeterminista);
    gateway.limpiar();
    gateway.registrar(adaptador);
    simulador.limpiar();
    adaptador.limpiarBuzones();
});

afterEach(() => {
    motor.detener();
    gateway.detener();
});

afterAll(async () => {
    // Se borra lo que creó esta suite y nada más: los holds del día, las citas por su nombre
    // de cliente, y las conversaciones por sus sesiones. Dejar basura en una base de
    // desarrollo es exactamente cómo empieza un "en mi máquina funciona".
    await limpiarHolds();

    await sequelize.query(
        `DELETE FROM reserva.reserva_cita_servicio WHERE id_cita IN
            (SELECT id_cita FROM reserva.reserva_cita WHERE cliente_nombre LIKE 'E2E %');`,
        { logging: false }
    );
    await sequelize.query(`DELETE FROM reserva.reserva_cita WHERE cliente_nombre LIKE 'E2E %';`, {
        logging: false,
    });

    const ids = (
        await consulta(
            `SELECT id_conversacion FROM intelligence.conversacion
              WHERE canal = :canal AND id_externo IN (:sesiones);`,
            { canal: CANAL, sesiones: [...sesiones, '__ninguna__'] }
        )
    ).map((f) => f.id_conversacion);

    if (ids.length) {
        await sequelize.query(
            `DELETE FROM intelligence.paso WHERE id_turno IN
                (SELECT id_turno FROM intelligence.turno WHERE id_conversacion IN (:ids));`,
            { replacements: { ids }, logging: false }
        );
        for (const tabla of ['mensaje', 'turno']) {
            await sequelize.query(`DELETE FROM intelligence.${tabla} WHERE id_conversacion IN (:ids);`, {
                replacements: { ids },
                logging: false,
            });
        }
        await sequelize.query(`DELETE FROM intelligence.conversacion WHERE id_conversacion IN (:ids);`, {
            replacements: { ids },
            logging: false,
        });
    }
    await sequelize.query(
        `DELETE FROM intelligence.ingesta_recibida WHERE canal = :canal AND id_externo LIKE 'cli_test_e2e_%';`,
        { replacements: { canal: CANAL }, logging: false }
    );
    await sequelize.close();
}, 30000);

// ── Criterio 1 ──────────────────────────────────────────────────────────────────────────

describe('criterio 1: una cita completa por WebChat', () => {
    test('seis turnos y la cita queda correcta en el dominio', async () => {
        const s = sesion('feliz');

        const menu = await decir(s, 'hola', 1);
        const servicios = opcionesDe(menu);
        expect(servicios.length).toBeGreaterThan(0);
        // El menú NO va numerado dentro del texto (ADR-017): va en `opciones`.
        expect(menu.contenido).not.toMatch(/1\)/);

        await decir(s, servicios[0].id, 2);
        const horas = opcionesDe(await decir(s, fechaConAgenda, 3));
        expect(horas.length).toBeGreaterThan(0);

        await decir(s, horas[0].id, 4);
        const propuesta = await decir(s, 'E2E Cliente', 5);
        expect(propuesta.contenido).toMatch(/¿Confirmo la cita\?/);

        const final = await decir(s, 'sí', 6);
        expect(final.contenido).toMatch(/agendada/i);

        // La prueba de verdad no es el texto del bot: es la fila en el dominio.
        const cita = await unaFila(
            // La fecha se pide formateada por Postgres: `String(Date)` en Node la imprime
            // como "Fri Aug 14 2026 ..." y compararla con un ISO no prueba nada.
            `SELECT codigo_publico, estado,
                    to_char(fecha_hora_inicio, 'YYYY-MM-DD') AS fecha_iso,
                    to_char(fecha_hora_inicio, 'HH24:MI')    AS hora_hhmm
               FROM reserva.reserva_cita
              WHERE id_negocio = :idNegocio AND cliente_nombre = 'E2E Cliente'
              ORDER BY id_cita DESC LIMIT 1;`,
            { idNegocio }
        );
        expect(cita).not.toBeNull();
        // El código que se le dio a la persona es el de la cita real, no uno inventado.
        expect(final.contenido).toContain(cita.codigo_publico);
        expect(cita.fecha_iso).toBe(fechaConAgenda);
        expect(cita.hora_hhmm).toBe(horas[0].id);

        // Y el código quedó en la memoria de la conversación: sin `consultar_mis_citas` es
        // lo único que permitiría reagendar o cancelar después.
        const conv = await conversacionDe(s);
        expect(conv.variables.ultima_cita).toBe(cita.codigo_publico);
        expect(conv.tarea_actual).toBeNull();
    }, 60000);

    test('el turno queda registrado como determinista y sin costo', async () => {
        // Criterio 4: F5 entero cuesta $0.00. Si algún día alguien enchufa un modelo aquí,
        // el nivel dejaría de ser `determinista` y este test lo diría.
        const s = sesion('nivel');
        await decir(s, 'hola', 1);
        const conv = await conversacionDe(s);

        const turnos = await consulta(
            `SELECT nivel FROM intelligence.turno WHERE id_conversacion = :id;`,
            { id: conv.id_conversacion }
        );
        expect(turnos.length).toBeGreaterThan(0);
        expect(turnos.every((t) => t.nivel === 'determinista')).toBe(true);

        const costos = await consulta(
            `SELECT COUNT(*)::int n FROM intelligence.costo WHERE id_conversacion = :id;`,
            { id: conv.id_conversacion }
        );
        expect(costos[0].n).toBe(0);
    }, 30000);
});

// ── Criterio 2 ──────────────────────────────────────────────────────────────────────────

describe('criterio 2: la ráfaga', () => {
    test('cinco mensajes en dos segundos producen UN turno', async () => {
        // El bug clásico: tres webhooks en paralelo, tres respuestas contradictorias y, en el
        // peor caso, dos citas. Lo que lo impide es debounce + FIFO por conversación + lock
        // pesimista, y aquí se comprueba con el motor entero, no con la cola aislada.
        const s = sesion('rafaga');

        for (const texto of ['hola', 'buenas', 'quiero cita', 'para mañana', 'porfa']) {
            await enviar(s, texto);
            await dormir(20);
        }

        await esperarRespuestas(s, 1);
        await dormir(DEBOUNCE_TEST * 4); // margen para que un segundo turno indebido apareciera

        const conv = await conversacionDe(s);
        const turnos = await consulta(
            `SELECT COUNT(*)::int n FROM intelligence.turno WHERE id_conversacion = :id;`,
            { id: conv.id_conversacion }
        );
        const salientes = await salientesDe(s);

        expect(turnos[0].n).toBe(1);
        expect(salientes).toHaveLength(1);

        // Y los cinco mensajes se agruparon en ese único turno.
        const entrantes = await consulta(
            `SELECT COUNT(*)::int n FROM intelligence.mensaje
              WHERE id_conversacion = :id AND direccion = 'entrante' AND id_turno IS NOT NULL;`,
            { id: conv.id_conversacion }
        );
        expect(entrantes[0].n).toBe(5);
    }, 60000);

    test('una ráfaga en el paso de confirmar no crea dos citas', async () => {
        // La variante que de verdad duele: repetir el "sí". Si el debounce fallara, dos
        // turnos confirmarían el mismo hold. El segundo no encuentra hold vigente, así que
        // como mucho habría una cita — pero el cliente vería dos respuestas contradictorias.
        const s = sesion('doblesi');

        const menu = await decir(s, 'hola', 1);
        await decir(s, opcionesDe(menu)[0].id, 2);
        const horas = opcionesDe(await decir(s, fechaConAgenda, 3));
        await decir(s, horas[0].id, 4);
        await decir(s, 'E2E Doble', 5);

        for (let i = 0; i < 3; i++) {
            await enviar(s, 'sí');
            await dormir(20);
        }
        await esperarRespuestas(s, 6);
        await dormir(DEBOUNCE_TEST * 4);

        const citas = await consulta(
            `SELECT COUNT(*)::int n FROM reserva.reserva_cita
              WHERE id_negocio = :idNegocio AND cliente_nombre = 'E2E Doble';`,
            { idNegocio }
        );
        expect(citas[0].n).toBe(1);
        expect(await salientesDe(s)).toHaveLength(6);
    }, 60000);
});

// ── Criterio 3 ──────────────────────────────────────────────────────────────────────────

describe('criterio 3: la continuidad', () => {
    test('la tarea sobrevive a que el proceso muera a mitad', async () => {
        const s = sesion('continuidad');

        const menu = await decir(s, 'hola', 1);
        await decir(s, opcionesDe(menu)[0].id, 2);

        const antes = await conversacionDe(s);
        expect(antes.tarea_actual).toBe('agendar_cita');
        expect(antes.tarea_datos.paso).toBe('fecha');

        // El "reinicio": se tira el motor entero, con su cola en memoria y su manejador.
        // Si el estado de la conversación viviera en memoria, aquí se perdería.
        motor.detener();
        motor._reiniciar();
        motor.registrarManejador(manejarDeterminista);

        const despues = await decir(s, 'seguimos', 3);
        expect(despues.contenido).toMatch(/Seguimos donde lo dejamos/);

        const conv = await conversacionDe(s);
        expect(conv.tarea_actual).toBe('agendar_cita');
        expect(conv.tarea_datos.paso).toBe('fecha');
        expect(conv.tarea_datos.id_servicio).toBe(antes.tarea_datos.id_servicio);
    }, 60000);

    test('tras el reinicio la tarea se completa hasta crear la cita', async () => {
        // Retomar y quedarse a medias no demostraría nada: lo que importa es que el trabajo
        // recuperado siga siendo utilizable hasta el final.
        const s = sesion('retomar');

        const menu = await decir(s, 'hola', 1);
        await decir(s, opcionesDe(menu)[0].id, 2);

        motor.detener();
        motor._reiniciar();
        motor.registrarManejador(manejarDeterminista);

        const horas = opcionesDe(await decir(s, fechaConAgenda, 3));
        await decir(s, horas[0].id, 4);
        await decir(s, 'E2E Retomada', 5);
        await decir(s, 'sí', 6);

        const cita = await unaFila(
            `SELECT codigo_publico FROM reserva.reserva_cita
              WHERE id_negocio = :idNegocio AND cliente_nombre = 'E2E Retomada' LIMIT 1;`,
            { idNegocio }
        );
        expect(cita).not.toBeNull();
    }, 60000);
});
