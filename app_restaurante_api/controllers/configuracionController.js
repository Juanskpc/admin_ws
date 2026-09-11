const { validationResult } = require('express-validator');

const ConfiguracionService = require('../services/configuracionService');
const Respuesta = require('../../app_core/helpers/respuesta');

function getValidationErrors(req, res) {
    const errors = validationResult(req);
    if (errors.isEmpty()) return null;
    return Respuesta.error(res, 'Datos de entrada invalidos', 400, errors.array());
}

function resolveStatusCode(error) {
    return Number(error?.statusCode || 500);
}

/**
 * Campos que el negocio puede cambiar desde Configuración.
 *
 * Es UNA lista y no un objeto copiado campo por campo porque esa copia ya se dejó atrás dos
 * banderas —`permite_cuentas_cliente` y `controla_inventario`—, y el síntoma no señalaba a
 * ningún sitio: el interruptor llegaba al servidor, el validador lo daba por bueno, y el
 * servicio contestaba «No se enviaron cambios para guardar» porque el campo se había caído
 * aquí en medio. Añadir una opción nueva es añadir una palabra a esta lista.
 *
 * Sigue siendo lista blanca, que es lo que importa: lo que no esté aquí no llega a la base,
 * aunque alguien lo mande en el cuerpo.
 */
const CAMPOS_EDITABLES = [
    'nombre',
    'nit',
    'email_contacto',
    'telefono',
    'direccion',
    'url_whatsapp',
    'url_facebook',
    'url_instagram',
    'permite_multipago',
    'permite_pago_domicilio',
    'permite_descuento',
    'pregunta_cobro_envio',
    'permite_cuentas_cliente',
    'controla_inventario',
    'id_paleta',
];

async function getConfiguracion(req, res) {
    try {
        const validationError = getValidationErrors(req, res);
        if (validationError) return validationError;

        const idUsuario = req.usuario.id_usuario;
        const idNegocio = req.query.id_negocio ? Number(req.query.id_negocio) : null;

        const data = await ConfiguracionService.getConfiguracionNegocio(idUsuario, idNegocio);
        return Respuesta.success(res, 'Configuracion obtenida', data);
    } catch (error) {
        console.error('[Configuracion] Error getConfiguracion:', error.message);
        return Respuesta.error(res, error.message || 'Error al obtener la configuracion.', resolveStatusCode(error));
    }
}

async function updateConfiguracion(req, res) {
    try {
        const validationError = getValidationErrors(req, res);
        if (validationError) return validationError;

        const idUsuario = req.usuario.id_usuario;
        const payload = {
            id_negocio: req.body.id_negocio ? Number(req.body.id_negocio) : null,
        };
        // Solo viaja lo que venga en el cuerpo: el servicio distingue «no lo mandaron» de
        // «lo mandaron vacío», y copiar los ausentes como undefined le quitaba esa señal.
        for (const campo of CAMPOS_EDITABLES) {
            if (req.body[campo] !== undefined) payload[campo] = req.body[campo];
        }

        const data = await ConfiguracionService.updateConfiguracionNegocio(idUsuario, payload);
        return Respuesta.success(res, 'Configuracion actualizada', data);
    } catch (error) {
        console.error('[Configuracion] Error updateConfiguracion:', error.message);
        return Respuesta.error(res, error.message || 'Error al actualizar la configuracion.', resolveStatusCode(error));
    }
}

async function getPaletas(req, res) {
    try {
        const paletas = await ConfiguracionService.getPaletasActivas();
        return Respuesta.success(res, 'Paletas obtenidas', paletas);
    } catch (error) {
        console.error('[Configuracion] Error getPaletas:', error.message);
        return Respuesta.error(res, 'Error al obtener paletas de colores.');
    }
}

async function getPaletaNegocio(req, res) {
    try {
        const validationError = getValidationErrors(req, res);
        if (validationError) return validationError;

        const idUsuario = req.usuario.id_usuario;
        const idNegocio = Number(req.params.id);
        const paleta = await ConfiguracionService.getPaletaNegocio(idUsuario, idNegocio);

        if (!paleta) {
            return Respuesta.error(res, 'No se encontro paleta para este negocio.', 404);
        }

        return Respuesta.success(res, 'Paleta del negocio obtenida', paleta);
    } catch (error) {
        console.error('[Configuracion] Error getPaletaNegocio:', error.message);
        return Respuesta.error(res, error.message || 'Error al obtener la paleta del negocio.', resolveStatusCode(error));
    }
}

async function assignPaletaNegocio(req, res) {
    try {
        const validationError = getValidationErrors(req, res);
        if (validationError) return validationError;

        const idUsuario = req.usuario.id_usuario;
        const idNegocio = Number(req.params.id);
        const idPaleta = Number(req.body.id_paleta);

        const paleta = await ConfiguracionService.updatePaletaNegocio(idUsuario, idNegocio, idPaleta);
        return Respuesta.success(res, 'Paleta asignada correctamente', paleta);
    } catch (error) {
        console.error('[Configuracion] Error assignPaletaNegocio:', error.message);
        return Respuesta.error(res, error.message || 'Error al asignar la paleta.', resolveStatusCode(error));
    }
}

module.exports = {
    getConfiguracion,
    updateConfiguracion,
    getPaletas,
    getPaletaNegocio,
    assignPaletaNegocio,
};
