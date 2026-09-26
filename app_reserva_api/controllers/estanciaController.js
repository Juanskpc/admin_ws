'use strict';
/**
 * Estancias por noches (alojamiento, hotel y guardería de mascotas) y sus unidades.
 * Ver `services/estancia/`.
 */
const path = require('path');
const fs = require('fs');
const { validationResult } = require('express-validator');
const Models = require('../../app_core/models/conection');
const Respuesta = require('../../app_core/helpers/respuesta');
const Estancias = require('../services/estancia/estanciaService');
const Unidades = require('../services/estancia/unidadService');
const Ical = require('../services/estancia/icalService');

function check(req, res) {
    const e = validationResult(req);
    if (!e.isEmpty()) { Respuesta.error(res, 'Datos inválidos', 422, e.array()); return false; }
    return true;
}

const idNegocio = (req) => Number(req.body?.id_negocio ?? req.query?.id_negocio ?? req.params?.id_negocio);
const usuario = (req) => req.usuario?.id_usuario ?? null;

function objetoDe(valor) {
    if (valor == null || valor === '') return null;
    if (typeof valor === 'object') return valor;
    try { return JSON.parse(String(valor)); } catch { return null; }
}

function manejar(contexto, fn, { codigo = 200, mensaje = 'OK' } = {}) {
    return async (req, res) => {
        if (!check(req, res)) return;
        try {
            const data = await fn(req);
            if (data === null) return Respuesta.error(res, 'No encontrado', 404);
            return Respuesta.success(res, mensaje, data, codigo);
        } catch (err) {
            if (err.statusCode) {
                return Respuesta.error(res, err.message, err.statusCode, err.code ? [{ code: err.code }] : null);
            }
            console.error(`[Reserva/Estancias] ${contexto}:`, err.message);
            return Respuesta.error(res, 'Error al procesar la solicitud.');
        }
    };
}

// ── Estancias (negocio) ──
const disponibilidad = manejar('disponibilidad', (req) => Estancias.disponibilidad(idNegocio(req), {
    entrada: String(req.query.entrada), salida: String(req.query.salida), huespedes: Number(req.query.huespedes || 1),
}));
const listar = manejar('listar', (req) => Estancias.listar(idNegocio(req), {
    desde: req.query.desde || null, hasta: req.query.hasta || null, estado: req.query.estado || null, q: req.query.q || null,
}));
const ocupacion = manejar('ocupacion', (req) => Estancias.ocupacion(idNegocio(req), {
    desde: String(req.query.desde), hasta: String(req.query.hasta),
}));
const resumenDia = manejar('resumen', (req) => Estancias.resumenDelDia(idNegocio(req)));
const informe = manejar('informe', (req) => Estancias.informe(idNegocio(req), {
    desde: String(req.query.desde), hasta: String(req.query.hasta),
}));
const getById = manejar('getById', (req) => Estancias.getById(idNegocio(req), Number(req.params.id)));

const crear = manejar('crear', (req) => Estancias.crear({
    idNegocio: idNegocio(req),
    idUnidadTipo: Number(req.body.id_unidad_tipo),
    idUnidad: req.body.id_unidad ? Number(req.body.id_unidad) : null,
    entrada: String(req.body.fecha_entrada),
    salida: String(req.body.fecha_salida),
    huespedes: Number(req.body.huespedes || 1),
    clienteNombre: req.body.cliente_nombre,
    clienteTelefono: req.body.cliente_telefono || null,
    clienteEmail: req.body.cliente_email || null,
    clienteDocumento: req.body.cliente_documento || null,
    notas: req.body.notas || null,
    idMascota: req.body.id_mascota || null,
    mascota: objetoDe(req.body.mascota),
    origen: req.body.origen || null,
    creadoPorIdUsuario: usuario(req),
}), { codigo: 201, mensaje: 'Estancia creada' });

const actualizar = manejar('actualizar', (req) => Estancias.actualizar(idNegocio(req), Number(req.params.id), req.body, usuario(req)));
const confirmar = manejar('confirmar', (req) => Estancias.confirmar(idNegocio(req), Number(req.params.id)));
const checkin = manejar('checkin', (req) => Estancias.checkin(idNegocio(req), Number(req.params.id)));
const noShow = manejar('noShow', (req) => Estancias.noShow(idNegocio(req), Number(req.params.id)));
const cancelar = manejar('cancelar', (req) => Estancias.cancelar(idNegocio(req), Number(req.params.id), {
    motivo: req.body.motivo || null, por: 'negocio', idUsuario: usuario(req),
}));
const checkout = manejar('checkout', (req) => Estancias.checkout(idNegocio(req), Number(req.params.id), {
    pagos: req.body.pagos, idMetodoPago: req.body.id_metodo_pago, idUsuario: usuario(req),
}));
const registrarPago = manejar('pago', (req) => Estancias.registrarPago(idNegocio(req), Number(req.params.id), {
    pagos: req.body.pagos, idMetodoPago: req.body.id_metodo_pago, valor: req.body.valor, idUsuario: usuario(req),
}));
const agregarCargo = manejar('cargo', (req) => Estancias.agregarCargo(idNegocio(req), Number(req.params.id), {
    concepto: req.body.concepto, valor: req.body.valor, idUsuario: usuario(req),
}));
const eliminarCargo = manejar('cargo', (req) => Estancias.eliminarCargo(idNegocio(req), Number(req.params.id), Number(req.params.idCargo)));
const aprobarPago = manejar('aprobar', (req) => Estancias.aprobarPago(idNegocio(req), Number(req.params.id), {
    idMetodoPago: req.body.id_metodo_pago ? Number(req.body.id_metodo_pago) : null, idUsuario: usuario(req),
}));
const rechazarPago = manejar('rechazar', (req) => Estancias.rechazarPago(idNegocio(req), Number(req.params.id), {
    motivo: req.body.motivo || null, idUsuario: usuario(req),
}));
const devolver = manejar('devolver', (req) => Estancias.devolver(idNegocio(req), Number(req.params.id), {
    valor: req.body.valor, idMetodoPago: req.body.id_metodo_pago || null, idUsuario: usuario(req),
}));

async function comprobante(req, res) {
    try {
        const e = await Models.ReservaEstancia.findOne({
            where: { id_estancia: Number(req.params.id), id_negocio: idNegocio(req) }, attributes: ['comprobante_pago_url'],
        });
        if (!e?.comprobante_pago_url) return Respuesta.error(res, 'Comprobante no disponible', 404);
        const raiz = path.resolve(path.join(__dirname, '..', '..'));
        const abs = path.resolve(raiz, e.comprobante_pago_url.replace(/^\/+/, ''));
        if (!abs.startsWith(path.join(raiz, 'uploads'))) return Respuesta.error(res, 'Ruta inválida', 400);
        if (!fs.existsSync(abs)) return Respuesta.error(res, 'Archivo no encontrado', 404);
        return res.sendFile(abs);
    } catch (err) {
        console.error('[Reserva/Estancias] comprobante:', err.message);
        return Respuesta.error(res, 'Error al obtener el comprobante.');
    }
}

// ── Unidades ──
const unidadesListar = manejar('unidades', (req) => Unidades.listarTipos(idNegocio(req)));
const tipoCrear = manejar('unidades', (req) => Unidades.crearTipo(idNegocio(req), req.body), { codigo: 201, mensaje: 'Tipo creado' });
const tipoActualizar = manejar('unidades', (req) => Unidades.actualizarTipo(idNegocio(req), Number(req.params.id), req.body));
const tipoInactivar = manejar('unidades', (req) => Unidades.inactivarTipo(idNegocio(req), Number(req.params.id)));
const tipoImagen = manejar('unidades', (req) => Unidades.subirImagenTipo(idNegocio(req), Number(req.params.id), req.file));
const tipoImagenEliminar = manejar('unidades', (req) => Unidades.eliminarImagenTipo(idNegocio(req), Number(req.params.id)));
const temporadaCrear = manejar('temporadas', (req) => Unidades.guardarTemporada(idNegocio(req), Number(req.params.id), req.body), { codigo: 201 });
const temporadaActualizar = manejar('temporadas',
    (req) => Unidades.guardarTemporada(idNegocio(req), Number(req.params.id), req.body, Number(req.params.idTarifa)));
const temporadaEliminar = manejar('temporadas', (req) => Unidades.eliminarTemporada(idNegocio(req), Number(req.params.id)));
const unidadCrear = manejar('unidades', (req) => Unidades.crearUnidad(idNegocio(req), Number(req.params.id), req.body), { codigo: 201 });
const unidadActualizar = manejar('unidades', (req) => Unidades.actualizarUnidad(idNegocio(req), Number(req.params.id), req.body));
const unidadInactivar = manejar('unidades', (req) => Unidades.inactivarUnidad(idNegocio(req), Number(req.params.id)));
const unidadToken = manejar('unidades', (req) => Unidades.regenerarTokenIcal(idNegocio(req), Number(req.params.id)));
const bloqueoCrear = manejar('bloqueos', (req) => Unidades.crearBloqueo(idNegocio(req), Number(req.params.id), {
    desde: req.body.fecha_desde, hasta: req.body.fecha_hasta, motivo: req.body.motivo,
}), { codigo: 201, mensaje: 'Bloqueo creado' });
const bloqueoEliminar = manejar('bloqueos', (req) => Unidades.eliminarBloqueo(idNegocio(req), Number(req.params.id)));
const calendarioCrear = manejar('calendarios', async (req) => {
    const c = await Unidades.crearCalendario(idNegocio(req), Number(req.params.id), req.body);
    // Se sincroniza de una vez: el dueño quiere ver sus reservas de Airbnb ahora, no en 15 min.
    const r = await Ical.sincronizarCalendario(c);
    return { ...c.toJSON(), sincronizacion: r };
}, { codigo: 201, mensaje: 'Calendario conectado' });
const calendarioEliminar = manejar('calendarios', (req) => Unidades.eliminarCalendario(idNegocio(req), Number(req.params.id)));
const sincronizar = manejar('sincronizar', (req) => Ical.sincronizarNegocio(idNegocio(req), req.body.id_unidad ? Number(req.body.id_unidad) : null));

// ── Portal ──
const publicoDisponibilidad = manejar('publico', (req) => Estancias.disponibilidad(Number(req.params.id_negocio), {
    entrada: String(req.query.entrada), salida: String(req.query.salida), huespedes: Number(req.query.huespedes || 1),
}).then((lista) => lista.map(({ unidades_libres, ...resto }) => resto)));

const publicoCrear = manejar('publicoCrear', async (req) => {
    const n = Number(req.params.id_negocio);
    const e = await Estancias.crear({
        idNegocio: n,
        idUnidadTipo: Number(req.body.id_unidad_tipo),
        entrada: String(req.body.fecha_entrada),
        salida: String(req.body.fecha_salida),
        huespedes: Number(req.body.huespedes || 1),
        clienteNombre: req.body.cliente_nombre,
        clienteTelefono: req.body.cliente_telefono || null,
        clienteEmail: req.body.cliente_email || null,
        clienteDocumento: req.body.cliente_documento || null,
        notas: req.body.notas || null,
        mascota: objetoDe(req.body.mascota),
        comprobantePath: req.file ? `/uploads/reserva/comprobantes/${n}/${req.file.filename}` : null,
        creadoPorIdUsuario: null,
    });
    return formatearPublica(e);
}, { codigo: 201, mensaje: 'Reserva creada' });

/** Lo que ve el huésped en «Mi reserva»: sin notas internas ni datos de caja. */
function formatearPublica(e) {
    const j = e?.toJSON ? e.toJSON() : e;
    return {
        tipo: 'estancia',
        id_estancia: j.id_estancia,
        codigo_publico: j.codigo_publico,
        estado: j.estado,
        pago_estado: j.pago_estado,
        requiere_pago: j.requiere_pago,
        fecha_entrada: j.fecha_entrada,
        fecha_salida: j.fecha_salida,
        huespedes: j.huespedes,
        cliente_nombre: j.cliente_nombre,
        unidad_tipo: j.tipo?.nombre || null,
        noches: (j.detalle_noches || []).length,
        detalle_noches: j.detalle_noches || [],
        monto_total: Number(j.monto_total || 0),
        monto_abono: j.monto_abono == null ? null : Number(j.monto_abono),
        mascota: j.mascota ? { nombre: j.mascota.nombre } : null,
        negocio: j.negocio || undefined,
    };
}

async function icalExportar(req, res) {
    try {
        const token = String(req.params.token || '').replace(/\.ics$/i, '');
        if (!/^[0-9a-f-]{36}$/i.test(token)) return res.status(404).send('No encontrado');
        const r = await Ical.exportar(token);
        if (!r) return res.status(404).send('No encontrado');
        res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache');
        return res.send(r.ics);
    } catch (err) {
        console.error('[Reserva/iCal] exportar:', err.message);
        return res.status(500).send('Error');
    }
}

module.exports = {
    disponibilidad, listar, ocupacion, resumenDia, informe, getById, crear, actualizar,
    confirmar, checkin, noShow, cancelar, checkout, registrarPago, agregarCargo, eliminarCargo,
    aprobarPago, rechazarPago, devolver, comprobante,
    unidadesListar, tipoCrear, tipoActualizar, tipoInactivar, tipoImagen, tipoImagenEliminar,
    temporadaCrear, temporadaActualizar, temporadaEliminar,
    unidadCrear, unidadActualizar, unidadInactivar, unidadToken,
    bloqueoCrear, bloqueoEliminar, calendarioCrear, calendarioEliminar, sincronizar,
    publicoDisponibilidad, publicoCrear, formatearPublica, icalExportar,
};
