const Models = require('../../app_core/models/conection');
const DashboardService = require('./dashboardService');

function esRolAdministrador(descripcion = '') {
    return String(descripcion).toUpperCase().includes('ADMIN');
}

function cleanNullableString(value) {
    if (value === undefined) return undefined;
    if (value === null) return null;

    const text = String(value).trim();
    return text.length > 0 ? text : null;
}

async function resolveAccesoNegocio(idUsuario, idNegocio = null) {
    const acceso = await DashboardService.verificarAccesoRestaurante(idUsuario);
    if (!acceso?.negocios?.length) {
        const error = new Error('No tienes acceso al modulo de restaurante.');
        error.statusCode = 403;
        throw error;
    }

    const negocio = idNegocio
        ? acceso.negocios.find((item) => item.id_negocio === Number(idNegocio))
        : (acceso.negocio || acceso.negocios[0]);

    if (!negocio) {
        const error = new Error('No tienes acceso al negocio solicitado.');
        error.statusCode = 403;
        throw error;
    }

    const roles = [
        ...(negocio.roles || []),
        ...(acceso.roles_globales || []),
    ];

    const canEdit = roles.some((rol) => esRolAdministrador(rol?.descripcion));

    return {
        idNegocio: negocio.id_negocio,
        roles,
        canEdit,
    };
}

async function getPaletasActivas() {
    return Models.GenerPaletaColor.findAll({
        where: { estado: 'A' },
        attributes: ['id_paleta', 'nombre', 'descripcion', 'colores', 'es_default'],
        order: [['es_default', 'DESC'], ['nombre', 'ASC']],
    });
}

async function getPaletaNegocio(idUsuario, idNegocio) {
    const acceso = await resolveAccesoNegocio(idUsuario, idNegocio);

    const negocio = await Models.GenerNegocio.findOne({
        where: { id_negocio: acceso.idNegocio, estado: 'A' },
        attributes: ['id_negocio', 'id_paleta'],
        include: [
            {
                model: Models.GenerPaletaColor,
                as: 'paletaColor',
                required: false,
                where: { estado: 'A' },
                attributes: ['id_paleta', 'nombre', 'descripcion', 'colores', 'es_default'],
            },
        ],
    });

    if (!negocio) {
        const error = new Error('Negocio no encontrado.');
        error.statusCode = 404;
        throw error;
    }

    if (negocio.paletaColor) {
        return negocio.paletaColor;
    }

    return Models.GenerPaletaColor.findOne({
        where: { estado: 'A', es_default: true },
        attributes: ['id_paleta', 'nombre', 'descripcion', 'colores', 'es_default'],
    });
}

async function getConfiguracionNegocio(idUsuario, idNegocio = null) {
    const acceso = await resolveAccesoNegocio(idUsuario, idNegocio);

    const negocio = await Models.GenerNegocio.findOne({
        where: {
            id_negocio: acceso.idNegocio,
            estado: 'A',
        },
        attributes: [
            'id_negocio',
            'nombre',
            'nit',
            'email_contacto',
            'telefono',
            'id_tipo_negocio',
            'id_paleta',
            'fecha_registro',
        ],
        include: [
            {
                model: Models.GenerTipoNegocio,
                as: 'tipoNegocio',
                attributes: ['id_tipo_negocio', 'nombre'],
                required: false,
            },
            {
                model: Models.GenerPaletaColor,
                as: 'paletaColor',
                attributes: ['id_paleta', 'nombre', 'descripcion', 'colores', 'es_default'],
                required: false,
            },
        ],
    });

    if (!negocio) {
        const error = new Error('Negocio no encontrado.');
        error.statusCode = 404;
        throw error;
    }

    return {
        id_negocio: negocio.id_negocio,
        nombre: negocio.nombre,
        nit: negocio.nit,
        email_contacto: negocio.email_contacto,
        telefono: negocio.telefono,
        id_tipo_negocio: negocio.id_tipo_negocio,
        tipo_negocio: negocio.tipoNegocio?.nombre || null,
        id_paleta: negocio.id_paleta,
        paleta: negocio.paletaColor || null,
        fecha_registro: negocio.fecha_registro,
        roles: acceso.roles,
        can_edit: acceso.canEdit,
    };
}

async function updateConfiguracionNegocio(idUsuario, payload = {}) {
    const acceso = await resolveAccesoNegocio(idUsuario, payload.id_negocio || null);

    if (!acceso.canEdit) {
        const error = new Error('No tienes permisos para actualizar la configuracion del negocio.');
        error.statusCode = 403;
        throw error;
    }

    const negocio = await Models.GenerNegocio.findOne({
        where: {
            id_negocio: acceso.idNegocio,
            estado: 'A',
        },
    });

    if (!negocio) {
        const error = new Error('Negocio no encontrado.');
        error.statusCode = 404;
        throw error;
    }

    const patch = {};

    if (payload.nombre !== undefined) {
        patch.nombre = String(payload.nombre).trim();
    }

    if (payload.nit !== undefined) {
        patch.nit = cleanNullableString(payload.nit);
    }

    if (payload.email_contacto !== undefined) {
        patch.email_contacto = cleanNullableString(payload.email_contacto);
    }

    if (payload.telefono !== undefined) {
        patch.telefono = cleanNullableString(payload.telefono);
    }

    if (payload.id_paleta !== undefined) {
        if (payload.id_paleta === null) {
            patch.id_paleta = null;
        } else {
            const idPaleta = Number(payload.id_paleta);
            const paleta = await Models.GenerPaletaColor.findOne({
                where: { id_paleta: idPaleta, estado: 'A' },
                attributes: ['id_paleta'],
            });

            if (!paleta) {
                const error = new Error('La paleta seleccionada no existe o esta inactiva.');
                error.statusCode = 404;
                throw error;
            }

            patch.id_paleta = idPaleta;
        }
    }

    if (Object.keys(patch).length === 0) {
        const error = new Error('No se enviaron cambios para guardar.');
        error.statusCode = 400;
        throw error;
    }

    try {
        await negocio.update(patch);
    } catch (err) {
        if (err?.name === 'SequelizeUniqueConstraintError') {
            const error = new Error('Ya existe otro negocio con ese NIT.');
            error.statusCode = 409;
            throw error;
        }
        throw err;
    }

    return getConfiguracionNegocio(idUsuario, acceso.idNegocio);
}

async function updatePaletaNegocio(idUsuario, idNegocio, idPaleta) {
    const payload = {
        id_negocio: idNegocio,
        id_paleta: idPaleta,
    };

    const config = await updateConfiguracionNegocio(idUsuario, payload);
    return config.paleta;
}

module.exports = {
    getPaletasActivas,
    getPaletaNegocio,
    getConfiguracionNegocio,
    updateConfiguracionNegocio,
    updatePaletaNegocio,
};
