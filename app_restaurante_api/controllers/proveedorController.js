'use strict';
/**
 * proveedorController — capa HTTP del módulo de Proveedores.
 *
 * No decide nada: valida la entrada, llama al servicio y traduce el error tipado a un código
 * HTTP. Toda la regla de privacidad (qué ve cada negocio de cada ficha) vive en
 * `proveedorService`, que es donde se puede razonar sobre ella de una vez y no endpoint a
 * endpoint.
 */
const fs = require('fs');
const path = require('path');
const { validationResult } = require('express-validator');

const ProveedorService = require('../services/proveedorService');
const CompraService = require('../services/compraService');
const Models = require('../../app_core/models/conection');
const Respuesta = require('../../app_core/helpers/respuesta');

const ADJUNTOS_BASE = path.resolve(path.join(__dirname, '..', '..', 'uploads', 'restaurante', 'compras'));

function invalido(req, res) {
    const e = validationResult(req);
    if (e.isEmpty()) return false;
    Respuesta.error(res, 'Datos de entrada inválidos', 400, e.array());
    return true;
}

function fallo(res, err, etiqueta) {
    if (err.statusCode) {
        return Respuesta.error(res, err.message, err.statusCode, null, { code: err.code });
    }
    console.error(`[Restaurante/Proveedores] ${etiqueta}:`, err.message);
    return Respuesta.error(res, 'Error al procesar la solicitud de proveedores.');
}

const idUsuarioDe = (req) => req.usuario.id_usuario;
const idNegocioQuery = (req) => (req.query.id_negocio ? Number(req.query.id_negocio) : null);

// ============================================================
// Catálogo
// ============================================================

async function categorias(_req, res) {
    try {
        const data = await ProveedorService.listarCategorias();
        return Respuesta.success(res, 'Categorías de proveedor', data);
    } catch (err) { return fallo(res, err, 'categorias'); }
}

// ============================================================
// Proveedores
// ============================================================

async function listar(req, res) {
    if (invalido(req, res)) return;
    try {
        const data = await ProveedorService.listar(idUsuarioDe(req), {
            idNegocio: idNegocioQuery(req),
            ambito: req.query.ambito,
            busqueda: req.query.busqueda,
            categoria: req.query.categoria,
            ciudad: req.query.ciudad,
            orden: req.query.orden,
            incluirArchivados: req.query.archivados === 'true',
            limite: req.query.limite,
            offset: req.query.offset,
        });
        return Respuesta.success(res, 'Proveedores obtenidos', data);
    } catch (err) { return fallo(res, err, 'listar'); }
}

async function detalle(req, res) {
    if (invalido(req, res)) return;
    try {
        const data = await ProveedorService.detalle(
            idUsuarioDe(req), Number(req.params.id), idNegocioQuery(req),
        );
        return Respuesta.success(res, 'Proveedor obtenido', data);
    } catch (err) { return fallo(res, err, 'detalle'); }
}

async function crear(req, res) {
    if (invalido(req, res)) return;
    try {
        const data = await ProveedorService.crear(idUsuarioDe(req), req.body);
        return Respuesta.success(res, 'Proveedor creado', data, 201);
    } catch (err) { return fallo(res, err, 'crear'); }
}

async function editar(req, res) {
    if (invalido(req, res)) return;
    try {
        const data = await ProveedorService.editar(idUsuarioDe(req), Number(req.params.id), req.body);
        return Respuesta.success(res, 'Proveedor actualizado', data);
    } catch (err) { return fallo(res, err, 'editar'); }
}

async function cambiarVisibilidad(req, res) {
    if (invalido(req, res)) return;
    try {
        const data = await ProveedorService.cambiarVisibilidad(
            idUsuarioDe(req), Number(req.params.id), req.body,
        );
        return Respuesta.success(res, 'Visibilidad actualizada', data);
    } catch (err) { return fallo(res, err, 'cambiarVisibilidad'); }
}

async function archivar(req, res) {
    if (invalido(req, res)) return;
    try {
        const data = await ProveedorService.archivar(idUsuarioDe(req), Number(req.params.id), req.body);
        return Respuesta.success(
            res, data.estado_interno === 'ARCHIVADO' ? 'Proveedor archivado' : 'Proveedor reactivado', data,
        );
    } catch (err) { return fallo(res, err, 'archivar'); }
}

async function vincular(req, res) {
    if (invalido(req, res)) return;
    try {
        const data = await ProveedorService.vincular(idUsuarioDe(req), Number(req.params.id), req.body);
        return Respuesta.success(
            res, data.ya_estaba ? 'Ya tenías este proveedor' : 'Proveedor agregado a tu lista', data,
        );
    } catch (err) { return fallo(res, err, 'vincular'); }
}

async function guardarPrivado(req, res) {
    if (invalido(req, res)) return;
    try {
        const data = await ProveedorService.guardarPrivado(
            idUsuarioDe(req), Number(req.params.id), req.body,
        );
        return Respuesta.success(res, 'Notas guardadas', data);
    } catch (err) { return fallo(res, err, 'guardarPrivado'); }
}

async function reportar(req, res) {
    if (invalido(req, res)) return;
    try {
        const data = await ProveedorService.reportar(idUsuarioDe(req), Number(req.params.id), req.body);
        return Respuesta.success(res, 'Gracias: revisaremos la información reportada', data);
    } catch (err) { return fallo(res, err, 'reportar'); }
}

// ============================================================
// Insumos
// ============================================================

async function listarInsumos(req, res) {
    if (invalido(req, res)) return;
    try {
        const data = await ProveedorService.listarInsumos(
            idUsuarioDe(req), Number(req.params.id), idNegocioQuery(req),
        );
        return Respuesta.success(res, 'Insumos del proveedor', data);
    } catch (err) { return fallo(res, err, 'listarInsumos'); }
}

async function crearInsumo(req, res) {
    if (invalido(req, res)) return;
    try {
        const data = await ProveedorService.crearInsumo(idUsuarioDe(req), Number(req.params.id), req.body);
        return Respuesta.success(res, 'Insumo agregado', data, 201);
    } catch (err) { return fallo(res, err, 'crearInsumo'); }
}

async function editarInsumo(req, res) {
    if (invalido(req, res)) return;
    try {
        const data = await ProveedorService.editarInsumo(
            idUsuarioDe(req), Number(req.params.idInsumo), req.body,
        );
        return Respuesta.success(res, 'Insumo actualizado', data);
    } catch (err) { return fallo(res, err, 'editarInsumo'); }
}

async function eliminarInsumo(req, res) {
    if (invalido(req, res)) return;
    try {
        const data = await ProveedorService.eliminarInsumo(
            idUsuarioDe(req), Number(req.params.idInsumo), idNegocioQuery(req),
        );
        return Respuesta.success(res, 'Insumo eliminado', data);
    } catch (err) { return fallo(res, err, 'eliminarInsumo'); }
}

async function historicoPrecios(req, res) {
    if (invalido(req, res)) return;
    try {
        const data = await ProveedorService.historicoPrecios(
            idUsuarioDe(req), Number(req.params.idInsumo), idNegocioQuery(req),
        );
        return Respuesta.success(res, 'Historial de precios', data);
    } catch (err) { return fallo(res, err, 'historicoPrecios'); }
}

// ============================================================
// Comparador
// ============================================================

async function comparar(req, res) {
    if (invalido(req, res)) return;
    try {
        const data = await ProveedorService.comparar(idUsuarioDe(req), {
            idNegocio: idNegocioQuery(req),
            busqueda: req.query.busqueda,
            idIngrediente: req.query.id_ingrediente,
        });
        return Respuesta.success(res, 'Comparación de precios', data);
    } catch (err) { return fallo(res, err, 'comparar'); }
}

// ============================================================
// Compras
// ============================================================

async function listarCompras(req, res) {
    if (invalido(req, res)) return;
    try {
        const data = await CompraService.listar(idUsuarioDe(req), {
            idNegocio: idNegocioQuery(req),
            idProveedor: req.query.id_proveedor,
            idIngrediente: req.query.id_ingrediente,
            busqueda: req.query.busqueda,
            desde: req.query.desde,
            hasta: req.query.hasta,
            incluirAnuladas: req.query.anuladas === 'true',
            limite: req.query.limite,
            offset: req.query.offset,
        });
        return Respuesta.success(res, 'Compras obtenidas', data);
    } catch (err) { return fallo(res, err, 'listarCompras'); }
}

async function resumenCompras(req, res) {
    if (invalido(req, res)) return;
    try {
        const data = await CompraService.resumen(idUsuarioDe(req), {
            idNegocio: idNegocioQuery(req),
            desde: req.query.desde,
            hasta: req.query.hasta,
        });
        return Respuesta.success(res, 'Resumen de gasto', data);
    } catch (err) { return fallo(res, err, 'resumenCompras'); }
}

async function evolucionPrecio(req, res) {
    if (invalido(req, res)) return;
    try {
        const data = await CompraService.evolucionPrecio(idUsuarioDe(req), {
            idNegocio: idNegocioQuery(req),
            idInsumo: req.query.id_proveedor_insumo,
            idIngrediente: req.query.id_ingrediente,
        });
        return Respuesta.success(res, 'Evolución del precio', data);
    } catch (err) { return fallo(res, err, 'evolucionPrecio'); }
}

async function detalleCompra(req, res) {
    if (invalido(req, res)) return;
    try {
        const data = await CompraService.detalle(
            idUsuarioDe(req), Number(req.params.idCompra), idNegocioQuery(req),
        );
        return Respuesta.success(res, 'Compra obtenida', data);
    } catch (err) { return fallo(res, err, 'detalleCompra'); }
}

async function crearCompra(req, res) {
    if (invalido(req, res)) return;
    try {
        const data = await CompraService.crear(idUsuarioDe(req), req.body);
        return Respuesta.success(res, 'Compra registrada', data, 201);
    } catch (err) { return fallo(res, err, 'crearCompra'); }
}

async function anularCompra(req, res) {
    if (invalido(req, res)) return;
    try {
        const data = await CompraService.anular(
            idUsuarioDe(req), Number(req.params.idCompra), req.body,
        );
        return Respuesta.success(res, 'Compra anulada', data);
    } catch (err) { return fallo(res, err, 'anularCompra'); }
}

// ============================================================
// Adjunto de la factura
// ============================================================

/**
 * El archivo ya lo guardó multer; aquí solo se apunta en la compra.
 *
 * La ruta se guarda relativa y **no se sirve estáticamente** (ver `app.js`): una factura de
 * compra lleva precios y datos fiscales, y `/uploads` solo expone lo que es público de verdad.
 * Para verla hay que pasar por `descargarAdjunto`, que vuelve a comprobar el negocio.
 */
async function subirAdjunto(req, res) {
    try {
        if (!req.file) return Respuesta.error(res, 'No llegó ningún archivo.', 400);

        const idUsuario = idUsuarioDe(req);
        const idCompra = Number(req.params.idCompra);
        const idNegocio = await ProveedorService.negocioDe(idUsuario, Number(req.body.id_negocio));
        await ProveedorService.exigir(idUsuario, idNegocio, 'proveedores_compras',
            'No tienes permiso para registrar compras.');

        const compra = await Models.RestCompra.findOne({
            where: { id_compra: idCompra, id_negocio: idNegocio },
        });
        if (!compra) {
            // El archivo ya está en disco pero no tiene dueño: se borra en vez de dejar basura.
            fs.promises.unlink(req.file.path).catch(() => {});
            return Respuesta.error(res, 'Compra no encontrada.', 404);
        }

        const relativa = `restaurante/compras/${idNegocio}/${req.file.filename}`;
        const anterior = compra.adjunto_url;
        await compra.update({ adjunto_url: relativa });

        // Reemplazar el adjunto borra el viejo: si no, cada corrección deja un archivo
        // huérfano que nadie va a limpiar nunca.
        if (anterior && anterior !== relativa) {
            fs.promises.unlink(path.join(ADJUNTOS_BASE, '..', '..', anterior)).catch(() => {});
        }

        return Respuesta.success(res, 'Adjunto guardado', { id_compra: idCompra, adjunto_url: relativa });
    } catch (err) {
        if (req.file) fs.promises.unlink(req.file.path).catch(() => {});
        return fallo(res, err, 'subirAdjunto');
    }
}

/** Entrega el archivo tras comprobar que la compra es de ESTE negocio. */
async function descargarAdjunto(req, res) {
    try {
        const idUsuario = idUsuarioDe(req);
        const idCompra = Number(req.params.idCompra);
        const idNegocio = await ProveedorService.negocioDe(idUsuario, idNegocioQuery(req));
        await ProveedorService.exigir(idUsuario, idNegocio, 'proveedores_precios',
            'No tienes permiso para ver las facturas de compra.');

        const compra = await Models.RestCompra.findOne({
            where: { id_compra: idCompra, id_negocio: idNegocio },
            attributes: ['id_compra', 'adjunto_url'],
        });
        if (!compra?.adjunto_url) return Respuesta.error(res, 'Esta compra no tiene adjunto.', 404);

        // El nombre lo pone el servidor al subir (id + extensión), pero se normaliza igual:
        // un `..` en la ruta guardada no puede sacar la lectura de la carpeta de adjuntos.
        const absoluta = path.resolve(ADJUNTOS_BASE, '..', '..', compra.adjunto_url);
        if (!absoluta.startsWith(ADJUNTOS_BASE)) {
            return Respuesta.error(res, 'Adjunto no disponible.', 404);
        }
        if (!fs.existsSync(absoluta)) return Respuesta.error(res, 'El archivo ya no está.', 404);

        return res.sendFile(absoluta);
    } catch (err) { return fallo(res, err, 'descargarAdjunto'); }
}

module.exports = {
    categorias,
    listar,
    detalle,
    crear,
    editar,
    cambiarVisibilidad,
    archivar,
    vincular,
    guardarPrivado,
    reportar,
    listarInsumos,
    crearInsumo,
    editarInsumo,
    eliminarInsumo,
    historicoPrecios,
    comparar,
    listarCompras,
    resumenCompras,
    evolucionPrecio,
    detalleCompra,
    crearCompra,
    anularCompra,
    subirAdjunto,
    descargarAdjunto,
    ADJUNTOS_BASE,
};
