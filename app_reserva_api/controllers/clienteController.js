'use strict';
const { validationResult } = require('express-validator');
const ClienteService = require('../services/clienteService');
const ClienteExportService = require('../services/clienteExportService');
const Respuesta = require('../../app_core/helpers/respuesta');
const { registrarEvento } = require('../../app_core/helpers/auditHelper');

function check(req, res) {
    const e = validationResult(req);
    if (!e.isEmpty()) {
        Respuesta.error(res, 'Datos inválidos', 422, e.array());
        return false;
    }
    return true;
}

function fallo(res, err, contexto, mensajeGenerico) {
    if (err.statusCode) {
        return Respuesta.error(res, err.message, err.statusCode, err.code ? [{ code: err.code }] : null);
    }
    console.error(`[Reserva/Clientes] ${contexto}:`, err.message);
    return Respuesta.error(res, mensajeGenerico);
}

/** GET /reserva/clientes?id_negocio=&buscar=&limite=&offset= */
async function listar(req, res) {
    if (!check(req, res)) return;
    try {
        const data = await ClienteService.listar({
            idNegocio: Number(req.query.id_negocio),
            buscar:    req.query.buscar || null,
            limite:    req.query.limite,
            offset:    req.query.offset,
        });
        return Respuesta.success(res, 'Clientes obtenidos', {
            ...data,
            // Lo consume la vista para decidir si enseña el formulario de edición.
            puede_editar: !!req.permisoVista?.puede_editar,
        });
    } catch (err) {
        return fallo(res, err, 'listar', 'No se pudo obtener la lista de clientes.');
    }
}

/**
 * GET /reserva/clientes/buscar?id_negocio=&telefono=
 *
 * Lo que rellena el formulario de cita cuando el mostrador escribe el número.
 *
 * **Solo autenticado y acotado al negocio, nunca público.** Un endpoint abierto que a cambio
 * de un teléfono devuelve el nombre de su dueño es un directorio de clientes servido a
 * cualquiera que pruebe números: el portal público captura datos, no los consulta.
 */
async function buscarPorTelefono(req, res) {
    if (!check(req, res)) return;
    try {
        const cliente = await ClienteService.buscarPorTelefono({
            idNegocio: Number(req.query.id_negocio),
            telefono:  String(req.query.telefono),
        });
        // Que no exista es un resultado normal, no un 404: es el caso de un cliente nuevo.
        return Respuesta.success(res, cliente ? 'Cliente encontrado' : 'Cliente no registrado', cliente);
    } catch (err) {
        return fallo(res, err, 'buscarPorTelefono', 'No se pudo consultar el cliente.');
    }
}

/** GET /reserva/clientes/:id?id_negocio= */
async function detalle(req, res) {
    if (!check(req, res)) return;
    try {
        const idNegocio = Number(req.query.id_negocio);
        const cliente = await ClienteService.buscarPorId({
            idNegocio,
            idPersonaNegocio: req.params.id,
        });
        if (!cliente) return Respuesta.error(res, 'Cliente no encontrado.', 404);

        const citas = await ClienteService.citasDe({ idNegocio, idPersonaNegocio: req.params.id });
        return Respuesta.success(res, 'Cliente obtenido', { ...cliente, citas });
    } catch (err) {
        return fallo(res, err, 'detalle', 'No se pudo obtener el cliente.');
    }
}

/** PUT /reserva/clientes/:id — nombre y notas. El teléfono es la llave y no se edita. */
async function actualizar(req, res) {
    if (!check(req, res)) return;
    try {
        if (!req.permisoVista?.puede_editar) {
            return Respuesta.error(res, 'Tu rol no puede editar los clientes.', 403);
        }
        const cliente = await ClienteService.actualizar({
            idNegocio: Number(req.body.id_negocio),
            idPersonaNegocio: req.params.id,
            nombre: req.body.nombre,
            notas:  req.body.notas,
        });
        return Respuesta.success(res, 'Cliente actualizado', cliente);
    } catch (err) {
        return fallo(res, err, 'actualizar', 'No se pudo actualizar el cliente.');
    }
}

/**
 * GET /reserva/clientes/exportar?id_negocio=&formato=xlsx|pdf&buscar=
 *
 * La cartera entera en un archivo, con el mismo filtro que la pantalla. Se deja constancia en
 * auditoría: sacar de golpe los teléfonos de todos los clientes es justo el tipo de acción sobre
 * datos personales de la que conviene poder responder quién y cuándo.
 */
async function exportar(req, res) {
    if (!check(req, res)) return;
    try {
        const idNegocio = Number(req.query.id_negocio);
        const formato = req.query.formato === 'pdf' ? 'pdf' : 'xlsx';
        const buscar = req.query.buscar ? String(req.query.buscar).trim() : null;

        const clientes = await ClienteService.listarParaExportar({ idNegocio, buscar });
        const { nombreNegocio, pais } = await ClienteExportService.getNegocio(idNegocio);
        const generar = formato === 'pdf' ? ClienteExportService.generarPDF : ClienteExportService.generarXLSX;
        const { buffer, filename } = await generar(clientes, { nombreNegocio, buscar, pais });

        await registrarEvento({
            modulo: 'clientes',
            accion: 'exportar',
            idNegocio,
            detalle: { formato, filas: clientes.length, buscar },
        });

        res.setHeader('Content-Type', formato === 'pdf'
            ? 'application/pdf'
            : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        // Sin esto el navegador no ve la cabecera y el archivo baja sin nombre ni extensión.
        res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
        return res.send(buffer);
    } catch (err) {
        return fallo(res, err, 'exportar', 'No se pudo generar el archivo de clientes.');
    }
}

module.exports = { listar, exportar, buscarPorTelefono, detalle, actualizar };
