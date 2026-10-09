/**
 * Pausa de emergencia del asistente (2026-10-04: Zona Burger se quedó sin papas y pidió que el
 * bot dejara de contestar YA).
 *
 * Correr con:  npx jest __tests__/intelligence/pausa_asistente.test.js   (contra la base LOCAL)
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
let adminA;
let adminB;

async function llamar(controlador, { idUsuario, body = {}, query = {} }) {
    const capturado = { statusCode: 200, cuerpo: null };
    const res = {
        status(c) { capturado.statusCode = c; return this; },
        json(p) { capturado.cuerpo = p; return this; },
    };
    await controlador({ body, query, params: {}, usuario: { id_usuario: idUsuario } }, res);
    return capturado;
}

const llega = (idExterno, texto) =>
    motor.recibir({
        canal: CANAL,
        idNegocio: negocioA,
        idExterno,
        texto,
        idExternoMensaje: `wamid.pausa.${CORRIDA}.${contador++}`,
        despertar: false,
    });

beforeAll(async () => {
    const admins = await consulta(
        `
        SELECT ur.id_negocio, ur.id_usuario
          FROM general.gener_usuario_rol ur
          JOIN general.gener_rol r ON r.id_rol = ur.id_rol AND r.estado = 'A'
          JOIN general.gener_negocio n ON n.id_negocio = ur.id_negocio AND n.estado = 'A'
         WHERE ur.estado = 'A' AND UPPER(TRIM(r.descripcion)) = 'ADMINISTRADOR'
           AND (SELECT count(DISTINCT ur2.id_negocio) FROM general.gener_usuario_rol ur2
                 WHERE ur2.id_usuario = ur.id_usuario AND ur2.estado = 'A') = 1
           AND NOT EXISTS (
               SELECT 1 FROM general.gener_usuario_rol s
                 JOIN general.gener_rol rs ON rs.id_rol = s.id_rol
                WHERE s.id_usuario = ur.id_usuario AND s.estado = 'A'
                  AND UPPER(TRIM(rs.descripcion)) = 'SUPER ADMINISTRADOR')
         ORDER BY ur.id_negocio;`
    );
    for (const a of admins) {
        if (negocioA == null) { negocioA = a.id_negocio; adminA = a.id_usuario; }
        else if (a.id_negocio !== negocioA) { adminB = a.id_usuario; break; }
    }
    if (!adminB) throw new Error('Hacen falta dos negocios con su administrador. Corre scripts/seed_dev_local.js.');
});

afterAll(async () => {
    await sequelize.query(
        `UPDATE general.gener_negocio SET asistente_pausado = false, asistente_pausado_en = NULL WHERE id_negocio = :n;`,
        { replacements: { n: negocioA }, logging: false }
    );
    await sequelize.close();
});

describe('el interruptor', () => {
    test('el administrador de OTRO negocio no puede pausarlo', async () => {
        const r = await llamar(Bandeja.pausarAsistente, { idUsuario: adminB, body: { id_negocio: negocioA, pausado: true } });
        expect(r.statusCode).toBe(403);
    });

    test('el administrador lo pausa, se lee en la configuración y queda auditado', async () => {
        const r = await llamar(Bandeja.pausarAsistente, { idUsuario: adminA, body: { id_negocio: negocioA, pausado: true } });
        expect(r.statusCode).toBe(200);
        expect(r.cuerpo.data.asistente_pausado).toBe(true);
        expect(r.cuerpo.data.asistente_pausado_en).not.toBeNull();

        const conf = await llamar(Bandeja.leerConfiguracion, { idUsuario: adminA, query: { id_negocio: negocioA } });
        expect(conf.cuerpo.data.asistente_pausado).toBe(true);

        const evento = await unaFila(
            `SELECT accion FROM auditoria.audit_evento
              WHERE id_negocio = :n AND accion = 'asistente_pausado' ORDER BY 1 DESC LIMIT 1;`,
            { n: negocioA }
        );
        expect(evento).not.toBeNull();
    });
});

describe('con el asistente en pausa', () => {
    test('el mensaje se guarda SIN turno y la conversación pasa a «Esperan respuesta»', async () => {
        await sequelize.query(`UPDATE general.gener_negocio SET asistente_pausado = true WHERE id_negocio = :n;`, {
            replacements: { n: negocioA }, logging: false,
        });
        const idExterno = `573${CORRIDA}${String(contador++).padStart(2, '0')}`;
        const r = await llega(idExterno, 'quiero una salchipapa');
        expect(r.sin_turno_motivo).toBe('asistente_pausado');

        const c = await unaFila(
            `SELECT estado, atendida_en FROM intelligence.conversacion WHERE id_conversacion = :id;`,
            { id: r.id_conversacion }
        );
        expect(c.estado).toBe('handoff_humano');
        expect(c.atendida_en).toBeNull();
    });

    test('al reanudar, un mensaje nuevo SÍ abre turno (lo de la pausa no)', async () => {
        await llamar(Bandeja.pausarAsistente, { idUsuario: adminA, body: { id_negocio: negocioA, pausado: false } });
        expect(await repositorio.asistentePausado(negocioA)).toBe(false);
        const idExterno = `573${CORRIDA}${String(contador++).padStart(2, '0')}`;
        const r = await llega(idExterno, 'hola');
        expect(r.sin_turno_motivo).toBeNull();
    });
});
