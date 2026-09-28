/**
 * Auditoría de los pedidos que toma el asistente de WhatsApp (2026-09-29).
 *
 * Hasta ahora la línea de tiempo de Caja → Movimientos sabía quién TOMÓ un pedido (el usuario
 * asistente, por ser el autor de la orden) pero no quién lo CONFIRMÓ ni quién avisó que ya estaba
 * listo: esas dos acciones tocaban la orden sin fijar el actor de auditoría, así que
 * `auditoria.audit_dato` quedaba con `id_usuario = NULL` para esas filas y `seguimientoPedidoService`
 * no tenía de dónde leerlas.
 *
 * Esto cierra esa vuelta: `confirmarPedidoAsistente` y `avisoPedido.avisarListo` fijan el actor
 * ANTES del UPDATE, y `seguimientoPedidoService.listar` lee esas dos acciones de
 * `auditoria.audit_dato`, igual que ya leía «canceló sin cobrar».
 *
 * Corre contra la base de verdad y necesita `Restaurante Demo` con al menos dos administradores
 * (para probar que confirmar y avisar quedan a nombre de PERSONAS DISTINTAS, que es la mitad del
 * punto: una auditoría que junte a todo el mundo bajo el mismo nombre no audita nada).
 */
'use strict';

require('dotenv').config();
process.env.FEATURES_FORZADAS = 'asistente_ia';

const Models = require('../../app_core/models/conection');
const puntoCajaService = require('../../app_restaurante_api/services/puntoCajaService');
const pedidoService = require('../../app_restaurante_api/services/pedidoService');
const usuarioAsistenteDao = require('../../app_core/dao/usuarioAsistenteDao');
const seguimientoService = require('../../app_restaurante_api/services/seguimientoPedidoService');
const avisoPedido = require('../../intelligence/adapters/restaurante/avisoPedido');
const repositorio = require('../../intelligence/engine/repositorio');

const sequelize = Models.sequelize;

let idNegocio;
let idUsuarioAsistente;
let idAdmin1;
let idAdmin2;
let idRolAdministrador;
let idNivelVerMovimientos;

const ordenesCreadas = [];
const telefonosUsados = [];

async function unaFila(sql, replacements = {}) {
    const filas = await sequelize.query(sql, { replacements, type: sequelize.QueryTypes.SELECT });
    return filas[0] ?? null;
}

async function fijarPermiso(activo) {
    await sequelize.query(
        `INSERT INTO general.gener_nivel_negocio (id_negocio, id_rol, id_nivel, puede_ver, estado, fecha_creacion, fecha_actualizacion)
         VALUES (:n, :r, :nv, :activo, 'A', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
         ON CONFLICT (id_negocio, id_rol, id_nivel)
         DO UPDATE SET puede_ver = :activo, fecha_actualizacion = CURRENT_TIMESTAMP;`,
        { replacements: { n: idNegocio, r: idRolAdministrador, nv: idNivelVerMovimientos, activo } },
    );
}

/** Un pedido «tomado por el asistente», tal como llega hoy en la práctica: insertado directo. */
async function crearOrdenDelBot(numero, telefono) {
    const { id_punto_caja: idPunto } = await puntoCajaService.resolverPuntoCaja({ idNegocio });
    const orden = await unaFila(
        `INSERT INTO restaurante.pedid_orden
            (id_negocio, id_punto_caja, id_usuario, numero_orden, tipo_pedido, estado, contacto_nombre, contacto_telefono, total)
         VALUES (:n, :p, :u, :num, 'LLEVAR', 'ABIERTA', 'BOT Cliente Auditoria', :tel, 18000)
         RETURNING id_orden;`,
        { n: idNegocio, p: idPunto, u: idUsuarioAsistente, num: numero, tel: telefono },
    );
    ordenesCreadas.push(orden.id_orden);
    return orden.id_orden;
}

async function crearConversacion(idExterno) {
    const t = await sequelize.transaction();
    const conv = await repositorio.asegurarConversacion({ idNegocio, canal: 'whatsapp', idExterno }, { transaction: t });
    await t.commit();
    return conv;
}

/** `listar` busca por rango de HOY, así que un pedido recién insertado siempre cae dentro. */
async function eventosDe(idOrden, idUsuarioQueMira = idAdmin1) {
    const r = await seguimientoService.listar({ idUsuario: idUsuarioQueMira, idNegocio, limite: 100 });
    const fila = r.rows.find((f) => f.id_orden === idOrden);
    return fila ? fila.eventos : [];
}

beforeAll(async () => {
    idNegocio = (await unaFila(`SELECT id_negocio FROM general.gener_negocio WHERE nombre = 'Restaurante Demo';`)).id_negocio;
    idUsuarioAsistente = await usuarioAsistenteDao.resolverOCrear(idNegocio);

    const admins = await sequelize.query(
        `SELECT gu.id_usuario FROM general.gener_usuario_rol ur
           JOIN general.gener_usuario gu ON gu.id_usuario = ur.id_usuario
           JOIN general.gener_rol gr ON gr.id_rol = ur.id_rol
          WHERE ur.id_negocio = :n AND ur.estado = 'A' AND gr.descripcion = 'ADMINISTRADOR'
          ORDER BY gu.id_usuario LIMIT 2;`,
        { replacements: { n: idNegocio }, type: sequelize.QueryTypes.SELECT },
    );
    if (admins.length < 2) throw new Error('Hacen falta al menos 2 usuarios ADMINISTRADOR en Restaurante Demo.');
    [idAdmin1, idAdmin2] = admins.map((u) => u.id_usuario);

    idRolAdministrador = (await unaFila(`SELECT id_rol FROM general.gener_rol WHERE descripcion = 'ADMINISTRADOR' AND id_tipo_negocio = 1;`)).id_rol;
    idNivelVerMovimientos = (await unaFila(
        `SELECT id_nivel FROM general.gener_nivel WHERE url = 'caja_ver_movimientos' AND id_tipo_negocio = 1 AND id_tipo_nivel = 4;`,
    )).id_nivel;
    await fijarPermiso(true);
});

afterAll(async () => {
    for (const idOrden of ordenesCreadas) {
        await sequelize.query('DELETE FROM restaurante.pedid_orden WHERE id_orden = :o;', { replacements: { o: idOrden } });
    }
    if (telefonosUsados.length > 0) {
        const ids = (
            await sequelize.query(
                `SELECT id_conversacion FROM intelligence.conversacion WHERE id_negocio = :n AND id_externo IN (:ext);`,
                { replacements: { n: idNegocio, ext: telefonosUsados }, type: sequelize.QueryTypes.SELECT },
            )
        ).map((f) => f.id_conversacion);
        if (ids.length > 0) {
            await sequelize.query(`DELETE FROM intelligence.mensaje WHERE id_conversacion IN (:ids);`, { replacements: { ids } });
            await sequelize.query(`DELETE FROM intelligence.conversacion WHERE id_conversacion IN (:ids);`, { replacements: { ids } });
        }
    }
    await fijarPermiso(false);
    await sequelize.close();
});

describe('quién confirmó', () => {
    it('deja «confirmado» en la línea de tiempo con el actor real, no el mesero (el asistente)', async () => {
        const idOrden = await crearOrdenDelBot('QA-AUD-1', '3199000001');

        await pedidoService.confirmarPedidoAsistente({ idNegocio, idOrden, idUsuario: idAdmin1 });

        const eventos = await eventosDe(idOrden);
        const tomado = eventos.find((e) => e.tipo === 'tomado');
        const confirmado = eventos.find((e) => e.tipo === 'confirmado');
        expect(tomado.id_usuario).toBe(idUsuarioAsistente);
        expect(confirmado).toBeTruthy();
        expect(confirmado.id_usuario).toBe(idAdmin1);
        expect(confirmado.actor).toBeTruthy();
        expect(confirmado.actor).not.toBe(tomado.actor);
    });

    it('confirmar dos veces (idempotente) no deja DOS eventos, uno solo', async () => {
        const idOrden = await crearOrdenDelBot('QA-AUD-2', '3199000002');

        await pedidoService.confirmarPedidoAsistente({ idNegocio, idOrden, idUsuario: idAdmin1 });
        await pedidoService.confirmarPedidoAsistente({ idNegocio, idOrden, idUsuario: idAdmin2 });

        const confirmaciones = (await eventosDe(idOrden)).filter((e) => e.tipo === 'confirmado');
        expect(confirmaciones).toHaveLength(1);
        // Y queda el PRIMERO: el segundo clic no le roba la autoría al primero.
        expect(confirmaciones[0].id_usuario).toBe(idAdmin1);
    });

    it('un pedido normal (no del bot) nunca tiene evento «confirmado»', async () => {
        const { id_punto_caja: idPunto } = await puntoCajaService.resolverPuntoCaja({ idNegocio });
        const orden = await unaFila(
            `INSERT INTO restaurante.pedid_orden (id_negocio, id_punto_caja, id_usuario, numero_orden, tipo_pedido, estado, total)
             VALUES (:n, :p, :u, 'QA-AUD-3', 'LLEVAR', 'ABIERTA', 12000) RETURNING id_orden;`,
            { n: idNegocio, p: idPunto, u: idAdmin1 },
        );
        ordenesCreadas.push(orden.id_orden);

        const eventos = await eventosDe(orden.id_orden);
        expect(eventos.some((e) => e.tipo === 'confirmado')).toBe(false);
    });
});

describe('quién avisó que ya estaba listo', () => {
    it('deja «avisado» con el actor real, distinto de quien confirmó', async () => {
        const idOrden = await crearOrdenDelBot('QA-AUD-4', '3199000004');
        await crearConversacion('573199000004');
        telefonosUsados.push('573199000004');

        await pedidoService.confirmarPedidoAsistente({ idNegocio, idOrden, idUsuario: idAdmin1 });
        await avisoPedido.avisarListo({ idNegocio, idOrden, idUsuario: idAdmin2 });

        const eventos = await eventosDe(idOrden);
        const confirmado = eventos.find((e) => e.tipo === 'confirmado');
        const avisado = eventos.find((e) => e.tipo === 'avisado');
        expect(confirmado.id_usuario).toBe(idAdmin1);
        expect(avisado).toBeTruthy();
        expect(avisado.id_usuario).toBe(idAdmin2);
        expect(avisado.actor).not.toBe(confirmado.actor);
        // «avisado» va DESPUÉS de «confirmado» en el tiempo: la línea sigue en orden cronológico.
        expect(new Date(avisado.fecha).getTime()).toBeGreaterThanOrEqual(new Date(confirmado.fecha).getTime());
    });

    it('un reintento (el aviso anterior murió) deja DOS eventos «avisado», uno por cada intento', async () => {
        const idOrden = await crearOrdenDelBot('QA-AUD-5', '3199000005');
        await crearConversacion('573199000005');
        telefonosUsados.push('573199000005');

        const primero = await avisoPedido.avisarListo({ idNegocio, idOrden, idUsuario: idAdmin1 });
        await sequelize.query(`UPDATE intelligence.mensaje SET estado_entrega = 'fallido' WHERE id_mensaje = :id;`, {
            replacements: { id: primero.id_mensaje },
        });
        await avisoPedido.avisarListo({ idNegocio, idOrden, idUsuario: idAdmin2 });

        const avisos = (await eventosDe(idOrden)).filter((e) => e.tipo === 'avisado');
        expect(avisos).toHaveLength(2);
        expect(avisos.map((a) => a.id_usuario)).toEqual([idAdmin1, idAdmin2]);
    });

    it('sin idUsuario (compatibilidad) no revienta y no deja actor', async () => {
        const idOrden = await crearOrdenDelBot('QA-AUD-6', '3199000006');
        await crearConversacion('573199000006');
        telefonosUsados.push('573199000006');

        await expect(avisoPedido.avisarListo({ idNegocio, idOrden })).resolves.toMatchObject({
            id_mensaje: expect.anything(),
        });
        const avisado = (await eventosDe(idOrden)).find((e) => e.tipo === 'avisado');
        expect(avisado).toBeTruthy();
        expect(avisado.id_usuario).toBeNull();
    });
});
