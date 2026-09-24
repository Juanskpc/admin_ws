/**
 * auditActor.js — Fija QUIÉN hace el cambio dentro de una transacción ya abierta.
 *
 * `auditoria.fn_audit()` atribuye cada UPDATE/DELETE leyendo las GUC `app.id_usuario` y
 * `app.id_negocio`, y `conection.js` las fija SOLO al abrir una transacción y SOLO si hay un
 * request detrás (AsyncLocalStorage). Dos casos se quedaban sin actor, sin dar error:
 *
 *   - un `instancia.update(...)` fuera de transacción (no hay dónde poner la GUC), y
 *   - una transacción abierta fuera de un request — el asistente de WhatsApp, un cron —, donde
 *     no hay JWT del que sacarlo.
 *
 * Esto cubre los dos: el servicio, que SÍ sabe quién actúa, lo dice explícitamente. Es
 * `set_config(..., is_local = true)`: muere con la transacción, seguro con el pool.
 */
'use strict';
const Models = require('../models/conection');
const usuarioAsistenteDao = require('../dao/usuarioAsistenteDao');

async function fijarActor(transaction, { idUsuario, idNegocio = null }) {
    if (!transaction) throw new Error('fijarActor requiere una transacción abierta.');
    if (idUsuario == null) return;
    await Models.sequelize.query(
        `SELECT set_config('app.id_usuario', $1, true), set_config('app.id_negocio', $2, true)`,
        {
            bind: [String(idUsuario), idNegocio == null ? '' : String(idNegocio)],
            transaction,
        }
    );
}

/**
 * En la transacción del Policy Gate (el bot: sin request ni JWT) el actor de auditoría es el
 * usuario asistente del negocio, el mismo a cuyo nombre quedan los pedidos que toma. Sin
 * transacción (uso directo, público) no hay dónde fijarlo y no se hace nada.
 */
async function fijarActorAsistente(transaction, idNegocio) {
    if (!transaction) return;
    const idAsistente = await usuarioAsistenteDao.resolverOCrear(idNegocio);
    await fijarActor(transaction, { idUsuario: idAsistente, idNegocio });
}

module.exports = { fijarActor, fijarActorAsistente };
