'use strict';
const Models = require('../models/conection');

/**
 * Todo negocio de restaurante necesita al menos una caja.
 *
 * Es la misma idea que `datosFiscales.asegurarFicha`: en vez de dejar que exista un negocio a
 * medias —sin caja no se puede tomar un pedido ni cobrar— se le da la suya al nacer. La
 * migración hizo esto mismo con los que ya existían.
 *
 * Idempotente: `ON CONFLICT DO NOTHING` sobre (id_negocio, nombre). Llamarla dos veces, o
 * sobre un negocio que ya la tiene, no hace nada.
 */
const NOMBRE_POR_DEFECTO = 'Caja principal';

async function asegurarCajaPrincipal(idNegocio, { transaction = null, nombre = NOMBRE_POR_DEFECTO } = {}) {
    if (!idNegocio) return null;

    const [fila] = await Models.sequelize.query(
        `INSERT INTO restaurante.rest_punto_caja (id_negocio, nombre, descripcion, orden, estado)
         SELECT :idNegocio, :nombre, 'Caja creada con el negocio', 1, 'A'
          WHERE NOT EXISTS (
                SELECT 1 FROM restaurante.rest_punto_caja
                 WHERE id_negocio = :idNegocio AND estado = 'A'
          )
         ON CONFLICT (id_negocio, nombre) DO NOTHING
         RETURNING id_punto_caja, nombre;`,
        { replacements: { idNegocio, nombre }, type: Models.sequelize.QueryTypes.INSERT, transaction },
    );

    return Array.isArray(fila) ? (fila[0] ?? null) : (fila ?? null);
}

module.exports = { asegurarCajaPrincipal, NOMBRE_POR_DEFECTO };
