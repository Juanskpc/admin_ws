/**
 * De qué está hecho un «cliente» en cada vertical (F1 de `docs/promociones-masivas.md`).
 *
 * ## El único trozo del módulo que sabe de verticales
 *
 * Segmentar clientes es siempre la misma pregunta —cuántas veces vino, cuándo fue la última, cuánto
 * ha dejado— pero el hecho que la contesta cambia: en restaurante es un **pedido**, en reserva una
 * **cita**, y mañana en gym una **asistencia**. Todo lo demás (los segmentos, el simulador, el
 * envío, los informes) trabaja sobre esas tres cifras y no necesita saber de dónde salieron.
 *
 * Por eso el adaptador devuelve **SQL y no filas**: la segmentación tiene que poder contar 800
 * clientes y cruzarlos con su estado de baja en una sola consulta. Si cada adaptador devolviera un
 * array, el segmentador tendría que unir dos listas en memoria y paginar a mano — y el día que un
 * negocio tenga 5.000 clientes eso se nota.
 *
 * ## ⚠️ El vertical se resuelve por NOMBRE, nunca por id
 *
 * `gener_tipo_negocio.id_tipo_negocio` **no vale lo mismo en desarrollo que en producción** (está
 * documentado en `CLAUDE.md` y ya costó un fallo). Así que aquí se mira el nombre del aplicativo y
 * se traduce a una clave nuestra. Un negocio de un vertical sin adaptador devuelve `null`, y quien
 * pregunte se queda sin promociones — que es el comportamiento correcto: mejor no ofrecer la
 * función que ofrecerla contando cosas que no son.
 */
'use strict';

const Models = require('../../models/conection');

const sequelize = Models.sequelize;

const ADAPTADORES = {
    restaurante: require('./restaurante'),
    reserva: require('./reserva'),
};

/**
 * El vertical de un negocio, como clave de `ADAPTADORES`.
 *
 * Se compara en mayúsculas y con `LIKE` por lo mismo que lo hacen las migraciones: el nombre del
 * tipo de negocio lo escribió una persona («Restaurante», «RESTAURANTES»), y acertar con el nombre
 * exacto es una apuesta que no hay por qué hacer.
 */
async function verticalDeNegocio(idNegocio, { transaction = null } = {}) {
    const [fila] = await sequelize.query(
        `SELECT UPPER(tn.nombre) AS nombre
           FROM general.gener_negocio n
           JOIN general.gener_tipo_negocio tn ON tn.id_tipo_negocio = n.id_tipo_negocio
          WHERE n.id_negocio = :idNegocio
          LIMIT 1;`,
        {
            replacements: { idNegocio: Number(idNegocio) },
            type: sequelize.QueryTypes.SELECT,
            transaction,
        }
    );
    if (!fila) return null;
    const nombre = String(fila.nombre || '');
    if (nombre.includes('RESTAURANTE')) return 'restaurante';
    if (nombre.includes('RESERVA')) return 'reserva';
    return null;
}

/** El adaptador de un vertical, o `null` si ese vertical todavía no tiene promociones. */
function adaptadorDe(vertical) {
    return ADAPTADORES[vertical] ?? null;
}

/**
 * El adaptador que le toca a un negocio, resuelto por su vertical.
 *
 * @returns {Promise<{vertical: string, adaptador: Object}|null>}
 */
async function paraNegocio(idNegocio, opciones = {}) {
    const vertical = await verticalDeNegocio(idNegocio, opciones);
    const adaptador = adaptadorDe(vertical);
    return adaptador ? { vertical, adaptador } : null;
}

module.exports = { ADAPTADORES, verticalDeNegocio, adaptadorDe, paraNegocio };
