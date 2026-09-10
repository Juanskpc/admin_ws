'use strict';

/**
 * El país de un negocio, para normalizar los teléfonos de sus clientes.
 *
 * Vive aparte de `telefono.js` a propósito: ese archivo no toca la base y por eso lo pueden
 * usar las migraciones sin arrancar la aplicación. Aquí es donde se paga la consulta.
 *
 * Es una lectura por clave primaria en el camino de escritura de pedidos y citas. No se cachea:
 * el ahorro sería microscópico al lado del INSERT que viene detrás, y una caché convertiría
 * "cambié el país del negocio" en un fallo que solo se arregla reiniciando.
 *
 * Si el negocio no existe o la columna aún no está migrada, devuelve 'CO', que es lo que había
 * antes de que el país existiera: degradar al comportamiento anterior, nunca a ninguno.
 */
const db = require('../models/conection');

const sequelize = db.sequelize;
const POR_DEFECTO = 'CO';

async function paisDeNegocio(idNegocio, { transaction } = {}) {
    if (!idNegocio) return POR_DEFECTO;
    try {
        const [fila] = await sequelize.query(
            'SELECT pais FROM general.gener_negocio WHERE id_negocio = :idNegocio;',
            { replacements: { idNegocio }, type: sequelize.QueryTypes.SELECT, transaction },
        );
        return (fila && fila.pais) ? String(fila.pais).toUpperCase() : POR_DEFECTO;
    } catch {
        return POR_DEFECTO;
    }
}

module.exports = { paisDeNegocio, PAIS_POR_DEFECTO: POR_DEFECTO };
