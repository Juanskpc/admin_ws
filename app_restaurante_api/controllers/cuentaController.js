'use strict';

const { validationResult } = require('express-validator');
const Respuesta = require('../../app_core/helpers/respuesta');
const Audit = require('../../app_core/helpers/auditHelper');
const { setAuditNegocio } = require('../../app_core/middleware/auditContext');
const { usuarioTieneSubnivel } = require('../../app_core/helpers/permisoSubnivel');
const CuentaService = require('../services/cuentaService');
const Models = require('../../app_core/models/conection');

/**
 * cuentaController — cuentas de cliente del restaurante (tiqueteras y fiado).
 *
 * Dos comprobaciones de permiso **en el servidor**, no solo en la pantalla:
 *
 *   clientes_abonar   → vender una tiquetera o recibir el pago de una cuenta (entra plata).
 *   clientes_ajustar  → mover un saldo sin que entre plata: perdonar una deuda, regalar un
 *                       almuerzo. Es la operación que permite hacer desaparecer dinero sin
 *                       rastro en caja, así que va aparte y el cajero no la tiene.
 *
 * Que el frontend esconda los botones es cosmético: un `curl` no ve botones.
 */

const SUB_ABONAR = 'clientes_abonar';
const SUB_AJUSTAR = 'clientes_ajustar';

/**
 * Las cuentas de cliente son opt-in por negocio (`permite_cuentas_cliente`).
 *
 * Se comprueba **en el servidor** y no solo escondiendo el menú: esconder un botón no cierra
 * una API. Mientras el negocio no lo encienda en Configuración, estas rutas no existen para
 * él — que es lo que permite desplegar el módulo sin que le aparezca a nadie que no lo pidió.
 */
async function exigirCuentasHabilitadas(req, res) {
    const idNegocio = Number(req.body?.id_negocio ?? req.query?.id_negocio);
    if (!idNegocio) {
        Respuesta.error(res, 'id_negocio es obligatorio.', 400);
        return false;
    }

    const negocio = await Models.GenerNegocio.findByPk(idNegocio, {
        attributes: ['id_negocio', 'permite_cuentas_cliente'],
    });
    if (!negocio?.permite_cuentas_cliente) {
        Respuesta.error(
            res,
            'Este negocio no tiene activadas las cuentas de cliente. Actívalas en Configuración.',
            403,
            { code: 'CUENTAS_NO_HABILITADAS' },
        );
        return false;
    }
    return true;
}

function handleValidation(req, res) {
    const errors = validationResult(req);
    if (errors.isEmpty()) return true;
    Respuesta.error(res, 'Datos inválidos', 400, errors.array());
    return false;
}

/** Traduce los errores tipados del servicio sin reescribirlos. */
function responderError(res, err, mensajePorDefecto) {
    if (err.statusCode) {
        return Respuesta.error(res, err.message, err.statusCode, { code: err.code });
    }
    console.error(`[Clientes] ${mensajePorDefecto}:`, err.message);
    return Respuesta.error(res, mensajePorDefecto);
}

async function exigirSubnivel(req, res, codigo) {
    const permitido = await usuarioTieneSubnivel({
        idUsuario: req.usuario.id_usuario,
        idNegocio: Number(req.body.id_negocio ?? req.query.id_negocio),
        codigo,
        // El administrador NO lo hereda por ser administrador en el caso de los ajustes: el
        // dueño puede querer dárselo a una sola persona. Se concede explícitamente.
        adminSiempre: codigo !== SUB_AJUSTAR,
    });
    if (!permitido) {
        Respuesta.error(res, 'No tienes permiso para esta acción.', 403, { code: 'SIN_PERMISO' });
        return false;
    }
    return true;
}

/** GET /restaurante/clientes?id_negocio=N&busqueda=&filtro=todos|deben|a_favor */
async function listar(req, res) {
    if (!handleValidation(req, res)) return;
    if (!(await exigirCuentasHabilitadas(req, res))) return;
    try {
        const cuentas = await CuentaService.listarCuentas({
            idNegocio: Number(req.query.id_negocio),
            busqueda: req.query.busqueda || null,
            filtro: req.query.filtro || 'todos',
            limite: req.query.limite,
            offset: req.query.offset,
        });
        return Respuesta.success(res, 'Cuentas de cliente', cuentas);
    } catch (err) {
        return responderError(res, err, 'Error al listar las cuentas');
    }
}

/** GET /restaurante/clientes/:id?id_negocio=N */
async function detalle(req, res) {
    if (!handleValidation(req, res)) return;
    if (!(await exigirCuentasHabilitadas(req, res))) return;
    try {
        const cuenta = await CuentaService.getCuenta({
            idNegocio: Number(req.query.id_negocio),
            idCuenta: Number(req.params.id),
        });
        if (!cuenta) return Respuesta.error(res, 'La cuenta no existe.', 404);
        return Respuesta.success(res, 'Cuenta', cuenta);
    } catch (err) {
        return responderError(res, err, 'Error al consultar la cuenta');
    }
}

/** GET /restaurante/clientes/:id/movimientos?id_negocio=N */
async function movimientos(req, res) {
    if (!handleValidation(req, res)) return;
    if (!(await exigirCuentasHabilitadas(req, res))) return;
    try {
        const filas = await CuentaService.listarMovimientos({
            idNegocio: Number(req.query.id_negocio),
            idCuenta: Number(req.params.id),
            limite: req.query.limite,
            offset: req.query.offset,
        });
        return Respuesta.success(res, 'Movimientos de la cuenta', filas);
    } catch (err) {
        return responderError(res, err, 'Error al consultar los movimientos');
    }
}

/** POST /restaurante/clientes */
async function crear(req, res) {
    if (!handleValidation(req, res)) return;
    if (!(await exigirCuentasHabilitadas(req, res))) return;
    try {
        const idNegocio = Number(req.body.id_negocio);
        setAuditNegocio(idNegocio);

        const cuenta = await CuentaService.crearCuenta({
            idNegocio,
            nombre: req.body.nombre,
            telefono: req.body.telefono || null,
            modo: req.body.modo || 'DINERO',
            cupo: req.body.cupo || 0,
            nota: req.body.nota || null,
        });

        await Audit.registrarEvento({
            modulo: 'clientes', accion: 'cuenta_creada', idNegocio,
            detalle: { id_cuenta: cuenta.id_cuenta, modo: cuenta.modo, cupo: cuenta.cupo },
        });
        return Respuesta.success(res, 'Cuenta creada', cuenta, 201);
    } catch (err) {
        return responderError(res, err, 'Error al crear la cuenta');
    }
}

/** PUT /restaurante/clientes/:id */
async function actualizar(req, res) {
    if (!handleValidation(req, res)) return;
    if (!(await exigirCuentasHabilitadas(req, res))) return;
    try {
        const idNegocio = Number(req.body.id_negocio);
        setAuditNegocio(idNegocio);

        const cuenta = await CuentaService.actualizarCuenta({
            idNegocio,
            idCuenta: Number(req.params.id),
            modo: req.body.modo,
            cupo: req.body.cupo,
            estado: req.body.estado,
            nota: req.body.nota,
        });
        if (!cuenta) return Respuesta.error(res, 'La cuenta no existe.', 404);

        await Audit.registrarEvento({
            modulo: 'clientes', accion: 'cuenta_actualizada', idNegocio,
            detalle: { id_cuenta: cuenta.id_cuenta, modo: cuenta.modo, cupo: cuenta.cupo },
        });
        return Respuesta.success(res, 'Cuenta actualizada', cuenta);
    } catch (err) {
        return responderError(res, err, 'Error al actualizar la cuenta');
    }
}

/** POST /restaurante/clientes/:id/abonos — vender tiquetera o recibir pago */
async function abonar(req, res) {
    if (!handleValidation(req, res)) return;
    if (!(await exigirCuentasHabilitadas(req, res))) return;
    if (!(await exigirSubnivel(req, res, SUB_ABONAR))) return;

    try {
        const idNegocio = Number(req.body.id_negocio);
        setAuditNegocio(idNegocio);

        const cuenta = await CuentaService.registrarAbono({
            idNegocio,
            idCuenta: Number(req.params.id),
            idUsuario: req.usuario.id_usuario,
            idMetodoPago: Number(req.body.id_metodo_pago),
            monto: req.body.monto,
            tiquetes: req.body.tiquetes,
            idProducto: req.body.id_producto || null,
            concepto: req.body.concepto || null,
        });

        await Audit.registrarEvento({
            modulo: 'clientes', accion: 'abono_registrado', idNegocio,
            detalle: {
                id_cuenta: Number(req.params.id),
                monto: Number(req.body.monto) || 0,
                tiquetes: Number(req.body.tiquetes) || 0,
            },
        });
        return Respuesta.success(res, 'Abono registrado', cuenta, 201);
    } catch (err) {
        return responderError(res, err, 'Error al registrar el abono');
    }
}

/** POST /restaurante/clientes/:id/ajustes — mover el saldo SIN que entre plata */
async function ajustar(req, res) {
    if (!handleValidation(req, res)) return;
    if (!(await exigirCuentasHabilitadas(req, res))) return;
    if (!(await exigirSubnivel(req, res, SUB_AJUSTAR))) return;

    try {
        const idNegocio = Number(req.body.id_negocio);
        setAuditNegocio(idNegocio);

        const cuenta = await CuentaService.registrarAjuste({
            idNegocio,
            idCuenta: Number(req.params.id),
            idUsuario: req.usuario.id_usuario,
            tipo: req.body.tipo,
            monto: req.body.monto,
            tiquetes: req.body.tiquetes,
            idProducto: req.body.id_producto || null,
            concepto: req.body.concepto,
        });

        await Audit.registrarEvento({
            modulo: 'clientes', accion: 'ajuste_registrado', idNegocio,
            detalle: {
                id_cuenta: Number(req.params.id),
                tipo: req.body.tipo,
                monto: Number(req.body.monto) || 0,
                tiquetes: Number(req.body.tiquetes) || 0,
                motivo: req.body.concepto,
            },
        });
        return Respuesta.success(res, 'Ajuste registrado', cuenta, 201);
    } catch (err) {
        return responderError(res, err, 'Error al registrar el ajuste');
    }
}

/**
 * GET /restaurante/clientes/:id/cobertura?id_negocio=N&id_orden=M
 *
 * Lo que el POS pregunta antes de cobrar: «¿cuánto de este pedido paga la cuenta?».
 * La respuesta se vuelve a calcular al cobrar de verdad — esto es para pintar, no para decidir.
 */
async function cobertura(req, res) {
    if (!handleValidation(req, res)) return;
    if (!(await exigirCuentasHabilitadas(req, res))) return;
    try {
        const datos = await CuentaService.calcularCobertura({
            idNegocio: Number(req.query.id_negocio),
            idCuenta: Number(req.params.id),
            idOrden: req.query.id_orden ? Number(req.query.id_orden) : null,
            total: req.query.total ? Number(req.query.total) : null,
        });
        return Respuesta.success(res, 'Cobertura de la cuenta', datos);
    } catch (err) {
        return responderError(res, err, 'Error al calcular la cobertura');
    }
}

module.exports = { listar, detalle, movimientos, crear, actualizar, abonar, ajustar, cobertura };
