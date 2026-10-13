'use strict';
const Models = require('../../app_core/models/conection');
const { usuarioTieneSubnivel } = require('../../app_core/helpers/permisoSubnivel');

/**
 * rubroService — los sectores de ingreso del negocio.
 *
 * Un restaurante con tres tipos de comida (parrilla, sushi, pizza) quiere saber cuánto deja
 * cada uno, aunque una misma mesa pida de los tres y pague una sola vez. Eso es un rubro.
 *
 * ## Por qué no son cajas
 *
 * `rest_punto_caja` ya existe y parece lo mismo, pero no sirve aquí: `pedid_orden.id_punto_caja`
 * es NOT NULL, así que una orden cae entera en una caja y el pedido mixto no se puede
 * representar. Además las cajas cuentan contra el tope del plan. La diferencia de fondo es el
 * nivel en el que vive la atribución: la caja es de la ORDEN (su turno, su arqueo), el rubro es
 * del ÍTEM.
 *
 * ## Dónde vive el vínculo
 *
 * En `carta_categoria.id_rubro`, nullable. El producto no lleva columna: hereda la de su
 * categoría. Una sola fuente de verdad, y la mitad del trabajo — el POS y los informes ya
 * agrupan por categoría. NULL = «General»: se vende en todos los sectores (bebidas, mecato).
 *
 * ## Permisos
 *
 * Escribir exige `caja_gestionar`, el mismo subnivel de las cajas: es la misma decisión (cómo se
 * parte el ingreso), la toma la misma persona y vive en la misma pantalla. Leer no exige nada —
 * los informes y el cierre de caja necesitan la lista para pintarse.
 */

const SUBNIVEL_GESTIONAR = 'caja_gestionar';

/**
 * Colores de arranque, en orden. Se asigna el primero libre al crear un rubro sin color para que
 * las gráficas salgan legibles sin que nadie elija nada. Son los de la paleta categórica del
 * sistema de diseño, no los del inquilino: un rubro tiene que distinguirse de los demás rubros,
 * no combinar con la marca.
 */
const COLORES = [
    '#4F46E5', '#0EA5E9', '#10B981', '#F59E0B',
    '#EC4899', '#8B5CF6', '#14B8A6', '#EF4444',
];

const sequelize = Models.sequelize;

function errorTipado(mensaje, code, statusCode) {
    const err = new Error(mensaje);
    err.code = code;
    err.statusCode = statusCode;
    return err;
}

async function exigirPermiso({ idUsuario, idNegocio }) {
    const puede = await usuarioTieneSubnivel({
        idUsuario, idNegocio, codigo: SUBNIVEL_GESTIONAR,
    });
    if (!puede) {
        throw errorTipado(
            'No tienes permiso para gestionar los sectores de ingreso del negocio.',
            'SIN_PERMISO_RUBROS',
            403,
        );
    }
}

// ── Lectura ───────────────────────────────────────────────────────────────────────────────

/**
 * ¿Este negocio separa sus ingresos por sector?
 *
 * Es la pregunta que decide si aparece la pestaña de informes por rubro y el desglose del
 * cierre de caja. No hay interruptor en `gener_negocio`: lo contesta el propio dato, y un
 * negocio que no creó ningún rubro nunca ve nada nuevo.
 */
async function negocioUsaRubros(idNegocio, { transaction } = {}) {
    const n = Number(idNegocio);
    if (!Number.isInteger(n) || n <= 0) return false;
    const filas = await sequelize.query(
        `SELECT 1 FROM restaurante.rest_rubro
          WHERE id_negocio = :idNegocio AND estado = 'A' LIMIT 1;`,
        { replacements: { idNegocio: n }, transaction, type: sequelize.QueryTypes.SELECT },
    );
    return filas.length > 0;
}

/** Los rubros activos, en su orden, mínimos: lo que necesitan los selectores y las gráficas. */
async function listarActivos(idNegocio, { transaction } = {}) {
    const filas = await sequelize.query(
        `SELECT id_rubro, nombre, color, orden
           FROM restaurante.rest_rubro
          WHERE id_negocio = :idNegocio AND estado = 'A'
          ORDER BY orden, nombre;`,
        { replacements: { idNegocio }, transaction, type: sequelize.QueryTypes.SELECT },
    );
    return filas.map((r) => ({
        id_rubro: Number(r.id_rubro),
        nombre: r.nombre,
        color: r.color || null,
        orden: Number(r.orden || 0),
    }));
}

/**
 * Listado de administración: todos los rubros (activos e inactivos) con las categorías que
 * tienen asignadas, más las categorías que están en «General» — el panel necesita las dos
 * cosas para dejar repartir sin pedir otra consulta.
 */
async function listarAdmin({ idNegocio }) {
    const [rubros, categorias] = await Promise.all([
        sequelize.query(
            `SELECT r.id_rubro, r.nombre, r.descripcion, r.color, r.orden, r.estado,
                    COUNT(c.id_categoria)::int AS categorias
               FROM restaurante.rest_rubro r
               LEFT JOIN restaurante.carta_categoria c
                      ON c.id_rubro = r.id_rubro AND c.estado = 'A'
              WHERE r.id_negocio = :idNegocio
              GROUP BY r.id_rubro, r.nombre, r.descripcion, r.color, r.orden, r.estado
              ORDER BY r.estado, r.orden, r.nombre;`,
            { replacements: { idNegocio }, type: sequelize.QueryTypes.SELECT },
        ),
        sequelize.query(
            `SELECT c.id_categoria, c.nombre, c.id_rubro,
                    (SELECT COUNT(*)::int FROM restaurante.carta_producto p
                      WHERE p.id_categoria = c.id_categoria AND p.estado = 'A') AS productos
               FROM restaurante.carta_categoria c
              WHERE c.id_negocio = :idNegocio AND c.estado = 'A'
              ORDER BY c.orden, c.nombre;`,
            { replacements: { idNegocio }, type: sequelize.QueryTypes.SELECT },
        ),
    ]);

    return {
        rows: rubros.map((r) => ({
            id_rubro: Number(r.id_rubro),
            nombre: r.nombre,
            descripcion: r.descripcion || null,
            color: r.color || null,
            orden: Number(r.orden || 0),
            estado: r.estado,
            categorias: Number(r.categorias || 0),
        })),
        categorias: categorias.map((c) => ({
            id_categoria: Number(c.id_categoria),
            nombre: c.nombre,
            id_rubro: c.id_rubro == null ? null : Number(c.id_rubro),
            productos: Number(c.productos || 0),
        })),
    };
}

// ── Escritura ─────────────────────────────────────────────────────────────────────────────

function limpiarNombre(raw) {
    const nombre = String(raw || '').trim();
    if (nombre.length < 2 || nombre.length > 60) {
        throw errorTipado('El nombre del sector debe tener entre 2 y 60 caracteres.', 'NOMBRE_INVALIDO', 422);
    }
    return nombre;
}

function limpiarColor(raw) {
    if (raw == null || raw === '') return null;
    const color = String(raw).trim();
    if (!/^#[0-9a-fA-F]{6}$/.test(color)) {
        throw errorTipado('El color debe venir en formato #RRGGBB.', 'COLOR_INVALIDO', 422);
    }
    return color.toUpperCase();
}

/** El primer color de la paleta que todavía no use ningún rubro del negocio. */
async function colorLibre(idNegocio, transaction) {
    const usados = await sequelize.query(
        `SELECT DISTINCT upper(color) AS color FROM restaurante.rest_rubro
          WHERE id_negocio = :idNegocio AND color IS NOT NULL;`,
        { replacements: { idNegocio }, transaction, type: sequelize.QueryTypes.SELECT },
    );
    const ocupados = new Set(usados.map((u) => u.color));
    return COLORES.find((c) => !ocupados.has(c)) || COLORES[0];
}

async function crear({ idNegocio, idUsuario, nombre, descripcion = null, color = null }) {
    await exigirPermiso({ idUsuario, idNegocio });
    const limpio = limpiarNombre(nombre);
    const colorLimpio = limpiarColor(color);

    return sequelize.transaction(async (t) => {
        const [[existe]] = await sequelize.query(
            `SELECT 1 AS ok FROM restaurante.rest_rubro
              WHERE id_negocio = :idNegocio AND lower(nombre) = lower(:nombre) LIMIT 1;`,
            { replacements: { idNegocio, nombre: limpio }, transaction: t },
        );
        if (existe) {
            throw errorTipado(`Ya tienes un sector llamado «${limpio}».`, 'RUBRO_DUPLICADO', 409);
        }

        const [[{ siguiente }]] = await sequelize.query(
            `SELECT COALESCE(MAX(orden), -1) + 1 AS siguiente FROM restaurante.rest_rubro
              WHERE id_negocio = :idNegocio;`,
            { replacements: { idNegocio }, transaction: t },
        );

        const [[fila]] = await sequelize.query(
            `INSERT INTO restaurante.rest_rubro (id_negocio, nombre, descripcion, color, orden)
             VALUES (:idNegocio, :nombre, :descripcion, :color, :orden)
             RETURNING id_rubro, nombre, descripcion, color, orden, estado;`,
            {
                replacements: {
                    idNegocio,
                    nombre: limpio,
                    descripcion: String(descripcion || '').trim() || null,
                    color: colorLimpio || await colorLibre(idNegocio, t),
                    orden: Number(siguiente || 0),
                },
                transaction: t,
            },
        );
        return fila;
    });
}

async function actualizar({ idRubro, idNegocio, idUsuario, nombre, descripcion, color, estado }) {
    await exigirPermiso({ idUsuario, idNegocio });

    return sequelize.transaction(async (t) => {
        const [[actual]] = await sequelize.query(
            `SELECT id_rubro, nombre FROM restaurante.rest_rubro
              WHERE id_rubro = :idRubro AND id_negocio = :idNegocio
              FOR UPDATE;`,
            { replacements: { idRubro, idNegocio }, transaction: t },
        );
        if (!actual) {
            throw errorTipado('Ese sector no existe en este negocio.', 'RUBRO_NO_ENCONTRADO', 404);
        }

        const patch = {};
        if (nombre !== undefined) {
            const limpio = limpiarNombre(nombre);
            const [[choca]] = await sequelize.query(
                `SELECT 1 AS ok FROM restaurante.rest_rubro
                  WHERE id_negocio = :idNegocio AND lower(nombre) = lower(:nombre)
                    AND id_rubro <> :idRubro LIMIT 1;`,
                { replacements: { idNegocio, nombre: limpio, idRubro }, transaction: t },
            );
            if (choca) {
                throw errorTipado(`Ya tienes un sector llamado «${limpio}».`, 'RUBRO_DUPLICADO', 409);
            }
            patch.nombre = limpio;
        }
        if (descripcion !== undefined) {
            patch.descripcion = String(descripcion || '').trim() || null;
        }
        if (color !== undefined) {
            patch.color = limpiarColor(color);
        }
        if (estado !== undefined) {
            if (estado !== 'A' && estado !== 'I') {
                throw errorTipado('El estado del sector solo puede ser A o I.', 'ESTADO_INVALIDO', 422);
            }
            patch.estado = estado;
        }

        const campos = Object.keys(patch);
        if (campos.length === 0) return { id_rubro: Number(idRubro) };

        // Desactivar NO desasigna las categorías: el histórico de informes tiene que seguir
        // sabiendo de qué sector era cada venta. El rubro inactivo simplemente deja de
        // ofrecerse para repartir categorías nuevas.
        await sequelize.query(
            `UPDATE restaurante.rest_rubro
                SET ${campos.map((c) => `${c} = :${c}`).join(', ')}, actualizado_en = now()
              WHERE id_rubro = :idRubro AND id_negocio = :idNegocio;`,
            { replacements: { ...patch, idRubro, idNegocio }, transaction: t },
        );
        return { id_rubro: Number(idRubro), ...patch };
    });
}

/**
 * Fija de una vez las categorías de un sector. Es como lo usa la pantalla: el administrador
 * marca las casillas y guarda.
 *
 * Una categoría solo puede estar en un sector (es una columna, no una tabla puente), así que
 * marcarla aquí la saca sola del sector donde estuviera. Las que se desmarcan vuelven a
 * «General» (`id_rubro = NULL`).
 */
async function fijarCategorias({ idRubro, idNegocio, idUsuario, idsCategoria = [] }) {
    await exigirPermiso({ idUsuario, idNegocio });

    const ids = [...new Set(
        (Array.isArray(idsCategoria) ? idsCategoria : [])
            .map(Number)
            .filter((n) => Number.isInteger(n) && n > 0),
    )];

    return sequelize.transaction(async (t) => {
        const [[rubro]] = await sequelize.query(
            `SELECT id_rubro FROM restaurante.rest_rubro
              WHERE id_rubro = :idRubro AND id_negocio = :idNegocio;`,
            { replacements: { idRubro, idNegocio }, transaction: t },
        );
        if (!rubro) {
            throw errorTipado('Ese sector no existe en este negocio.', 'RUBRO_NO_ENCONTRADO', 404);
        }

        // Las que ya no están marcadas vuelven a «General». Con la lista vacía se pasa [0]:
        // ninguna categoría tiene id 0, así que el NOT ... ANY vale para todas y el sector
        // queda sin ninguna, que es lo que significa desmarcarlas todas.
        await sequelize.query(
            `UPDATE restaurante.carta_categoria
                SET id_rubro = NULL
              WHERE id_negocio = :idNegocio AND id_rubro = :idRubro
                AND NOT (id_categoria = ANY(ARRAY[:ids]::int[]));`,
            { replacements: { idNegocio, idRubro, ids: ids.length ? ids : [0] }, transaction: t },
        );

        // Y las marcadas pasan a este sector. El `id_negocio` del WHERE es lo que impide que
        // llegue por la API el id de una categoría de otro inquilino.
        let asignadas = 0;
        if (ids.length > 0) {
            const [, meta] = await sequelize.query(
                `UPDATE restaurante.carta_categoria
                    SET id_rubro = :idRubro
                  WHERE id_negocio = :idNegocio AND id_categoria = ANY(ARRAY[:ids]::int[])
                    AND (id_rubro IS NULL OR id_rubro <> :idRubro);`,
                { replacements: { idNegocio, idRubro, ids }, transaction: t },
            );
            asignadas = Number(meta?.rowCount ?? 0);
        }

        return { id_rubro: Number(idRubro), categorias: ids.length, movidas: asignadas };
    });
}

/**
 * Borra un sector de verdad. Las categorías que lo tuvieran vuelven a «General» por el
 * `ON DELETE SET NULL` de la FK — y con eso el histórico de informes deja de verlas separadas,
 * que es justo lo que significa borrar un sector. Para conservar el histórico, desactivar.
 */
async function eliminar({ idRubro, idNegocio, idUsuario }) {
    await exigirPermiso({ idUsuario, idNegocio });

    const [, meta] = await sequelize.query(
        `DELETE FROM restaurante.rest_rubro
          WHERE id_rubro = :idRubro AND id_negocio = :idNegocio;`,
        { replacements: { idRubro, idNegocio } },
    );
    if (Number(meta?.rowCount ?? 0) === 0) {
        throw errorTipado('Ese sector no existe en este negocio.', 'RUBRO_NO_ENCONTRADO', 404);
    }
    return { id_rubro: Number(idRubro) };
}

module.exports = {
    COLORES,
    negocioUsaRubros,
    listarActivos,
    listarAdmin,
    crear,
    actualizar,
    fijarCategorias,
    eliminar,
};
