'use strict';
/**
 * Endpoints de las funciones de los perfiles de rubro: catálogo de arranque, cabinas,
 * mascotas, ficha del cliente y portafolio. Ver `docs/perfiles-de-reserva.md`.
 *
 * Cada ruta va detrás de `exigirFuncion` (en `routes/index.js`): si el negocio no tiene la
 * función encendida, la ruta no existe para él.
 */
const { validationResult } = require('express-validator');
const Respuesta = require('../../app_core/helpers/respuesta');
const CatalogoService = require('../services/catalogoService');
const RecursoService = require('../services/recursoService');
const MascotaService = require('../services/mascotaService');
const FichaService = require('../services/fichaService');
const PortafolioService = require('../services/portafolioService');
const Perfiles = require('../perfiles');

function check(req, res) {
    const e = validationResult(req);
    if (!e.isEmpty()) { Respuesta.error(res, 'Datos inválidos', 422, e.array()); return false; }
    return true;
}

function idNegocioDe(req) {
    return Number(req.body?.id_negocio ?? req.query?.id_negocio);
}

/** Envuelve un manejador: valida, ejecuta y reenvía los errores de dominio tal cual. */
function manejar(contexto, fn, { codigo = 200, mensaje = 'OK' } = {}) {
    return async (req, res) => {
        if (!check(req, res)) return;
        try {
            const data = await fn(req);
            return Respuesta.success(res, mensaje, data, codigo);
        } catch (err) {
            if (err.statusCode) {
                return Respuesta.error(res, err.message, err.statusCode, err.code ? [{ code: err.code }] : null);
            }
            console.error(`[Reserva/Perfil] ${contexto}:`, err.message);
            return Respuesta.error(res, 'Error al procesar la solicitud.');
        }
    };
}

// ── Perfil ──
const getPerfil = manejar('perfil', (req) => Perfiles.perfilDeNegocio(idNegocioDe(req)), { mensaje: 'Perfil del negocio' });

// ── Catálogo de arranque ──
const catalogoVistaPrevia = manejar('catalogo', (req) => CatalogoService.vistaPrevia(idNegocioDe(req)));
const catalogoSembrarServicios = manejar('catalogo', (req) => CatalogoService.sembrarServicios(idNegocioDe(req)),
    { codigo: 201, mensaje: 'Servicios de ejemplo cargados' });
const catalogoSembrarUnidades = manejar('catalogo', (req) => CatalogoService.sembrarUnidades(idNegocioDe(req)),
    { codigo: 201, mensaje: 'Unidades de ejemplo cargadas' });

// ── Recursos ──
const recursosListar = manejar('recursos', (req) => RecursoService.listar(idNegocioDe(req)));
const recursosCrearTipo = manejar('recursos', (req) => RecursoService.crearTipo(idNegocioDe(req), req.body),
    { codigo: 201, mensaje: 'Recurso creado' });
const recursosActualizarTipo = manejar('recursos',
    (req) => RecursoService.actualizarTipo(idNegocioDe(req), Number(req.params.id), req.body));
const recursosInactivarTipo = manejar('recursos',
    (req) => RecursoService.inactivarTipo(idNegocioDe(req), Number(req.params.id)));
const recursosCrearUnidad = manejar('recursos',
    (req) => RecursoService.crearRecurso(idNegocioDe(req), Number(req.params.id), req.body), { codigo: 201 });
const recursosActualizarUnidad = manejar('recursos',
    (req) => RecursoService.actualizarRecurso(idNegocioDe(req), Number(req.params.id), req.body));
const recursosInactivarUnidad = manejar('recursos',
    (req) => RecursoService.inactivarRecurso(idNegocioDe(req), Number(req.params.id)));

// ── Mascotas ──
const mascotasListar = manejar('mascotas', (req) => MascotaService.listar(idNegocioDe(req), {
    q: req.query.q, limite: req.query.limite, pagina: req.query.pagina,
}));
const mascotasDeCliente = manejar('mascotas',
    (req) => MascotaService.listarDeCliente(idNegocioDe(req), String(req.params.id_persona)));
const mascotasCrear = manejar('mascotas',
    (req) => MascotaService.crear(idNegocioDe(req), String(req.body.id_persona_negocio), req.body),
    { codigo: 201, mensaje: 'Mascota registrada' });
const mascotasActualizar = manejar('mascotas',
    (req) => MascotaService.actualizar(idNegocioDe(req), String(req.params.id), req.body));
const mascotasInactivar = manejar('mascotas',
    (req) => MascotaService.inactivar(idNegocioDe(req), String(req.params.id)));

// ── Ficha ──
const fichaListar = manejar('ficha', (req) => FichaService.listar(idNegocioDe(req), {
    idPersonaNegocio: req.query.id_persona_negocio || null,
    idMascota: req.query.id_mascota || null,
    idCita: req.query.id_cita ? Number(req.query.id_cita) : null,
}));
const fichaCrear = manejar('ficha',
    (req) => FichaService.crear(idNegocioDe(req), req.usuario?.id_usuario, req.body, req.file || null),
    { codigo: 201, mensaje: 'Anotación guardada' });
const fichaEliminar = manejar('ficha', (req) => FichaService.eliminar(idNegocioDe(req), Number(req.params.id)));

async function fichaArchivo(req, res) {
    try {
        const abs = await FichaService.rutaArchivo(idNegocioDe(req), Number(req.params.id));
        // Un consentimiento firmado no debe quedar en cachés intermedias.
        res.setHeader('Cache-Control', 'private, no-store');
        return res.sendFile(abs);
    } catch (err) {
        if (err.statusCode) return Respuesta.error(res, err.message, err.statusCode);
        console.error('[Reserva/Perfil] fichaArchivo:', err.message);
        return Respuesta.error(res, 'Error al obtener el archivo.');
    }
}

// ── Portafolio ──
const portafolioListar = manejar('portafolio',
    (req) => PortafolioService.listar(idNegocioDe(req), Number(req.params.id)));
const portafolioAgregar = manejar('portafolio',
    (req) => PortafolioService.agregar(idNegocioDe(req), Number(req.params.id), req.file, req.body.descripcion),
    { codigo: 201, mensaje: 'Imagen agregada' });
const portafolioEliminar = manejar('portafolio',
    (req) => PortafolioService.eliminar(idNegocioDe(req), Number(req.params.id)));

module.exports = {
    getPerfil,
    catalogoVistaPrevia, catalogoSembrarServicios, catalogoSembrarUnidades,
    recursosListar, recursosCrearTipo, recursosActualizarTipo, recursosInactivarTipo,
    recursosCrearUnidad, recursosActualizarUnidad, recursosInactivarUnidad,
    mascotasListar, mascotasDeCliente, mascotasCrear, mascotasActualizar, mascotasInactivar,
    fichaListar, fichaCrear, fichaEliminar, fichaArchivo,
    portafolioListar, portafolioAgregar, portafolioEliminar,
};
