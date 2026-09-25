/**
 * Controlador de cobranza — el cobro de NUESTRAS mensualidades.
 *
 * Ver `docs/cobro-mensualidades.md` §4. Reparto de responsabilidades: aquí solo se valida la
 * entrada, se resuelve quién pregunta y se reenvían los errores tipados del servicio sin
 * re-envolverlos.
 *
 * ## Dos audiencias en el mismo módulo
 *
 * `getMiSuscripcion` la consume el inquilino desde `negocio_app` y **no** puede confiar en el
 * `id_negocio` que llega en la query: ese parámetro es la frontera entre dos clientes. Se
 * comprueba contra `alcanceDeNegocios`, que lo resuelve desde la base.
 *
 * Todo lo demás es super-admin y va protegido en el router.
 */
'use strict';
const { validationResult } = require('express-validator');
const CobranzaService = require('../services/cobranzaService');
const Respuesta = require('../../app_core/helpers/respuesta');
const { alcanceDeNegocios } = require('../../app_core/middleware/auth');

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
    console.error(`[Cobranza] ${contexto}:`, err.message);
    return Respuesta.error(res, porDefecto);
}

/**
 * ¿Puede este usuario mirar este negocio? Un super admin siempre; el resto, solo los suyos.
 * Devuelve true si ya respondió con un 403 (el llamador debe cortar).
 */
async function negocioAjeno(req, res, idNegocio) {
    const alcance = await alcanceDeNegocios(req.usuario?.id_usuario);
    if (alcance.superAdmin || alcance.idNegocios.includes(Number(idNegocio))) return false;
    Respuesta.error(res, 'No tiene acceso a la información de cobro de este negocio', 403);
    return true;
}

/** GET /admin/cobranza/mi-suscripcion?id_negocio=N */
async function getMiSuscripcion(req, res) {
    if (!check(req, res)) return;
    try {
        const idNegocio = Number(req.query.id_negocio);
        if (await negocioAjeno(req, res, idNegocio)) return;

        const resumen = await CobranzaService.getResumenNegocio(idNegocio);
        return Respuesta.success(res, 'Suscripción del negocio', resumen);
    } catch (err) {
        return fallo(res, err, 'getMiSuscripcion', 'Error al consultar la suscripción.');
    }
}

/** GET /admin/cobranza/cartera?estado=&q= — super-admin */
async function getCartera(req, res) {
    if (!check(req, res)) return;
    try {
        const cartera = await CobranzaService.listarCartera({
            estado: req.query.estado || null,
            busqueda: req.query.q || null,
        });
        return Respuesta.success(res, 'Cartera de suscripciones', cartera);
    } catch (err) {
        return fallo(res, err, 'getCartera', 'Error al consultar la cartera.');
    }
}

/** GET /admin/cobranza/ingresos?meses=6 — super-admin */
async function getIngresos(req, res) {
    if (!check(req, res)) return;
    try {
        const meses = req.query.meses ? Number(req.query.meses) : 6;
        const resumen = await CobranzaService.resumenIngresos({ meses });
        return Respuesta.success(res, 'Ingresos por mes', resumen);
    } catch (err) {
        return fallo(res, err, 'getIngresos', 'Error al consultar los ingresos.');
    }
}

/** PUT /admin/cobranza/negocios/:id_negocio/suscripcion — super-admin */
async function configurarSuscripcion(req, res) {
    if (!check(req, res)) return;
    try {
        const suscripcion = await CobranzaService.configurarSuscripcion(
            Number(req.params.id_negocio),
            req.body
        );
        return Respuesta.success(res, 'Suscripción configurada', suscripcion);
    } catch (err) {
        return fallo(res, err, 'configurarSuscripcion', 'Error al configurar la suscripción.');
    }
}

/**
 * POST /admin/cobranza/negocios/:id_negocio/facturas — super-admin
 *
 * Responde 200 (no 201) cuando la factura ya existía: el llamador pidió «que exista la factura
 * de este período» y eso ya se cumplía. Distinguirlo con el código de estado evita que la
 * consola muestre «creada» dos veces por el mismo mes.
 */
/** GET /admin/cobranza/negocios/:id_negocio/complementos — catálogo con lo que tiene el negocio. */
async function getComplementos(req, res) {
    if (!check(req, res)) return;
    try {
        const datos = await CobranzaService.getComplementosNegocio(Number(req.params.id_negocio));
        return Respuesta.success(res, 'Complementos del negocio', datos);
    } catch (err) {
        return fallo(res, err, 'getComplementos', 'Error al consultar los complementos.');
    }
}

/**
 * POST /admin/cobranza/negocios/:id_negocio/total-mensual — vista previa: cuánto valdría al mes un
 * plan con unos complementos. No guarda nada.
 */
async function postTotalMensual(req, res) {
    if (!check(req, res)) return;
    try {
        const datos = await CobranzaService.previsualizarTotalMensual(Number(req.params.id_negocio), {
            idPlan: req.body.id_plan != null ? Number(req.body.id_plan) : null,
            complementos: req.body.complementos ?? [],
        });
        return Respuesta.success(res, 'Total mensual', datos);
    } catch (err) {
        return fallo(res, err, 'postTotalMensual', 'Error al calcular el total mensual.');
    }
}

/** PUT /admin/cobranza/negocios/:id_negocio/complementos — fija cantidades y qué se cobra. */
async function putComplementos(req, res) {
    if (!check(req, res)) return;
    try {
        const datos = await CobranzaService.fijarComplementosNegocio(
            Number(req.params.id_negocio),
            req.body.complementos ?? []
        );
        return Respuesta.success(res, 'Complementos actualizados', datos);
    } catch (err) {
        return fallo(res, err, 'putComplementos', 'Error al guardar los complementos.');
    }
}

async function generarFactura(req, res) {
    if (!check(req, res)) return;
    try {
        const { factura, ya_existia } = await CobranzaService.generarFacturaPeriodo(
            Number(req.params.id_negocio),
            { desde: req.body.desde || null }
        );
        return Respuesta.success(
            res,
            ya_existia ? 'La factura de ese período ya existía' : 'Factura generada',
            factura,
            ya_existia ? 200 : 201
        );
    } catch (err) {
        return fallo(res, err, 'generarFactura', 'Error al generar la factura.');
    }
}

/** POST /admin/cobranza/facturas/:id/pago-manual — super-admin */
async function registrarPagoManual(req, res) {
    if (!check(req, res)) return;
    try {
        const factura = await CobranzaService.registrarPagoManual(Number(req.params.id), req.body);
        return Respuesta.success(res, 'Pago registrado', factura);
    } catch (err) {
        return fallo(res, err, 'registrarPagoManual', 'Error al registrar el pago.');
    }
}

/**
 * POST /admin/cobranza/facturas/:id/cobrar — super-admin
 *
 * Dispara el cobro por la pasarela de la factura. Es el «reintentar» de la consola y también
 * la forma de probar una pasarela nueva sin esperar al cron.
 *
 * Los tres desenlaces se devuelven tal cual, sin maquillar: `pendiente` con `urlPago` significa
 * que hay que mandarle el link al cliente, no que ya pagó.
 */
async function cobrarFactura(req, res) {
    if (!check(req, res)) return;
    try {
        const resultado = await CobranzaService.cobrarFactura(Number(req.params.id));
        const mensajes = {
            aprobada: 'Cobro aprobado',
            pendiente: 'Cobro creado, pendiente de que el cliente pague',
            rechazada: 'La pasarela rechazó el cobro',
        };
        return Respuesta.success(res, mensajes[resultado.estado] ?? 'Cobro procesado', resultado);
    } catch (err) {
        return fallo(res, err, 'cobrarFactura', 'Error al cobrar la factura.');
    }
}

/** POST /admin/cobranza/facturas/:id/anular — super-admin */
async function anularFactura(req, res) {
    if (!check(req, res)) return;
    try {
        const factura = await CobranzaService.anularFactura(Number(req.params.id), {
            motivo: req.body.motivo,
        });
        return Respuesta.success(res, 'Factura anulada', factura);
    } catch (err) {
        return fallo(res, err, 'anularFactura', 'Error al anular la factura.');
    }
}

// ── Pagos del cliente ───────────────────────────────────────────────────────────────────

/**
 * GET /admin/cobranza/mi-plan?id_negocio=N — qué tiene contratado ESTE negocio.
 *
 * Es el gemelo de solo lectura de `/cobranza/negocios/:id/complementos`, que es de super-admin
 * porque ahí se deciden cortesías. El dueño necesita lo mismo sin poder tocarlo: cuántos usuarios
 * y cajas le caben, cuántos extra tiene y qué dejó pedido. Lo usa el panel «Mi plan» de la app
 * del negocio, que enseña el estado y manda a «Mis pagos» para cambiarlo.
 */
async function getMiPlan(req, res) {
    if (!check(req, res)) return;
    try {
        const idNegocio = Number(req.query.id_negocio);

        const alcance = await alcanceDeNegocios(req.usuario?.id_usuario);
        const esSuyo =
            alcance.superAdmin ||
            (await CobranzaService.usuarioAdministraNegocio(req.usuario.id_usuario, idNegocio));
        if (!esSuyo) return Respuesta.error(res, 'No tienes acceso a la suscripción de este negocio', 403);

        const datos = await CobranzaService.getComplementosNegocio(idNegocio);
        return Respuesta.success(res, 'Mi plan', datos);
    } catch (err) {
        return fallo(res, err, 'getMiPlan', 'Error al consultar tu plan.');
    }
}

/** GET /admin/cobranza/mis-cobros — el administrador del negocio, con sesión. */
async function getMisCobros(req, res) {
    try {
        // «Mis pagos» los quiere todos: también los negocios sin suscripción de cobro.
        const cobros = await CobranzaService.cobrosDeUsuario(req.usuario.id_usuario, {
            incluirSinSuscripcion: true,
        });
        return Respuesta.success(res, 'Mis cobros', cobros);
    } catch (err) {
        return fallo(res, err, 'getMisCobros', 'Error al consultar tus cobros.');
    }
}

/**
 * POST /admin/cobranza/facturas/:id/pagar — el administrador paga desde la app.
 *
 * El dueño de la factura se comprueba contra la base: el id viaja en la URL y cualquiera puede
 * cambiarlo. Un super admin también puede, para acompañar a un cliente por teléfono.
 */
async function pagarFactura(req, res) {
    if (!check(req, res)) return;
    try {
        const idFactura = Number(req.params.id);
        const factura = await require('../../app_core/dao/cobranzaDao').getFactura(idFactura);
        if (!factura) return Respuesta.error(res, 'No encontramos un cobro pendiente con esos datos', 404);

        const alcance = await alcanceDeNegocios(req.usuario?.id_usuario);
        const esSuyo =
            alcance.superAdmin ||
            (await CobranzaService.usuarioAdministraNegocio(req.usuario.id_usuario, factura.id_negocio));
        if (!esSuyo) return Respuesta.error(res, 'No encontramos un cobro pendiente con esos datos', 404);

        // `origen: 'app'` hace que la pasarela devuelva a «Mis pagos» y no al portal público: el
        // administrador que paga con sesión iniciada no tiene por qué acabar fuera de ella.
        const resultado = await CobranzaService.iniciarPago(idFactura, {
            pasarela: req.body.pasarela,
            origen: 'app',
        });
        return Respuesta.success(res, 'Pago iniciado', resultado);
    } catch (err) {
        return fallo(res, err, 'pagarFactura', 'Error al iniciar el pago.');
    }
}

/**
 * POST /admin/cobranza/mi-plan — el administrador del negocio cambia su plan y/o sus complementos.
 *
 * Los tres escenarios pasan por aquí, y se distinguen por lo que llega en el cuerpo:
 *   - solo `id_plan` → cambia de plan y conserva sus complementos;
 *   - solo `complementos` → conserva el plan y ajusta usuarios/cajas;
 *   - los dos → cambia de plan y de complementos a la vez, con una sola cuenta.
 *
 * El dueño del negocio se comprueba contra la base, igual que al pagar: el `id_negocio` viaja en
 * el cuerpo y cualquiera puede cambiarlo.
 */
async function elegirPlan(req, res) {
    if (!check(req, res)) return;
    try {
        const idNegocio = Number(req.body.id_negocio);

        const alcance = await alcanceDeNegocios(req.usuario?.id_usuario);
        const esSuyo =
            alcance.superAdmin ||
            (await CobranzaService.usuarioAdministraNegocio(req.usuario.id_usuario, idNegocio));
        if (!esSuyo) return Respuesta.error(res, 'No tienes acceso a la suscripción de este negocio', 403);

        const resultado = await CobranzaService.cambiarMiPlan(idNegocio, {
            idPlan: req.body.id_plan != null ? Number(req.body.id_plan) : null,
            complementos: Array.isArray(req.body.complementos) ? req.body.complementos : null,
        });

        // El mensaje lo compone el servicio, que es quien sabe si hubo que cobrar algo.
        return Respuesta.success(res, resultado.mensaje ?? 'Plan actualizado', resultado);
    } catch (err) {
        return fallo(res, err, 'elegirPlan', 'No se pudo cambiar el plan.');
    }
}

/**
 * GET /admin/cobranza/mi-plan/simular — cuánto se cobraría por un cambio, sin hacerlo.
 *
 * Solo lectura. Los complementos viajan como `complementos=CODIGO:cantidad,CODIGO:cantidad` porque
 * es un GET; el dueño del negocio se comprueba igual que al cambiar el plan de verdad.
 */
async function simularCambio(req, res) {
    if (!check(req, res)) return;
    try {
        const idNegocio = Number(req.query.id_negocio);

        const alcance = await alcanceDeNegocios(req.usuario?.id_usuario);
        const esSuyo =
            alcance.superAdmin ||
            (await CobranzaService.usuarioAdministraNegocio(req.usuario.id_usuario, idNegocio));
        if (!esSuyo) return Respuesta.error(res, 'No tienes acceso a la suscripción de este negocio', 403);

        const complementos =
            req.query.complementos == null
                ? null
                : String(req.query.complementos)
                      .split(',')
                      .filter(Boolean)
                      .map((par) => {
                          const [codigo, cantidad] = par.split(':');
                          return { codigo, cantidad: Number(cantidad) };
                      });

        const resultado = await CobranzaService.simularCambioPlan(idNegocio, {
            idPlan: req.query.id_plan != null ? Number(req.query.id_plan) : null,
            complementos,
        });
        return Respuesta.success(res, 'Simulación del cambio', resultado);
    } catch (err) {
        return fallo(res, err, 'simularCambio', 'No se pudo simular el cambio.');
    }
}

/**
 * POST /admin/cobranza/conciliar-pendientes — el admin lo llama al iniciar sesión, al abrir la app
 * con sesión y al volver a la pestaña.
 *
 * Concilia los pagos pendientes de los negocios que el usuario ADMINISTRA (un super admin puede
 * pasar `id_negocio`): le pregunta a la pasarela por cada intento y aplica lo que ya esté aprobado.
 * Sin intentos pendientes responde al instante y no llama a nadie. Responde
 * `{ aplicados: [{id_negocio, referencia}], pendientes }`.
 */
async function conciliarPendientes(req, res) {
    if (!check(req, res)) return;
    try {
        const idUsuario = req.usuario.id_usuario;
        let idNegocios;

        if (req.body?.id_negocio != null) {
            const idNegocio = Number(req.body.id_negocio);
            const alcance = await alcanceDeNegocios(idUsuario);
            const esSuyo =
                alcance.superAdmin || (await CobranzaService.usuarioAdministraNegocio(idUsuario, idNegocio));
            if (!esSuyo) return Respuesta.error(res, 'No tienes acceso a este negocio', 403);
            idNegocios = [idNegocio];
        } else {
            idNegocios = await CobranzaService.negociosQueAdministra(idUsuario);
        }

        const ConciliacionService = require('../services/cobranzaConciliacionService');
        const resultado = await ConciliacionService.conciliarPendientes(idNegocios, {
            via: req.body?.origen === 'al_volver' ? 'al_volver' : 'al_iniciar_sesion',
        });
        return Respuesta.success(res, 'Pagos conciliados', resultado);
    } catch (err) {
        return fallo(res, err, 'conciliarPendientes', 'No se pudo conciliar los pagos.');
    }
}

/** POST /admin/publico/cobranza/consultar — sin sesión. */
async function consultarPublico(req, res) {
    if (!check(req, res)) return;
    try {
        const cobros = await CobranzaService.consultarPublico(req.body.identificacion, { ip: req.ip });
        return Respuesta.success(res, 'Consulta de cobros', cobros);
    } catch (err) {
        return fallo(res, err, 'consultarPublico', 'Error al consultar los cobros.');
    }
}

/** POST /admin/publico/cobranza/pagar — sin sesión. */
async function pagarPublico(req, res) {
    if (!check(req, res)) return;
    try {
        const resultado = await CobranzaService.pagarPublico({
            identificacion: req.body.identificacion,
            referencia: req.body.referencia,
            pasarela: req.body.pasarela,
            ip: req.ip,
        });
        return Respuesta.success(res, 'Pago iniciado', resultado);
    } catch (err) {
        return fallo(res, err, 'pagarPublico', 'Error al iniciar el pago.');
    }
}

/**
 * POST /admin/publico/cobranza/confirmar — sin sesión.
 *
 * La vuelta desde el checkout: Wompi añade `?id=<transacción>` a la URL de retorno. En local el
 * webhook no llega (localhost no es público) y en producción se puede perder, así que el portal
 * pide confirmar por ese id en cuanto el cliente vuelve.
 *
 * No es «creerle a la redirección» —lo que Wompi desaconseja—: del navegador solo se toma el id;
 * el estado y el monto se le preguntan a la API de Wompi con nuestra llave privada. Lo peor que
 * puede hacer quien invente un id es confirmar un pago que de verdad existe y fue aprobado.
 */
async function confirmarRetorno(req, res) {
    if (!check(req, res)) return;
    try {
        const WebhookService = require('../services/cobranzaWebhookService');
        const resultado = await WebhookService.confirmarPorRetorno(
            req.body.pasarela,
            req.body.id_transaccion,
            { ip: req.ip }
        );
        return Respuesta.success(res, 'Estado del pago', resultado);
    } catch (err) {
        return fallo(res, err, 'confirmarRetorno', 'No pudimos confirmar el pago todavía.');
    }
}

/**
 * POST /admin/cobranza/wompi/verificar — super-admin
 *
 * Confirma un pago de Wompi pegando el id de su transacción (sale en la pantalla de resultado de
 * Wompi y en su panel). Dos usos:
 *   - **Probar en local**, donde ni el webhook ni la vuelta con `?id=` llegan (Wompi rechaza un
 *     retorno a `http://localhost`).
 *   - **Atender al cliente que dice «pagué y no se activó»** cuando un webhook se perdió.
 *
 * Mismo camino que el webhook: le pregunta a Wompi, comprueba el monto y aplica el pago. No hay
 * una lógica de pago aparte que se pueda desincronizar.
 */
async function verificarPagoWompi(req, res) {
    if (!check(req, res)) return;
    try {
        const WebhookService = require('../services/cobranzaWebhookService');
        const resultado = await WebhookService.confirmarPorRetorno('wompi', req.body.id_transaccion, {
            ip: req.ip,
            via: 'manual',
        });
        const mensajes = {
            aprobada: 'Pago confirmado: el plan quedó extendido',
            pendiente: 'Wompi todavía no aprueba esa transacción',
            rechazada: 'Wompi rechazó esa transacción',
            desconocida: 'Esa transacción no corresponde a una factura pendiente, o su monto no coincide',
        };
        return Respuesta.success(res, mensajes[resultado.estado] ?? 'Verificación hecha', resultado);
    } catch (err) {
        return fallo(res, err, 'verificarPagoWompi', 'No se pudo verificar la transacción.');
    }
}

module.exports = {
    getComplementos,
    putComplementos,
    postTotalMensual,
    getMiSuscripcion,
    getCartera,
    getIngresos,
    configurarSuscripcion,
    generarFactura,
    registrarPagoManual,
    cobrarFactura,
    anularFactura,
    getMisCobros,
    getMiPlan,
    pagarFactura,
    elegirPlan,
    simularCambio,
    conciliarPendientes,
    consultarPublico,
    pagarPublico,
    confirmarRetorno,
    verificarPagoWompi,
};
