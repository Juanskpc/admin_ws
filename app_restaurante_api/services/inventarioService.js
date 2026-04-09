const Models = require('../../app_core/models/conection');

/**
 * inventarioService - Control de insumos y recetas del restaurante.
 */

async function getInventarioResumen(idNegocio) {
    const ingredientes = await Models.CartaIngrediente.findAll({
        where: { id_negocio: idNegocio, estado: 'A' },
        attributes: [
            'id_ingrediente',
            'nombre',
            'unidad_medida',
            'stock_actual',
            'stock_minimo',
            'stock_maximo',
        ],
        include: [{
            model: Models.CartaProductoIngred,
            as: 'productosIngred',
            where: { estado: 'A' },
            required: false,
            attributes: ['id_producto', 'porcion', 'unidad_medida'],
            include: [{
                model: Models.CartaProducto,
                as: 'producto',
                where: { estado: 'A' },
                required: false,
                attributes: ['id_producto', 'id_categoria', 'nombre', 'icono', 'disponible', 'precio'],
                include: [{
                    model: Models.CartaCategoria,
                    as: 'categoria',
                    required: false,
                    attributes: ['nombre', 'icono'],
                }],
            }],
        }],
        order: [['nombre', 'ASC']],
    });

    const productos = await Models.CartaProducto.findAll({
        where: { id_negocio: idNegocio, estado: 'A' },
        attributes: ['id_producto', 'nombre', 'icono', 'precio', 'disponible'],
        include: [{
            model: Models.CartaProductoIngred,
            as: 'ingredientes',
            where: { estado: 'A' },
            required: false,
            attributes: ['id_ingrediente', 'porcion', 'unidad_medida'],
            include: [{
                model: Models.CartaIngrediente,
                as: 'ingrediente',
                where: { estado: 'A' },
                required: false,
                attributes: ['id_ingrediente', 'nombre', 'stock_actual', 'unidad_medida'],
            }],
        }],
        order: [['nombre', 'ASC']],
        limit: 24,
    });

    const insumos = ingredientes.map((ing) => {
        const stockActual = Number(ing.stock_actual ?? 0);
        const stockMinimo = Number(ing.stock_minimo ?? 0);
        const stockMaximoRaw = Number(ing.stock_maximo ?? 0);
        const stockMaximo = stockMaximoRaw > 0 ? stockMaximoRaw : Math.max(stockMinimo * 2, stockActual, 1);

        const status = stockActual <= 0
            ? 'agotado'
            : stockActual <= stockMinimo
                ? 'bajo'
                : 'ok';

        const categoriaPrincipal = ing.productosIngred?.find((pi) => pi.producto?.categoria?.nombre)?.producto?.categoria?.nombre
            || 'Sin categoria';

        return {
            id_ingrediente: ing.id_ingrediente,
            nombre: ing.nombre,
            categoria: categoriaPrincipal,
            unidad_medida: ing.unidad_medida || 'g',
            stock_actual: stockActual,
            stock_minimo: stockMinimo,
            stock_maximo: stockMaximo,
            porcentaje_stock: Math.max(0, Math.min(100, Math.round((stockActual / stockMaximo) * 100))),
            status,
        };
    });

    const totalInsumos = insumos.length;
    const stockBajo = insumos.filter((i) => i.status === 'bajo').length;
    const agotados = insumos.filter((i) => i.status === 'agotado').length;

    const recetasProducto = productos.map((p) => ({
        id_producto: p.id_producto,
        nombre: p.nombre,
        icono: p.icono || '🍽️',
        precio: Number(p.precio ?? 0),
        disponible: Boolean(p.disponible),
        receta: (p.ingredientes || [])
            .filter((pi) => pi.ingrediente)
            .map((pi) => {
                const stockActual = Number(pi.ingrediente.stock_actual ?? 0);
                const porcion = Number(pi.porcion ?? 0);
                const alcanzaPara = porcion > 0
                    ? Math.floor(stockActual / porcion)
                    : null;

                return {
                    id_ingrediente: pi.ingrediente.id_ingrediente,
                    nombre: pi.ingrediente.nombre,
                    porcion,
                    unidad_medida: pi.unidad_medida || pi.ingrediente.unidad_medida || 'g',
                    stock_actual: stockActual,
                    alcanza_para: alcanzaPara,
                };
            }),
    }));

    return {
        kpis: {
            total_insumos: totalInsumos,
            stock_bajo: stockBajo,
            agotados,
        },
        insumos,
        productos: recetasProducto,
    };
}

async function ajustarStockIngrediente(idNegocio, idIngrediente, payload = {}) {
    const ingrediente = await Models.CartaIngrediente.findOne({
        where: {
            id_ingrediente: idIngrediente,
            id_negocio: idNegocio,
            estado: 'A',
        },
    });

    if (!ingrediente) {
        throw new Error('Ingrediente no encontrado');
    }

    const stockActual = Number(ingrediente.stock_actual ?? 0);
    const tieneSet = payload.stock_actual !== undefined && payload.stock_actual !== null;
    const tieneDelta = payload.delta !== undefined && payload.delta !== null;

    if (!tieneSet && !tieneDelta) {
        throw new Error('Debes enviar stock_actual o delta');
    }

    let nextStock = stockActual;
    if (tieneSet) {
        nextStock = Number(payload.stock_actual);
    } else if (tieneDelta) {
        nextStock = stockActual + Number(payload.delta);
    }

    if (!Number.isFinite(nextStock)) {
        throw new Error('Valor de stock invalido');
    }

    if (nextStock < 0) nextStock = 0;

    await ingrediente.update({ stock_actual: nextStock });

    return {
        id_ingrediente: ingrediente.id_ingrediente,
        nombre: ingrediente.nombre,
        unidad_medida: ingrediente.unidad_medida || 'g',
        stock_actual: Number(ingrediente.stock_actual ?? 0),
        stock_minimo: Number(ingrediente.stock_minimo ?? 0),
        stock_maximo: Number(ingrediente.stock_maximo ?? 0),
    };
}

module.exports = {
    getInventarioResumen,
    ajustarStockIngrediente,
};
