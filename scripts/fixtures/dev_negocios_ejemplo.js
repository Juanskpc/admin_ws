/**
 * Negocios de ejemplo para probar el asistente contra varios inquilinos.
 *
 * ## Por qué existe
 *
 * El fixture `dev_reserva.sql` colgó una peluquería del negocio 1, que se llama «Restaurante
 * Demo»: sirve para probar el motor, pero no para mirar cómo se comporta el asistente cuando
 * cambia de negocio —ni para ver un saludo con el nombre del sitio sin que suene absurdo—.
 * Esto crea negocios coherentes, cada uno con su catálogo, su gente y su horario.
 *
 * Todos son del vertical `reserva` porque es el único con adaptador de capacidades (F4 lo
 * eligió como piloto). Cuando `restaurante` adopte capacidades (F9), aquí van los suyos.
 *
 * ## Idempotente
 *
 * Se identifica cada negocio por su nombre. Si ya está, se reutiliza y solo se completa lo que
 * falte; volver a ejecutarlo no duplica nada. No se insertan ids explícitos, para no dejar las
 * secuencias desincronizadas.
 *
 * ## Uso
 *
 *   node scripts/fixtures/dev_negocios_ejemplo.js
 *
 * ⚠️ Comprueba a qué base apuntas antes (`grep -E '^DB_(HOST|PORT|NAME)=' .env`). Escribe.
 */

require('dotenv').config();
const { Client } = require('pg');

const TIPO_BARBERIA = 3;

const L_A_V = [1, 2, 3, 4, 5];
const L_A_S = [1, 2, 3, 4, 5, 6];

const NEGOCIOS = [
    {
        nombre: 'Barbería Don Nico',
        tipo: TIPO_BARBERIA,
        email: 'hola@barberiadonnico.local',
        telefono: '3011234567',
        direccion: 'Cra 13 #85-32, Bogotá',
        config: { anticipacion_min_horas: 1, buffer_limpieza_min: 10, ventana_cancelacion_horas: 4, paso_slot_min: 15 },
        servicios: [
            { nombre: 'Corte clásico', duracion_min: 30, precio: 28000, descripcion: 'Corte a tijera y máquina, con lavado.' },
            { nombre: 'Arreglo de barba', duracion_min: 20, precio: 18000, descripcion: 'Perfilado y toalla caliente.' },
            { nombre: 'Corte + barba', duracion_min: 50, precio: 42000, descripcion: 'El combo completo.' },
        ],
        profesionales: [
            { nombre: 'Andrés Molina', especialidad: 'Barbero' },
            { nombre: 'Julián Cortés', especialidad: 'Barbero' },
        ],
        horario: { dias: L_A_S, bloques: [['09:00', '13:00'], ['14:00', '19:00']] },
    },
    {
        nombre: 'Spa Aurora',
        tipo: TIPO_BARBERIA,
        email: 'reservas@spaaurora.local',
        telefono: '3029876543',
        direccion: 'Calle 70 #10-15, Bogotá',
        // Buffer más largo a propósito: un spa necesita limpiar la cabina entre clientes, y
        // así hay un negocio donde el buffer se nota en las horas que se ofrecen.
        config: { anticipacion_min_horas: 2, buffer_limpieza_min: 20, ventana_cancelacion_horas: 24, paso_slot_min: 30 },
        servicios: [
            { nombre: 'Masaje relajante', duracion_min: 60, precio: 95000, descripcion: 'Cuerpo completo, aceites tibios.' },
            { nombre: 'Limpieza facial', duracion_min: 45, precio: 75000, descripcion: 'Incluye extracción e hidratación.' },
        ],
        profesionales: [
            { nombre: 'Valentina Ríos', especialidad: 'Terapeuta' },
            { nombre: 'Camila Ospina', especialidad: 'Esteticista' },
        ],
        horario: { dias: [2, 3, 4, 5, 6], bloques: [['10:00', '14:00'], ['15:00', '19:00']] },
    },
    {
        nombre: 'Consultorio Dental Sonrisa',
        tipo: TIPO_BARBERIA,
        email: 'citas@dentalsonrisa.local',
        telefono: '3045551212',
        direccion: 'Av. Suba #120-40, Bogotá',
        // Un solo profesional: es el caso donde el bug de «SLOT_NO_DISPONIBLE sobre una hora
        // que el bot acababa de ofrecer» es INVISIBLE. Tenerlo aparte, junto a los de dos
        // profesionales, es lo que permite notar la diferencia al probar.
        config: { anticipacion_min_horas: 24, buffer_limpieza_min: 15, ventana_cancelacion_horas: 48, paso_slot_min: 30 },
        servicios: [
            { nombre: 'Valoración inicial', duracion_min: 30, precio: 60000, descripcion: 'Diagnóstico y plan de tratamiento.' },
            { nombre: 'Limpieza dental', duracion_min: 45, precio: 130000, descripcion: 'Profilaxis y control de placa.' },
        ],
        profesionales: [{ nombre: 'Dra. Paula Herrera', especialidad: 'Odontóloga' }],
        horario: { dias: L_A_V, bloques: [['08:00', '12:00'], ['13:00', '17:00']] },
    },
];

const CAPACIDADES = [
    'consultar_servicios',
    'consultar_profesionales',
    'consultar_disponibilidad',
    'proponer_turno',
    'reservar_turno',
    'reagendar_cita',
    'cancelar_cita',
];

async function unaFila(c, sql, params) {
    const r = await c.query(sql, params);
    return r.rows[0];
}

async function crearNegocio(c, def) {
    const existente = await unaFila(c, 'SELECT id_negocio FROM general.gener_negocio WHERE nombre = $1', [def.nombre]);

    let id;
    let creado = false;
    if (existente) {
        id = existente.id_negocio;
    } else {
        const fila = await unaFila(
            c,
            `INSERT INTO general.gener_negocio
                 (nombre, nit, email_contacto, telefono, estado, fecha_registro,
                  id_tipo_negocio, direccion, permite_multipago)
             VALUES ($1, $2, $3, $4, 'A', now(), $5, $6, false)
             RETURNING id_negocio`,
            [def.nombre, null, def.email, def.telefono, def.tipo, def.direccion]
        );
        id = fila.id_negocio;
        creado = true;
    }

    const cfg = def.config;
    await c.query(
        `INSERT INTO reserva.reserva_config
             (id_negocio, anticipacion_min_horas, buffer_limpieza_min, ventana_cancelacion_horas,
              paso_slot_min, cobro_adelantado)
         VALUES ($1, $2, $3, $4, $5, false)
         ON CONFLICT (id_negocio) DO UPDATE SET
             anticipacion_min_horas = EXCLUDED.anticipacion_min_horas,
             buffer_limpieza_min = EXCLUDED.buffer_limpieza_min,
             ventana_cancelacion_horas = EXCLUDED.ventana_cancelacion_horas,
             paso_slot_min = EXCLUDED.paso_slot_min`,
        [id, cfg.anticipacion_min_horas, cfg.buffer_limpieza_min, cfg.ventana_cancelacion_horas, cfg.paso_slot_min]
    );

    const idsServicio = [];
    for (const s of def.servicios) {
        let fila = await unaFila(
            c,
            'SELECT id_servicio FROM reserva.reserva_servicio WHERE id_negocio = $1 AND nombre = $2',
            [id, s.nombre]
        );
        if (!fila) {
            fila = await unaFila(
                c,
                `INSERT INTO reserva.reserva_servicio
                     (id_negocio, nombre, descripcion, duracion_min, precio, estado, fecha_creacion)
                 VALUES ($1, $2, $3, $4, $5, 'A', now())
                 RETURNING id_servicio`,
                [id, s.nombre, s.descripcion, s.duracion_min, s.precio]
            );
        }
        idsServicio.push(fila.id_servicio);
    }

    const idsProfesional = [];
    for (const p of def.profesionales) {
        let fila = await unaFila(
            c,
            'SELECT id_profesional FROM reserva.reserva_profesional WHERE id_negocio = $1 AND nombre = $2',
            [id, p.nombre]
        );
        if (!fila) {
            fila = await unaFila(
                c,
                `INSERT INTO reserva.reserva_profesional
                     (id_negocio, nombre, especialidad, estado, fecha_creacion)
                 VALUES ($1, $2, $3, 'A', now())
                 RETURNING id_profesional`,
                [id, p.nombre, p.especialidad]
            );
        }
        idsProfesional.push(fila.id_profesional);
    }

    // Todos atienden todo: un catálogo por profesional es realista pero convierte cada prueba
    // en un rompecabezas de por qué no hay horas.
    for (const idProf of idsProfesional) {
        for (const idServ of idsServicio) {
            await c.query(
                `INSERT INTO reserva.reserva_profesional_servicio (id_profesional, id_servicio)
                 VALUES ($1, $2) ON CONFLICT DO NOTHING`,
                [idProf, idServ]
            );
        }
    }

    let horarios = 0;
    for (const idProf of idsProfesional) {
        for (const dia of def.horario.dias) {
            for (const [desde, hasta] of def.horario.bloques) {
                const ya = await unaFila(
                    c,
                    `SELECT 1 FROM reserva.reserva_horario
                      WHERE id_profesional = $1 AND dia_semana = $2 AND hora_inicio = $3`,
                    [idProf, dia, desde]
                );
                if (!ya) {
                    await c.query(
                        `INSERT INTO reserva.reserva_horario
                             (id_negocio, id_profesional, dia_semana, hora_inicio, hora_fin)
                         VALUES ($1, $2, $3, $4, $5)`,
                        [id, idProf, dia, desde, hasta]
                    );
                    horarios += 1;
                }
            }
        }
    }

    // Sin fila en `capacidad_habilitada` el Policy Gate deniega TODO: un negocio de ejemplo sin
    // esto se ve bien en la base y el asistente no le contesta nada.
    for (const cap of CAPACIDADES) {
        await c.query(
            // `habilitada_por` es un id de usuario y va NULL: lo habilitó un fixture, no una
            // persona, y meter un id inventado ensucia la auditoría de quién concede qué.
            `INSERT INTO platform.capacidad_habilitada (id_negocio, capacidad, habilitada, habilitada_en, habilitada_por)
             VALUES ($1, $2, true, now(), NULL)
             ON CONFLICT (id_negocio, capacidad) DO UPDATE SET habilitada = true`,
            [id, cap]
        );
    }

    return { id, nombre: def.nombre, creado, servicios: idsServicio.length, profesionales: idsProfesional.length, horarios };
}

(async () => {
    const cliente = new Client({
        host: process.env.DB_HOST,
        port: Number(process.env.DB_PORT),
        database: process.env.DB_NAME,
        user: process.env.DB_USER,
        password: process.env.DB_PASS,
        ssl: process.env.DB_SSL === 'true',
    });

    await cliente.connect();
    console.log(`Base: ${process.env.DB_NAME} en ${process.env.DB_HOST}:${process.env.DB_PORT}\n`);

    try {
        await cliente.query('BEGIN');
        const resultados = [];
        for (const def of NEGOCIOS) resultados.push(await crearNegocio(cliente, def));
        await cliente.query('COMMIT');

        for (const r of resultados) {
            console.log(
                `  ${r.creado ? '✓ creado ' : '· ya estaba'}  negocio ${String(r.id).padStart(2)} — ${r.nombre}` +
                    `  (${r.servicios} servicios, ${r.profesionales} profesional(es), +${r.horarios} horarios)`
            );
        }
        console.log('\nPruébalos cambiando el campo "negocio" del widget:');
        console.log('  http://localhost:3000/intelligence/webchat/');
    } catch (error) {
        await cliente.query('ROLLBACK');
        console.error('Nada se escribió:', error.message);
        process.exitCode = 1;
    } finally {
        await cliente.end();
    }
})();
