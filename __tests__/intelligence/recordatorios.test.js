/**
 * Recordatorios proactivos (F8-B) — el primer consumidor del outbox de F1.
 *
 * Lo que esta suite tiene que dejar establecido es una sola idea, la que decidió el diseño:
 * **el recordatorio se decide al enviarlo, no al programarlo.** Por eso no hay ni un test de
 * «llega el evento de cancelación»: no existe ese evento, y el sistema es correcto igualmente
 * porque relee la cita cuando le toca salir. Si alguien cancela con un `UPDATE` a mano desde el
 * panel, el recordatorio también tiene que morir — y eso es lo que se comprueba aquí.
 *
 * Corre contra la base de verdad porque todo lo que importa está en SQL: la unicidad que hace
 * idempotente la programación, el `SKIP LOCKED` del drenaje, y la relectura.
 */
'use strict';

require('dotenv').config();
const Models = require('../../app_core/models/conection');
const recordatorios = require('../../intelligence/recordatorios');
const recordatoriosReserva = require('../../intelligence/adapters/reserva/recordatorios');
const repositorio = require('../../intelligence/engine/repositorio');
const outboxDao = require('../../app_core/dao/outboxDao');
const relay = require('../../app_core/outbox/outboxRelay');
const citaService = require('../../app_reserva_api/services/citaService');
const disponibilidadService = require('../../app_reserva_api/services/disponibilidadService');
const plantillas = require('../../intelligence/core/plantillas');

const sequelize = Models.sequelize;
const SELECT = { type: sequelize.QueryTypes.SELECT, logging: false };
const consulta = (sql, replacements = {}) => sequelize.query(sql, { replacements, ...SELECT });
const unaFila = async (sql, r = {}) => (await consulta(sql, r))[0] ?? null;

const TELEFONO = '3001234567';
const CANAL = recordatorios.CONFIG.canal;
const HORA = 3600 * 1000;

let idNegocio;
let idProfesional;
let idServicio;
const citasCreadas = [];
const conversacionesCreadas = [];

/** Una cita a medida, escrita directamente: aquí interesa controlar el estado y la hora. */
async function crearCitaCruda({ dentroDeHoras = 48, estado = 'pendiente', telefono = TELEFONO }) {
    const fila = await unaFila(
        `
        INSERT INTO reserva.reserva_cita
            (id_negocio, id_profesional, fecha_hora_inicio, fecha_hora_fin, estado,
             cliente_nombre, cliente_telefono)
        VALUES (:idNegocio, :idProfesional,
                (now() AT TIME ZONE 'America/Bogota') + (:horas || ' hours')::interval,
                (now() AT TIME ZONE 'America/Bogota') + ((:horas::numeric + 0.5) || ' hours')::interval,
                :estado, 'Cliente Recordatorio', :telefono)
        RETURNING id_cita, codigo_publico, fecha_hora_inicio;
        `,
        { idNegocio, idProfesional, horas: String(dentroDeHoras), estado, telefono }
    );
    await sequelize.query(
        `INSERT INTO reserva.reserva_cita_servicio
             (id_cita, id_servicio, precio_snapshot, duracion_snapshot_min)
         VALUES (:idCita, :idServicio, 35000, 30);`,
        { replacements: { idCita: fila.id_cita, idServicio }, logging: false }
    );
    citasCreadas.push(fila.id_cita);
    return fila;
}

const recordatorioDe = (referencia) =>
    unaFila(
        `SELECT * FROM intelligence.recordatorio
          WHERE id_negocio = :idNegocio AND referencia = :referencia;`,
        { idNegocio, referencia }
    );

const salientesDe = (idExterno) =>
    consulta(
        `SELECT m.contenido, m.plantilla, m.estado_entrega, m.id_turno
           FROM intelligence.mensaje m
           JOIN intelligence.conversacion c ON c.id_conversacion = m.id_conversacion
          WHERE c.id_negocio = :idNegocio AND c.canal = :canal AND c.id_externo = :idExterno
            AND m.direccion = 'saliente'
          ORDER BY m.creado_en;`,
        { idNegocio, canal: CANAL, idExterno }
    );

/** Adelanta el reloj de un recordatorio en vez de esperar dos días. */
async function vencer(referencia, { hace = '1 minute' } = {}) {
    await sequelize.query(
        `UPDATE intelligence.recordatorio
            SET enviar_en = now() - (:hace)::interval
          WHERE id_negocio = :idNegocio AND referencia = :referencia;`,
        { replacements: { idNegocio, referencia, hace }, logging: false }
    );
}

beforeAll(async () => {
    const profesional = await unaFila(
        `SELECT p.id_negocio, p.id_profesional
           FROM reserva.reserva_profesional p
          WHERE p.estado = 'A'
          ORDER BY p.id_negocio, p.id_profesional
          LIMIT 1;`
    );
    if (!profesional) throw new Error('Sin fixture de reserva. Corre scripts/fixtures/dev_reserva.sql.');
    idNegocio = profesional.id_negocio;
    idProfesional = profesional.id_profesional;

    const servicio = await unaFila(
        `SELECT id_servicio FROM reserva.reserva_servicio WHERE id_negocio = :idNegocio LIMIT 1;`,
        { idNegocio }
    );
    idServicio = servicio.id_servicio;

    recordatorios.limpiarRevisores();
    recordatorios.registrarRevisor(recordatoriosReserva.PREFIJO, recordatoriosReserva.revisar);
});

afterAll(async () => {
    if (citasCreadas.length) {
        await sequelize.query(`DELETE FROM reserva.reserva_cita_servicio WHERE id_cita IN (:ids);`, {
            replacements: { ids: citasCreadas },
            logging: false,
        });
        await sequelize.query(`DELETE FROM reserva.reserva_cita WHERE id_cita IN (:ids);`, {
            replacements: { ids: citasCreadas },
            logging: false,
        });
    }
    if (conversacionesCreadas.length) {
        await sequelize.query(`DELETE FROM intelligence.mensaje WHERE id_conversacion IN (:ids);`, {
            replacements: { ids: conversacionesCreadas },
            logging: false,
        });
        await sequelize.query(`DELETE FROM intelligence.conversacion WHERE id_conversacion IN (:ids);`, {
            replacements: { ids: conversacionesCreadas },
            logging: false,
        });
    }
    await sequelize.query(
        `DELETE FROM intelligence.recordatorio WHERE referencia LIKE 'cita:%' AND id_negocio = :idNegocio;`,
        { replacements: { idNegocio }, logging: false }
    );
    await sequelize.close();
});

// ── El evento ───────────────────────────────────────────────────────────────────────────

describe('reserva emite cita.creada.v1', () => {
    test('crear una cita deja el evento en el outbox, en la misma transacción', async () => {
        // La cita se crea por el servicio de verdad, no a mano: lo que se prueba es que el
        // productor exista, que es lo que faltaba desde F1. Y la hora se pide a la
        // disponibilidad en vez de escribirla: desde F3 crear fuera de horario se rechaza, así
        // que una fecha a ojo convierte esta prueba en un test del calendario del fixture.
        const hueco = await primerHuecoLibre();
        const cita = await citaService.crearCita({
            idNegocio,
            idProfesional,
            idServicios: [idServicio],
            fechaHoraInicioISO: hueco,
            clienteNombre: 'Cliente Evento',
            clienteTelefono: TELEFONO,
        });
        citasCreadas.push(cita.id_cita);

        const evento = await unaFila(
            `SELECT tipo, id_negocio, payload FROM platform.outbox
              WHERE tipo = 'cita.creada.v1' AND payload->>'id_cita' = :idCita;`,
            { idCita: String(cita.id_cita) }
        );
        expect(evento).not.toBeNull();
        expect(evento.id_negocio).toBe(idNegocio);
        // Delgado: identificadores y el hecho, no una copia del estado (ADR-013).
        expect(Object.keys(evento.payload)).toEqual(['id_cita']);
    }, 20000);
});

// ── Programar ───────────────────────────────────────────────────────────────────────────

describe('programar al consumir el evento', () => {
    test('deja el recordatorio a 24 h de la cita', async () => {
        const cita = await crearCitaCruda({ dentroDeHoras: 48 });
        const resultado = await recordatoriosReserva.alCrearseUnaCita({
            id_negocio: idNegocio,
            payload: { id_cita: cita.id_cita },
        });

        expect(resultado.programado).toBe(true);
        const fila = await recordatorioDe(`cita:${cita.codigo_publico}`);
        expect(fila.estado).toBe('pendiente');
        expect(fila.plantilla).toBe('recordatorio_cita');
        // Sin el `+`: el `id_externo` de WhatsApp es el `from` del webhook, y con el `+` se
        // abriría una conversación distinta de la que la persona ya tiene.
        expect(fila.id_externo).toBe('573001234567');

        const horasAntes = (new Date(cita.fecha_hora_inicio) - new Date(fila.enviar_en)) / HORA;
        expect(horasAntes).toBeCloseTo(recordatoriosReserva.CONFIG.horasAntes, 1);
    });

    test('el mismo evento dos veces deja UN recordatorio', async () => {
        // El outbox entrega al menos una vez (ADR-012): esto no es una hipótesis.
        const cita = await crearCitaCruda({ dentroDeHoras: 50 });
        const evento = { id_negocio: idNegocio, payload: { id_cita: cita.id_cita } };
        await recordatoriosReserva.alCrearseUnaCita(evento);
        await recordatoriosReserva.alCrearseUnaCita(evento);

        const filas = await consulta(
            `SELECT id_recordatorio FROM intelligence.recordatorio
              WHERE id_negocio = :idNegocio AND referencia = :referencia;`,
            { idNegocio, referencia: `cita:${cita.codigo_publico}` }
        );
        expect(filas).toHaveLength(1);
    });

    test('sin teléfono no se programa, y no es un error', async () => {
        const cita = await crearCitaCruda({ dentroDeHoras: 48, telefono: null });
        const resultado = await recordatoriosReserva.alCrearseUnaCita({
            id_negocio: idNegocio,
            payload: { id_cita: cita.id_cita },
        });
        expect(resultado).toMatchObject({ programado: false });
        expect(await recordatorioDe(`cita:${cita.codigo_publico}`)).toBeNull();
    });

    test('una cita antes de la antelación no se programa', async () => {
        const cita = await crearCitaCruda({ dentroDeHoras: 2 });
        const resultado = await recordatoriosReserva.alCrearseUnaCita({
            id_negocio: idNegocio,
            payload: { id_cita: cita.id_cita },
        });
        expect(resultado.programado).toBe(false);
    });
});

// ── Drenar: aquí es donde se decide de verdad ───────────────────────────────────────────

describe('al vencer se relee la cita', () => {
    test('cita viva: sale un saliente con plantilla y el texto compuesto', async () => {
        const cita = await crearCitaCruda({ dentroDeHoras: 30 });
        const referencia = `cita:${cita.codigo_publico}`;
        await recordatoriosReserva.alCrearseUnaCita({
            id_negocio: idNegocio,
            payload: { id_cita: cita.id_cita },
        });
        // La cita se acerca a menos de la antelación: si no, el revisor haría lo correcto
        // —reprogramarlo al futuro— y este test estaría midiendo otra cosa.
        await acercarCita(cita.id_cita, 20);
        await vencer(referencia);

        const resumen = await recordatorios.drenarUnaVez();
        expect(resumen.enviados).toBeGreaterThanOrEqual(1);

        const fila = await recordatorioDe(referencia);
        expect(fila.estado).toBe('enviado');
        expect(fila.id_mensaje).not.toBeNull();

        const conversacion = await unaFila(
            `SELECT id_conversacion FROM intelligence.conversacion
              WHERE id_negocio = :idNegocio AND canal = :canal AND id_externo = '573001234567';`,
            { idNegocio, canal: CANAL }
        );
        conversacionesCreadas.push(conversacion.id_conversacion);

        const salientes = await salientesDe('573001234567');
        const mensaje = salientes.at(-1);
        expect(mensaje.estado_entrega).toBe('pendiente');
        expect(mensaje.plantilla.nombre).toBe('recordatorio_cita');
        // El contenido va compuesto: es lo que un humano lee en la Consola, y lo que entrega
        // un canal que no tenga plantillas.
        expect(mensaje.contenido).toContain('Cliente Recordatorio');
        expect(mensaje.contenido).toBe(
            plantillas.renderizarTexto('recordatorio_cita', mensaje.plantilla.parametros)
        );
        // Sin turno: no lo decidió una conversación, lo decidió un calendario.
        expect(mensaje.id_turno).toBeNull();
    });

    test('cita cancelada por fuera: el recordatorio muere y no sale nada', async () => {
        // Éste es EL test de la fase. Nadie emitió `cita.cancelada`: se canceló con un UPDATE,
        // como lo hace el panel. El recordatorio tiene que enterarse igual.
        const cita = await crearCitaCruda({ dentroDeHoras: 30 });
        const referencia = `cita:${cita.codigo_publico}`;
        await recordatoriosReserva.alCrearseUnaCita({
            id_negocio: idNegocio,
            payload: { id_cita: cita.id_cita },
        });
        await sequelize.query(
            `UPDATE reserva.reserva_cita SET estado = 'cancelada' WHERE id_cita = :idCita;`,
            { replacements: { idCita: cita.id_cita }, logging: false }
        );
        await vencer(referencia);

        const antes = (await salientesDe('573001234567')).length;
        await recordatorios.drenarUnaVez();

        const fila = await recordatorioDe(referencia);
        expect(fila.estado).toBe('cancelado');
        expect(fila.motivo).toMatch(/cancelada/);
        expect((await salientesDe('573001234567')).length).toBe(antes);
    });

    test('cita movida a otro día: el recordatorio se mueve con ella', async () => {
        const cita = await crearCitaCruda({ dentroDeHoras: 30 });
        const referencia = `cita:${cita.codigo_publico}`;
        await recordatoriosReserva.alCrearseUnaCita({
            id_negocio: idNegocio,
            payload: { id_cita: cita.id_cita },
        });
        await sequelize.query(
            `UPDATE reserva.reserva_cita
                SET fecha_hora_inicio = fecha_hora_inicio + interval '5 days',
                    fecha_hora_fin    = fecha_hora_fin    + interval '5 days'
              WHERE id_cita = :idCita;`,
            { replacements: { idCita: cita.id_cita }, logging: false }
        );
        await vencer(referencia);

        const resumen = await recordatorios.drenarUnaVez();
        expect(resumen.reprogramados).toBeGreaterThanOrEqual(1);

        const fila = await recordatorioDe(referencia);
        expect(fila.estado).toBe('pendiente');
        expect(new Date(fila.enviar_en).getTime()).toBeGreaterThan(Date.now());
    });

    test('demasiado tarde: no se manda a destiempo, se cancela', async () => {
        const cita = await crearCitaCruda({ dentroDeHoras: 30 });
        const referencia = `cita:${cita.codigo_publico}`;
        await recordatoriosReserva.alCrearseUnaCita({
            id_negocio: idNegocio,
            payload: { id_cita: cita.id_cita },
        });
        // Vencido hace mucho más que la tolerancia, como si el proceso hubiera estado caído.
        await acercarCita(cita.id_cita, 20);
        await vencer(referencia, { hace: `${recordatorios.CONFIG.toleranciaMinutos + 60} minutes` });

        await recordatorios.drenarUnaVez();
        const fila = await recordatorioDe(referencia);
        expect(fila.estado).toBe('cancelado');
        expect(fila.motivo).toMatch(/tolerancia/);
    });

    test('a quien pidió la baja no se le recuerda nada', async () => {
        const cita = await crearCitaCruda({ dentroDeHoras: 30 });
        const referencia = `cita:${cita.codigo_publico}`;
        await recordatoriosReserva.alCrearseUnaCita({
            id_negocio: idNegocio,
            payload: { id_cita: cita.id_cita },
        });

        // La conversación ya existe de los tests de arriba; se bloquea como haría un STOP.
        const conversacion = await unaFila(
            `SELECT id_conversacion FROM intelligence.conversacion
              WHERE id_negocio = :idNegocio AND canal = :canal AND id_externo = '573001234567';`,
            { idNegocio, canal: CANAL }
        );
        await sequelize.query(
            `UPDATE intelligence.conversacion SET estado = 'bloqueada' WHERE id_conversacion = :id;`,
            { replacements: { id: conversacion.id_conversacion }, logging: false }
        );
        await acercarCita(cita.id_cita, 20);
        await vencer(referencia);

        const antes = (await salientesDe('573001234567')).length;
        await recordatorios.drenarUnaVez();

        const fila = await recordatorioDe(referencia);
        expect(fila.estado).toBe('cancelado');
        expect(fila.motivo).toMatch(/bloqueada/);
        // Y sobre todo: ni siquiera se creó el mensaje. Uno pendiente que nunca sale ensucia
        // la cola y el Ledger con algo que no va a ocurrir.
        expect((await salientesDe('573001234567')).length).toBe(antes);

        await sequelize.query(
            `UPDATE intelligence.conversacion SET estado = 'activa' WHERE id_conversacion = :id;`,
            { replacements: { id: conversacion.id_conversacion }, logging: false }
        );
    });
});

// ── El relay, de punta a punta ──────────────────────────────────────────────────────────

describe('el camino completo desde el outbox', () => {
    test('el relay entrega el evento al consumidor y aparece el recordatorio', async () => {
        relay.limpiarConsumidores();
        recordatoriosReserva.registrar({ relay });

        const cita = await crearCitaCruda({ dentroDeHoras: 60 });
        const t = await sequelize.transaction();
        try {
            await outboxDao.emitir(
                { tipo: 'cita.creada.v1', idNegocio, payload: { id_cita: cita.id_cita } },
                { transaction: t }
            );
            await t.commit();
        } catch (error) {
            await t.rollback();
            throw error;
        }

        await relay.drenarUnaVez();

        const fila = await recordatorioDe(`cita:${cita.codigo_publico}`);
        expect(fila).not.toBeNull();
        expect(fila.estado).toBe('pendiente');
        relay.limpiarConsumidores();
    }, 20000);
});

/**
 * El primer hueco libre de los próximos catorce días, preguntándoselo a la vertical.
 *
 * Se calcula en vez de fijarse por lo mismo que en `e2e_agendar`: el fixture monta lunes a
 * viernes, y un test con fecha escrita a mano falla los fines de semana. Un test que solo falla
 * los sábados es peor que no tenerlo.
 */
async function primerHuecoLibre() {
    for (let i = 1; i <= 14; i++) {
        const fechaISO = diaISO(i);
        const { slots } = await disponibilidadService.calcularSlots({
            idNegocio,
            idServicio,
            idProfesional,
            fechaISO,
        });
        const libre = (slots || []).find((s) => s.disponible !== false);
        if (libre) return `${fechaISO}T${libre.hora}:00`;
    }
    throw new Error('No hay ningún hueco libre en dos semanas: revisa el fixture de reserva.');
}

/** `YYYY-MM-DD` de dentro de `dias`, en calendario de Bogotá y sin pasar por UTC. */
function diaISO(dias) {
    const hoy = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Bogota',
        year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());
    const [a, m, d] = hoy.split('-').map(Number);
    return new Date(Date.UTC(a, m - 1, d + dias)).toISOString().slice(0, 10);
}

/** Acerca la cita para que su recordatorio caiga en el pasado y el drenaje lo mande. */
async function acercarCita(idCita, horas) {
    await sequelize.query(
        `UPDATE reserva.reserva_cita
            SET fecha_hora_inicio = (now() AT TIME ZONE 'America/Bogota') + (:horas || ' hours')::interval,
                fecha_hora_fin    = (now() AT TIME ZONE 'America/Bogota') + ((:horas::numeric + 0.5) || ' hours')::interval
          WHERE id_cita = :idCita;`,
        { replacements: { idCita, horas: String(horas) }, logging: false }
    );
}

/** `Date` → la cadena sin huso que espera el servicio de la vertical, en hora de Bogotá. */
function fechaBogota(fecha) {
    const partes = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Bogota',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false,
    }).formatToParts(fecha);
    const p = Object.fromEntries(partes.map((x) => [x.type, x.value]));
    return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`;
}
