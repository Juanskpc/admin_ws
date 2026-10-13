/**
 * Promociones — audiencia, segmentos y simulador (F1 de `docs/promociones-masivas.md`).
 *
 * ## Por qué vive en el API de admin y no en el de restaurante
 *
 * Porque no es del vertical: la misma pantalla va a servir a reserva con solo cambiar el adaptador
 * de hechos (`app_core/promociones/hechos/`). Montarla en `app_restaurante_api` obligaría a
 * duplicarla el día que reserva la pida, y entonces habría dos segmentadores — el que alguien
 * arregló y el que no.
 *
 * Es el mismo sitio y el mismo patrón que `/usuarios/admin/*`: rutas transversales que consume
 * `negocio_app`, **sin `requireSuperAdmin`** y acotadas por negocio con `alcanceAdmin` sobre
 * `req.principal` (CLAUDE.md). El dueño de un restaurante tiene que poder ver su propia clientela;
 * lo que no puede es ver la de otro.
 *
 * ## F1 no manda nada
 *
 * Aquí no hay envío ni cobro: se cuenta, se segmenta y se simula. El envío es F2 y el precio F3.
 * Lo que sí se puede hacer desde ya es **sacar a alguien** de las promociones (`baja`), porque un
 * cliente que lo pide en el mostrador no puede quedarse esperando a que exista la pantalla de
 * envío.
 */
'use strict';

const { body, param, query, validationResult } = require('express-validator');

const Respuesta = require('../../app_core/helpers/respuesta');
const Alcance = require('../../app_core/authz/alcanceAdmin');
const audiencia = require('../../app_core/promociones/audiencia');
const segmentos = require('../../app_core/promociones/segmentos');
const simulador = require('../../app_core/promociones/simulador');
const hechos = require('../../app_core/promociones/hechos');
const campanas = require('../../app_core/promociones/campanas');
const elegibilidad = require('../../app_core/promociones/elegibilidad');
const plantillasMeta = require('../../app_core/promociones/plantillasMeta');
const habilitado = require('../../app_core/promociones/habilitado');
const catalogoPlantillas = require('../../intelligence/core/plantillas');

/** El patrón de la casa: validar al principio del controlador y salir con 400. */
function erroresDeEntrada(req, res) {
    const errors = validationResult(req);
    if (errors.isEmpty()) return false;
    Respuesta.error(res, 'Datos de entrada inválidos', 400, errors.array());
    return true;
}

/**
 * El negocio sobre el que se opera, comprobado de alcance pero **sin** mirar la lista blanca.
 *
 * Devuelve `null` si la petición ya se contestó (fuera de alcance), para el patrón
 * `if (idNegocio === null) return;`.
 */
function negocioEnAlcance(req, res, valor) {
    const idNegocio = valor ? Number(valor) : null;
    if (!idNegocio) {
        Respuesta.error(res, 'Falta el negocio.', 400);
        return null;
    }
    if (Alcance.negarSiNegocioFuera(req, res, idNegocio)) return null;
    return idNegocio;
}

/**
 * El negocio sobre el que se opera, ya comprobado del todo: alcance **y** lista blanca.
 *
 * Son dos preguntas distintas y las dos se contestan aquí, en el único sitio por el que pasan las
 * 18 rutas. El alcance dice «este token no es de ese negocio»; la lista blanca dice «a ese negocio
 * no se le ha encendido la función» (`app_core/promociones/habilitado.js`). Un permiso de pantalla
 * no sirve para lo segundo: esconder el menú no cierra la API, y lo que hay detrás de esta manda
 * publicidad por el número del negocio y gasta dinero en Meta.
 *
 * `getDisponible` es la única que no pasa por aquí —usa `negocioEnAlcance`— porque su trabajo es
 * precisamente **contestar** si la función está disponible: un endpoint de diagnóstico que
 * responde 403 no diagnostica nada.
 */
async function negocioDeLaPeticion(req, res, valor) {
    const idNegocio = negocioEnAlcance(req, res, valor);
    if (idNegocio === null) return null;

    if (!(await habilitado.estaHabilitado(idNegocio))) {
        Respuesta.error(res, habilitado.MENSAJE_NO_HABILITADO, 403, {
            code: habilitado.CODE_NO_HABILITADO,
        });
        return null;
    }
    return idNegocio;
}

/**
 * Los errores de dominio se reenvían tal cual: los services ya los tipan con `.code` y
 * `.statusCode`, y volver a envolverlos escondería el motivo (regla fija de `CLAUDE.md`).
 */
function responderError(res, error, mensajeGenerico) {
    const status = Number(error?.statusCode) || 500;
    if (status >= 400 && status < 500) {
        return Respuesta.error(res, error.message, status, error.code ? { code: error.code } : undefined);
    }
    console.error(`[promociones] ${mensajeGenerico}:`, error);
    return Respuesta.error(res, mensajeGenerico, 500);
}

/**
 * GET /admin/promociones/audiencia?id_negocio=N
 *
 * Lo primero que ve la pantalla: a cuántos se le puede escribir, quién queda fuera y por qué, y
 * cómo se reparte la clientela en segmentos.
 *
 * Las dos cifras van juntas a propósito. El resumen dice «tienes 812 clientes, 780 contactables»
 * y los segmentos dicen **a cuáles de ellos vale la pena escribirle**; por separado, la primera
 * invita a mandarle a todo el mundo, que es justo lo que no hay que hacer.
 */
async function getAudiencia(req, res) {
    if (erroresDeEntrada(req, res)) return;
    const idNegocio = await negocioDeLaPeticion(req, res, req.query.id_negocio);
    if (idNegocio === null) return;

    try {
        const [resumen, porSegmento] = await Promise.all([
            audiencia.resumenDeAudiencia({ idNegocio }),
            segmentos.contarPorSegmento({ idNegocio }),
        ]);

        return Respuesta.success(res, 'Audiencia de promociones', {
            resumen,
            ...porSegmento,
        });
    } catch (error) {
        return responderError(res, error, 'No se pudo calcular la audiencia');
    }
}

/**
 * GET /admin/promociones/destinatarios?id_negocio=N&segmentos=en_riesgo,dormido&q=&solo_contactables=
 *
 * La tabla. Sirve para dos cosas distintas con el mismo endpoint: revisar a quién se le va a
 * escribir (con `solo_contactables=true`, el valor por defecto) y revisar **quién quedó fuera y por
 * qué** (`solo_contactables=false`, que devuelve `motivo_exclusion`).
 */
async function getDestinatarios(req, res) {
    if (erroresDeEntrada(req, res)) return;
    const idNegocio = await negocioDeLaPeticion(req, res, req.query.id_negocio);
    if (idNegocio === null) return;

    try {
        const lista = String(req.query.segmentos || '')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);

        const datos = await segmentos.listarDestinatarios({
            idNegocio,
            segmentos: lista.length ? lista : null,
            busqueda: (req.query.q || '').trim() || null,
            // Solo `false` explícito apaga el filtro: cualquier otra cosa deja el lado prudente.
            soloContactables: String(req.query.solo_contactables) !== 'false',
            limite: req.query.limite,
            offset: req.query.offset,
        });

        return Respuesta.success(res, 'Destinatarios', datos);
    } catch (error) {
        return responderError(res, error, 'No se pudo listar los destinatarios');
    }
}

/**
 * POST /admin/promociones/simular
 * Body: { id_negocio, segmentos?: [], personas?: [], margen? }
 *
 * Es un POST y no un GET porque la selección a mano puede traer cientos de ids, que no caben
 * razonablemente en una URL. No escribe nada: se puede llamar en cada clic de la pantalla.
 */
async function postSimular(req, res) {
    if (erroresDeEntrada(req, res)) return;
    const idNegocio = await negocioDeLaPeticion(req, res, req.body.id_negocio);
    if (idNegocio === null) return;

    try {
        const destinatarios = await segmentos.destinatariosParaEnvio({
            idNegocio,
            segmentos: Array.isArray(req.body.segmentos) ? req.body.segmentos : null,
            personas: Array.isArray(req.body.personas) ? req.body.personas : null,
        });

        const simulacion = await simulador.calcularConCupo(destinatarios, {
            idNegocio,
            margen: req.body.margen != null ? Number(req.body.margen) : undefined,
            moneda: 'COP',
        });

        return Respuesta.success(res, 'Simulación', simulacion);
    } catch (error) {
        return responderError(res, error, 'No se pudo simular la promoción');
    }
}

/**
 * POST /admin/promociones/clientes/:id/baja
 * Body: { id_negocio }
 *
 * Saca a un cliente de las promociones desde la ficha. Es para el que lo pide en el mostrador o
 * por teléfono: no todo el mundo va a escribir «no promos» por WhatsApp.
 *
 * Queda con `origen = 'negocio'` —lo marcó el personal— y con el usuario que lo hizo en el evento
 * de auditoría. La distinción importa: una baja dicha por el cliente en el canal y una marcada por
 * un cajero no valen lo mismo el día que haya que explicarla.
 */
async function postBaja(req, res) {
    if (erroresDeEntrada(req, res)) return;
    const idNegocio = await negocioDeLaPeticion(req, res, req.body.id_negocio);
    if (idNegocio === null) return;

    try {
        const resultado = await audiencia.excluir({
            idNegocio,
            idPersonaNegocio: req.params.id,
            origen: audiencia.ORIGEN.NEGOCIO,
            prueba: { registrado_por: 'panel', nota: (req.body.nota || '').trim() || null },
            idUsuario: req.usuario?.id_usuario ?? null,
        });

        return Respuesta.success(
            res,
            resultado.excluido ? 'El cliente ya no recibirá promociones' : 'Ya estaba fuera de las promociones',
            resultado,
        );
    } catch (error) {
        return responderError(res, error, 'No se pudo registrar la baja');
    }
}

/**
 * POST /admin/promociones/clientes/:id/readmitir
 * Body: { id_negocio }
 *
 * Deshace lo anterior. Existe para el error del cajero o el cliente que cambia de idea, **no**
 * para reactivar una lista de bajas: por eso deja su propio evento con el usuario que lo hizo.
 */
async function postReadmitir(req, res) {
    if (erroresDeEntrada(req, res)) return;
    const idNegocio = await negocioDeLaPeticion(req, res, req.body.id_negocio);
    if (idNegocio === null) return;

    try {
        const resultado = await audiencia.readmitir({
            idNegocio,
            idPersonaNegocio: req.params.id,
            idUsuario: req.usuario?.id_usuario ?? null,
        });

        return Respuesta.success(
            res,
            resultado.readmitido ? 'El cliente vuelve a recibir promociones' : 'No estaba de baja',
            resultado,
        );
    } catch (error) {
        return responderError(res, error, 'No se pudo readmitir al cliente');
    }
}

/**
 * GET /admin/promociones/disponible?id_negocio=N
 *
 * ¿Tiene sentido enseñarle esta pantalla a este negocio? Hoy solo contesta por el vertical, que es
 * lo único que decide en F1. La compuerta completa —canal conectado, token propio, calidad del
 * número, créditos— es de F2 (`docs/promociones-masivas.md` §6.8), y va a vivir aquí mismo para
 * que la pantalla y la API miren **la misma** respuesta: esconder un botón no cierra una API.
 */
async function getDisponible(req, res) {
    if (erroresDeEntrada(req, res)) return;
    // Sin la lista blanca: esta ruta es la que la CONTESTA. Ver `negocioDeLaPeticion`.
    const idNegocio = negocioEnAlcance(req, res, req.query.id_negocio);
    if (idNegocio === null) return;

    try {
        // Lo primero, y antes de preguntarle nada a Meta: ¿se le encendió a este negocio? Un
        // negocio fuera de la lista no gasta ni una llamada a la Graph API en averiguar lo que no
        // va a poder hacer.
        if (!(await habilitado.estaHabilitado(idNegocio))) {
            return Respuesta.success(res, 'Disponibilidad de promociones', {
                disponible: false,
                vertical: null,
                motivo: habilitado.CODE_NO_HABILITADO,
                envio_disponible: false,
                envio_motivos: [],
            });
        }

        const par = await hechos.paraNegocio(idNegocio);
        if (!par) {
            return Respuesta.success(res, 'Disponibilidad de promociones', {
                disponible: false,
                vertical: null,
                motivo: 'PROMOS_VERTICAL_NO_SOPORTADO',
                envio_disponible: false,
                envio_motivos: [],
            });
        }

        // Lo que falta para poder enviar de verdad lo contesta la compuerta, no la pantalla. Sin
        // campaña todavía, así que la prueba no se evalúa: eso se comprueba al enviar.
        const gate = await elegibilidad
            .verificar({ idNegocio })
            .catch(() => ({ puede: false, motivos: [], avisos: [] }));

        return Respuesta.success(res, 'Disponibilidad de promociones', {
            disponible: true,
            vertical: par.vertical,
            motivo: null,
            envio_disponible: gate.puede,
            envio_motivos: gate.motivos,
            avisos: gate.avisos,
            numero: gate.numero,
            plantillas: gate.plantillas,
        });
    } catch (error) {
        return responderError(res, error, 'No se pudo comprobar la disponibilidad');
    }
}

// ── F2: plantillas, campañas y envío ────────────────────────────────────────────────────

/**
 * GET /admin/promociones/plantillas?id_negocio=N
 *
 * En qué estado están las plantillas de **este** inquilino en su propia WABA, con el texto que
 * llevan para que la pantalla pueda enseñar la vista previa sin inventárselo.
 */
async function getPlantillas(req, res) {
    if (erroresDeEntrada(req, res)) return;
    const idNegocio = await negocioDeLaPeticion(req, res, req.query.id_negocio);
    if (idNegocio === null) return;

    try {
        const estados = await plantillasMeta.estadoDe({ idNegocio });
        const definiciones = catalogoPlantillas.deMarketing();

        return Respuesta.success(res, 'Plantillas de promoción', {
            plantillas: estados.map((e) => {
                const d = definiciones.find((x) => x.nombre === e.nombre);
                return {
                    ...e,
                    // El texto con los huecos, tal cual se aprobó. La pantalla lo rellena para la
                    // vista previa: así lo que el dueño ve es lo que va a salir.
                    cuerpo: d?.texto ?? null,
                    pie: d?.pie ?? null,
                    botones: d?.botones ?? [],
                    parametros: d?.parametros ?? [],
                };
            }),
        });
    } catch (error) {
        return responderError(res, error, 'No se pudieron leer las plantillas');
    }
}

/**
 * POST /admin/promociones/plantillas/asegurar
 * Body: { id_negocio, imagen_url? }
 *
 * Crea en la WABA del inquilino las plantillas que le falten y refresca su estado. Es lo que
 * conviene llamar **en el alta del canal**, no cuando el dueño quiere mandar la promo el viernes a
 * las 6 p. m.: Meta tarda de minutos a 24 h en revisar.
 */
async function postAsegurarPlantillas(req, res) {
    if (erroresDeEntrada(req, res)) return;
    const idNegocio = await negocioDeLaPeticion(req, res, req.body.id_negocio);
    if (idNegocio === null) return;

    try {
        // La imagen de ejemplo que Meta pide para aprobar la plantilla con encabezado. Se descarga
        // de la URL que ya subió el negocio (nuestro propio `uploads/`), porque Meta exige un
        // `handle` de su API de subidas y no acepta un enlace al crear la plantilla.
        let imagenEjemplo = null;
        if (req.body.imagen_url) {
            try {
                const r = await fetch(String(req.body.imagen_url));
                if (r.ok) imagenEjemplo = Buffer.from(await r.arrayBuffer());
            } catch (error) {
                console.warn('[promociones] no se pudo bajar la imagen de ejemplo:', error.message);
            }
        }

        const resultado = await plantillasMeta.asegurar({ idNegocio, imagenEjemplo });
        return Respuesta.success(res, 'Plantillas al día', resultado);
    } catch (error) {
        return responderError(res, error, 'No se pudieron crear las plantillas');
    }
}

/** POST /admin/promociones/plantillas/sincronizar — vuelve a preguntarle a Meta. */
async function postSincronizarPlantillas(req, res) {
    if (erroresDeEntrada(req, res)) return;
    const idNegocio = await negocioDeLaPeticion(req, res, req.body.id_negocio);
    if (idNegocio === null) return;

    try {
        const plantillas = await plantillasMeta.sincronizar({ idNegocio });
        return Respuesta.success(res, 'Estado actualizado', { plantillas });
    } catch (error) {
        return responderError(res, error, 'No se pudo consultar el estado en Meta');
    }
}

/**
 * GET /admin/promociones/elegibilidad?id_negocio=N&id_campana=&destinatarios=
 *
 * La compuerta, tal cual. La pantalla y la API miran **esta misma** respuesta: esconder un botón
 * no cierra una API.
 */
async function getElegibilidad(req, res) {
    if (erroresDeEntrada(req, res)) return;
    const idNegocio = await negocioDeLaPeticion(req, res, req.query.id_negocio);
    if (idNegocio === null) return;

    try {
        const datos = await elegibilidad.verificar({
            idNegocio,
            idCampana: req.query.id_campana || null,
            destinatarios: req.query.destinatarios ? Number(req.query.destinatarios) : null,
        });
        return Respuesta.success(res, 'Elegibilidad', datos);
    } catch (error) {
        return responderError(res, error, 'No se pudo comprobar la elegibilidad');
    }
}

/** POST /admin/promociones/campanas — arma la campaña y congela su lista. No envía nada. */
async function postCrearCampana(req, res) {
    if (erroresDeEntrada(req, res)) return;
    const idNegocio = await negocioDeLaPeticion(req, res, req.body.id_negocio);
    if (idNegocio === null) return;

    try {
        const campana = await campanas.crear({
            idNegocio,
            nombre: req.body.nombre,
            plantilla: req.body.plantilla,
            parametros: req.body.parametros || {},
            imagenUrl: req.body.imagen_url || null,
            segmentos: Array.isArray(req.body.segmentos) ? req.body.segmentos : null,
            personas: Array.isArray(req.body.personas) ? req.body.personas : null,
            margen: req.body.margen != null ? Number(req.body.margen) : undefined,
            idUsuario: req.usuario?.id_usuario ?? null,
        });
        return Respuesta.success(res, 'Promoción preparada', campana, 201);
    } catch (error) {
        return responderError(res, error, 'No se pudo preparar la promoción');
    }
}

/**
 * POST /admin/promociones/campanas/:id/prueba — el mensaje real a un WhatsApp de verdad.
 *
 * El `telefono` viene del formulario: es el móvil de quien va a revisar la prueba. No se deduce
 * del canal porque el canal es **el que envía**, y un número no se manda mensajes a sí mismo
 * (ver `campanas.mandarPrueba`).
 */
async function postPrueba(req, res) {
    if (erroresDeEntrada(req, res)) return;
    const idNegocio = await negocioDeLaPeticion(req, res, req.body.id_negocio);
    if (idNegocio === null) return;

    try {
        const datos = await campanas.mandarPrueba({
            idNegocio,
            idCampana: req.params.id,
            idUsuario: req.usuario?.id_usuario ?? null,
            telefono: req.body.telefono ?? null,
        });
        return Respuesta.success(
            res,
            `Prueba enviada a ${datos.telefono}. Mira que llegue antes de enviar.`,
            datos,
        );
    } catch (error) {
        return responderError(res, error, 'No se pudo mandar la prueba');
    }
}

/** POST /admin/promociones/campanas/:id/enviar — da la orden; manda el despachador. */
async function postEnviar(req, res) {
    if (erroresDeEntrada(req, res)) return;
    const idNegocio = await negocioDeLaPeticion(req, res, req.body.id_negocio);
    if (idNegocio === null) return;

    try {
        const campana = await campanas.enviar({
            idNegocio,
            idCampana: req.params.id,
            programadaPara: req.body.programada_para || null,
            idUsuario: req.usuario?.id_usuario ?? null,
        });
        return Respuesta.success(res, 'Promoción en marcha', campana);
    } catch (error) {
        return responderError(res, error, 'No se pudo enviar la promoción');
    }
}

/** POST /admin/promociones/campanas/:id/pausar */
async function postPausar(req, res) {
    if (erroresDeEntrada(req, res)) return;
    const idNegocio = await negocioDeLaPeticion(req, res, req.body.id_negocio);
    if (idNegocio === null) return;

    try {
        const datos = await campanas.pausar({
            idNegocio,
            idCampana: req.params.id,
            motivo: req.body.motivo || null,
            idUsuario: req.usuario?.id_usuario ?? null,
        });
        return Respuesta.success(res, 'Promoción pausada', datos);
    } catch (error) {
        return responderError(res, error, 'No se pudo pausar');
    }
}

/** POST /admin/promociones/campanas/:id/cancelar */
async function postCancelar(req, res) {
    if (erroresDeEntrada(req, res)) return;
    const idNegocio = await negocioDeLaPeticion(req, res, req.body.id_negocio);
    if (idNegocio === null) return;

    try {
        const datos = await campanas.cancelar({
            idNegocio,
            idCampana: req.params.id,
            idUsuario: req.usuario?.id_usuario ?? null,
        });
        return Respuesta.success(res, 'Promoción cancelada', datos);
    } catch (error) {
        return responderError(res, error, 'No se pudo cancelar');
    }
}

/** GET /admin/promociones/campanas?id_negocio=N — el historial. */
async function getCampanas(req, res) {
    if (erroresDeEntrada(req, res)) return;
    const idNegocio = await negocioDeLaPeticion(req, res, req.query.id_negocio);
    if (idNegocio === null) return;

    try {
        const lista = await campanas.listar({ idNegocio, limite: req.query.limite });
        return Respuesta.success(res, 'Promociones', { campanas: lista });
    } catch (error) {
        return responderError(res, error, 'No se pudo leer el historial');
    }
}

/** GET /admin/promociones/campanas/:id?id_negocio=N — el informe, que es el producto. */
async function getCampana(req, res) {
    if (erroresDeEntrada(req, res)) return;
    const idNegocio = await negocioDeLaPeticion(req, res, req.query.id_negocio);
    if (idNegocio === null) return;

    try {
        const datos = await campanas.informe({ idNegocio, idCampana: req.params.id });
        return Respuesta.success(res, 'Informe de la promoción', datos);
    } catch (error) {
        return responderError(res, error, 'No se pudo leer la promoción');
    }
}

/**
 * POST /admin/promociones/:id_negocio/imagen  (multipart, campo `imagen`)
 *
 * Devuelve la URL **absoluta** de la imagen subida. Absoluta y no relativa porque quien la va a
 * descargar es un servidor de Meta desde internet, no el navegador del dueño: una ruta relativa
 * aquí es una promoción que sale sin imagen.
 */
async function postImagen(req, res) {
    if (erroresDeEntrada(req, res)) return;
    const idNegocio = await negocioDeLaPeticion(req, res, req.params.id_negocio);
    if (idNegocio === null) return;

    if (!req.file) return Respuesta.error(res, 'No llegó ninguna imagen.', 400);

    const base = String(process.env.APP_PUBLIC_URL || 'https://api.escalapp.cloud').replace(/\/+$/, '');
    const url = `${base}/uploads/promociones/${idNegocio}/${req.file.filename}`;

    return Respuesta.success(res, 'Imagen subida', {
        url,
        bytes: req.file.size,
        // Para que la pantalla pueda avisar: Meta rechaza por encima de 5 MB y recorta las muy
        // alargadas. 1.200 × 628 es la proporción que mejor se ve en el encabezado.
        recomendacion: '1.200 × 628 px, menos de 5 MB, JPG o PNG',
    });
}

const promocionValidators = {
    audiencia: [query('id_negocio').isInt({ min: 1 })],
    disponible: [query('id_negocio').isInt({ min: 1 })],
    destinatarios: [
        query('id_negocio').isInt({ min: 1 }),
        query('segmentos').optional().isString().isLength({ max: 200 }),
        query('q').optional().isString().isLength({ max: 100 }),
        query('solo_contactables').optional().isIn(['true', 'false']),
        query('limite').optional().isInt({ min: 1, max: 1000 }),
        query('offset').optional().isInt({ min: 0 }),
    ],
    simular: [
        body('id_negocio').isInt({ min: 1 }),
        body('segmentos').optional().isArray({ max: 10 }),
        body('segmentos.*').optional().isString().isLength({ max: 30 }),
        // El tope de 2.000 no es un número redondo: es más del doble de la clientela del negocio
        // más grande de la cartera, y evita que una petición cargue media base en memoria.
        body('personas').optional().isArray({ max: 2000 }),
        body('personas.*').optional().isUUID(),
        body('margen').optional().isFloat({ min: 0.01, max: 1 }),
    ],
    baja: [
        param('id').isUUID(),
        body('id_negocio').isInt({ min: 1 }),
        body('nota').optional({ nullable: true }).isString().isLength({ max: 200 }),
    ],
    readmitir: [param('id').isUUID(), body('id_negocio').isInt({ min: 1 })],

    // ── F2 ──────────────────────────────────────────────────────────────────────────────
    plantillas: [query('id_negocio').isInt({ min: 1 })],
    asegurarPlantillas: [
        body('id_negocio').isInt({ min: 1 }),
        body('imagen_url').optional({ nullable: true }).isString().isLength({ max: 500 }),
    ],
    sincronizarPlantillas: [body('id_negocio').isInt({ min: 1 })],
    elegibilidadCampana: [
        query('id_negocio').isInt({ min: 1 }),
        query('id_campana').optional().isUUID(),
        query('destinatarios').optional().isInt({ min: 0, max: 100000 }),
    ],
    crearCampana: [
        body('id_negocio').isInt({ min: 1 }),
        body('nombre').optional({ nullable: true }).isString().isLength({ max: 120 }),
        body('plantilla').isString().isLength({ min: 3, max: 80 }),
        // La oferta es lo único que escribe el dueño. 400 caracteres caben de sobra en el cuerpo
        // de la plantilla (1.024 con el texto fijo incluido) y evitan un rechazo de Meta por
        // longitud, que llega tarde y sin explicación clara.
        body('parametros.oferta').isString().isLength({ min: 3, max: 400 }),
        body('imagen_url').optional({ nullable: true }).isString().isLength({ max: 500 }),
        body('segmentos').optional().isArray({ max: 10 }),
        body('personas').optional().isArray({ max: 2000 }),
        body('personas.*').optional().isUUID(),
        body('margen').optional().isFloat({ min: 0.01, max: 1 }),
    ],
    porCampana: [param('id').isUUID(), body('id_negocio').isInt({ min: 1 })],
    // La prueba lleva además el teléfono de quien la revisa. Se valida de forma laxa aquí —solo
    // que sea un texto corto— porque quien sabe si un número es un número es
    // `identidad.normalizarTelefono`, y una sola fuente para eso vale más que dos reglas parecidas.
    pruebaCampana: [
        param('id').isUUID(),
        body('id_negocio').isInt({ min: 1 }),
        body('telefono').optional({ nullable: true }).isString().isLength({ min: 7, max: 25 }),
    ],
    enviarCampana: [
        param('id').isUUID(),
        body('id_negocio').isInt({ min: 1 }),
        // Hora de pared de Bogotá, como el resto del dominio: sin zona, que es lo que guarda la
        // columna. `null` = ahora mismo.
        body('programada_para').optional({ nullable: true }).isISO8601(),
    ],
    pausarCampana: [
        param('id').isUUID(),
        body('id_negocio').isInt({ min: 1 }),
        body('motivo').optional({ nullable: true }).isString().isLength({ max: 200 }),
    ],
    campanas: [query('id_negocio').isInt({ min: 1 }), query('limite').optional().isInt({ min: 1, max: 200 })],
    verCampana: [param('id').isUUID(), query('id_negocio').isInt({ min: 1 })],
};

module.exports = {
    promocionValidators,
    getAudiencia,
    getDisponible,
    getDestinatarios,
    postSimular,
    postBaja,
    postReadmitir,
    // F2
    getPlantillas,
    postAsegurarPlantillas,
    postSincronizarPlantillas,
    getElegibilidad,
    postCrearCampana,
    postPrueba,
    postEnviar,
    postPausar,
    postCancelar,
    getCampanas,
    getCampana,
    postImagen,
};
