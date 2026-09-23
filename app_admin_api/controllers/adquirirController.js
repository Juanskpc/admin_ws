/**
 * Controlador de «Adquirir plan» — la compra desde la web, sin cuenta previa.
 *
 * Son rutas **públicas**: las llama un visitante que todavía no es cliente. Por eso aquí no hay
 * token que valide nada y el router les pone un rate limit propio. La regla de siempre: validar
 * la entrada, reenviar los errores tipados del servicio sin re-envolverlos, y no devolver más
 * datos de los que la pantalla necesita.
 *
 * Ver `services/adquirirService.js` para por qué la cuenta se crea antes de pagar.
 */
'use strict';
const { validationResult } = require('express-validator');
const AdquirirService = require('../services/adquirirService');
const Respuesta = require('../../app_core/helpers/respuesta');

function check(req, res) {
    const e = validationResult(req);
    if (!e.isEmpty()) {
        Respuesta.error(res, 'Datos inválidos', 422, e.array());
        return false;
    }
    return true;
}

function fallo(res, err, contexto, porDefecto) {
    if (err.statusCode) return Respuesta.error(res, err.message, err.statusCode);
    console.error(`[Adquirir] ${contexto}:`, err.message);
    return Respuesta.error(res, porDefecto);
}

/** GET /admin/publico/adquirir/catalogo — planes contratables en línea y medios de pago. */
async function getCatalogo(req, res) {
    try {
        const catalogo = await AdquirirService.catalogoCompra({
            moneda: req.query.moneda || 'COP',
            ciclo: req.query.ciclo || 'mensual',
        });
        return Respuesta.success(res, 'Catálogo de compra', catalogo);
    } catch (err) {
        return fallo(res, err, 'getCatalogo', 'Error al consultar los planes.');
    }
}

/**
 * POST /admin/publico/adquirir/cuenta — crea la cuenta y deja su primer cobro esperando.
 *
 * No abre el checkout: eso es el paso siguiente. Así el comprador recibe la confirmación de que
 * su cuenta existe antes de pagar, que es lo que de verdad ocurre — si el pago falla, la cuenta
 * sigue ahí.
 */
async function postCuenta(req, res) {
    if (!check(req, res)) return;
    try {
        const cuenta = await AdquirirService.crearCuenta({
            nombres: req.body.nombres,
            apellidos: req.body.apellidos,
            num_identificacion: req.body.num_identificacion,
            email: req.body.email,
            password: req.body.password,
            telefono: req.body.telefono ?? null,
            rubro: req.body.rubro,
            nombre_negocio: req.body.nombre_negocio,
            plan: req.body.plan,
            pasarela: req.body.pasarela,
            complementos: req.body.complementos ?? [],
        });
        return Respuesta.success(res, 'Cuenta creada', cuenta, 201);
    } catch (err) {
        return fallo(res, err, 'postCuenta', 'No pudimos crear tu cuenta. Inténtalo de nuevo.');
    }
}

/** POST /admin/publico/adquirir — crea la cuenta apagada y devuelve el enlace de pago. */
async function postCompra(req, res) {
    if (!check(req, res)) return;
    try {
        const compra = await AdquirirService.iniciarCompra({
            nombres: req.body.nombres,
            apellidos: req.body.apellidos,
            num_identificacion: req.body.num_identificacion,
            email: req.body.email,
            telefono: req.body.telefono ?? null,
            rubro: req.body.rubro,
            nombre_negocio: req.body.nombre_negocio,
            plan: req.body.plan,
            pasarela: req.body.pasarela,
            complementos: req.body.complementos ?? [],
        });
        return Respuesta.success(res, 'Compra iniciada', compra, 201);
    } catch (err) {
        return fallo(res, err, 'postCompra', 'No pudimos iniciar la compra. Inténtalo de nuevo.');
    }
}

/** POST /admin/publico/adquirir/reintentar — vuelve a abrir el checkout de una compra a medias. */
async function postReintentar(req, res) {
    if (!check(req, res)) return;
    try {
        const pago = await AdquirirService.reintentarPago(req.body.referencia, {
            pasarela: req.body.pasarela,
        });
        return Respuesta.success(res, 'Pago reabierto', pago);
    } catch (err) {
        return fallo(res, err, 'postReintentar', 'No pudimos reabrir el pago.');
    }
}

/** GET /admin/publico/adquirir/estado/:referencia — para la pantalla de vuelta del checkout. */
async function getEstado(req, res) {
    if (!check(req, res)) return;
    try {
        const estado = await AdquirirService.estadoCompra(req.params.referencia);
        return Respuesta.success(res, 'Estado de la compra', estado);
    } catch (err) {
        return fallo(res, err, 'getEstado', 'Error al consultar la compra.');
    }
}

module.exports = { getCatalogo, postCuenta, postCompra, postReintentar, getEstado };
