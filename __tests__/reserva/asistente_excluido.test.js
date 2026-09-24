/**
 * El usuario asistente del bot (`ASISTENTE-<id_negocio>`) es un actor de auditoría y el autor de
 * los pedidos del bot, NO una persona del equipo. Estas pruebas fijan lo que no da error cuando
 * se rompe:
 *
 *   - no sale en el listado de usuarios del negocio (reserva ni admin),
 *   - no ocupa un sitio del plan (`contarUsuarios`),
 *   - el bot de reserva (`cancelarPorCliente` con transacción) deja al asistente como actor de
 *     `auditoria.audit_dato`,
 *   - y una única función lo reconoce (`esUsuarioAsistente`): nadie repite el prefijo.
 *
 * Corre contra la base de verdad y necesita un negocio de reserva con servicio y profesional.
 */
'use strict';

require('dotenv').config();

const Models = require('../../app_core/models/conection');
const usuarioAsistenteDao = require('../../app_core/dao/usuarioAsistenteDao');
const usuarioAdminDao = require('../../app_core/dao/usuarioAdminDao');
const cupoUsuarios = require('../../app_core/helpers/cupoUsuarios');
const usuarioService = require('../../app_reserva_api/services/usuarioService');
const citaService = require('../../app_reserva_api/services/citaService');

const sequelize = Models.sequelize;

let idNegocio;
let idServicio;
let idProfesional;
const citas = [];

async function unaFila(sql, replacements = {}) {
    const filas = await sequelize.query(sql, { replacements, type: sequelize.QueryTypes.SELECT });
    return filas[0] ?? null;
}

beforeAll(async () => {
    const s = await unaFila(
        `SELECT s.id_negocio, s.id_servicio, (SELECT p.id_profesional FROM reserva.reserva_profesional p
                                              WHERE p.id_negocio = s.id_negocio LIMIT 1) AS id_profesional
           FROM reserva.reserva_servicio s
          WHERE s.estado = 'A' AND EXISTS (SELECT 1 FROM reserva.reserva_profesional p WHERE p.id_negocio = s.id_negocio)
          ORDER BY s.id_servicio DESC LIMIT 1;`,
    );
    ({ id_negocio: idNegocio, id_servicio: idServicio, id_profesional: idProfesional } = s);
});

afterAll(async () => {
    for (const id of citas) {
        await sequelize.query('DELETE FROM reserva.reserva_cita WHERE id_cita = :c', { replacements: { c: id } });
    }
    await sequelize.close();
});

describe('esUsuarioAsistente: una sola fuente', () => {
    it('reconoce el número o la fila, y solo ese prefijo', () => {
        expect(usuarioAsistenteDao.esUsuarioAsistente(usuarioAsistenteDao.identificacionDe(7))).toBe(true);
        expect(usuarioAsistenteDao.esUsuarioAsistente({ num_identificacion: 'ASISTENTE-12' })).toBe(true);
        expect(usuarioAsistenteDao.esUsuarioAsistente({ num_identificacion: '1000000002' })).toBe(false);
        expect(usuarioAsistenteDao.esUsuarioAsistente(null)).toBe(false);
    });
});

describe('no es una persona del equipo', () => {
    let idAsistente;

    beforeAll(async () => {
        idAsistente = await usuarioAsistenteDao.resolverOCrear(idNegocio);
    });

    it('el asistente existe y está vinculado al negocio (el caso a proteger)', async () => {
        const v = await unaFila(
            `SELECT 1 AS ok FROM general.gener_negocio_usuario WHERE id_usuario = :u AND id_negocio = :n AND estado = 'A'`,
            { u: idAsistente, n: idNegocio },
        );
        expect(v).not.toBeNull();
    });

    it('no sale en el listado de usuarios de reserva', async () => {
        const lista = await usuarioService.listar({ idNegocio });
        expect(lista.some((u) => u.id_usuario === idAsistente)).toBe(false);
        const buscada = await usuarioService.listar({ idNegocio, search: 'Asistente' });
        expect(buscada.some((u) => u.id_usuario === idAsistente)).toBe(false);
    });

    it('no sale en el listado de usuarios del admin', async () => {
        // (Sin filtro de negocio: con él `planHelper` consulta `gener_plan.usuarios_incluidos`,
        // columna que a esta base local le falta por deriva de migraciones — no es de esta prueba.)
        const sin = await usuarioAdminDao.getUsuarios({ search: 'Asistente' });
        expect(sin.some((u) => u.id_usuario === idAsistente)).toBe(false);
        const porId = await usuarioAdminDao.getUsuarios({ search: usuarioAsistenteDao.identificacionDe(idNegocio) });
        expect(porId.some((u) => u.id_usuario === idAsistente)).toBe(false);
    });

    it('no ocupa un sitio del plan', async () => {
        const conAsistente = await cupoUsuarios.contarUsuarios(idNegocio);
        const cuentaSql = await unaFila(
            `SELECT COUNT(DISTINCT nu.id_usuario)::int AS n
               FROM general.gener_negocio_usuario nu
               JOIN general.gener_usuario u ON u.id_usuario = nu.id_usuario AND u.estado = 'A'
              WHERE nu.id_negocio = :n AND nu.estado = 'A'
                AND NOT EXISTS (SELECT 1 FROM general.gener_usuario_rol ur
                                 WHERE ur.id_usuario = u.id_usuario AND ur.id_negocio IS NULL AND ur.estado = 'A')`,
            { n: idNegocio },
        );
        // La cuenta «ingenua» (con el asistente) es exactamente una más que la del cupo.
        expect(cuentaSql.n).toBe(conAsistente + 1);
    });
});

describe('bot de reserva: el actor de auditoría es el asistente', () => {
    it('cancelarPorCliente dentro de una transacción deja id_usuario = asistente', async () => {
        // El código público lo genera la base (`fn_codigo_cita()`): uno inventado no pasa `CodigoCita.normalizar`.
        const [cita] = await sequelize.query(
            `INSERT INTO reserva.reserva_cita
                (id_negocio, id_profesional, fecha_hora_inicio, fecha_hora_fin, estado, cliente_nombre)
             VALUES (:n, :p, '2031-02-15 10:00:00', '2031-02-15 10:30:00', 'pendiente', 'TEST bot actor')
             RETURNING id_cita, codigo_publico;`,
            { replacements: { n: idNegocio, p: idProfesional }, type: sequelize.QueryTypes.SELECT },
        );
        citas.push(cita.id_cita);
        const idAsistente = await usuarioAsistenteDao.resolverOCrear(idNegocio);

        await sequelize.transaction(async (t) => {
            await citaService.cancelarPorCliente(cita.codigo_publico, 'test', { idNegocio, transaction: t });
        });

        const audit = await unaFila(
            `SELECT id_usuario FROM auditoria.audit_dato
              WHERE esquema = 'reserva' AND tabla = 'reserva_cita' AND operacion = 'U'
                AND pk_registro::text = :pk AND datos_despues->>'estado' = 'cancelada'
              ORDER BY id_audit DESC LIMIT 1;`,
            { pk: String(cita.id_cita) },
        );
        expect(audit?.id_usuario).toBe(idAsistente);
    });
});
