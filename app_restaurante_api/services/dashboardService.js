const Models = require('../../app_core/models/conection');

/**
 * dashboardService — Lógica de negocio para el módulo restaurante.
 */

/**
 * Verifica que el usuario tenga acceso a al menos un negocio de tipo restaurante.
 * Retorna los datos del usuario, su negocio(s) de restaurante y roles.
 *
 * @param {number} idUsuario
 * @returns {Object|null} { usuario, negocio, roles } o null si no tiene acceso
 */
async function verificarAccesoRestaurante(idUsuario) {
    // 1. Obtener datos del usuario
    const usuario = await Models.GenerUsuario.findOne({
        where: { id_usuario: idUsuario, estado: 'A' },
        attributes: ['id_usuario', 'primer_nombre', 'segundo_nombre', 'primer_apellido',
                     'segundo_apellido', 'email', 'num_identificacion'],
    });

    if (!usuario) return null;

    // 2. Obtener negocios del usuario que sean de tipo restaurante
    // (tipo_negocio con nombre que contenga "restaurante" o similar)
    const negociosUsuario = await Models.GenerNegocioUsuario.findAll({
        where: { id_usuario: idUsuario, estado: 'A' },
        include: [{
            model: Models.GenerNegocio,
            as: 'negocio',
            where: { estado: 'A' },
            required: true,
            include: [
                {
                    model: Models.GenerTipoNegocio,
                    as: 'tipoNegocio',
                    attributes: ['id_tipo_negocio', 'nombre'],
                },
                {
                    model: Models.GenerPaletaColor,
                    as: 'paletaColor',
                    attributes: ['id_paleta', 'nombre', 'colores'],
                },
            ],
            attributes: ['id_negocio', 'nombre', 'id_tipo_negocio', 'id_paleta'],
        }],
    });

    if (!negociosUsuario || negociosUsuario.length === 0) return null;

    // 3. Obtener roles del usuario en esos negocios
    const idNegocios = negociosUsuario.map(nu => nu.negocio.id_negocio);

    const rolesUsuario = await Models.GenerUsuarioRol.findAll({
        where: { id_usuario: idUsuario, estado: 'A', id_negocio: idNegocios },
        include: [{
            model: Models.GenerRol,
            as: 'rol',
            attributes: ['id_rol', 'descripcion'],
        }],
    });

    // Agrupar por negocio
    const negocios = negociosUsuario.map(nu => {
        const negocio = nu.negocio;
        const roles = rolesUsuario
            .filter(r => r.id_negocio === negocio.id_negocio)
            .map(r => ({ id_rol: r.rol.id_rol, descripcion: r.rol.descripcion }));

        return {
            id_negocio: negocio.id_negocio,
            nombre: negocio.nombre,
            tipo_negocio: negocio.tipoNegocio
                ? negocio.tipoNegocio.nombre
                : null,
            paleta: negocio.paletaColor || null,
            roles,
        };
    });

    // Roles globales (sin negocio asociado, ej: Super Admin)
    const rolesGlobales = await Models.GenerUsuarioRol.findAll({
        where: { id_usuario: idUsuario, estado: 'A', id_negocio: null },
        include: [{ model: Models.GenerRol, as: 'rol', attributes: ['id_rol', 'descripcion'] }],
    });

    return {
        usuario: {
            id_usuario: usuario.id_usuario,
            nombre_completo: `${usuario.primer_nombre} ${usuario.primer_apellido}`,
            primer_nombre: usuario.primer_nombre,
            primer_apellido: usuario.primer_apellido,
            email: usuario.email,
        },
        negocios,
        negocio: negocios[0] || null, // Negocio principal (el primero)
        roles: negocios[0]?.roles || [],
        roles_globales: rolesGlobales.map(r => ({
            id_rol: r.rol.id_rol,
            descripcion: r.rol.descripcion,
        })),
    };
}

/**
 * Obtiene datos resumidos para el dashboard.
 * (Placeholder — retorna datos de ejemplo. Se completará con tablas reales.)
 *
 * @param {number} idUsuario
 * @returns {Object}
 */
async function getResumenDashboard(idUsuario) {
    // TODO: Reemplazar con consultas reales cuando existan las tablas
    //       de pedidos, mesas, productos, etc.
    return {
        kpis: {
            ventas_dia: { valor: 0, meta: 5000, tendencia: 0 },
            pedidos_totales: { valor: 0, en_proceso: 0, tendencia: 0 },
            mesas_ocupadas: { ocupadas: 0, total: 0 },
            calificacion: { valor: 0, resenas: 0, tendencia: 0 },
        },
        ultimos_pedidos: [],
        ventas_por_hora: [],
    };
}

module.exports = {
    verificarAccesoRestaurante,
    getResumenDashboard,
};
