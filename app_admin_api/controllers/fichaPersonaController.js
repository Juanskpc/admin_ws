'use strict';
const { validationResult } = require('express-validator');
const Respuesta = require('../../app_core/helpers/respuesta');
const Models = require('../../app_core/models/conection');

/**
 * Ficha 360 — entregable visible de F0 (roadmap, revision-01 §2).
 *
 * Vista de **solo lectura** que agrega la actividad de una `platform.persona_negocio`.
 * No altera la arquitectura: no escribe, no emite eventos y no conoce a Intelligence.
 *
 * Hoy la única vertical que aporta actividad es `restaurante`: la medición del 2026-07-31
 * confirmó que gym, parqueadero, tienda y reserva están vacías en producción (0–1 filas).
 * Construir la agregación de esas cuatro sería construir para nadie; se añadirá cuando
 * tengan datos. Ver mediciones/2026-07-31-calidad-telefonos-restaurante.md.
 */

const LIMITE_POR_DEFECTO = 25;
const LIMITE_MAXIMO = 100;
const ULTIMOS_PEDIDOS = 10;

/**
 * GET /admin/personas
 * Lista personas conocidas, con su resumen mínimo para pintar una tabla.
 *
 * Query: ?id_negocio= &q= &limit= &offset=
 * `q` busca por nombre o por teléfono, tolerando cómo lo escriba el usuario: se comparan
 * solo los dígitos, así que "300 111" encuentra a "+573001112233".
 */
async function listarPersonas(req, res) {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return Respuesta.error(res, 'Datos de entrada inválidos', 400, errors.array());
        }

        const idNegocio = req.query.id_negocio ? Number(req.query.id_negocio) : null;
        const q = (req.query.q || '').trim();
        const limit = Math.min(Number(req.query.limit) || LIMITE_POR_DEFECTO, LIMITE_MAXIMO);
        const offset = Number(req.query.offset) || 0;
        const qDigitos = q.replace(/\D/g, '');

        const filtros = `
            WHERE (:idNegocio::int IS NULL OR pn.id_negocio = :idNegocio)
              AND (
                    :q = ''
                 OR pn.nombre_mostrado ILIKE '%' || :q || '%'
                 OR (:qDigitos <> '' AND pn.telefono_e164 LIKE '%' || :qDigitos || '%')
              )
        `;

        const [filas] = await Models.sequelize.query(
            `
            SELECT
                pn.id_persona_negocio,
                pn.id_negocio,
                n.nombre                              AS negocio,
                pn.nombre_mostrado,
                pn.telefono_e164,
                pn.creado_en,
                COUNT(o.id_orden)::int                AS pedidos,
                COALESCE(SUM(o.total), 0)             AS total_gastado,
                MAX(o.fecha_creacion)                 AS ultimo_pedido
              FROM platform.persona_negocio pn
              JOIN general.gener_negocio n ON n.id_negocio = pn.id_negocio
              LEFT JOIN restaurante.pedid_orden o ON o.id_persona_negocio = pn.id_persona_negocio
            ${filtros}
             GROUP BY pn.id_persona_negocio, pn.id_negocio, n.nombre, pn.nombre_mostrado,
                      pn.telefono_e164, pn.creado_en
             ORDER BY MAX(o.fecha_creacion) DESC NULLS LAST, pn.creado_en DESC
             LIMIT :limit OFFSET :offset;
            `,
            { replacements: { idNegocio, q, qDigitos, limit, offset } }
        );

        const [[conteo]] = await Models.sequelize.query(
            `
            SELECT COUNT(*)::int AS total
              FROM platform.persona_negocio pn
            ${filtros};
            `,
            { replacements: { idNegocio, q, qDigitos } }
        );

        return Respuesta.success(res, 'Personas obtenidas', {
            personas: filas,
            total: conteo.total,
            limit,
            offset,
        });
    } catch (error) {
        console.error('Error en listarPersonas:', error);
        return Respuesta.error(res, 'Error al obtener las personas');
    }
}

/**
 * GET /admin/personas/:id/ficha
 * La Ficha 360 de una persona: identidad + actividad agregada + últimos pedidos.
 */
async function getFicha(req, res) {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return Respuesta.error(res, 'Datos de entrada inválidos', 400, errors.array());
        }

        const { id } = req.params;

        const [[persona]] = await Models.sequelize.query(
            `
            SELECT
                pn.id_persona_negocio,
                pn.id_negocio,
                n.nombre                        AS negocio,
                pn.id_persona,
                pn.nombre_mostrado,
                pn.telefono_e164,
                pn.notas,
                pn.etiquetas,
                pn.consentimiento_mensajeria,
                pn.creado_en
              FROM platform.persona_negocio pn
              JOIN general.gener_negocio n ON n.id_negocio = pn.id_negocio
             WHERE pn.id_persona_negocio = :id;
            `,
            { replacements: { id } }
        );

        if (!persona) {
            return Respuesta.error(res, 'Persona no encontrada', 404);
        }

        const [[restaurante]] = await Models.sequelize.query(
            `
            SELECT
                COUNT(*)::int                                              AS pedidos,
                COUNT(*) FILTER (WHERE estado_pago = 'pagado')::int        AS pedidos_pagados,
                COALESCE(SUM(total), 0)                                    AS total_gastado,
                COALESCE(ROUND(AVG(total), 2), 0)                          AS ticket_promedio,
                MIN(fecha_creacion)                                        AS primer_pedido,
                MAX(fecha_creacion)                                        AS ultimo_pedido
              FROM restaurante.pedid_orden
             WHERE id_persona_negocio = :id;
            `,
            { replacements: { id } }
        );

        const [pedidos] = await Models.sequelize.query(
            `
            SELECT id_orden, numero_orden, fecha_creacion, total, estado, estado_pago, tipo_pedido
              FROM restaurante.pedid_orden
             WHERE id_persona_negocio = :id
             ORDER BY fecha_creacion DESC
             LIMIT :limite;
            `,
            { replacements: { id, limite: ULTIMOS_PEDIDOS } }
        );

        return Respuesta.success(res, 'Ficha obtenida', {
            persona,
            actividad: {
                restaurante,
                // Las demás verticales no tienen datos en producción (medición 2026-07-31).
                // Se declaran para que el frontend no tenga que adivinar la forma futura.
                reserva: null,
                gym: null,
                parqueadero: null,
                tienda: null,
            },
            ultimos_pedidos: pedidos,
        });
    } catch (error) {
        console.error('Error en getFicha:', error);
        return Respuesta.error(res, 'Error al obtener la ficha');
    }
}

module.exports = { listarPersonas, getFicha };
