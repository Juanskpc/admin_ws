'use strict';
/**
 * Los siete oficios de `reserva`, poblados para poder probar el asistente en cada uno.
 *
 *   node scripts/fixtures/dev_reserva_oficios.js
 *
 * ## Por qué hace falta
 *
 * `verificar_perfiles_reserva.js` ya crea un negocio por oficio, pero los deja **vacíos**: sin
 * servicios, sin profesionales y sin horarios. Sirven para comprobar que el perfil resuelve, no
 * para hablar con el bot. Y sin hablar con el bot no se ve lo que de verdad importa —que en una
 * peluquería canina pregunta por la mascota, que en un tatuador no promete precio—, que es justo
 * donde estaban los fallos.
 *
 * ## Lo que NO hace, y es deliberado
 *
 * **No toca producción ni ningún negocio real.** Aborta si la base no se llama `escalapp_dev`, y
 * además solo escribe en los siete negocios «Prueba …» que crea el verificador de perfiles: si
 * alguno no existe, lo salta en vez de crear uno nuevo con ese nombre en otra base.
 *
 * Idempotente: cada servicio, profesional y horario se busca por nombre antes de insertarse, así
 * que correrlo diez veces deja lo mismo que correrlo una.
 *
 * ## Los datos están elegidos para que el bot se luzca o se rompa
 *
 * No son datos de relleno. Cada oficio trae **exactamente** lo que activa su camino propio:
 * el salón y la peluquería canina traen variantes (que cambian precio y duración), el tatuador
 * trae un servicio «a cotizar» junto a uno normal (para ver que distingue), la estética trae un
 * servicio con consentimiento. La barbería no trae nada especial a propósito: es la referencia.
 */
require('dotenv').config();
const { Client } = require('pg');

const TODOS_LOS_DIAS = [1, 2, 3, 4, 5, 6];
const JORNADA = [['08:00', '12:00'], ['13:00', '19:00']];

/** Tamaños de mascota — las mismas claves que `reserva_mascota.tamano`. */
const TAMANOS = [
    { nombre: 'Pequeño', clave: 'PEQUENO', duracion_min: 45, precio: 45000 },
    { nombre: 'Mediano', clave: 'MEDIANO', duracion_min: 60, precio: 60000 },
    { nombre: 'Grande', clave: 'GRANDE', duracion_min: 90, precio: 85000 },
    { nombre: 'Gigante', clave: 'GIGANTE', duracion_min: 120, precio: 110000 },
];

const LARGOS = [
    { nombre: 'Pelo corto', clave: null, duracion_min: 60, precio: 90000 },
    { nombre: 'Pelo medio', clave: null, duracion_min: 90, precio: 130000 },
    { nombre: 'Pelo largo', clave: null, duracion_min: 120, precio: 180000 },
];

const OFICIOS = [
    {
        negocio: 'Prueba Barbería',
        perfil: 'BASE',
        // La referencia: nada especial. Si aquí el bot cambia de comportamiento, algo se rompió.
        servicios: [
            { nombre: 'Corte de cabello', duracion_min: 30, precio: 25000 },
            { nombre: 'Barba', duracion_min: 20, precio: 15000 },
        ],
        profesionales: [{ nombre: 'Marco Ruiz', especialidad: 'Barbero' },
                        { nombre: 'Julián Pérez', especialidad: 'Barbero' }],
    },
    {
        negocio: 'Prueba Salón de Belleza',
        perfil: 'SALON',
        servicios: [
            // Con variantes: el precio de lista es el del caso más barato, y por eso el bot
            // tiene que decir «desde» y preguntar el largo antes de ofrecer horas.
            { nombre: 'Coloración', duracion_min: 60, precio: 90000, variantes: LARGOS,
              // Tiempo de proceso: la estilista queda libre mientras actúa el tinte.
              proceso_desde_min: 20, proceso_min: 30 },
            { nombre: 'Corte de dama', duracion_min: 45, precio: 45000 },
        ],
        profesionales: [{ nombre: 'Laura Gómez', especialidad: 'Colorimetría' },
                        { nombre: 'Sofía Díaz', especialidad: 'Estilista' }],
    },
    {
        negocio: 'Prueba Spa',
        perfil: 'SPA',
        servicios: [
            { nombre: 'Masaje relajante', duracion_min: 60, precio: 120000 },
            { nombre: 'Facial hidratante', duracion_min: 45, precio: 95000 },
        ],
        profesionales: [{ nombre: 'Carolina Ríos', especialidad: 'Terapeuta' },
                        { nombre: 'Andrés Mora', especialidad: 'Masajista' }],
    },
    {
        negocio: 'Prueba Centro de Estética',
        perfil: 'ESTETICA',
        servicios: [
            { nombre: 'Valoración', duracion_min: 20, precio: 0 },
            // Con consentimiento: el bot tiene que avisar «trae tu documento» al confirmar.
            { nombre: 'Depilación láser', duracion_min: 45, precio: 150000, requiere_consentimiento: true },
        ],
        profesionales: [{ nombre: 'Paula Herrera', especialidad: 'Especialista' }],
    },
    {
        negocio: 'Prueba Tatuajes',
        perfil: 'TATUAJE',
        servicios: [
            // Uno de cada tipo, a propósito: el bot debe agendar el primero y NO el segundo.
            { nombre: 'Valoración de diseño', duracion_min: 30, precio: 0 },
            { nombre: 'Tatuaje personalizado', duracion_min: 120, precio: 0, a_cotizar: true,
              requiere_consentimiento: true },
        ],
        profesionales: [{ nombre: 'Diego Silva', especialidad: 'Artista' }],
    },
    {
        negocio: 'Prueba Peluquería Canina',
        perfil: 'MASCOTAS',
        servicios: [
            // Variantes POR TAMAÑO: elegir la mascota debe elegir la variante sola.
            { nombre: 'Baño y secado', duracion_min: 45, precio: 45000, variantes: TAMANOS },
            { nombre: 'Corte de uñas', duracion_min: 15, precio: 20000 },
        ],
        profesionales: [{ nombre: 'Natalia Cruz', especialidad: 'Groomer' }],
        // Un cliente que ya vino, con su perro: el bot debe ofrecerle el perro como botón.
        clientes: [{ telefono: '+573001112233', nombre: 'Ana Pérez',
                     mascotas: [{ nombre: 'Firulais', especie: 'PERRO', raza: 'Labrador', tamano: 'GRANDE' }] }],
    },
    {
        negocio: 'Prueba Consultorio',
        perfil: 'BASE',
        // SIN HORARIO, a propósito. Es la reproducción del caso de producción del 2026-09-28: un
        // negocio con servicio y profesional pero sin horas configuradas. El bot tiene que decir
        // la verdad y avisar al negocio, no proponer días vacíos uno detrás de otro.
        sinHorario: true,
        servicios: [{ nombre: 'Consulta general', duracion_min: 30, precio: 60000 }],
        profesionales: [{ nombre: 'Dra. Paula Rivas', especialidad: 'Medicina general' }],
    },
    {
        negocio: 'Prueba Hotel',
        perfil: 'ALOJAMIENTO',
        // Sin servicios ni profesionales: un alojamiento no agenda citas. Su flujo es otro.
        servicios: [],
        profesionales: [],
    },
];

const CAPACIDADES = [
    'consultar_servicios', 'consultar_profesionales', 'consultar_disponibilidad',
    'consultar_mis_mascotas', 'consultar_dias_con_horas', 'proponer_turno', 'reservar_turno', 'reagendar_cita', 'cancelar_cita',
];

async function unaFila(c, sql, params) {
    const r = await c.query(sql, params);
    return r.rows[0] || null;
}

async function poblar(c, def) {
    const negocio = await unaFila(
        c, 'SELECT id_negocio FROM general.gener_negocio WHERE nombre = $1', [def.negocio],
    );
    if (!negocio) {
        console.log(`  · ${def.negocio}: no existe en esta base — se salta`);
        return;
    }
    const id = negocio.id_negocio;

    // La configuración la crea el perfil; aquí solo se garantiza que exista, porque el adaptador
    // exige fila de config antes de apartar nada (`RESERVA_SIN_CONFIGURAR`).
    await c.query(
        `INSERT INTO reserva.reserva_config (id_negocio) VALUES ($1) ON CONFLICT DO NOTHING`, [id],
    );

    const idsServicio = [];
    for (const s of def.servicios) {
        let fila = await unaFila(
            c, 'SELECT id_servicio FROM reserva.reserva_servicio WHERE id_negocio = $1 AND nombre = $2',
            [id, s.nombre],
        );
        if (!fila) {
            fila = await unaFila(
                c,
                `INSERT INTO reserva.reserva_servicio
                     (id_negocio, nombre, duracion_min, precio, estado, fecha_creacion,
                      a_cotizar, requiere_consentimiento, proceso_desde_min, proceso_min)
                 VALUES ($1,$2,$3,$4,'A',now(),$5,$6,$7,$8) RETURNING id_servicio`,
                [id, s.nombre, s.duracion_min, s.precio, Boolean(s.a_cotizar),
                 Boolean(s.requiere_consentimiento), s.proceso_desde_min || 0, s.proceso_min || 0],
            );
        }
        idsServicio.push(fila.id_servicio);

        for (const [i, v] of (s.variantes || []).entries()) {
            const ya = await unaFila(
                c, 'SELECT 1 FROM reserva.reserva_servicio_variante WHERE id_servicio = $1 AND nombre = $2',
                [fila.id_servicio, v.nombre],
            );
            if (!ya) {
                await c.query(
                    `INSERT INTO reserva.reserva_servicio_variante
                         (id_servicio, id_negocio, nombre, clave, duracion_min, precio, orden, estado)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,'A')`,
                    [fila.id_servicio, id, v.nombre, v.clave, v.duracion_min, v.precio, i],
                );
            }
        }
    }

    const idsProfesional = [];
    for (const p of def.profesionales) {
        let fila = await unaFila(
            c, 'SELECT id_profesional FROM reserva.reserva_profesional WHERE id_negocio = $1 AND nombre = $2',
            [id, p.nombre],
        );
        if (!fila) {
            fila = await unaFila(
                c,
                `INSERT INTO reserva.reserva_profesional (id_negocio, nombre, especialidad, estado, fecha_creacion)
                 VALUES ($1,$2,$3,'A',now()) RETURNING id_profesional`,
                [id, p.nombre, p.especialidad],
            );
        }
        idsProfesional.push(fila.id_profesional);
    }

    for (const idProf of idsProfesional) {
        for (const idServ of idsServicio) {
            await c.query(
                `INSERT INTO reserva.reserva_profesional_servicio (id_profesional, id_servicio)
                 VALUES ($1,$2) ON CONFLICT DO NOTHING`, [idProf, idServ],
            );
        }
        for (const dia of def.sinHorario ? [] : TODOS_LOS_DIAS) {
            for (const [desde, hasta] of JORNADA) {
                const ya = await unaFila(
                    c, `SELECT 1 FROM reserva.reserva_horario
                         WHERE id_profesional = $1 AND dia_semana = $2 AND hora_inicio = $3`,
                    [idProf, dia, desde],
                );
                if (!ya) {
                    await c.query(
                        `INSERT INTO reserva.reserva_horario
                             (id_negocio, id_profesional, dia_semana, hora_inicio, hora_fin)
                         VALUES ($1,$2,$3,$4,$5)`,
                        [id, idProf, dia, desde, hasta],
                    );
                }
            }
        }
    }

    // Clientes con mascota, para el oficio que las atiende.
    for (const cli of def.clientes || []) {
        let persona = await unaFila(
            c, `SELECT id_persona_negocio FROM platform.persona_negocio
                 WHERE id_negocio = $1 AND telefono_e164 = $2`, [id, cli.telefono],
        );
        if (!persona) {
            persona = await unaFila(
                c, `INSERT INTO platform.persona_negocio (id_negocio, telefono_e164, nombre_mostrado)
                    VALUES ($1,$2,$3) RETURNING id_persona_negocio`,
                [id, cli.telefono, cli.nombre],
            );
        }
        for (const m of cli.mascotas || []) {
            const ya = await unaFila(
                c, `SELECT 1 FROM reserva.reserva_mascota
                     WHERE id_negocio = $1 AND id_persona_negocio = $2 AND nombre = $3`,
                [id, persona.id_persona_negocio, m.nombre],
            );
            if (!ya) {
                await c.query(
                    `INSERT INTO reserva.reserva_mascota
                         (id_negocio, id_persona_negocio, nombre, especie, raza, tamano, estado)
                     VALUES ($1,$2,$3,$4,$5,$6,'A')`,
                    [id, persona.id_persona_negocio, m.nombre, m.especie, m.raza, m.tamano],
                );
            }
        }
    }

    // Sin fila en `capacidad_habilitada` el Policy Gate deniega TODO.
    for (const cap of CAPACIDADES) {
        await c.query(
            `INSERT INTO platform.capacidad_habilitada (id_negocio, capacidad, habilitada, habilitada_en, habilitada_por)
             VALUES ($1,$2,true,now(),NULL)
             ON CONFLICT (id_negocio, capacidad) DO UPDATE SET habilitada = true`,
            [id, cap],
        );
    }

    console.log(
        `  ✓ ${id}\t${def.negocio} (${def.perfil}): ` +
        `${idsServicio.length} servicios, ${idsProfesional.length} profesionales`,
    );
}

async function main() {
    const { DB_NAME, DB_PORT, DB_HOST, DB_USER, DB_PASS } = process.env;
    console.log(`\nBase: ${DB_HOST}:${DB_PORT}/${DB_NAME}`);
    if (DB_NAME !== 'escalapp_dev') {
        throw new Error('Se niega a correr: la base no es escalapp_dev.');
    }

    const c = new Client({
        host: DB_HOST, port: Number(DB_PORT), database: DB_NAME, user: DB_USER, password: DB_PASS,
    });
    await c.connect();
    try {
        await c.query('BEGIN');
        console.log('\n=== Oficios de reserva para probar el asistente ===\n');
        for (const def of OFICIOS) await poblar(c, def);
        await c.query('COMMIT');
        console.log('\n✓ Listo.\n');
    } catch (err) {
        await c.query('ROLLBACK');
        throw err;
    } finally {
        await c.end();
    }
}

main().catch((e) => { console.error('\n✗', e.message, '\n'); process.exitCode = 1; });
