'use strict';
/**
 * Las mesas que un cliente puede ELEGIR desde la carta virtual («En el local»).
 *
 * Vive aparte de `mesaService` a propósito: aquel es el de la operación (estado del servicio,
 * cuentas abiertas) y esto es lo mínimo que se le enseña a alguien sin sesión. Solo sale id,
 * nombre y número; nada de si está ocupada o de qué se debe en ella.
 *
 * «Activa» = `estado = 'A'`. Que esté ocupada NO la descarta: quien pide desde su mesa está, por
 * definición, sentado en una mesa que el negocio ya marcó como en servicio.
 *
 * El id que llegue de un pedido (`~t=` del código, o lo que diga el cliente) es una SUGERENCIA:
 * `resolverMesa` la relee y exige que sea de este negocio.
 */
const Models = require('../../app_core/models/conection');

async function listarPublicas(idNegocio) {
    const filas = await Models.RestMesa.findAll({
        where: { id_negocio: idNegocio, estado: 'A' },
        attributes: ['id_mesa', 'nombre', 'numero'],
        order: [['numero', 'ASC']],
    });
    return filas.map((m) => ({ id_mesa: m.id_mesa, nombre: m.nombre, numero: m.numero }));
}

/**
 * La mesa del pedido, releída de la base. Lanza `MESA_INVALIDA` (400) si no es de este negocio
 * o no está activa; el bot lo traduce a «¿en qué mesa estás?».
 */
async function resolverMesa({ idNegocio, idMesa, transaction = null, bloquear = false }) {
    const fila = await Models.RestMesa.findOne({
        where: { id_mesa: Number(idMesa), id_negocio: idNegocio, estado: 'A' },
        attributes: ['id_mesa', 'nombre', 'numero'],
        transaction,
        // Con `bloquear`, dos comensales que piden a la vez por la misma mesa se ponen en fila:
        // el segundo ve la cuenta que abrió el primero en vez de abrir otra.
        lock: bloquear && transaction ? transaction.LOCK.UPDATE : undefined,
    });
    if (!fila) {
        const err = new Error('Esa mesa no existe o no está disponible.');
        err.code = 'MESA_INVALIDA';
        err.statusCode = 400;
        throw err;
    }
    return { id_mesa: fila.id_mesa, nombre: fila.nombre, numero: fila.numero };
}

/**
 * La cuenta abierta de la mesa, o `null`. Mesas y cobro asumen UNA cuenta activa por mesa
 * (`getMesasDashboard` pinta solo la primera orden ABIERTA), así que un segundo pedido de la misma
 * mesa NO puede ser una orden nueva: quedaría sin verse ni cobrarse. Se suma a esta.
 * Si hubiera más de una (datos antiguos), la más antigua: es la que Mesas enseña.
 */
async function cuentaAbierta({ idNegocio, idMesa, transaction = null }) {
    return Models.PedidOrden.findOne({
        where: { id_negocio: idNegocio, id_mesa: idMesa, estado: 'ABIERTA' },
        attributes: ['id_orden', 'numero_orden'],
        order: [['id_orden', 'ASC']],
        transaction,
    });
}

module.exports = { listarPublicas, resolverMesa, cuentaAbierta };
