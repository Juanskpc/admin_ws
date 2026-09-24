/**
 * Toda escritura sobre una tabla auditada de Restaurante deja QUIÉN la hizo en
 * `auditoria.audit_dato.id_usuario`.
 *
 * `fn_audit()` lee el actor de las GUC que `conection.js` fija SOLO al abrir una transacción, así
 * que un `update`/`save` suelto lo dejaba en NULL (la columna «Usuario» de Auditoría mostraba «—»).
 * Estos puntos se envolvieron en transacción; aquí se comprueba uno por módulo:
 *
 *   - cocina        `cambiarEstadoCocina`, `enviarACocina`   (pedid_orden)
 *   - caja          `cerrarCaja`                             (rest_caja)
 *   - configuración `updateConfiguracionNegocio`             (gener_negocio)
 *   - carta         `eliminarProducto`                       (carta_producto)
 *   - bot           `agregarItemsPorCliente` → el usuario asistente, sin request
 *
 * El request se simula con el middleware `auditContext` (contexto ALS con `req.usuario`).
 * Corre contra la base de verdad y necesita `Restaurante Demo` con carta.
 */
'use strict';

require('dotenv').config();

const Models = require('../../app_core/models/conection');
const pedidoService = require('../../app_restaurante_api/services/pedidoService');
const cajaService = require('../../app_restaurante_api/services/cajaService');
const configuracionService = require('../../app_restaurante_api/services/configuracionService');
const cartaAdminService = require('../../app_restaurante_api/services/cartaAdminService');
const usuarioAsistenteDao = require('../../app_core/dao/usuarioAsistenteDao');
const { auditContext } = require('../../app_core/middleware/auditContext');

const sequelize = Models.sequelize;

let idNegocio;
let idUsuario;
let idProducto;
let idCategoria;
let descuentoOriginal;
const ordenes = [];
const productos = [];

async function unaFila(sql, replacements = {}) {
    const filas = await sequelize.query(sql, { replacements, type: sequelize.QueryTypes.SELECT });
    return filas[0] ?? null;
}

/** Ejecuta `fn` como si fuera un request del usuario `idUsuario`. */
function comoRequest(fn) {
    return new Promise((resolve, reject) => {
        auditContext({ usuario: { id_usuario: idUsuario }, ip: '127.0.0.1' }, {}, () => {
            Promise.resolve().then(fn).then(resolve, reject);
        });
    });
}

/** El actor de la última fila de auditoría de esa tabla/registro que cumpla la condición. */
function actorDe(esquema, tabla, pk, condicion = 'true') {
    return unaFila(
        `SELECT id_usuario FROM auditoria.audit_dato
          WHERE esquema = :e AND tabla = :t AND operacion = 'U' AND pk_registro::text = :pk
            AND ${condicion}
          ORDER BY id_audit DESC LIMIT 1;`,
        { e: esquema, t: tabla, pk: String(pk) },
    );
}

async function crearPedido(tipoPedido = 'LLEVAR') {
    const orden = await pedidoService.crearOrden({
        idNegocio, idUsuario, idMesa: null, nota: 'test auditoria actor', tipoPedido,
        items: [{ id_producto: idProducto, cantidad: 1, precio_unitario: 10000 }],
    });
    ordenes.push(orden.id_orden);
    return orden;
}

async function cerrarTodasLasCajas() {
    await sequelize.query(
        `UPDATE restaurante.rest_caja SET estado = 'C' WHERE id_negocio = :n AND estado = 'A';`,
        { replacements: { n: idNegocio } },
    );
}

beforeAll(async () => {
    idNegocio = (await unaFila(`SELECT id_negocio FROM general.gener_negocio WHERE nombre = 'Restaurante Demo';`)).id_negocio;
    idUsuario = (await unaFila(
        `SELECT id_usuario FROM general.gener_negocio_usuario WHERE id_negocio = :n AND estado = 'A' ORDER BY id_usuario LIMIT 1;`,
        { n: idNegocio },
    )).id_usuario;
    const prod = await unaFila(
        `SELECT id_producto, id_categoria FROM restaurante.carta_producto
          WHERE id_negocio = :n AND estado = 'A' AND precio > 0 LIMIT 1;`,
        { n: idNegocio },
    );
    idProducto = prod.id_producto;
    idCategoria = prod.id_categoria;
    descuentoOriginal = (await unaFila(
        'SELECT permite_descuento FROM general.gener_negocio WHERE id_negocio = :n', { n: idNegocio },
    )).permite_descuento;

    // Una caja abierta por la suite, sin restos de otras corridas que impidan cerrarla.
    await cerrarTodasLasCajas();
    await cajaService.abrirCaja({ idNegocio, idUsuario, montoApertura: 0, observaciones: 'test auditoria actor' });
});

afterAll(async () => {
    for (const id of ordenes) {
        await sequelize.query('DELETE FROM restaurante.pedid_detalle WHERE id_orden = :o', { replacements: { o: id } });
        await sequelize.query('DELETE FROM restaurante.pedid_orden WHERE id_orden = :o', { replacements: { o: id } });
    }
    for (const id of productos) {
        await sequelize.query('DELETE FROM restaurante.carta_producto WHERE id_producto = :p', { replacements: { p: id } });
    }
    await sequelize.query('UPDATE general.gener_negocio SET permite_descuento = :v WHERE id_negocio = :n', {
        replacements: { v: descuentoOriginal, n: idNegocio },
    });
    await cerrarTodasLasCajas();
    await sequelize.close();
});

describe('cocina', () => {
    it('cambiarEstadoCocina deja al usuario', async () => {
        const orden = await crearPedido();
        await comoRequest(() => pedidoService.cambiarEstadoCocina(orden.id_orden, 'EN_PREPARACION'));
        const audit = await actorDe('restaurante', 'pedid_orden', orden.id_orden, `datos_despues->>'estado_cocina' = 'EN_PREPARACION'`);
        expect(audit?.id_usuario).toBe(idUsuario);
    });

    it('enviarACocina deja al usuario', async () => {
        const orden = await crearPedido();
        await comoRequest(() => pedidoService.enviarACocina(orden.id_orden));
        const audit = await actorDe('restaurante', 'pedid_orden', orden.id_orden, `datos_despues->>'estado_cocina' = 'PENDIENTE'`);
        expect(audit?.id_usuario).toBe(idUsuario);
    });
});

describe('configuración y carta', () => {
    it('updateConfiguracionNegocio deja al usuario', async () => {
        await comoRequest(() => configuracionService.updateConfiguracionNegocio(idUsuario, {
            id_negocio: idNegocio, permite_descuento: !descuentoOriginal,
        }));
        const audit = await actorDe('general', 'gener_negocio', idNegocio);
        expect(audit?.id_usuario).toBe(idUsuario);
    });

    it('eliminarProducto deja al usuario', async () => {
        const p = await Models.CartaProducto.create({
            id_negocio: idNegocio, id_categoria: idCategoria, nombre: `TEST-actor-${Date.now()}`, precio: 1000, estado: 'A',
        });
        productos.push(p.id_producto);
        await comoRequest(() => cartaAdminService.eliminarProducto(p.id_producto));
        const audit = await actorDe('restaurante', 'carta_producto', p.id_producto, `datos_despues->>'estado' = 'I'`);
        expect(audit?.id_usuario).toBe(idUsuario);
    });
});

describe('bot (sin request)', () => {
    it('agregarItemsPorCliente deja al usuario asistente del negocio', async () => {
        const orden = await crearPedido('DOMICILIO');
        const idAsistente = await usuarioAsistenteDao.resolverOCrear(idNegocio);

        await sequelize.transaction(async (t) => {
            await pedidoService.agregarItemsPorCliente(orden.id_orden, {
                idNegocio, transaction: t,
                items: [{ id_producto: idProducto, cantidad: 1, precio_unitario: 10000 }],
            });
        });

        const audit = await actorDe('restaurante', 'pedid_orden', orden.id_orden);
        expect(audit?.id_usuario).toBe(idAsistente);
        expect(audit.id_usuario).not.toBe(idUsuario);
    });
});

// Al final: cerrar el turno exige que no queden pedidos abiertos de esta suite.
describe('caja', () => {
    it('cerrarCaja deja al usuario', async () => {
        const caja = await Models.RestCaja.findOne({ where: { id_negocio: idNegocio, estado: 'A' } });
        for (const id of ordenes) {
            await sequelize.query(`UPDATE restaurante.pedid_orden SET estado = 'CANCELADA' WHERE id_orden = :o`, { replacements: { o: id } });
        }
        await comoRequest(() => cajaService.cerrarCaja({ idCaja: caja.id_caja, idNegocio, montoReportado: 0 }));
        const audit = await actorDe('restaurante', 'rest_caja', caja.id_caja, `datos_despues->>'estado' = 'C'`);
        expect(audit?.id_usuario).toBe(idUsuario);
    });
});
