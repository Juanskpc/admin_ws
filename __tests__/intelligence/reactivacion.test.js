/**
 * Reactivación del asistente tras la intervención de una persona — ADR-023, Enmienda 2.
 *
 * ## Qué se está probando de verdad
 *
 * La Enmienda 2 abre una puerta que la Enmienda 1 mantenía cerrada: que el bot vuelva SIN un clic.
 * Las pruebas no miran que «vuelva»; miran las **salvaguardas**, que son lo que la hace aceptable:
 *
 *   1. No vuelve ANTES del plazo, ni con «nunca» (0, el valor de fábrica), ni si nadie intervino.
 *   2. Vuelve cuando llega un mensaje del CLIENTE pasado el plazo —y solo entonces: la regla es
 *      perezosa, no hay temporizador—, y lo deja escrito.
 *   3. El plazo cuenta desde la ÚLTIMA intervención humana: cada respuesta suya lo reinicia.
 *   4. Quien no es administrador de ESE negocio no puede cambiarla.
 *   5. Los recordatorios (que también asegurarían la conversación) NO la reactivan.
 *
 * El reloj se controla escribiendo `humano_ultimo_en` en el pasado, como `bandeja.test.js` hace con
 * la ventana de 24 h: hay que **fijar** el instante, no esperarlo.
 *
 * ⚠️ Contra la base LOCAL (DB_PORT=5432).
 */
'use strict';
require('dotenv').config();

const Models = require('../../app_core/models/conection');
const repositorio = require('../../intelligence/engine/repositorio');
const motor = require('../../intelligence/engine/motor');
const Bandeja = require('../../app_admin_api/controllers/intelligenceBandejaController');

const sequelize = Models.sequelize;
const SELECT = { type: sequelize.QueryTypes.SELECT, logging: false };
const consulta = (sql, r = {}) => sequelize.query(sql, { replacements: r, ...SELECT });
const unaFila = async (sql, r = {}) => (await consulta(sql, r))[0] ?? null;

const CANAL = 'whatsapp';
const CORRIDA = String(Date.now()).slice(-7);
let contador = 0;

let negocioA;
let negocioB;
let adminA;
let adminB;
const originales = new Map();

function resFalso() {
    const capturado = { statusCode: 200, cuerpo: null };
    return {
        capturado,
        status(code) {
            capturado.statusCode = code;
            return this;
        },
        json(payload) {
            capturado.cuerpo = payload;
            return this;
        },
    };
}

async function llamar(controlador, { idUsuario, query = {}, params = {}, body = {} } = {}) {
    const res = resFalso();
    await controlador({ query, params, body, usuario: { id_usuario: idUsuario } }, res);
    return res.capturado;
}

async function fijarMinutos(idNegocio, minutos) {
    await sequelize.query(
        `UPDATE general.gener_negocio SET reactivar_asistente_min = :minutos WHERE id_negocio = :idNegocio;`,
        { replacements: { idNegocio, minutos }, logging: false }
    );
}

/**
 * Una conversación en manos de una persona.
 *
 * `haceMin` = hace cuántos minutos intervino por última vez una persona (`null` = nadie: el bot
 * escaló y nadie ha hecho nada). Lleva un entrante reciente para que la ventana de 24 h esté
 * abierta y se pueda responder desde la Bandeja.
 */
async function enHandoff({ idNegocio, haceMin }) {
    const idExterno = `573${CORRIDA}${String(contador++).padStart(2, '0')}`;
    const t = await sequelize.transaction();
    let conversacion;
    try {
        conversacion = await repositorio.asegurarConversacion(
            { idNegocio, canal: CANAL, idExterno },
            { transaction: t }
        );
        await t.commit();
    } catch (error) {
        await t.rollback();
        throw error;
    }

    await sequelize.query(
        `
        INSERT INTO intelligence.mensaje
            (id_conversacion, id_negocio, direccion, canal, contenido, enviado_en, creado_en)
        VALUES (:id, :idNegocio, 'entrante', :canal, 'necesito una persona', now(), now());
        `,
        { replacements: { id: conversacion.id_conversacion, idNegocio, canal: CANAL }, logging: false }
    );
    await sequelize.query(
        `UPDATE intelligence.conversacion
            SET estado = 'handoff_humano',
                humano_ultimo_en = CASE WHEN :haceMin::int IS NULL THEN NULL
                                        ELSE now() - (:haceMin::int * interval '1 minute') END
          WHERE id_conversacion = :id;`,
        { replacements: { id: conversacion.id_conversacion, haceMin }, logging: false }
    );
    return { ...conversacion, idExterno };
}

/** Lo que hace el motor cuando entra un mensaje del cliente. */
async function llegaMensajeDelCliente(idNegocio, idExterno, opciones = { reactivarPorPlazo: true }) {
    const t = await sequelize.transaction();
    try {
        const c = await repositorio.asegurarConversacion(
            { idNegocio, canal: CANAL, idExterno },
            { transaction: t, ...opciones }
        );
        await t.commit();
        return c;
    } catch (error) {
        await t.rollback();
        throw error;
    }
}

const estadoDe = async (id) =>
    (await unaFila(`SELECT estado FROM intelligence.conversacion WHERE id_conversacion = :id;`, { id })).estado;

beforeAll(async () => {
    // Un administrador propio por negocio (que solo pertenezca a ese negocio): la frontera del 403.
    const admins = await consulta(
        `
        SELECT ur.id_negocio, ur.id_usuario
          FROM general.gener_usuario_rol ur
          JOIN general.gener_rol r ON r.id_rol = ur.id_rol AND r.estado = 'A'
          JOIN general.gener_negocio n ON n.id_negocio = ur.id_negocio AND n.estado = 'A'
         WHERE ur.estado = 'A'
           AND UPPER(TRIM(r.descripcion)) = 'ADMINISTRADOR'
           AND (SELECT count(DISTINCT ur2.id_negocio) FROM general.gener_usuario_rol ur2
                 WHERE ur2.id_usuario = ur.id_usuario AND ur2.estado = 'A') = 1
           AND NOT EXISTS (
               SELECT 1 FROM general.gener_usuario_rol s
                 JOIN general.gener_rol rs ON rs.id_rol = s.id_rol
                WHERE s.id_usuario = ur.id_usuario AND s.estado = 'A'
                  AND UPPER(TRIM(rs.descripcion)) = 'SUPER ADMINISTRADOR')
         ORDER BY ur.id_negocio;
        `
    );
    for (const a of admins) {
        if (negocioA == null) {
            negocioA = a.id_negocio;
            adminA = a.id_usuario;
        } else if (a.id_negocio !== negocioA) {
            negocioB = a.id_negocio;
            adminB = a.id_usuario;
            break;
        }
    }
    if (negocioB == null) {
        throw new Error(
            'Hacen falta dos negocios, cada uno con su propio administrador. Corre scripts/seed_dev_local.js.'
        );
    }

    for (const id of [negocioA, negocioB]) {
        const f = await unaFila(
            `SELECT reactivar_asistente_min AS m FROM general.gener_negocio WHERE id_negocio = :id;`,
            { id }
        );
        originales.set(id, f.m);
    }
});

afterAll(async () => {
    for (const [id, m] of originales) await fijarMinutos(id, m);
    await sequelize.close();
});

describe('el valor de fábrica es «nunca»', () => {
    test('un negocio recién migrado tiene 0: nada cambia hasta que lo active', async () => {
        const columna = await unaFila(
            `SELECT column_default, is_nullable FROM information_schema.columns
              WHERE table_schema = 'general' AND table_name = 'gener_negocio'
                AND column_name = 'reactivar_asistente_min';`
        );
        expect(columna.column_default).toBe('0');
        expect(columna.is_nullable).toBe('NO');
    });
});

describe('no vuelve cuando no debe', () => {
    test('antes de cumplirse el plazo', async () => {
        await fijarMinutos(negocioA, 30);
        const c = await enHandoff({ idNegocio: negocioA, haceMin: 29 });

        const tras = await llegaMensajeDelCliente(negocioA, c.idExterno);

        expect(tras.estado).toBe('handoff_humano');
        expect(tras.reactivada_automaticamente).toBeUndefined();
        expect(await estadoDe(c.id_conversacion)).toBe('handoff_humano');
    });

    test('con «nunca» (0), pase el tiempo que pase', async () => {
        await fijarMinutos(negocioA, 0);
        const c = await enHandoff({ idNegocio: negocioA, haceMin: 60 * 24 * 30 });

        const tras = await llegaMensajeDelCliente(negocioA, c.idExterno);

        expect(tras.estado).toBe('handoff_humano');
        expect(await estadoDe(c.id_conversacion)).toBe('handoff_humano');
    });

    test('si NADIE intervino (el asistente escaló y no hay reloj), no vuelve solo', async () => {
        await fijarMinutos(negocioA, 1);
        const c = await enHandoff({ idNegocio: negocioA, haceMin: null });

        const tras = await llegaMensajeDelCliente(negocioA, c.idExterno);

        expect(tras.estado).toBe('handoff_humano');
    });

    test('los recordatorios y avisos (sin la opción) nunca la reactivan', async () => {
        await fijarMinutos(negocioA, 5);
        const c = await enHandoff({ idNegocio: negocioA, haceMin: 600 });

        // Es la llamada que hacen `recordatorios/index.js` y los avisos: no pasan la opción.
        const tras = await llegaMensajeDelCliente(negocioA, c.idExterno, {});

        expect(tras.estado).toBe('handoff_humano');
        expect(await estadoDe(c.id_conversacion)).toBe('handoff_humano');
    });

    test('una conversación bloqueada no se toca', async () => {
        await fijarMinutos(negocioA, 5);
        const c = await enHandoff({ idNegocio: negocioA, haceMin: 600 });
        await sequelize.query(
            `UPDATE intelligence.conversacion SET estado = 'bloqueada', bloqueada_por = 'negocio'
              WHERE id_conversacion = :id;`,
            { replacements: { id: c.id_conversacion }, logging: false }
        );

        const tras = await llegaMensajeDelCliente(negocioA, c.idExterno);

        expect(tras.estado).toBe('bloqueada');
    });
});

describe('vuelve cuando el cliente escribe pasado el plazo', () => {
    test('a los X minutos, al llegar su mensaje, y lo deja escrito', async () => {
        await fijarMinutos(negocioA, 30);
        const c = await enHandoff({ idNegocio: negocioA, haceMin: 31 });

        const tras = await llegaMensajeDelCliente(negocioA, c.idExterno);

        expect(tras.estado).toBe('activa');
        expect(tras.reactivada_automaticamente).toBe(true);
        expect(await estadoDe(c.id_conversacion)).toBe('activa');

        const evento = await unaFila(
            `SELECT detalle, id_usuario, id_negocio FROM auditoria.audit_evento
              WHERE modulo = 'intelligence' AND accion = 'asistente_retomo_automatico'
                AND detalle ->> 'id_conversacion' = :id;`,
            { id: c.id_conversacion }
        );
        expect(evento).not.toBeNull();
        expect(evento.id_usuario).toBeNull(); // nadie lo decidió en ese instante: fue el plazo
        expect(evento.id_negocio).toBe(negocioA);
        expect(evento.detalle.origen).toBe('automatico');
        expect(evento.detalle.minutos).toBe(30);
    });

    test('lo hace el MOTOR al recibir un mensaje del cliente (no solo el repositorio)', async () => {
        await fijarMinutos(negocioA, 30);
        const c = await enHandoff({ idNegocio: negocioA, haceMin: 45 });

        // `despertar: false` guarda el mensaje sin procesarlo: se prueba la ingesta, no el LLM.
        await motor.recibir({
            canal: CANAL,
            idNegocio: negocioA,
            idExterno: c.idExterno,
            texto: 'ya estoy de vuelta',
            idExternoMensaje: `wamid.react.${CORRIDA}.${contador++}`,
            despertar: false,
        });

        expect(await estadoDe(c.id_conversacion)).toBe('activa');
    });

    test('una reentrega DUPLICADA del canal no reactiva nada', async () => {
        await fijarMinutos(negocioA, 30);
        const c = await enHandoff({ idNegocio: negocioA, haceMin: 45 });
        const wamid = `wamid.dup.${CORRIDA}.${contador++}`;

        // La primera reentrega ya la habría reactivado; se simula que ya se procesó y luego se
        // vuelve a poner en manos de una persona: la duplicada no debe volver a levantarla.
        await sequelize.query(
            `INSERT INTO intelligence.ingesta_recibida (id_negocio, canal, id_externo, id_mensaje)
             VALUES (:n, :canal, :wamid, platform.uuid_generate_v7());`,
            { replacements: { n: negocioA, canal: CANAL, wamid }, logging: false }
        );

        await motor.recibir({
            canal: CANAL,
            idNegocio: negocioA,
            idExterno: c.idExterno,
            texto: 'hola otra vez',
            idExternoMensaje: wamid,
            despertar: false,
        });

        expect(await estadoDe(c.id_conversacion)).toBe('handoff_humano');
    });
});

describe('el plazo se reinicia con cada intervención humana', () => {
    test('responder desde la Bandeja reinicia el reloj', async () => {
        await fijarMinutos(negocioA, 30);
        // Habría vuelto (40 > 30)…
        const c = await enHandoff({ idNegocio: negocioA, haceMin: 40 });

        // …pero el administrador escribe ahora.
        const r = await llamar(Bandeja.responder, {
            idUsuario: adminA,
            params: { id: c.id_conversacion },
            body: { texto: 'Ya te ayudo' },
        });
        expect(r.statusCode).toBe(200);

        const fila = await unaFila(
            `SELECT extract(epoch FROM (now() - humano_ultimo_en)) AS seg
               FROM intelligence.conversacion WHERE id_conversacion = :id;`,
            { id: c.id_conversacion }
        );
        expect(Number(fila.seg)).toBeLessThan(15);

        const tras = await llegaMensajeDelCliente(negocioA, c.idExterno);
        expect(tras.estado).toBe('handoff_humano');
    });

    test('marcarla atendida (sin escribir) también cuenta como intervención', async () => {
        await fijarMinutos(negocioA, 30);
        const c = await enHandoff({ idNegocio: negocioA, haceMin: 40 });

        const r = await llamar(Bandeja.atender, { idUsuario: adminA, params: { id: c.id_conversacion } });
        expect(r.statusCode).toBe(200);

        const tras = await llegaMensajeDelCliente(negocioA, c.idExterno);
        expect(tras.estado).toBe('handoff_humano');
    });

    test('el dueño escribiendo desde su propio WhatsApp también reinicia el reloj', async () => {
        await fijarMinutos(negocioA, 30);
        const c = await enHandoff({ idNegocio: negocioA, haceMin: 40 });

        await repositorio.marcarIntervencionHumana(c.id_conversacion);

        const tras = await llegaMensajeDelCliente(negocioA, c.idExterno);
        expect(tras.estado).toBe('handoff_humano');
    });
});

describe('la configuración es del negocio, y solo su administrador la cambia', () => {
    test('el administrador de ESE negocio la guarda, y queda auditado', async () => {
        await fijarMinutos(negocioA, 0);

        const r = await llamar(Bandeja.guardarConfiguracion, {
            idUsuario: adminA,
            body: { id_negocio: negocioA, reactivar_asistente_min: 45 },
        });

        expect(r.statusCode).toBe(200);
        expect((await unaFila(
            `SELECT reactivar_asistente_min AS m FROM general.gener_negocio WHERE id_negocio = :id;`,
            { id: negocioA }
        )).m).toBe(45);

        const evento = await unaFila(
            `SELECT detalle FROM auditoria.audit_evento
              WHERE modulo = 'intelligence' AND accion = 'reactivacion_asistente_configurada'
                AND id_negocio = :id ORDER BY fecha DESC LIMIT 1;`,
            { id: negocioA }
        );
        expect(evento.detalle.minutos_antes).toBe(0);
        expect(evento.detalle.minutos_despues).toBe(45);
    });

    test('el administrador de OTRO negocio recibe 403 y no cambia nada', async () => {
        await fijarMinutos(negocioA, 0);

        const r = await llamar(Bandeja.guardarConfiguracion, {
            idUsuario: adminB,
            body: { id_negocio: negocioA, reactivar_asistente_min: 30 },
        });

        expect(r.statusCode).toBe(403);
        expect((await unaFila(
            `SELECT reactivar_asistente_min AS m FROM general.gener_negocio WHERE id_negocio = :id;`,
            { id: negocioA }
        )).m).toBe(0);
    });

    test('leer la configuración de un negocio ajeno responde 404', async () => {
        const r = await llamar(Bandeja.leerConfiguracion, {
            idUsuario: adminB,
            query: { id_negocio: String(negocioA) },
        });
        expect(r.statusCode).toBe(404);
    });

    test('el administrador la lee y sabe que puede editarla', async () => {
        await fijarMinutos(negocioA, 15);
        const r = await llamar(Bandeja.leerConfiguracion, {
            idUsuario: adminA,
            query: { id_negocio: String(negocioA) },
        });
        expect(r.cuerpo.data.reactivar_asistente_min).toBe(15);
        expect(r.cuerpo.data.puede_editar).toBe(true);
    });
});

describe('el hilo cuenta que el asistente retomó', () => {
    test('el detalle incluye la reactivación automática, con su origen', async () => {
        await fijarMinutos(negocioA, 30);
        const c = await enHandoff({ idNegocio: negocioA, haceMin: 31 });
        await llegaMensajeDelCliente(negocioA, c.idExterno);

        const r = await llamar(Bandeja.detalleConversacion, {
            idUsuario: adminA,
            params: { id: c.id_conversacion },
        });

        expect(r.cuerpo.data.retomadas).toHaveLength(1);
        expect(r.cuerpo.data.retomadas[0].origen).toBe('automatico');
        expect(r.cuerpo.data.conversacion.reactivar_asistente_min).toBe(30);
    });

    test('devolverla a mano se cuenta como «manual» y con quién', async () => {
        await fijarMinutos(negocioA, 0);
        const c = await enHandoff({ idNegocio: negocioA, haceMin: 5 });

        const dev = await llamar(Bandeja.devolverAlAsistente, {
            idUsuario: adminA,
            params: { id: c.id_conversacion },
        });
        expect(dev.statusCode).toBe(200);

        const r = await llamar(Bandeja.detalleConversacion, {
            idUsuario: adminA,
            params: { id: c.id_conversacion },
        });
        expect(r.cuerpo.data.retomadas).toHaveLength(1);
        expect(r.cuerpo.data.retomadas[0].origen).toBe('manual');
    });
});
