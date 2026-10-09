'use strict';
/**
 * El servicio de emisión: convierte un pedido cobrado en un documento fiscal, lo envía al
 * proveedor y lo reintenta hasta que quede aceptado o haga falta una persona.
 * R4.3 de `docs/plan-fe-restaurante.md`.
 *
 * ## La regla que manda sobre todas las demás (D4)
 *
 * **La venta nunca espera ni falla por la facturación.** Todo esto ocurre después del commit del
 * cobro, en transacciones propias, y `alCobrarPedido` —lo único que llama la vertical— no lanza
 * jamás. Si aquí se rompe algo, el documento queda en `ERROR` o, en el peor caso, ni se crea: la
 * reconciliación recoge luego los pedidos cobrados que se quedaron sin documento.
 *
 * ## No todo cobro se factura
 *
 * Por defecto se factura **solo el cobro en el que el cajero lo pide** («Factura electrónica» en
 * la pantalla de cobro): anónima —a consumidor final— o con los datos del cliente. Un negocio con
 * un paquete pequeño de documentos no puede gastarlo en cada venta. El que sí quiere facturarlo
 * todo enciende `fe_configuracion.facturar_todo`, y entonces un cobro sin más sale a consumidor
 * final y la reconciliación recoge los que se queden sin documento.
 *
 * ## Por qué reintentar no duplica
 *
 * El documento se crea una sola vez por pedido (`uq_fedoc_origen`) y guarda su
 * `codigo_referencia`. Factus devuelve el mismo documento si se le repite una referencia
 * (comprobado en el sandbox, §5 del plan), así que reintentar con la misma es seguro. Solo se
 * cambia cuando el documento fue **rechazado** y se corrige: esa referencia quedó gastada.
 *
 * ## Una emisión a la vez por negocio (D14)
 *
 * En Factus una factura pendiente bloquea las siguientes de la misma cuenta. El reclamo del
 * documento es atómico en la base y, además, las emisiones de un mismo negocio se encadenan en
 * memoria.
 */
const crypto = require('crypto');

const Models = require('../models/conection');
const datosFiscales = require('./datosFiscales');
const configuracionDao = require('./configuracionDao');
const origenRestaurante = require('./origenes/restaurante');
const { construirFactura } = require('./construirFactura');
const { normalizarComprador } = require('./comprador');
const { CONSUMIDOR_FINAL, topeConsumidorFinal, urlConsultaDian } = require('./constantes');
const { getProveedor } = require('./proveedores');
const { correoFactura, marcaDeNegocio } = require('./correoFactura');

const sequelize = Models.sequelize;
const SELECT = sequelize.QueryTypes.SELECT;

/** Minutos hasta el siguiente intento, según cuántos van. Después del último, espera a una persona. */
const BACKOFF_MIN = [1, 5, 15, 60, 360];
const ORIGEN = { vertical: 'RESTAURANTE', tipo: 'PEDIDO' };

function fallo(mensaje, code, statusCode) {
    const e = new Error(mensaje);
    e.code = code;
    e.statusCode = statusCode;
    return e;
}

const json = (v) => JSON.stringify(v ?? null);

async function leerDocumento(idDocumento, transaction) {
    const filas = await sequelize.query(
        `SELECT * FROM facturacion.fe_documento WHERE id_documento = :idDocumento;`,
        { replacements: { idDocumento }, transaction, type: SELECT }
    );
    return filas[0] || null;
}

async function leerLineas(idDocumento) {
    const filas = await sequelize.query(
        `SELECT * FROM facturacion.fe_documento_linea WHERE id_documento = :idDocumento ORDER BY orden;`,
        { replacements: { idDocumento }, type: SELECT }
    );
    // numeric llega como texto; el adaptador espera números.
    return filas.map((l) => ({
        ...l,
        cantidad: Number(l.cantidad),
        precio_neto: Number(l.precio_neto),
        tarifa_impuesto: Number(l.tarifa_impuesto),
    }));
}

/** UPDATE de un documento con los campos dados; devuelve la fila. */
async function actualizarDocumento(idDocumento, campos, transaction) {
    const asignaciones = Object.keys(campos).map((c) =>
        ['adquiriente', 'payload', 'respuesta', 'avisos', 'pagos'].includes(c) ? `${c} = :${c}::jsonb` : `${c} = :${c}`
    );
    const filas = await sequelize.query(
        `UPDATE facturacion.fe_documento SET ${asignaciones.join(', ')}, actualizado_en = now()
          WHERE id_documento = :idDocumento RETURNING *;`,
        { replacements: { idDocumento, ...campos }, transaction, type: SELECT }
    );
    return filas[0] || null;
}

function referenciaNueva(idNegocio, idOrden, ambiente, tipo = 'FV') {
    // En PRUEBAS todas las bases de desarrollo emiten contra la MISMA cuenta del sandbox, y como
    // Factus devuelve el documento existente cuando se repite una referencia, el pedido 10 de una
    // base recibiría sin error la factura del pedido 10 de otra. El sufijo lo impide. En
    // producción cada negocio tiene su cuenta y la referencia es legible tal cual.
    if (ambiente === 'PRUEBAS') return `EAP${idNegocio}-${tipo}-${idOrden}-${crypto.randomBytes(4).toString('hex')}`;
    return `EA${idNegocio}-${tipo}-${idOrden}`;
}

// ─── a) Crear el documento ─────────────────────────────────────────────────────────────────

async function buscarPorPedido(idNegocio, idOrden, transaction) {
    const filas = await sequelize.query(
        `SELECT * FROM facturacion.fe_documento
          WHERE id_negocio = :idNegocio AND origen_vertical = :vertical AND origen_tipo = :tipo
            AND origen_id = :origenId AND tipo = 'FV';`,
        { replacements: { idNegocio, ...ORIGEN, origenId: String(idOrden) }, transaction, type: SELECT }
    );
    return filas[0] || null;
}

/**
 * Crea el documento de un pedido cobrado, si el negocio factura. Idempotente (D5): llamarlo dos
 * veces para el mismo pedido devuelve el mismo documento.
 *
 * @returns {Promise<object|null>} la fila de `fe_documento`, o `null` si no hay nada que facturar.
 */
async function crearDocumentoPedido({ idOrden, comprador = null, idUsuario = null }) {
    // Lo primero y lo más barato: casi ningún negocio factura, y a esos el cobro no les puede
    // costar más que esta consulta.
    const activos = await sequelize.query(
        `SELECT o.id_negocio, c.facturar_todo
           FROM restaurante.pedid_orden o
           JOIN facturacion.fe_configuracion c ON c.id_negocio = o.id_negocio
          WHERE o.id_orden = :idOrden AND c.estado IN (:estados);`,
        { replacements: { idOrden, estados: configuracionDao.ESTADOS_QUE_EMITEN }, type: SELECT }
    );
    if (activos.length === 0) return null;

    // Sin que nadie la pida no hay factura, salvo en el negocio que lo factura todo. Si el pedido
    // ya tenía una (se cobró en Despacho y ahora se cierra), se devuelve esa.
    if (!activos[0].facturar_todo && (comprador === null || comprador === undefined)) {
        return buscarPorPedido(activos[0].id_negocio, idOrden);
    }
    // «Anónima»: la pidieron, pero sin datos. Sale a consumidor final.
    const anonima = comprador?.consumidor_final === true;

    const pedido = await origenRestaurante.leerPedido(idOrden);
    if (!pedido || !pedido.cobrado || pedido.anulado) return null;

    const { facturar, config } = await configuracionDao.debeFacturar(pedido.id_negocio);
    if (!facturar) return null;

    const existente = await buscarPorPedido(pedido.id_negocio, idOrden);
    if (existente) {
        if (existente.estado === 'PENDIENTE_DATOS' && comprador && !anonima) {
            return completarComprador(existente.id_documento, comprador);
        }
        return existente;
    }

    // Un comprador mal escrito no puede convertirse en «consumidor final» por descarte: el
    // documento espera a que la caja lo corrija.
    let adquiriente = CONSUMIDOR_FINAL;
    let errorComprador = null;
    try {
        adquiriente = anonima ? CONSUMIDOR_FINAL : normalizarComprador(comprador) ?? CONSUMIDOR_FINAL;
    } catch (err) {
        if (err.code !== 'FE_COMPRADOR_INVALIDO') throw err;
        errorComprador = err.message;
    }

    let calculo = null;
    let errorCalculo = null;
    try {
        calculo = construirFactura({
            items: pedido.items,
            domicilio: pedido.valor_domicilio,
            impuestoDomicilio: pedido.impuestoDomicilio,
            descuento: pedido.descuento,
            totalPedido: pedido.total,
            pagos: pedido.pagos,
        });
    } catch (err) {
        // Se crea igual, en ERROR, para que aparezca en la pestaña Facturas y alguien lo vea.
        errorCalculo = err.message;
    }

    let estado = 'EN_COLA';
    if (errorCalculo) estado = 'ERROR';
    else if (errorComprador) estado = 'PENDIENTE_DATOS';
    else if (adquiriente.consumidor_final && calculo.total > topeConsumidorFinal()) estado = 'PENDIENTE_DATOS'; // D10

    const emisor = await datosFiscales.obtener(pedido.id_negocio);

    return sequelize.transaction(async (t) => {
        const insertadas = await sequelize.query(
            `INSERT INTO facturacion.fe_documento
                 (id_negocio, tipo, estado, ambiente, proveedor, origen_vertical, origen_tipo, origen_id,
                  origen_referencia, codigo_referencia, emisor, adquiriente, pagos,
                  subtotal, total_impuestos, total, ajuste_redondeo, ultimo_error, creado_por)
             VALUES (:idNegocio, 'FV', :estado, :ambiente, :proveedor, :vertical, :tipo, :origenId,
                     :origenReferencia, :codigoReferencia, :emisor::jsonb, :adquiriente::jsonb, :pagos::jsonb,
                     :subtotal, :totalImpuestos, :total, :ajuste, :ultimoError, :idUsuario)
             ON CONFLICT ON CONSTRAINT uq_fedoc_origen DO NOTHING
             RETURNING *;`,
            {
                replacements: {
                    idNegocio: pedido.id_negocio,
                    estado,
                    ambiente: config.ambiente,
                    proveedor: config.proveedor,
                    ...ORIGEN,
                    origenId: String(idOrden),
                    origenReferencia: pedido.numero_orden,
                    codigoReferencia: referenciaNueva(pedido.id_negocio, idOrden, config.ambiente),
                    emisor: json(emisor),
                    adquiriente: json(adquiriente),
                    pagos: json(calculo?.pagos ?? []),
                    subtotal: calculo?.subtotal ?? 0,
                    totalImpuestos: calculo?.total_impuestos ?? 0,
                    total: calculo?.total ?? pedido.total,
                    ajuste: calculo?.ajuste_redondeo ?? 0,
                    ultimoError: errorCalculo || errorComprador,
                    idUsuario,
                },
                transaction: t,
                type: SELECT,
            }
        );
        // Sin fila: otro proceso lo creó entre la comprobación y el INSERT. Es el mismo documento.
        if (insertadas.length === 0) return buscarPorPedido(pedido.id_negocio, idOrden, t);

        const doc = insertadas[0];
        for (const l of calculo?.lineas ?? []) {
            await sequelize.query(
                `INSERT INTO facturacion.fe_documento_linea
                     (id_documento, id_negocio, orden, codigo, descripcion, cantidad, precio_bruto, precio_neto,
                      codigo_impuesto, tarifa_impuesto, base, impuesto, total, unidad_medida, es_domicilio)
                 VALUES (:idDocumento, :idNegocio, :orden, :codigo, :descripcion, :cantidad, :precio_bruto,
                         :precio_neto, :codigo_impuesto, :tarifa_impuesto, :base, :impuesto, :total,
                         :unidad_medida, :es_domicilio);`,
                {
                    replacements: {
                        idDocumento: doc.id_documento,
                        idNegocio: pedido.id_negocio,
                        orden: l.orden,
                        codigo: String(l.codigo).slice(0, 50),
                        descripcion: String(l.descripcion).slice(0, 300),
                        cantidad: l.cantidad,
                        precio_bruto: l.precio_bruto,
                        precio_neto: l.precio_neto,
                        codigo_impuesto: l.codigo_impuesto,
                        tarifa_impuesto: l.tarifa_impuesto,
                        base: l.base,
                        impuesto: l.impuesto,
                        total: l.total,
                        unidad_medida: l.unidad_medida,
                        es_domicilio: Boolean(l.es_domicilio),
                    },
                    transaction: t,
                }
            );
        }
        return doc;
    });
}

// ─── b) Procesar ───────────────────────────────────────────────────────────────────────────

/** id_negocio → la promesa de la última emisión encolada de ese negocio. */
const candados = new Map();

function enSerie(idNegocio, tarea) {
    const anterior = candados.get(idNegocio) || Promise.resolve();
    const esta = anterior.catch(() => {}).then(tarea);
    candados.set(idNegocio, esta);
    // Sin esto el mapa crecería con cada negocio que haya emitido alguna vez.
    const limpiar = () => candados.get(idNegocio) === esta && candados.delete(idNegocio);
    esta.then(limpiar, limpiar);
    return esta;
}

function proximoIntento(intentos) {
    const minutos = BACKOFF_MIN[intentos - 1];
    return minutos === undefined ? null : new Date(Date.now() + minutos * 60000);
}

async function registrarIntento(doc, r, duracionMs) {
    await sequelize.query(
        `INSERT INTO facturacion.fe_intento
             (id_documento, id_negocio, duracion_ms, http_status, resultado, mensaje, respuesta)
         VALUES (:idDocumento, :idNegocio, :duracionMs, :httpStatus, :resultado, :mensaje, :respuesta::jsonb);`,
        {
            replacements: {
                idDocumento: doc.id_documento,
                idNegocio: doc.id_negocio,
                duracionMs,
                httpStatus: r.httpStatus ?? null,
                resultado: r.resultado,
                mensaje: r.mensaje ?? null,
                respuesta: json(r.respuesta),
            },
        }
    );
}

function aceptar(doc, r) {
    return actualizarDocumento(doc.id_documento, {
        estado: 'ACEPTADO',
        numero: r.numero,
        cufe: r.cufe,
        fecha_validacion: r.fechaValidacion,
        url_publica: r.urlPublica,
        url_qr: r.urlQr,
        // En una consulta por referencia no hay payload: se conserva el que hubiera.
        payload: json(r.payload ?? doc.payload),
        respuesta: json(r.respuesta),
        avisos: json(r.avisos),
        proximo_intento_en: null,
        ultimo_error: null,
    });
}

async function emitirReclamado(doc) {
    const proveedor = getProveedor(doc.proveedor);
    const esNota = doc.tipo === 'NC';
    const [credenciales, config, rango, lineas] = await Promise.all([
        configuracionDao.obtenerCredenciales(doc.id_negocio),
        configuracionDao.obtener(doc.id_negocio),
        configuracionDao.rangoEnUso(doc.id_negocio, doc.tipo),
        leerLineas(doc.id_documento),
    ]);
    if (!rango) {
        throw fallo(
            esNota
                ? 'El negocio no tiene un rango de notas crédito en uso: no se puede anular la factura.'
                : 'El negocio no tiene un rango de numeración en uso.',
            'FE_SIN_RANGO',
            409
        );
    }
    if (lineas.length === 0) {
        throw fallo(doc.ultimo_error || 'El documento no tiene líneas que facturar.', 'FE_SIN_LINEAS', 409);
    }
    const base = { credenciales, ambiente: doc.ambiente };

    // Si ya se intentó antes, puede que Factus lo tenga y solo nos faltara la respuesta. (La
    // búsqueda por referencia es de facturas; una nota crédito se reenvía con su misma referencia.)
    if (doc.intentos > 1 && !esNota) {
        const inicio = Date.now();
        const previo = await proveedor.consultarPorReferencia({ ...base, codigoReferencia: doc.codigo_referencia });
        if (previo?.resultado === 'ACEPTADO') {
            await registrarIntento(doc, previo, Date.now() - inicio);
            return aceptar(doc, previo);
        }
    }

    const envio = {
        ...base,
        documento: doc,
        lineas,
        idRango: rango.id_rango_proveedor,
        enviarCorreo: config.enviar_correo,
    };
    if (esNota) {
        const factura = await leerDocumento(doc.id_documento_referencia);
        if (!factura?.numero) throw fallo('La factura que anula esta nota no tiene número.', 'FE_SIN_FACTURA', 409);
        envio.facturaReferencia = { numero: factura.numero };
    }
    const inicio = Date.now();
    const r = esNota ? await proveedor.emitirNotaCredito(envio) : await proveedor.emitirFactura(envio);
    await registrarIntento(doc, r, Date.now() - inicio);

    switch (r.resultado) {
        case 'ACEPTADO': {
            const aceptado = await aceptar(doc, r);
            await configuracionDao
                .anotarConsecutivo(rango.id_resolucion, r.numero)
                .catch((err) => console.error('[facturacion] anotarConsecutivo', err.message));
            // La copia propia del PDF y el XML, y después el correo al comprador (que los lleva
            // adjuntos). Ninguno de los dos puede retrasar ni tumbar la respuesta del cobro.
            archivar(doc.id_documento)
                .then(() => enviarCorreo(doc.id_documento))
                .catch((err) => console.error('[facturacion] archivar/correo', doc.id_documento, err.message));
            return aceptado;
        }
        case 'RECHAZADO': {
            const rechazado = await actualizarDocumento(doc.id_documento, {
                estado: 'RECHAZADO',
                payload: json(r.payload),
                respuesta: json(r.respuesta),
                avisos: json(r.avisos),
                proximo_intento_en: null,
                ultimo_error: r.rechazos.map((x) => x.mensaje).join(' ') || r.mensaje,
            });
            // Una factura rechazada que se queda en Factus bloquea las siguientes del negocio.
            if (!esNota) {
                await proveedor
                    .eliminarPendiente({ ...base, codigoReferencia: doc.codigo_referencia })
                    .catch((err) => console.error('[facturacion] eliminarPendiente', doc.codigo_referencia, err.message));
            }
            return rechazado;
        }
        case 'ERROR_CREDENCIALES':
            // Reintentar solo no arregla una contraseña: espera a una persona.
            return actualizarDocumento(doc.id_documento, {
                estado: 'ERROR',
                proximo_intento_en: null,
                ultimo_error: r.mensaje,
            });
        default:
            // PENDIENTE_DIAN, ERROR_RED, ERROR_PROVEEDOR, BLOQUEADO_PENDIENTE: se reintenta con
            // los MISMOS datos y la misma referencia.
            return actualizarDocumento(doc.id_documento, {
                estado: 'ERROR',
                proximo_intento_en: proximoIntento(doc.intentos),
                ultimo_error: r.mensaje,
            });
    }
}

/**
 * Envía un documento en cola. Si otro proceso ya lo tiene, o todavía no le toca, no hace nada.
 *
 * @returns {Promise<object|null>} la fila como quedó.
 */
async function procesarDocumento(idDocumento, { forzar = false } = {}) {
    const actual = await leerDocumento(idDocumento);
    if (!actual) return null;

    return enSerie(actual.id_negocio, async () => {
        const reclamados = await sequelize.query(
            `UPDATE facturacion.fe_documento
                SET estado = 'ENVIANDO', intentos = intentos + 1, actualizado_en = now()
              WHERE id_documento = :idDocumento
                AND estado IN ('EN_COLA','ERROR')
                AND (:forzar OR proximo_intento_en IS NULL OR proximo_intento_en <= now())
             RETURNING *;`,
            { replacements: { idDocumento, forzar }, type: SELECT }
        );
        const doc = reclamados[0];
        if (!doc) return leerDocumento(idDocumento);

        try {
            return await emitirReclamado(doc);
        } catch (err) {
            // Pase lo que pase, nunca se queda en ENVIANDO.
            console.error('[facturacion] procesarDocumento', idDocumento, err.message);
            return actualizarDocumento(idDocumento, {
                estado: 'ERROR',
                // Un error nuestro (sin credenciales, sin rango, sin líneas) no se arregla
                // esperando: se queda hasta que alguien lo resuelva y pulse «Reintentar».
                proximo_intento_en: String(err.code || '').startsWith('FE_') ? null : proximoIntento(doc.intentos),
                ultimo_error: err.message,
            });
        }
    });
}

// ─── c) Archivar ───────────────────────────────────────────────────────────────────────────

/** Guarda nuestra copia del PDF y el XML (D13): Factus no conserva nada si la cuenta se elimina. */
async function archivar(idDocumento) {
    const doc = await leerDocumento(idDocumento);
    if (!doc || doc.estado !== 'ACEPTADO' || !doc.numero) return;
    const credenciales = await configuracionDao.obtenerCredenciales(doc.id_negocio);
    const proveedor = getProveedor(doc.proveedor);
    const yaEstan = await sequelize.query(
        `SELECT tipo FROM facturacion.fe_documento_archivo WHERE id_documento = :idDocumento;`,
        { replacements: { idDocumento }, type: SELECT }
    );
    for (const tipo of ['PDF', 'XML']) {
        if (yaEstan.some((a) => a.tipo === tipo)) continue;
        const contenido = await proveedor.descargarArchivo({
            credenciales,
            ambiente: doc.ambiente,
            numero: doc.numero,
            tipo,
            documento: doc.tipo,
        });
        await sequelize.query(
            `INSERT INTO facturacion.fe_documento_archivo (id_documento, tipo, contenido, bytes, sha256)
             VALUES (:idDocumento, :tipo, :contenido, :bytes, :sha256)
             ON CONFLICT (id_documento, tipo) DO NOTHING;`,
            {
                replacements: {
                    idDocumento,
                    tipo,
                    contenido,
                    bytes: contenido.length,
                    sha256: crypto.createHash('sha256').update(contenido).digest('hex'),
                },
            }
        );
    }
}

/**
 * Le manda al comprador su factura (o nota crédito), con la marca del negocio y el PDF y el XML
 * adjuntos. Una sola vez por documento: el reclamo es atómico, así que dos procesos no mandan dos
 * correos; si el envío falla, se suelta para poder reintentarlo.
 *
 * No hace nada si el comprador no dio correo o si el negocio apagó el envío.
 *
 * @returns {Promise<boolean>} si se envió.
 */
async function enviarCorreo(idDocumento) {
    const doc = await leerDocumento(idDocumento);
    const correo = doc?.adquiriente?.correo;
    if (!doc || doc.estado !== 'ACEPTADO' || !correo || doc.correo_enviado_en) return false;
    const config = await configuracionDao.obtener(doc.id_negocio);
    if (config && config.enviar_correo === false) return false;

    const [reclamado] = await sequelize.query(
        `UPDATE facturacion.fe_documento SET correo_enviado_en = now()
          WHERE id_documento = :idDocumento AND correo_enviado_en IS NULL RETURNING id_documento;`,
        { replacements: { idDocumento }, type: SELECT }
    );
    if (!reclamado) return false;

    try {
        const [lineas, marca, pdf, xml, anulada] = await Promise.all([
            leerLineas(idDocumento),
            marcaDeNegocio(doc.id_negocio),
            obtenerArchivo(idDocumento, 'PDF'),
            obtenerArchivo(idDocumento, 'XML'),
            doc.id_documento_referencia ? leerDocumento(doc.id_documento_referencia) : null,
        ]);
        const { asunto, html, texto } = correoFactura({
            documento: { ...doc, numero_factura_anulada: anulada?.numero ?? null },
            lineas,
            marca,
            ejemplo: doc.ambiente === 'PRUEBAS',
        });
        // El servicio de correo vive en el admin; se carga aquí y no arriba para no arrastrarlo
        // a quien solo necesita emitir (las pruebas, los scripts).
        const MailService = require('../../app_admin_api/services/mailService');
        const enviado = await MailService.sendHtmlEmail({
            to: correo,
            subject: asunto,
            text: texto,
            html,
            attachments: [
                { filename: `${doc.numero}.pdf`, content: pdf, contentType: 'application/pdf' },
                { filename: `${doc.numero}.xml`, content: xml, contentType: 'application/xml' },
            ],
        });
        if (!enviado) throw new Error('el servicio de correo no lo envió');
        return true;
    } catch (err) {
        await sequelize.query(
            `UPDATE facturacion.fe_documento SET correo_enviado_en = NULL WHERE id_documento = :idDocumento;`,
            { replacements: { idDocumento } }
        );
        console.error('[facturacion] enviarCorreo', idDocumento, err.message);
        return false;
    }
}

// ─── d) Lo que llama la vertical ───────────────────────────────────────────────────────────

function resumen(doc) {
    let mensaje = 'La factura se está procesando';
    if (doc.estado === 'ACEPTADO') {
        mensaje = doc.tipo === 'NC' ? `Nota crédito ${doc.numero} enviada` : `Factura ${doc.numero} enviada`;
    } else if (doc.estado === 'ANULADO') mensaje = 'La factura se anuló antes de enviarse';
    else if (doc.estado === 'PENDIENTE_DATOS') {
        mensaje = doc.ultimo_error || 'Faltan los datos del comprador (el total supera 5 UVT)';
    } else if (doc.estado === 'RECHAZADO') mensaje = 'La factura fue rechazada y hay que corregirla';
    return {
        id_documento: doc.id_documento,
        estado: doc.estado,
        tipo: doc.tipo,
        numero: doc.numero,
        cufe: doc.cufe,
        // Hacia afuera, la consulta de la DIAN; nunca la página del proveedor (ver urlConsultaDian).
        url_publica: urlConsultaDian(doc.cufe, doc.ambiente),
        url_qr: doc.url_qr,
        mensaje,
    };
}

/**
 * El gancho del cobro. **Nunca lanza** y espera como mucho `FE_ESPERA_MS`: si Factus tarda más,
 * el documento sigue su camino y la caja lo ve después.
 *
 * @returns {Promise<{id_documento, estado, numero, url_publica, mensaje}|null>} `null` si este
 *          negocio no factura (lo normal) o si algo falló antes de crear el documento.
 */
async function alCobrarPedido({ idOrden, comprador = null, idUsuario = null }) {
    try {
        const doc = await crearDocumentoPedido({ idOrden, comprador, idUsuario });
        if (!doc) return null;
        if (doc.estado !== 'EN_COLA') return resumen(doc);
        const espera = Number(process.env.FE_ESPERA_MS || 5000);
        let reloj;
        const final = await Promise.race([
            procesarDocumento(doc.id_documento, { forzar: true }),
            new Promise((r) => {
                reloj = setTimeout(() => r(null), espera);
            }),
        ]);
        clearTimeout(reloj);
        return resumen(final || doc); // si no alcanzó, sigue en proceso: se verá luego
    } catch (err) {
        console.error('[facturacion] alCobrarPedido', idOrden, err.message);
        return null;
    }
}

// ─── Anular (D17) ──────────────────────────────────────────────────────────────────────────

const ANULABLES_SIN_NOTA = ['PENDIENTE_DATOS', 'EN_COLA', 'ERROR', 'RECHAZADO'];

/** Crea la nota crédito que anula por completo una factura aceptada. Idempotente por pedido. */
async function crearNotaCredito(factura, idUsuario) {
    return sequelize.transaction(async (t) => {
        const insertadas = await sequelize.query(
            `INSERT INTO facturacion.fe_documento
                 (id_negocio, tipo, estado, ambiente, proveedor, origen_vertical, origen_tipo, origen_id,
                  origen_referencia, id_documento_referencia, codigo_referencia, emisor, adquiriente, pagos,
                  subtotal, total_impuestos, total, ajuste_redondeo, creado_por)
             SELECT id_negocio, 'NC', 'EN_COLA', ambiente, proveedor, origen_vertical, origen_tipo, origen_id,
                    origen_referencia, id_documento, :codigoReferencia, emisor, adquiriente, pagos,
                    subtotal, total_impuestos, total, ajuste_redondeo, :idUsuario
               FROM facturacion.fe_documento WHERE id_documento = :idFactura
             ON CONFLICT ON CONSTRAINT uq_fedoc_origen DO NOTHING
             RETURNING *;`,
            {
                replacements: {
                    idFactura: factura.id_documento,
                    idUsuario,
                    codigoReferencia: referenciaNueva(factura.id_negocio, factura.origen_id, factura.ambiente, 'NC'),
                },
                transaction: t,
                type: SELECT,
            }
        );
        if (insertadas.length === 0) {
            const [ya] = await sequelize.query(
                `SELECT * FROM facturacion.fe_documento WHERE id_documento_referencia = :idFactura AND tipo = 'NC';`,
                { replacements: { idFactura: factura.id_documento }, transaction: t, type: SELECT }
            );
            return ya;
        }
        await sequelize.query(
            `INSERT INTO facturacion.fe_documento_linea
                 (id_documento, id_negocio, orden, codigo, descripcion, cantidad, precio_bruto, precio_neto,
                  codigo_impuesto, tarifa_impuesto, base, impuesto, total, unidad_medida, es_domicilio)
             SELECT :idNota, id_negocio, orden, codigo, descripcion, cantidad, precio_bruto, precio_neto,
                    codigo_impuesto, tarifa_impuesto, base, impuesto, total, unidad_medida, es_domicilio
               FROM facturacion.fe_documento_linea WHERE id_documento = :idFactura;`,
            { replacements: { idNota: insertadas[0].id_documento, idFactura: factura.id_documento }, transaction: t }
        );
        return insertadas[0];
    });
}

/**
 * El gancho de la anulación de un pedido cobrado. **Nunca lanza.**
 *
 * Una factura que todavía no salió se anula sin más; una ya aceptada por la DIAN no se puede
 * tocar, así que se emite una nota crédito por el total.
 */
async function alAnularPedido({ idOrden, idUsuario = null }) {
    try {
        const [factura] = await sequelize.query(
            `SELECT * FROM facturacion.fe_documento
              WHERE origen_vertical = :vertical AND origen_tipo = :tipo AND origen_id = :origenId AND tipo = 'FV';`,
            { replacements: { ...ORIGEN, origenId: String(idOrden) }, type: SELECT }
        );
        if (!factura) return null;

        const anular = () =>
            sequelize.query(
                `UPDATE facturacion.fe_documento
                    SET estado = 'ANULADO', proximo_intento_en = NULL, actualizado_en = now()
                  WHERE id_documento = :id AND estado IN (:estados) RETURNING *;`,
                { replacements: { id: factura.id_documento, estados: ANULABLES_SIN_NOTA }, type: SELECT }
            );
        let [anulada] = await anular();
        if (anulada) return resumen(anulada);

        let actual = await leerDocumento(factura.id_documento);
        if (actual.estado === 'ENVIANDO') {
            // Justo lo tiene el proceso de fondo: se le da tiempo a terminar y se mira otra vez.
            await new Promise((r) => setTimeout(r, Number(process.env.FE_ESPERA_ANULAR_MS || 10000)));
            [anulada] = await anular();
            if (anulada) return resumen(anulada);
            actual = await leerDocumento(factura.id_documento);
        }
        if (actual.estado !== 'ACEPTADO') return resumen(actual);

        const nota = await crearNotaCredito(actual, idUsuario);
        const final = nota.estado === 'EN_COLA' ? await procesarDocumento(nota.id_documento, { forzar: true }) : nota;
        return resumen(final);
    } catch (err) {
        console.error('[facturacion] alAnularPedido', idOrden, err.message);
        return null;
    }
}

// ─── Lo que lee la pestaña «Facturas» ──────────────────────────────────────────────────────

/** Los documentos de un negocio, del más reciente al más antiguo (máx. 200). */
async function listar(idNegocio, { desde = null, hasta = null, estado = null } = {}) {
    const filas = await sequelize.query(
        `SELECT d.id_documento, d.tipo, d.estado, d.numero, d.origen_referencia, d.total, d.creado_en,
                d.ultimo_error, d.ambiente, d.cufe, d.intentos,
                COALESCE(d.adquiriente->>'razon_social', d.adquiriente->>'nombres') AS comprador,
                COALESCE((d.adquiriente->>'consumidor_final')::boolean, false) AS consumidor_final,
                f.numero AS numero_factura_anulada
           FROM facturacion.fe_documento d
           LEFT JOIN facturacion.fe_documento f ON f.id_documento = d.id_documento_referencia
          WHERE d.id_negocio = :idNegocio
            AND (CAST(:desde AS date) IS NULL OR d.creado_en >= CAST(:desde AS date))
            AND (CAST(:hasta AS date) IS NULL OR d.creado_en < CAST(:hasta AS date) + 1)
            AND (CAST(:estado AS text) IS NULL OR d.estado = :estado)
          ORDER BY d.creado_en DESC
          LIMIT 200;`,
        { replacements: { idNegocio, desde, hasta, estado }, type: SELECT }
    );
    // «Ver en línea» abre la consulta de la DIAN, no la página del proveedor.
    return filas.map(({ ambiente, ...d }) => ({ ...d, url_publica: urlConsultaDian(d.cufe, ambiente) }));
}

/** Un documento, solo si es de ese negocio. `null` tanto si no existe como si es de otro. */
async function obtenerDeNegocio(idDocumento, idNegocio) {
    const filas = await sequelize.query(
        `SELECT * FROM facturacion.fe_documento WHERE id_documento = :idDocumento AND id_negocio = :idNegocio;`,
        { replacements: { idDocumento, idNegocio }, type: SELECT }
    );
    return filas[0] || null;
}

/** El PDF o el XML guardado; si todavía no está, intenta traerlo una vez. */
async function obtenerArchivo(idDocumento, tipo = 'PDF') {
    const leer = () =>
        sequelize.query(
            `SELECT contenido FROM facturacion.fe_documento_archivo WHERE id_documento = :idDocumento AND tipo = :tipo;`,
            { replacements: { idDocumento, tipo }, type: SELECT }
        );
    let [archivo] = await leer();
    if (!archivo) {
        await archivar(idDocumento).catch((err) => console.error('[facturacion] archivar', idDocumento, err.message));
        [archivo] = await leer();
    }
    if (!archivo) throw fallo('El archivo de este documento todavía no está disponible.', 'FE_ARCHIVO_NO_DISPONIBLE', 404);
    return archivo.contenido;
}

// ─── e), f) Lo que hace una persona desde la caja ──────────────────────────────────────────

/** Pone (o corrige) el comprador de un documento que lo espera o que fue rechazado. */
async function completarComprador(idDocumento, comprador) {
    const doc = await leerDocumento(idDocumento);
    if (!doc) throw fallo('El documento no existe.', 'FE_DOCUMENTO_NO_ENCONTRADO', 404);
    if (!['PENDIENTE_DATOS', 'RECHAZADO'].includes(doc.estado)) {
        throw fallo('Este documento ya no se puede corregir.', 'FE_DOCUMENTO_NO_EDITABLE', 409);
    }
    const adquiriente = normalizarComprador(comprador);
    if (!adquiriente) throw fallo('Faltan los datos del comprador.', 'FE_COMPRADOR_INVALIDO', 422);
    return actualizarDocumento(idDocumento, {
        adquiriente: json(adquiriente),
        estado: 'EN_COLA',
        proximo_intento_en: null,
        ultimo_error: null,
        // La referencia de un rechazado quedó gastada en Factus: repetirla sería repetir el
        // mismo intento que ya falló.
        codigo_referencia: doc.estado === 'RECHAZADO' ? `${doc.codigo_referencia}-r${doc.intentos}` : doc.codigo_referencia,
    });
}

/** «Reintentar» de la pestaña Facturas. */
async function reintentar(idDocumento) {
    const doc = await leerDocumento(idDocumento);
    if (!doc) throw fallo('El documento no existe.', 'FE_DOCUMENTO_NO_ENCONTRADO', 404);
    if (!['ERROR', 'RECHAZADO'].includes(doc.estado)) {
        throw fallo('Este documento no está para reintentar.', 'FE_DOCUMENTO_NO_EDITABLE', 409);
    }
    await actualizarDocumento(idDocumento, {
        estado: 'EN_COLA',
        proximo_intento_en: null,
        codigo_referencia: doc.estado === 'RECHAZADO' ? `${doc.codigo_referencia}-r${doc.intentos}` : doc.codigo_referencia,
    });
    return procesarDocumento(idDocumento, { forzar: true });
}

// ─── g), h) Lo que hace el proceso de fondo ────────────────────────────────────────────────

/**
 * Pedidos cobrados que se quedaron sin documento (el proceso se reinició justo después del
 * commit, o el gancho falló). Es la red de D4, y solo existe para los negocios que facturan
 * todos sus cobros: en los demás no hay forma de saber si a un pedido le falta la factura o
 * simplemente nadie la pidió.
 *
 * `fecha_creacion` es `timestamp` en hora de Bogotá y `activado_en` es `timestamptz`: la
 * comparación es correcta porque la sesión de Postgres está en `America/Bogota`. No «arreglarlo».
 */
async function reconciliar() {
    const huerfanos = await sequelize.query(
        `SELECT o.id_orden
           FROM restaurante.pedid_orden o
           JOIN facturacion.fe_configuracion c
             ON c.id_negocio = o.id_negocio AND c.estado IN ('EN_PRUEBAS','ACTIVO')
            -- Solo donde se factura todo: en los demás, un pedido sin documento es lo normal.
            AND c.facturar_todo
          WHERE (o.estado_pago = 'pagado' OR (o.estado = 'CERRADA' AND o.id_caja IS NOT NULL))
            AND o.estado NOT IN ('CANCELADA','ANULADA')
            AND o.fecha_creacion >= c.activado_en
            AND o.fecha_creacion >= now() - interval '72 hours'
            AND o.fecha_creacion <= now() - interval '2 minutes'
            AND NOT EXISTS (
                SELECT 1 FROM facturacion.fe_documento d
                 WHERE d.id_negocio = o.id_negocio AND d.origen_vertical = 'RESTAURANTE'
                   AND d.origen_tipo = 'PEDIDO' AND d.origen_id = o.id_orden::text AND d.tipo = 'FV')
          LIMIT 50;`,
        { type: SELECT }
    );
    let creados = 0;
    for (const { id_orden: idOrden } of huerfanos) {
        try {
            if (await crearDocumentoPedido({ idOrden, comprador: null })) creados += 1;
        } catch (err) {
            console.error('[facturacion] reconciliar', idOrden, err.message);
        }
    }
    return creados;
}

/** Un ciclo de reintentos: suelta los atascados y envía, en serie, lo que ya toca. */
async function procesarPendientes() {
    // Un ENVIANDO de hace cinco minutos es un proceso que murió a mitad: vuelve a la cola.
    await sequelize.query(
        `UPDATE facturacion.fe_documento SET estado = 'EN_COLA', actualizado_en = now()
          WHERE estado = 'ENVIANDO' AND actualizado_en < now() - interval '5 minutes';`
    );
    // Un ERROR sin fecha de reintento espera a una persona; un EN_COLA sin fecha, no.
    const pendientes = await sequelize.query(
        `SELECT id_documento FROM facturacion.fe_documento
          WHERE (estado = 'EN_COLA' AND (proximo_intento_en IS NULL OR proximo_intento_en <= now()))
             OR (estado = 'ERROR' AND proximo_intento_en <= now())
          ORDER BY creado_en
          LIMIT 20;`,
        { type: SELECT }
    );
    for (const { id_documento: idDocumento } of pendientes) await procesarDocumento(idDocumento);
    return pendientes.length;
}

module.exports = {
    crearDocumentoPedido,
    procesarDocumento,
    archivar,
    alCobrarPedido,
    alAnularPedido,
    listar,
    obtenerDeNegocio,
    obtenerArchivo,
    enviarCorreo,
    completarComprador,
    reintentar,
    reconciliar,
    procesarPendientes,
    resumen,
};
