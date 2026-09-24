const CartaService = require('../services/cartaService');
const PublicoService = require('../services/publicoService');
const CartaDisenoService = require('../services/cartaDisenoService');
const horarioService = require('../services/horarioService');
const BarrioService = require('../services/barrioService');
const MesaPublicaService = require('../services/mesaPublicaService');
const Respuesta = require('../../app_core/helpers/respuesta');
const { tienePlanActivo } = require('../../app_core/helpers/planHelper');

const CODIGO_SIN_PLAN = 'SIN_PLAN_ACTIVO';

function planError(res) {
    return Respuesta.error(res, 'El negocio no cuenta con un plan activo.', 402, [{
        code: CODIGO_SIN_PLAN,
        message: 'Suscripcion inactiva',
    }]);
}

/** GET /restaurante/public/negocios/:id */
async function getNegocio(req, res) {
    try {
        const idNegocio = Number(req.params.id);
        if (!idNegocio) return Respuesta.error(res, 'id_negocio requerido', 400);

        const negocio = await PublicoService.getNegocioPublico(idNegocio);
        if (!negocio) return Respuesta.error(res, 'Negocio no encontrado', 404);

        const planActivo = await tienePlanActivo(idNegocio);

        // El diseño viaja en esta misma respuesta y no en una petición aparte: la carta no se
        // pinta hasta tenerlo, así que no hay un parpadeo con los colores por defecto antes de
        // los del negocio. Si leerlo falla, la carta sale con el diseño de siempre en vez de
        // no salir.
        let carta;
        try {
            carta = await CartaDisenoService.getCartaPublica(negocio);
        } catch (err) {
            console.error('[Publico] Error diseño de carta:', err.message);
            carta = CartaDisenoService.cartaPorDefecto(negocio);
        }

        // Los colores y la paleta ya van resueltos dentro de `carta`: no se exponen crudos.
        const { colores: _colores, id_paleta: _idPaleta, paletaColor: _paleta, ...datos } =
            negocio.toJSON();

        // Mismo estado que lee el saludo de WhatsApp (`horarioService.estadoDeAtencion`): si el
        // negocio no está atendiendo, el menú digital tiene que decirlo también, o el cliente
        // arma un carrito y abre WhatsApp para que el bot le diga que no puede tomarlo. Si esto
        // falla, se sale con "abierto" (falla abierto): es un gesto de la carta, no la comprobación
        // que de verdad protege la creación de la orden — esa sigue siendo `requireCajaAbierta`.
        let atencion;
        try {
            atencion = await horarioService.estadoDeAtencion({ idNegocio });
        } catch (err) {
            console.error('[Publico] Error estado de atención:', err.message);
            atencion = { estado: 'abierto' };
        }

        return Respuesta.success(res, 'Negocio obtenido', {
            ...datos,
            plan_activo: planActivo,
            carta,
            atencion,
        });
    } catch (err) {
        console.error('[Publico] Error getNegocio:', err.message);
        return Respuesta.error(res, 'Error al obtener informacion del negocio.');
    }
}

/** GET /restaurante/public/negocios/:id/barrios — solo id, nombre y valor; vacío si no cobra domicilio. */
async function getBarrios(req, res) {
    try {
        const idNegocio = Number(req.params.id);
        if (!idNegocio) return Respuesta.error(res, 'id_negocio requerido', 400);
        if (!(await tienePlanActivo(idNegocio))) return planError(res);
        return Respuesta.success(res, 'Barrios obtenidos', await BarrioService.listarPublico(idNegocio));
    } catch (err) {
        console.error('[Publico] Error getBarrios:', err.message);
        return Respuesta.error(res, 'Error al obtener los barrios.');
    }
}

/** GET /restaurante/public/negocios/:id/mesas — solo id, nombre y número de las mesas activas. */
async function getMesas(req, res) {
    try {
        const idNegocio = Number(req.params.id);
        if (!idNegocio) return Respuesta.error(res, 'id_negocio requerido', 400);
        if (!(await tienePlanActivo(idNegocio))) return planError(res);
        return Respuesta.success(res, 'Mesas obtenidas', await MesaPublicaService.listarPublicas(idNegocio));
    } catch (err) {
        console.error('[Publico] Error getMesas:', err.message);
        return Respuesta.error(res, 'Error al obtener las mesas.');
    }
}

/** GET /restaurante/public/carta/categorias?id_negocio=N */
async function getCategorias(req, res) {
    try {
        const idNegocio = Number(req.query.id_negocio);
        if (!idNegocio) return Respuesta.error(res, 'id_negocio requerido', 400);

        if (!(await tienePlanActivo(idNegocio))) return planError(res);

        const categorias = await CartaService.getCategoriasPublicas(idNegocio);
        const data = categorias.map(c => ({
            id_categoria: c.id_categoria,
            nombre: c.nombre,
            descripcion: c.descripcion,
            icono: c.icono,
            imagen_url: c.imagen_url,
            orden: c.orden,
            total_productos: c.productos ? c.productos.length : 0,
        }));

        return Respuesta.success(res, 'Categorias obtenidas', data);
    } catch (err) {
        console.error('[Publico] Error getCategorias:', err.message);
        return Respuesta.error(res, 'Error al obtener las categorias.');
    }
}

/** GET /restaurante/public/carta/productos?id_negocio=N&id_categoria=N[&incluir_agotados=1] */
async function getProductos(req, res) {
    try {
        const idNegocio = Number(req.query.id_negocio);
        const idCategoria = Number(req.query.id_categoria);
        if (!idNegocio || !idCategoria) {
            return Respuesta.error(res, 'id_negocio e id_categoria requeridos', 400);
        }

        if (!(await tienePlanActivo(idNegocio))) return planError(res);

        // Los agotados solo viajan si se piden. La carta los pide siempre y decide si mostrarlos
        // según el diseño; así la vista previa de Configuración puede encender la opción sin
        // esperar a publicar. Lo oculto (`visible = false`) no sale nunca.
        const incluirAgotados = ['1', 'true'].includes(String(req.query.incluir_agotados));
        const productos = await CartaService.getProductosPublicosByCategoria(
            idNegocio, idCategoria, { incluirAgotados },
        );
        const data = productos.map(p => ({
            id_producto: p.id_producto,
            nombre: p.nombre,
            descripcion: p.descripcion,
            precio: Number(p.precio),
            imagen_url: p.imagen_url,
            icono: p.icono,
            es_popular: p.es_popular,
            disponible: p.disponible !== false,
            ingredientes: (p.ingredientes || []).map(pi => ({
                id_producto_ingred: pi.id_producto_ingred,
                id_ingrediente: pi.ingrediente.id_ingrediente,
                nombre: pi.ingrediente.nombre,
                es_removible: pi.es_removible,
            })),
        }));

        return Respuesta.success(res, 'Productos obtenidos', data);
    } catch (err) {
        console.error('[Publico] Error getProductos:', err.message);
        return Respuesta.error(res, 'Error al obtener los productos.');
    }
}

/** GET /restaurante/public/carta/completa?id_negocio=N[&incluir_agotados=1] */
async function getCartaCompleta(req, res) {
    try {
        const idNegocio = Number(req.query.id_negocio);
        if (!idNegocio) return Respuesta.error(res, 'id_negocio requerido', 400);

        if (!(await tienePlanActivo(idNegocio))) return planError(res);

        const incluirAgotados = ['1', 'true'].includes(String(req.query.incluir_agotados));
        const categorias = await CartaService.getCartaPublicaCompleta(idNegocio, { incluirAgotados });
        const data = categorias.map(c => ({
            id_categoria: c.id_categoria,
            nombre: c.nombre,
            descripcion: c.descripcion,
            icono: c.icono,
            imagen_url: c.imagen_url,
            orden: c.orden,
            productos: (c.productos || []).map(p => ({
                id_producto: p.id_producto,
                nombre: p.nombre,
                descripcion: p.descripcion,
                precio: Number(p.precio),
                imagen_url: p.imagen_url,
                icono: p.icono,
                es_popular: p.es_popular,
                disponible: p.disponible !== false,
                // Solo lo que el cliente puede quitar, sin cantidades ni stock ni costos.
                ingredientes_removibles: p.removibles ?? [],
            })),
        }));

        return Respuesta.success(res, 'Carta obtenida', data);
    } catch (err) {
        console.error('[Publico] Error getCartaCompleta:', err.message);
        return Respuesta.error(res, 'Error al obtener la carta.');
    }
}

/** GET /restaurante/public/negocios/:id/paleta */
async function getPaleta(req, res) {
    try {
        const idNegocio = Number(req.params.id);
        if (!idNegocio) return Respuesta.error(res, 'id_negocio requerido', 400);

        const paleta = await PublicoService.getPaletaNegocioPublico(idNegocio);
        if (!paleta) return Respuesta.error(res, 'Paleta no encontrada', 404);

        return Respuesta.success(res, 'Paleta obtenida', {
            id_paleta: paleta.id_paleta,
            nombre: paleta.nombre,
            colores: paleta.colores,
        });
    } catch (err) {
        console.error('[Publico] Error getPaleta:', err.message);
        return Respuesta.error(res, 'Error al obtener la paleta.');
    }
}

module.exports = {
    getNegocio,
    getBarrios,
    getMesas,
    getCartaCompleta,
    getCategorias,
    getProductos,
    getPaleta,
};
