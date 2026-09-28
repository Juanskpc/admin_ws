/**
 * «Movimientos» de Caja, acotado a UNA caja (2026-09-29).
 *
 * La pantalla ya no pide un rango de fechas: muestra los pedidos del turno en curso. Los pedidos
 * de un turno son dos grupos —los que se COBRARON en él (`id_caja`, que llega nulo hasta cobrar) y
 * los que se TOMARON durante él en su mismo rubro— y hacen falta los dos: con solo el primero
 * desaparecería lo que sigue abierto o se canceló sin cobrar, que es lo que esta pantalla vigila.
 *
 * Los pedidos se insertan directos para controlar `fecha_creacion` e `id_caja`, y el producto es
 * propio: `Restaurante Demo` puede no tener carta en la base compartida.
 *
 * Corre contra la base de verdad.
 */
'use strict';

require('dotenv').config();

const Models = require('../../app_core/models/conection');
const puntoCajaService = require('../../app_restaurante_api/services/puntoCajaService');
const cajaService = require('../../app_restaurante_api/services/cajaService');
const seguimientoService = require('../../app_restaurante_api/services/seguimientoPedidoService');

const sequelize = Models.sequelize;

let idNegocio;
let idUsuario;
let idPunto;
let idCaja;
let idRolAdministrador;
let idNivelVerMovimientos;
let cajaAbiertaPorLaSuite = false;
const ordenes = {};

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

/** `creadaHaceMin`: minutos respecto de la APERTURA del turno (negativo = antes de abrir). */
async function insertarOrden({ numero, estado = 'ABIERTA', minRespectoApertura, idCajaCobro = null, punto = idPunto }) {
    const fila = await unaFila(
        `INSERT INTO restaurante.pedid_orden
            (id_negocio, id_punto_caja, id_usuario, numero_orden, tipo_pedido, estado, total, id_caja, fecha_creacion)
         SELECT :n, :p, :u, :num, 'LLEVAR', :estado, 10000, :cobro,
                c.fecha_apertura + (:min || ' minutes')::interval
           FROM restaurante.rest_caja c WHERE c.id_caja = :caja
         RETURNING id_orden;`,
        { n: idNegocio, p: punto, u: idUsuario, num: numero, estado, cobro: idCajaCobro, min: minRespectoApertura, caja: idCaja },
    );
    return fila.id_orden;
}

beforeAll(async () => {
    idNegocio = (await unaFila(`SELECT id_negocio FROM general.gener_negocio WHERE nombre = 'Restaurante Demo';`)).id_negocio;
    idUsuario = (await unaFila(
        `SELECT gu.id_usuario FROM general.gener_usuario_rol ur
           JOIN general.gener_usuario gu ON gu.id_usuario = ur.id_usuario
           JOIN general.gener_rol gr ON gr.id_rol = ur.id_rol
          WHERE ur.id_negocio = :n AND ur.estado = 'A' AND gr.descripcion = 'ADMINISTRADOR' ORDER BY gu.id_usuario LIMIT 1;`,
        { n: idNegocio },
    )).id_usuario;
    idRolAdministrador = (await unaFila(`SELECT id_rol FROM general.gener_rol WHERE descripcion = 'ADMINISTRADOR' AND id_tipo_negocio = 1;`)).id_rol;
    idNivelVerMovimientos = (await unaFila(
        `SELECT id_nivel FROM general.gener_nivel WHERE url = 'caja_ver_movimientos' AND id_tipo_negocio = 1 AND id_tipo_nivel = 4;`,
    )).id_nivel;
    await fijarPermiso(true);

    ({ id_punto_caja: idPunto } = await puntoCajaService.resolverPuntoCaja({ idNegocio }));

    const abierta = await unaFila(
        `SELECT id_caja FROM restaurante.rest_caja WHERE id_negocio = :n AND estado = 'A' AND id_punto_caja = :p LIMIT 1;`,
        { n: idNegocio, p: idPunto },
    );
    if (abierta) {
        idCaja = abierta.id_caja;
    } else {
        idCaja = (await cajaService.abrirCaja({ idNegocio, idUsuario, montoApertura: 0, observaciones: 'test por caja' })).id_caja;
        cajaAbiertaPorLaSuite = true;
    }

    // Una caja de AYER, ya cerrada, para comprobar que sus pedidos no se cuelan.
    ordenes.tomadaAntes = await insertarOrden({ numero: 'ORD-9801', minRespectoApertura: -600 });
    ordenes.abierta = await insertarOrden({ numero: 'ORD-9802', minRespectoApertura: 1 });
    ordenes.cancelada = await insertarOrden({ numero: 'ORD-9803', estado: 'CANCELADA', minRespectoApertura: 2 });
    // Tomada en el turno anterior pero COBRADA en éste: `id_caja` la trae aunque se creara antes.
    ordenes.cobradaAqui = await insertarOrden({ numero: 'ORD-9804', estado: 'CERRADA', minRespectoApertura: -30, idCajaCobro: idCaja });
});

afterAll(async () => {
    for (const id of Object.values(ordenes)) {
        await sequelize.query('DELETE FROM restaurante.pedid_orden WHERE id_orden = :o;', { replacements: { o: id } });
    }
    await fijarPermiso(false);
    if (cajaAbiertaPorLaSuite) {
        await sequelize.query(`UPDATE restaurante.rest_caja SET estado = 'C' WHERE id_caja = :c;`, { replacements: { c: idCaja } });
    }
    await sequelize.close();
});

const listarCaja = (extra = {}) => seguimientoService.listar({ idUsuario, idNegocio, idCaja, ...extra });
const idsDe = (r) => r.rows.map((f) => f.id_orden);

describe('listar por caja', () => {
    it('trae lo abierto y lo cancelado del turno, sin pedir fechas', async () => {
        const r = await listarCaja();
        expect(idsDe(r)).toEqual(expect.arrayContaining([ordenes.abierta, ordenes.cancelada]));
        expect(r.id_caja).toBe(idCaja);
        expect(r.rango).toBeNull();
    });

    it('trae también lo que se COBRÓ en este turno aunque se tomara antes', async () => {
        expect(idsDe(await listarCaja())).toContain(ordenes.cobradaAqui);
    });

    it('NO trae lo que se tomó antes de abrir y no se cobró aquí', async () => {
        expect(idsDe(await listarCaja())).not.toContain(ordenes.tomadaAntes);
    });

    it('el resumen y el conteo sólo cuentan los de esa caja', async () => {
        const r = await listarCaja();
        expect(r.total).toBe(r.rows.length);
        expect(r.resumen.cancelo ?? r.resumen.canceladas).toBeGreaterThanOrEqual(1);
    });

    it('se puede buscar por número de orden dentro de la caja', async () => {
        const r = await listarCaja({ q: 'ORD-9803' });
        expect(idsDe(r)).toEqual([ordenes.cancelada]);
    });

    it('el filtro por estado sigue funcionando', async () => {
        const r = await listarCaja({ estado: 'CANCELADA' });
        expect(idsDe(r)).toContain(ordenes.cancelada);
        expect(idsDe(r)).not.toContain(ordenes.abierta);
    });

    it('una caja que no existe es un 404, no una lista vacía', async () => {
        await expect(
            seguimientoService.listar({ idUsuario, idNegocio, idCaja: 2147483000 }),
        ).rejects.toMatchObject({ code: 'CAJA_NO_ENCONTRADA', statusCode: 404 });
    });

    it('el id de una caja ajena no sirve para asomarse a otro negocio', async () => {
        // El permiso se comprueba ANTES de mirar la caja: quien no es de ese negocio ni se entera de si existe.
        await expect(
            seguimientoService.listar({ idUsuario, idNegocio: idNegocio + 100000, idCaja }),
        ).rejects.toMatchObject({ statusCode: 403 });
    });

    it('sin idCaja sigue funcionando por rango de fechas (compatibilidad)', async () => {
        const r = await seguimientoService.listar({ idUsuario, idNegocio });
        expect(r.rango).toMatchObject({ desde: expect.any(String), hasta: expect.any(String) });
    });
});
