/**
 * Configuración de la emisión de facturación electrónica de un negocio (R6.1 de
 * `docs/plan-fe-restaurante.md`). **Solo super admin**: las rutas llevan `requireSuperAdmin`.
 *
 * Es el alta de un cliente vista desde aquí, en el orden en que ocurre:
 *   1. Guardar las credenciales que entregó el proveedor para ESE negocio (`PUT`).
 *   2. Probar la conexión y comprobar que la empresa es la del negocio (`POST …/probar`).
 *   3. Ver qué prefijos tiene asociados la DIAN y crear el rango en el proveedor
 *      (`GET …/rangos/dian`, `POST …/rangos`): el proveedor no lo toma solo.
 *   4. Sincronizar los rangos y elegir cuál se usa (`POST …/sincronizar`, `PUT …/usar`).
 *   5. Pasar a pruebas o activar (`PATCH …/estado`).
 *
 * Las credenciales entran por aquí y no vuelven a salir: ninguna respuesta las incluye.
 */
'use strict';

const { validationResult } = require('express-validator');

const Respuesta = require('../../app_core/helpers/respuesta');
const datosFiscales = require('../../app_core/facturacion/datosFiscales');
const configuracionDao = require('../../app_core/facturacion/configuracionDao');
const features = require('../../intelligence/core/features');
const { getProveedor } = require('../../app_core/facturacion/proveedores');

function validar(req, res) {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        Respuesta.error(res, 'Datos de entrada inválidos', 400, errors.array());
        return false;
    }
    return true;
}

/** Envuelve un manejador: valida, saca el id y reenvía los errores de dominio sin taparlos. */
function manejar(nombre, fn) {
    return async (req, res) => {
        try {
            if (!validar(req, res)) return;
            await fn(req, res, Number(req.params.id_negocio));
        } catch (error) {
            if (!error.statusCode) console.error(`Error en ${nombre}:`, error);
            Respuesta.error(res, error.message || 'Error en la configuración de facturación', error.statusCode || 500);
        }
    };
}

async function vista(idNegocio) {
    const [config, rangos, puedeEmitir, decision, feature, alertas] = await Promise.all([
        configuracionDao.obtener(idNegocio),
        configuracionDao.listarRangos(idNegocio),
        datosFiscales.puedeEmitir(idNegocio),
        configuracionDao.debeFacturar(idNegocio),
        features.estaHabilitado(idNegocio, features.FEATURE.FACTURACION_ELECTRONICA),
        configuracionDao.alertasDe(idNegocio),
    ]);
    return {
        config,
        rangos,
        puede_emitir: puedeEmitir,
        debe_facturar: { facturar: decision.facturar, motivo: decision.motivo },
        feature,
        alertas,
    };
}

/** Las credenciales y el ambiente con los que se llama al proveedor para este negocio. */
async function acceso(idNegocio) {
    const config = await configuracionDao.obtener(idNegocio);
    const credenciales = await configuracionDao.obtenerCredenciales(idNegocio);
    return { proveedor: getProveedor(config.proveedor), base: { credenciales, ambiente: config.ambiente } };
}

const getConfiguracion = manejar('getConfiguracion', async (req, res, idNegocio) => {
    Respuesta.success(res, 'Configuración de facturación obtenida', await vista(idNegocio));
});

const putConfiguracion = manejar('putConfiguracion', async (req, res, idNegocio) => {
    await configuracionDao.guardar(idNegocio, req.body);
    Respuesta.success(res, 'Configuración guardada', await vista(idNegocio));
});

const probarConexion = manejar('probarConexion', async (req, res, idNegocio) => {
    const { proveedor, base } = await acceso(idNegocio);
    const empresa = await proveedor.probarConexion(base);
    const ficha = await datosFiscales.obtener(idNegocio);
    Respuesta.success(res, 'Conexión correcta', {
        empresa,
        // Si no coincide, esas credenciales son de OTRA empresa: facturaría a nombre de quien no es.
        coincide_nit: Boolean(ficha?.numero_documento) && String(ficha.numero_documento) === String(empresa.nit),
        nit_del_negocio: ficha?.numero_documento ?? null,
    });
});

const sincronizarRangos = manejar('sincronizarRangos', async (req, res, idNegocio) => {
    const { proveedor, base } = await acceso(idNegocio);
    const rangos = await configuracionDao.guardarRangos(idNegocio, await proveedor.listarRangos(base));
    Respuesta.success(res, 'Rangos sincronizados', { rangos });
});

const rangosDian = manejar('rangosDian', async (req, res, idNegocio) => {
    const { proveedor, base } = await acceso(idNegocio);
    Respuesta.success(res, 'Rangos asociados en la DIAN', { rangos: await proveedor.listarRangosDian(base) });
});

const crearRango = manejar('crearRango', async (req, res, idNegocio) => {
    const { proveedor, base } = await acceso(idNegocio);
    const { tipo_documento: tipoDocumento, prefijo, resolucion = null, actual } = req.body;
    const creado = await proveedor.crearRango({ ...base, tipoDocumento, prefijo, resolucion, actual });
    const rangos = await configuracionDao.guardarRangos(idNegocio, await proveedor.listarRangos(base));
    Respuesta.success(res, 'Rango creado', { creado, rangos }, 201);
});

const usarRango = manejar('usarRango', async (req, res, idNegocio) => {
    await configuracionDao.usarRango(idNegocio, req.params.id_resolucion);
    Respuesta.success(res, 'Rango en uso', { rangos: await configuracionDao.listarRangos(idNegocio) });
});

const cambiarEstado = manejar('cambiarEstado', async (req, res, idNegocio) => {
    await configuracionDao.cambiarEstado(idNegocio, req.body.estado, req.usuario?.id_usuario ?? null);
    Respuesta.success(res, 'Estado actualizado', await vista(idNegocio));
});

module.exports = {
    getConfiguracion,
    putConfiguracion,
    probarConexion,
    sincronizarRangos,
    rangosDian,
    crearRango,
    usarRango,
    cambiarEstado,
};
