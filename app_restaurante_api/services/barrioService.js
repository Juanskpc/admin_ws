'use strict';
/**
 * Barrios con precio de domicilio.
 *
 * Quién manda: **el servidor**. El barrio que llega en un pedido (carta, bot) es una sugerencia
 * del cliente; el valor que se cobra sale de aquí, releído por (id_negocio, id_barrio), nunca de
 * lo que venga en el mensaje. Ver `resolverBarrio`.
 *
 * Todo esto solo aplica si el negocio tiene `permite_pago_domicilio` encendido; apagado, no hay
 * barrios que preguntar ni domicilio que cobrar (comportamiento de siempre).
 */
const { Op } = require('sequelize');
const Models = require('../../app_core/models/conection');
const ConfiguracionService = require('./configuracionService');

function domainError(message, code, statusCode) {
    const err = new Error(message);
    err.code = code;
    err.statusCode = statusCode;
    return err;
}

function limpiarNombre(nombre) {
    return String(nombre ?? '').trim().replace(/\s+/g, ' ');
}

function aPlano(b) {
    return { id_barrio: b.id_barrio, nombre: b.nombre, valor: Number(b.valor) };
}

/** Acceso de escritura = administrador del negocio, igual que Configuración. */
async function accesoEscritura(idUsuario, idNegocio) {
    const acceso = await ConfiguracionService.resolveAccesoNegocio(idUsuario, idNegocio);
    if (!acceso.canEdit) {
        throw domainError('No tienes permiso para editar los barrios.', 'SIN_PERMISO', 403);
    }
    return acceso.idNegocio;
}

async function asegurarNombreLibre(idNegocio, nombre, exceptoId = null) {
    const where = {
        id_negocio: idNegocio,
        estado: 'A',
        [Op.and]: [Models.sequelize.where(
            Models.sequelize.fn('lower', Models.sequelize.col('nombre')), nombre.toLowerCase(),
        )],
    };
    if (exceptoId) where.id_barrio = { [Op.ne]: exceptoId };
    if (await Models.RestBarrioDomicilio.count({ where })) {
        throw domainError('Ya tienes un barrio con ese nombre.', 'BARRIO_DUPLICADO', 409);
    }
}

async function listar(idUsuario, idNegocio) {
    const acceso = await ConfiguracionService.resolveAccesoNegocio(idUsuario, idNegocio);
    const filas = await Models.RestBarrioDomicilio.findAll({
        where: { id_negocio: acceso.idNegocio, estado: 'A' },
        order: [['nombre', 'ASC']],
    });
    return filas.map(aPlano);
}

async function crear(idUsuario, { id_negocio, nombre, valor }) {
    const idNegocio = await accesoEscritura(idUsuario, id_negocio);
    const limpio = limpiarNombre(nombre);
    await asegurarNombreLibre(idNegocio, limpio);
    const fila = await Models.RestBarrioDomicilio.create({
        id_negocio: idNegocio, nombre: limpio, valor: Number(valor),
    });
    return aPlano(fila);
}

async function editar(idUsuario, idBarrio, { id_negocio, nombre, valor }) {
    const idNegocio = await accesoEscritura(idUsuario, id_negocio);
    const fila = await Models.RestBarrioDomicilio.findOne({
        where: { id_barrio: idBarrio, id_negocio: idNegocio, estado: 'A' },
    });
    if (!fila) throw domainError('Barrio no encontrado.', 'BARRIO_NO_ENCONTRADO', 404);

    if (nombre !== undefined) {
        const limpio = limpiarNombre(nombre);
        await asegurarNombreLibre(idNegocio, limpio, idBarrio);
        fila.nombre = limpio;
    }
    if (valor !== undefined) fila.valor = Number(valor);
    await fila.save();
    return aPlano(fila);
}

async function eliminar(idUsuario, idBarrio, idNegocioSolicitado) {
    const idNegocio = await accesoEscritura(idUsuario, idNegocioSolicitado);
    const [n] = await Models.RestBarrioDomicilio.update(
        { estado: 'E' },
        { where: { id_barrio: idBarrio, id_negocio: idNegocio, estado: 'A' } },
    );
    if (!n) throw domainError('Barrio no encontrado.', 'BARRIO_NO_ENCONTRADO', 404);
    return { id_barrio: idBarrio };
}

/**
 * Lo que ve el cliente en la carta pública: `habilitado` dice si el negocio cobra domicilio por
 * barrio (flag `permite_pago_domicilio`) y la lista solo lleva id, nombre y valor.
 */
async function listarPublico(idNegocio) {
    const negocio = await Models.GenerNegocio.findByPk(idNegocio, {
        attributes: ['id_negocio', 'permite_pago_domicilio'],
    });
    if (!negocio || !negocio.permite_pago_domicilio) return { habilitado: false, barrios: [] };
    const filas = await Models.RestBarrioDomicilio.findAll({
        where: { id_negocio: idNegocio, estado: 'A' },
        order: [['nombre', 'ASC']],
    });
    return { habilitado: true, barrios: filas.map(aPlano) };
}

/**
 * El barrio que dijo el cliente, releído de la base: debe ser de ESTE negocio y estar activo.
 * Lanza `ZONA_INVALIDA` (400) si no; el bot lo traduce a «¿en qué barrio estás?».
 */
async function resolverBarrio({ idNegocio, idBarrio, transaction = null }) {
    const fila = await Models.RestBarrioDomicilio.findOne({
        where: { id_barrio: Number(idBarrio), id_negocio: idNegocio, estado: 'A' },
        transaction,
    });
    if (!fila) throw domainError('Ese barrio no está en nuestra lista.', 'ZONA_INVALIDA', 400);
    return aPlano(fila);
}

/**
 * El barrio y lo que cuesta llevarle un pedido: `{ barrio, valor }`. `valor` es 0 si el negocio
 * tiene apagado `permite_pago_domicilio` (mismo criterio que `pedidoService.resolverValorDomicilio`,
 * que además lo vuelve a aplicar al crear la orden). Lo usan la pregunta de confirmación y la
 * creación del pedido, para que digan lo mismo.
 */
async function valorDomicilioDe({ idNegocio, idBarrio, transaction = null }) {
    const barrio = await resolverBarrio({ idNegocio, idBarrio, transaction });
    const negocio = await Models.GenerNegocio.findByPk(idNegocio, {
        attributes: ['id_negocio', 'permite_pago_domicilio'],
        transaction,
    });
    return { barrio, valor: negocio?.permite_pago_domicilio ? barrio.valor : 0 };
}

module.exports = {
    listar, crear, editar, eliminar, listarPublico, resolverBarrio, valorDomicilioDe,
};
