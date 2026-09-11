'use strict';

const realtime = require('../../app_core/realtime');

/**
 * avisoService — qué se le avisa a las pantallas del restaurante cuando algo cambia.
 *
 * Los TEMAS son áreas de datos, no pantallas. Es a propósito: una pantalla mira varias áreas
 * (el POS mira pedidos y mesas) y un área la miran varias pantallas (los pedidos los miran POS,
 * Despacho y Caja). Si los temas fueran pantallas, añadir una obligaría a repasar cada punto de
 * emisión del backend para acordarse de incluirla.
 *
 *   pedidos  → órdenes: se crean, se les agregan cosas, se cobran, se cierran, se cancelan.
 *   mesas    → qué mesa está ocupada, libre o en cuenta.
 *   cocina   → el tablero del KDS.
 *   caja     → el turno abierto y sus movimientos.
 *   clientes → las cuentas de cliente: tiqueteras, fiado y sus saldos.
 *
 * ## La regla que no se puede saltar: avisar DESPUÉS del commit
 *
 * Un aviso emitido dentro de la transacción anuncia algo que todavía puede deshacerse. El caso
 * no es teórico: el Policy Gate de Intelligence envuelve toda ejecución en una transacción
 * propia para poder hacer *dry-run* —simular el pedido y deshacerlo—, así que un aviso emitido
 * ahí dentro mandaría a doce tablets a buscar un pedido que nunca existió.
 *
 * Por eso, donde hay transacción, se usa `avisarTrasCommit(t, ...)`: Sequelize lo dispara solo
 * si esa transacción confirma, y nunca si se deshace. Y como funciona igual con la transacción
 * del POS que con la del Gate, los pedidos que entran por WhatsApp aparecen en las pantallas
 * sin que este módulo sepa que existe un bot.
 */

const CANAL = 'restaurante';

const TEMAS = Object.freeze({
    PEDIDOS: 'pedidos',
    MESAS: 'mesas',
    COCINA: 'cocina',
    CAJA: 'caja',
    CLIENTES: 'clientes',
});

/** Avisa ya. Para operaciones que no abren transacción explícita. */
function avisar(idNegocio, ...temas) {
    return realtime.emitir({ canal: CANAL, idNegocio, temas });
}

/**
 * Avisa solo si la transacción confirma.
 *
 * @param {object} transaction — la transacción de Sequelize en curso.
 */
function avisarTrasCommit(transaction, idNegocio, ...temas) {
    if (!transaction || typeof transaction.afterCommit !== 'function') {
        // Sin transacción no hay nada que esperar: el cambio ya está escrito.
        return avisar(idNegocio, ...temas);
    }
    transaction.afterCommit(() => avisar(idNegocio, ...temas));
    return 0;
}

module.exports = { CANAL, TEMAS, avisar, avisarTrasCommit };
