const fs = require('fs');
const path = require('path');
const CartaAdminService = require('../services/cartaAdminService');
const Respuesta = require('../../app_core/helpers/respuesta');

/**
 * cartaAdminController — CRUD de categorías, productos e ingredientes del menú.
 */

// ── Ingredientes base ─────────────────────────────────────────────────

/** GET /restaurante/carta/ingredientes?id_negocio=N */
async function getIngredientes(req, res) {
    try {
        const idNegocio = Number(req.query.id_negocio);
        if (!idNegocio) return Respuesta.error(res, 'id_negocio requerido', 400);

        const data = await CartaAdminService.getIngredientes(idNegocio);
        return Respuesta.success(res, 'Ingredientes obtenidos', data.map((i) => ({
            id_ingrediente: i.id_ingrediente,
            nombre: i.nombre,
            unidad_medida: i.unidad_medida,
            stock_actual: Number(i.stock_actual ?? 0),
            stock_minimo: Number(i.stock_minimo ?? 0),
            stock_maximo: Number(i.stock_maximo ?? 0),
        })));
    } catch (err) {
        console.error('[CartaAdmin] Error getIngredientes:', err.message);
        return Respuesta.error(res, 'Error al obtener ingredientes.');
    }
}

/** POST /restaurante/carta/admin/ingredientes */
async function crearIngrediente(req, res) {
    try {
        const { id_negocio, nombre, unidad_medida, stock_actual, stock_minimo, stock_maximo } = req.body;
        if (!id_negocio || !nombre?.trim()) {
            return Respuesta.error(res, 'id_negocio y nombre son requeridos', 400);
        }

        const ingred = await CartaAdminService.crearIngrediente(id_negocio, nombre.trim(), {
            unidad_medida,
            stock_actual,
            stock_minimo,
            stock_maximo,
        });
        return Respuesta.success(res, 'Ingrediente creado', {
            id_ingrediente: ingred.id_ingrediente,
            nombre:         ingred.nombre,
            unidad_medida:  ingred.unidad_medida,
            stock_actual:   Number(ingred.stock_actual ?? 0),
            stock_minimo:   Number(ingred.stock_minimo ?? 0),
            stock_maximo:   Number(ingred.stock_maximo ?? 0),
        }, 201);
    } catch (err) {
        console.error('[CartaAdmin] Error crearIngrediente:', err.message);
        if (err.code === 'INGREDIENTE_DUPLICADO' || err.name === 'SequelizeUniqueConstraintError') {
            return Respuesta.error(res, 'Ya existe un insumo con ese nombre.', 409);
        }
        return Respuesta.error(res, 'Error al crear ingrediente.');
    }
}

/** PUT /restaurante/carta/admin/ingredientes/:id */
async function editarIngrediente(req, res) {
    try {
        const idIngrediente = Number(req.params.id);
        if (!idIngrediente) return Respuesta.error(res, 'id requerido', 400);

        const { nombre, unidad_medida } = req.body;
        const ing = await CartaAdminService.editarIngrediente(idIngrediente, { nombre, unidad_medida });

        return Respuesta.success(res, 'Insumo actualizado', {
            id_ingrediente: ing.id_ingrediente,
            nombre:         ing.nombre,
            unidad_medida:  ing.unidad_medida,
        });
    } catch (err) {
        if (err.code === 'INGREDIENTE_NO_ENCONTRADO' || err.code === 'INGREDIENTE_DUPLICADO') {
            return Respuesta.error(res, err.message, err.statusCode || 409);
        }
        console.error('[CartaAdmin] Error editarIngrediente:', err.message);
        return Respuesta.error(res, 'Error al editar insumo.');
    }
}

/** DELETE /restaurante/carta/admin/ingredientes/:id */
async function eliminarIngrediente(req, res) {
    try {
        const idIngrediente = Number(req.params.id);
        if (!idIngrediente) return Respuesta.error(res, 'id requerido', 400);

        await CartaAdminService.eliminarIngrediente(idIngrediente);
        return Respuesta.success(res, 'Insumo eliminado');
    } catch (err) {
        if (err.code === 'INGREDIENTE_NO_ENCONTRADO') {
            return Respuesta.error(res, err.message, 404);
        }
        console.error('[CartaAdmin] Error eliminarIngrediente:', err.message);
        return Respuesta.error(res, 'Error al eliminar insumo.');
    }
}

// ── Imágenes de carta ─────────────────────────────────────────────────

/**
 * POST /restaurante/carta/admin/:id_negocio/imagen/:tipo/:id_entidad
 * (multipart, campo "imagen"). El archivo se nombra con el ID de la entidad.
 */
async function subirImagenCarta(req, res) {
    try {
        const idNegocio = Number(req.params.id_negocio);
        const tipo = req.params.tipo === 'categoria' ? 'categoria' : 'producto';
        const idEntidad = Number(req.params.id_entidad);
        if (!idNegocio) return Respuesta.error(res, 'id_negocio requerido', 400);
        if (!idEntidad) return Respuesta.error(res, 'id de entidad requerido', 400);
        if (!req.file) return Respuesta.error(res, 'No se recibió ninguna imagen', 400);

        // Limpia versiones anteriores del mismo ID con otra extensión
        // (p.ej. reemplazar un antiguo <id>.jpg por el nuevo <id>.webp).
        try {
            const dir = req.file.destination;
            for (const nombre of fs.readdirSync(dir)) {
                if (nombre !== req.file.filename && nombre.startsWith(`${idEntidad}.`)) {
                    fs.unlinkSync(path.join(dir, nombre));
                }
            }
        } catch { /* limpieza best-effort */ }

        // ?v= evita que el caché (navegador/CDN) sirva la imagen anterior,
        // ya que el nombre del archivo es fijo por ID.
        const imagen_url = `/uploads/restaurante/menu/${idNegocio}/${tipo}/${req.file.filename}?v=${Date.now()}`;
        return Respuesta.success(res, 'Imagen subida', { imagen_url }, 201);
    } catch (err) {
        console.error('[CartaAdmin] Error subirImagenCarta:', err.message);
        return Respuesta.error(res, 'Error al subir la imagen.');
    }
}

// ── Categorías ────────────────────────────────────────────────────────

/** GET /restaurante/carta/admin/categorias?id_negocio=N */
async function getCategoriasAdmin(req, res) {
    try {
        const idNegocio = Number(req.query.id_negocio);
        if (!idNegocio) return Respuesta.error(res, 'id_negocio requerido', 400);

        const categorias = await CartaAdminService.getCategoriasAdmin(idNegocio);
        const data = categorias.map(c => ({
            id_categoria:    c.id_categoria,
            nombre:          c.nombre,
            descripcion:     c.descripcion,
            icono:           c.icono,
            imagen_url:      c.imagen_url,
            orden:           c.orden,
            visible:         c.visible !== false,
            total_productos: c.productos ? c.productos.length : 0,
        }));

        return Respuesta.success(res, 'Categorías obtenidas', data);
    } catch (err) {
        console.error('[CartaAdmin] Error getCategoriasAdmin:', err.message);
        return Respuesta.error(res, 'Error al obtener categorías.');
    }
}

/** POST /restaurante/carta/admin/categorias */
async function crearCategoria(req, res) {
    try {
        const { id_negocio, nombre, descripcion, icono, imagen_url, orden, visible } = req.body;
        if (!id_negocio || !nombre?.trim()) {
            return Respuesta.error(res, 'id_negocio y nombre son requeridos', 400);
        }

        const cat = await CartaAdminService.crearCategoria({ id_negocio, nombre: nombre.trim(), descripcion, icono, imagen_url, orden, visible });
        return Respuesta.success(res, 'Categoría creada', {
            id_categoria: cat.id_categoria,
            nombre:       cat.nombre,
            icono:        cat.icono,
            imagen_url:   cat.imagen_url,
            orden:        cat.orden,
            visible:      cat.visible !== false,
        }, 201);
    } catch (err) {
        console.error('[CartaAdmin] Error crearCategoria:', err.message);
        return Respuesta.error(res, 'Error al crear categoría.');
    }
}

/** PUT /restaurante/carta/admin/categorias/:id */
async function editarCategoria(req, res) {
    try {
        const idCategoria = Number(req.params.id);
        if (!idCategoria) return Respuesta.error(res, 'id requerido', 400);

        await CartaAdminService.editarCategoria(idCategoria, req.body);
        return Respuesta.success(res, 'Categoría actualizada');
    } catch (err) {
        console.error('[CartaAdmin] Error editarCategoria:', err.message);
        return Respuesta.error(res, err.message || 'Error al editar categoría.');
    }
}

/** DELETE /restaurante/carta/admin/categorias/:id */
async function eliminarCategoria(req, res) {
    try {
        const idCategoria = Number(req.params.id);
        if (!idCategoria) return Respuesta.error(res, 'id requerido', 400);

        await CartaAdminService.eliminarCategoria(idCategoria);
        return Respuesta.success(res, 'Categoría eliminada');
    } catch (err) {
        console.error('[CartaAdmin] Error eliminarCategoria:', err.message);
        return Respuesta.error(res, err.message || 'Error al eliminar categoría.');
    }
}

// ── Productos ─────────────────────────────────────────────────────────

/** GET /restaurante/carta/admin/productos?id_negocio=N[&id_categoria=N] */
async function getProductosAdmin(req, res) {
    try {
        const idNegocio   = Number(req.query.id_negocio);
        const idCategoria = req.query.id_categoria ? Number(req.query.id_categoria) : null;
        if (!idNegocio) return Respuesta.error(res, 'id_negocio requerido', 400);

        const productos = await CartaAdminService.getProductosAdmin(idNegocio, idCategoria);
        const data = productos.map(p => ({
            id_producto:  p.id_producto,
            id_categoria: p.id_categoria,
            nombre:       p.nombre,
            descripcion:  p.descripcion,
            precio:       Number(p.precio),
            imagen_url:   p.imagen_url,
            icono:        p.icono,
            es_popular:   p.es_popular,
            disponible:   p.disponible,
            visible:      p.visible !== false,
            ingredientes: (p.ingredientes || [])
                .map(pi => {
                    const idIngrediente = pi.ingrediente?.id_ingrediente ?? pi.id_ingrediente;
                    if (!idIngrediente) return null;
                    return {
                        id_producto_ingred: pi.id_producto_ingred,
                        id_ingrediente:     Number(idIngrediente),
                        nombre:             pi.ingrediente?.nombre ?? '',
                        porcion:            Number(pi.porcion),
                        unidad_medida:      pi.unidad_medida,
                        es_removible:       pi.es_removible,
                    };
                })
                .filter(Boolean),
        }));

        return Respuesta.success(res, 'Productos obtenidos', data);
    } catch (err) {
        console.error('[CartaAdmin] Error getProductosAdmin:', err.message);
        return Respuesta.error(res, 'Error al obtener productos.');
    }
}

/** POST /restaurante/carta/admin/productos */
async function crearProducto(req, res) {
    try {
        const { id_negocio, id_categoria, nombre, descripcion, precio, icono, imagen_url, es_popular, disponible, visible, ingredientes } = req.body;
        if (!id_negocio || !id_categoria || !nombre?.trim() || precio === undefined) {
            return Respuesta.error(res, 'id_negocio, id_categoria, nombre y precio son requeridos', 400);
        }

        const prod = await CartaAdminService.crearProducto({
            id_negocio, id_categoria, nombre: nombre.trim(), descripcion,
            precio, icono, imagen_url, es_popular, disponible, visible, ingredientes,
        });
        return Respuesta.success(res, 'Producto creado', { id_producto: prod.id_producto }, 201);
    } catch (err) {
        console.error('[CartaAdmin] Error crearProducto:', err.message);
        return Respuesta.error(res, 'Error al crear producto.');
    }
}

/** PUT /restaurante/carta/admin/productos/:id */
async function editarProducto(req, res) {
    try {
        const idProducto = Number(req.params.id);
        if (!idProducto) return Respuesta.error(res, 'id requerido', 400);

        await CartaAdminService.editarProducto(idProducto, req.body);
        return Respuesta.success(res, 'Producto actualizado');
    } catch (err) {
        console.error('[CartaAdmin] Error editarProducto:', err.message);
        return Respuesta.error(res, err.message || 'Error al editar producto.');
    }
}

/** DELETE /restaurante/carta/admin/productos/:id */
async function eliminarProducto(req, res) {
    try {
        const idProducto = Number(req.params.id);
        if (!idProducto) return Respuesta.error(res, 'id requerido', 400);

        await CartaAdminService.eliminarProducto(idProducto);
        return Respuesta.success(res, 'Producto eliminado');
    } catch (err) {
        console.error('[CartaAdmin] Error eliminarProducto:', err.message);
        return Respuesta.error(res, err.message || 'Error al eliminar producto.');
    }
}

module.exports = {
    getIngredientes,
    crearIngrediente,
    editarIngrediente,
    eliminarIngrediente,
    subirImagenCarta,
    getCategoriasAdmin,
    crearCategoria,
    editarCategoria,
    eliminarCategoria,
    getProductosAdmin,
    crearProducto,
    editarProducto,
    eliminarProducto,
};
