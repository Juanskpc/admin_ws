'use strict';
const Models = require('../../app_core/models/conection');
const ImagenService = require('./imagenService');

/** Campos propios de los perfiles de rubro. Sin tocarlos, el servicio es el de siempre. */
const CAMPOS_PERFIL = [
    'proceso_desde_min', 'proceso_min', 'a_cotizar', 'requiere_consentimiento', 'id_tipo_recurso',
    'precio_min', 'precio_max',
];

function error(mensaje, statusCode = 400, code = null) {
    const e = new Error(mensaje);
    e.statusCode = statusCode;
    if (code) e.code = code;
    return e;
}

async function listar({ idNegocio, soloActivos = true }) {
    const where = { id_negocio: idNegocio };
    if (soloActivos) where.estado = 'A';
    return Models.ReservaServicio.findAll({
        where,
        // La categoría viaja incluida para que la lista del admin pueda agruparse sin una
        // segunda petición y sin que el cliente tenga que cruzar ids a mano.
        include: [
            { model: Models.ReservaCategoria, as: 'categoria',
              attributes: ['id_categoria', 'nombre', 'orden'], required: false },
            // Variantes activas y el tipo de cabina, para los perfiles que los usan. En una
            // barbería llegan vacías y el LEFT JOIN no cambia las filas.
            { model: Models.ReservaServicioVariante, as: 'variantes', required: false,
              where: { estado: 'A' },
              attributes: ['id_variante', 'nombre', 'clave', 'duracion_min', 'precio', 'orden'] },
            { model: Models.ReservaTipoRecurso, as: 'tipoRecurso', required: false,
              attributes: ['id_tipo_recurso', 'nombre'] },
        ],
        order: [['nombre', 'ASC'], [{ model: Models.ReservaServicioVariante, as: 'variantes' }, 'orden', 'ASC']],
    });
}

async function getById(idServicio, idNegocio) {
    return Models.ReservaServicio.findOne({
        where: { id_servicio: idServicio, id_negocio: idNegocio },
        include: [{ model: Models.ReservaServicioVariante, as: 'variantes', required: false, where: { estado: 'A' } }],
    });
}

/**
 * La categoría tiene que ser del mismo negocio.
 *
 * `id_categoria` llega en el cuerpo, así que sin esta comprobación un inquilino podría colgar
 * su servicio de la categoría de otro: no rompe nada visible de inmediato, pero mete una fila
 * de un negocio dentro de la sección de otro y filtra el nombre de esa categoría al portal.
 */
async function validarCategoria(idCategoria, idNegocio) {
    if (idCategoria === undefined) return;
    if (idCategoria === null || idCategoria === '') return null;

    const cat = await Models.ReservaCategoria.findOne({
        where: { id_categoria: Number(idCategoria), id_negocio: idNegocio, estado: 'A' },
        attributes: ['id_categoria'],
    });
    if (!cat) {
        const e = new Error('La categoría no existe o no pertenece al negocio.');
        e.statusCode = 400;
        throw e;
    }
}

/** El tipo de cabina, igual que la categoría: tiene que ser del negocio. */
async function validarTipoRecurso(idTipoRecurso, idNegocio) {
    if (idTipoRecurso === undefined || idTipoRecurso === null || idTipoRecurso === '') return;
    const tipo = await Models.ReservaTipoRecurso.findOne({
        where: { id_tipo_recurso: Number(idTipoRecurso), id_negocio: idNegocio, estado: 'A' },
        attributes: ['id_tipo_recurso'],
    });
    if (!tipo) throw error('La cabina o equipo no existe o no pertenece al negocio.');
}

/**
 * El tiempo de espera tiene que caber dentro del servicio. Una espera que empieza después de
 * terminar no libera nada y confunde; se rechaza aquí en vez de ignorarla en silencio.
 */
function validarProceso({ duracion_min, proceso_desde_min, proceso_min }) {
    const min = Number(proceso_min || 0);
    if (min === 0) return;
    const desde = Number(proceso_desde_min || 0);
    if (desde <= 0) throw error('Indica a los cuántos minutos empieza la espera.', 422, 'PROCESO_NO_VALIDO');
    if (desde + min >= Number(duracion_min)) {
        throw error('La espera tiene que terminar antes de que acabe el servicio.', 422, 'PROCESO_NO_VALIDO');
    }
}

function normalizarCamposPerfil(data) {
    const salida = {};
    for (const c of CAMPOS_PERFIL) {
        if (data[c] === undefined) continue;
        if (c === 'id_tipo_recurso') salida[c] = data[c] === '' || data[c] === null ? null : Number(data[c]);
        else if (c === 'a_cotizar' || c === 'requiere_consentimiento') salida[c] = data[c] === true || data[c] === 'true';
        // Sin rango es "no lo digas", no cero: un 0 se pintaría como "$0 - $50.000" en el portal.
        else if (c === 'precio_min' || c === 'precio_max') {
            salida[c] = data[c] === '' || data[c] === null ? null : Number(data[c]);
        } else salida[c] = Number(data[c]) || 0;
    }
    return salida;
}

/**
 * El rango que se enseña en el portal cuando el precio se decide al atender («Tatuaje pequeño,
 * $80.000 - $150.000»). Ninguno de los dos extremos es obligatorio —un servicio a cotizar puede
 * no dar ninguna pista de precio, como hasta ahora—, pero si se da uno el rango tiene que tener
 * sentido: al revés no orienta a nadie y solo confunde en el portal.
 */
function validarRangoPrecio({ precio_min, precio_max }) {
    if (precio_min == null && precio_max == null) return;
    if (precio_min != null && (!Number.isFinite(precio_min) || precio_min < 0)) {
        throw error('El precio "desde" no es válido.', 422, 'RANGO_PRECIO_NO_VALIDO');
    }
    if (precio_max != null && (!Number.isFinite(precio_max) || precio_max < 0)) {
        throw error('El precio "hasta" no es válido.', 422, 'RANGO_PRECIO_NO_VALIDO');
    }
    if (precio_min != null && precio_max != null && precio_min > precio_max) {
        throw error('El precio "desde" no puede ser mayor que "hasta".', 422, 'RANGO_PRECIO_NO_VALIDO');
    }
}

/**
 * Reemplaza las variantes del servicio por la lista recibida: se actualizan las que traen id,
 * se crean las nuevas y se **inactivan** (no se borran) las que desaparecen, porque una cita
 * vieja puede apuntar a ellas y su nombre debe seguir leyéndose.
 */
async function sincronizarVariantes(servicio, variantes, transaction) {
    if (!Array.isArray(variantes)) return;
    const actuales = await Models.ReservaServicioVariante.findAll({
        where: { id_servicio: servicio.id_servicio, estado: 'A' }, transaction,
    });
    const recibidas = variantes
        .map((v, i) => ({
            id_variante: v.id_variante ? Number(v.id_variante) : null,
            nombre: String(v.nombre || '').trim().slice(0, 80),
            clave: v.clave ? String(v.clave).trim().toUpperCase().slice(0, 20) : null,
            duracion_min: Number(v.duracion_min),
            precio: Number(v.precio),
            orden: i,
        }));
    for (const v of recibidas) {
        if (!v.nombre) throw error('Cada variante necesita un nombre.', 422, 'VARIANTE_NO_VALIDA');
        if (!Number.isInteger(v.duracion_min) || v.duracion_min < 5 || v.duracion_min > 600) {
            throw error(`La duración de «${v.nombre}» debe estar entre 5 y 600 minutos.`, 422, 'VARIANTE_NO_VALIDA');
        }
        if (!Number.isFinite(v.precio) || v.precio < 0) {
            throw error(`El precio de «${v.nombre}» no es válido.`, 422, 'VARIANTE_NO_VALIDA');
        }
    }
    const idsRecibidos = new Set(recibidas.filter((v) => v.id_variante).map((v) => v.id_variante));
    for (const a of actuales) {
        if (!idsRecibidos.has(a.id_variante)) {
            await a.update({ estado: 'I', fecha_actualizacion: new Date() }, { transaction });
        }
    }
    for (const v of recibidas) {
        const existente = v.id_variante ? actuales.find((a) => a.id_variante === v.id_variante) : null;
        const datos = { nombre: v.nombre, clave: v.clave, duracion_min: v.duracion_min, precio: v.precio, orden: v.orden };
        if (existente) {
            await existente.update({ ...datos, fecha_actualizacion: new Date() }, { transaction });
        } else {
            await Models.ReservaServicioVariante.create({
                ...datos, id_servicio: servicio.id_servicio, id_negocio: servicio.id_negocio,
            }, { transaction });
        }
    }
}

async function crear(data) {
    const idNegocio = Number(data.id_negocio);
    await validarCategoria(data.id_categoria, idNegocio);
    await validarTipoRecurso(data.id_tipo_recurso, idNegocio);
    const { variantes, ...resto } = data;
    const perfil = normalizarCamposPerfil(resto);
    validarProceso({ duracion_min: resto.duracion_min, ...perfil });
    validarRangoPrecio(perfil);
    if (resto.id_categoria === '') resto.id_categoria = null;

    return Models.sequelize.transaction(async (t) => {
        const s = await Models.ReservaServicio.create({ ...resto, ...perfil }, { transaction: t });
        await sincronizarVariantes(s, variantes, t);
        return s;
    }).then((s) => getById(s.id_servicio, idNegocio));
}

async function actualizar(idServicio, idNegocio, data) {
    const s = await Models.ReservaServicio.findOne({ where: { id_servicio: idServicio, id_negocio: idNegocio } });
    if (!s) return null;
    await validarCategoria(data.id_categoria, idNegocio);
    await validarTipoRecurso(data.id_tipo_recurso, idNegocio);
    const { variantes, ...resto } = data;
    if (resto.id_categoria === '') resto.id_categoria = null;
    delete resto.id_servicio; delete resto.id_negocio; delete resto.fecha_creacion;
    const perfil = normalizarCamposPerfil(resto);
    for (const c of CAMPOS_PERFIL) delete resto[c];
    validarProceso({
        duracion_min: resto.duracion_min ?? s.duracion_min,
        proceso_desde_min: perfil.proceso_desde_min ?? s.proceso_desde_min,
        proceso_min: perfil.proceso_min ?? s.proceso_min,
    });
    validarRangoPrecio({
        precio_min: 'precio_min' in perfil ? perfil.precio_min : (s.precio_min == null ? null : Number(s.precio_min)),
        precio_max: 'precio_max' in perfil ? perfil.precio_max : (s.precio_max == null ? null : Number(s.precio_max)),
    });
    resto.fecha_actualizacion = new Date();

    await Models.sequelize.transaction(async (t) => {
        await s.update({ ...resto, ...perfil }, { transaction: t });
        await sincronizarVariantes(s, variantes, t);
    });
    return getById(idServicio, idNegocio);
}

/**
 * Inactiva el servicio y **borra su imagen del disco**.
 *
 * El registro se conserva (las citas ya cobradas lo referencian y su histórico debe seguir
 * leyéndose), pero el archivo no: un servicio retirado no se muestra en ninguna parte, así que
 * su foto solo ocuparía espacio hasta que alguien la encontrara por casualidad. Si se reactiva,
 * se vuelve a subir — es un clic frente a una carpeta que crece sola.
 */
async function inactivar(idServicio, idNegocio) {
    const s = await Models.ReservaServicio.findOne({ where: { id_servicio: idServicio, id_negocio: idNegocio } });
    if (!s) return null;
    if (s.imagen_url) {
        ImagenService.eliminar({ tipo: 'servicio', idNegocio, idEntidad: idServicio });
    }
    return Models.sequelize.transaction((t) => s.update({ estado: 'I', imagen_url: null, fecha_actualizacion: new Date() }, { transaction: t }));
}

module.exports = { listar, getById, crear, actualizar, inactivar, sincronizarVariantes };
