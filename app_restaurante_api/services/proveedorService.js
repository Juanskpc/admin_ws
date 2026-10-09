'use strict';
/**
 * proveedorService — proveedores de insumos del restaurante.
 *
 * ## Las dos reglas que gobiernan todo este archivo
 *
 * **1. Un proveedor es del mundo; lo que sabes de él es tuyo.** La ficha (`rest_proveedor`) la
 * puede ver otro negocio si su dueño lo permitió. Las notas, la calificación, los precios
 * negociados y las compras (`rest_proveedor_negocio`, `rest_proveedor_insumo`, `rest_compra`)
 * NO salen nunca del negocio que las escribió. Toda consulta de esas tres va acotada por
 * `id_negocio`, sin excepción.
 *
 * **2. Quién registró una ficha es secreto.** `id_negocio_origen` jamás se proyecta hacia
 * fuera: saber qué restaurante registró a un proveedor es saber a quién le compra la
 * competencia. Lo único que sale es `es_propio` (si el que pregunta lo tiene vinculado).
 *
 * El filtro no es cosmético y por eso vive aquí y no en el frontend: `proyectar()` construye el
 * objeto campo a campo según el nivel de visibilidad, en vez de borrar campos de la fila. Una
 * lista blanca no se olvida de una columna nueva; una lista negra sí.
 */
const { Op, QueryTypes } = require('sequelize');
const Models = require('../../app_core/models/conection');
const Audit = require('../../app_core/helpers/auditHelper');
const { fijarActor } = require('../../app_core/helpers/auditActor');
const { usuarioTieneSubnivel } = require('../../app_core/helpers/permisoSubnivel');
const ConfiguracionService = require('./configuracionService');

// ============================================================
// Constantes del dominio
// ============================================================

const VISIBILIDADES = ['PRIVADO', 'DIRECTORIO_BASICO', 'DIRECTORIO_SIN_PRECIOS', 'DIRECTORIO'];
const TIPOS_ATENCION = ['ENTREGA', 'RECOGIDA', 'AMBOS'];
const UNIDADES = ['KG', 'G', 'L', 'ML', 'UN', 'CAJA', 'BULTO', 'PAQUETE', 'OTRA'];

/** Las que se publican en el directorio compartido. `PRIVADO` no está, y es lo importante. */
const VISIBLES_EN_DIRECTORIO = ['DIRECTORIO_BASICO', 'DIRECTORIO_SIN_PRECIOS', 'DIRECTORIO'];

/**
 * A qué unidad base se reduce cada unidad, y con qué factor.
 *
 * Peso y volumen se pueden comparar entre sí (un kilo son mil gramos). Caja, bulto y paquete
 * NO: son recipientes, no medidas, y lo que llevan dentro lo dice `cantidad_presentacion`.
 * Por eso caen en `UN` y el comparador avisa cuando se mezclan.
 */
const UNIDAD_BASE = {
    KG: { base: 'KG', factor: 1 },
    G: { base: 'KG', factor: 0.001 },
    L: { base: 'L', factor: 1 },
    ML: { base: 'L', factor: 0.001 },
    UN: { base: 'UN', factor: 1 },
    CAJA: { base: 'UN', factor: 1 },
    BULTO: { base: 'UN', factor: 1 },
    PAQUETE: { base: 'UN', factor: 1 },
    OTRA: { base: 'UN', factor: 1 },
};

/** Desde cuántos días un precio se considera viejo y el comparador lo advierte. */
const DIAS_PRECIO_VIEJO = 90;

function domainError(message, code, statusCode) {
    const err = new Error(message);
    err.code = code;
    err.statusCode = statusCode;
    return err;
}

// ============================================================
// Acceso y permisos
// ============================================================

/** El negocio sobre el que se trabaja, comprobando que el usuario pertenece a él. */
async function negocioDe(idUsuario, idNegocio) {
    const acceso = await ConfiguracionService.resolveAccesoNegocio(idUsuario, idNegocio);
    return acceso.idNegocio;
}

/**
 * Exige un subnivel o lanza 403.
 *
 * El frontend ya esconde lo que el rol no puede hacer, pero eso es cosmético: aquí es donde
 * de verdad se decide, porque una petición no tiene por qué venir de nuestra pantalla.
 */
async function exigir(idUsuario, idNegocio, codigo, mensaje) {
    const ok = await usuarioTieneSubnivel({ idUsuario, idNegocio, codigo });
    if (!ok) throw domainError(mensaje, 'SIN_PERMISO', 403);
}

/** ¿Puede ver precios y gasto privados? No lanza: hay vistas que se recortan en vez de negarse. */
function puedeVerPrecios(idUsuario, idNegocio) {
    return usuarioTieneSubnivel({ idUsuario, idNegocio, codigo: 'proveedores_precios' });
}

// ============================================================
// Normalización de entrada
// ============================================================

const texto = (v, max) => {
    if (v === undefined || v === null) return null;
    const limpio = String(v).trim().replace(/\s+/g, ' ');
    if (!limpio) return null;
    return max ? limpio.slice(0, max) : limpio;
};

const numero = (v, porDefecto = null) => {
    if (v === undefined || v === null || v === '') return porDefecto;
    const n = Number(v);
    return Number.isFinite(n) ? n : porDefecto;
};

const booleano = (v, porDefecto = false) => (v === undefined || v === null ? porDefecto : Boolean(v));

/** Array de textos cortos (zonas de cobertura). Se limpia y se deduplica. */
function listaTextos(v, maxItems = 30, maxLargo = 60) {
    if (!Array.isArray(v)) return [];
    const vistos = new Set();
    const salida = [];
    for (const item of v) {
        const limpio = texto(item, maxLargo);
        if (!limpio) continue;
        const clave = limpio.toLowerCase();
        if (vistos.has(clave)) continue;
        vistos.add(clave);
        salida.push(limpio);
        if (salida.length >= maxItems) break;
    }
    return salida;
}

/** Días de la semana como enteros 0..6 (0 = domingo), ordenados y sin repetidos. */
function diasSemana(v) {
    if (!Array.isArray(v)) return [];
    const set = new Set();
    for (const item of v) {
        const n = Number(item);
        if (Number.isInteger(n) && n >= 0 && n <= 6) set.add(n);
    }
    return [...set].sort((a, b) => a - b);
}

/** Solo las redes que conocemos, como URL o usuario. El resto se descarta sin avisar. */
function redesSociales(v) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
    const salida = {};
    for (const clave of ['instagram', 'facebook', 'tiktok', 'x', 'linkedin']) {
        const valor = texto(v[clave], 160);
        if (valor) salida[clave] = valor;
    }
    return salida;
}

const unidadValida = (v) => (UNIDADES.includes(String(v || '').toUpperCase()) ? String(v).toUpperCase() : 'UN');

// ============================================================
// Proyección: qué ve cada quien
// ============================================================

/**
 * Qué nivel de detalle le corresponde a quien pregunta.
 *
 *   'propio'      → es suyo (lo creó o lo vinculó): lo ve todo, incluido lo privado.
 *   'completo'    → del directorio, con precios publicados.
 *   'sin_precios' → del directorio, con condiciones pero sin precios.
 *   'basico'      → del directorio, solo lo indispensable para contactarlo.
 */
function nivelDeAcceso(prov, vinculo) {
    if (vinculo) return 'propio';
    switch (prov.visibilidad) {
        case 'DIRECTORIO': return 'completo';
        case 'DIRECTORIO_SIN_PRECIOS': return 'sin_precios';
        case 'DIRECTORIO_BASICO': return 'basico';
        default: return null; // PRIVADO: para quien no lo tiene vinculado, no existe.
    }
}

/**
 * La ficha, campo a campo, según el nivel.
 *
 * Lista BLANCA a propósito: el día que alguien añada una columna a `rest_proveedor` no se
 * filtrará sola al directorio por habérsele olvidado tacharla aquí.
 */
function proyectar(prov, { nivel, vinculo, categorias = [] }) {
    const propio = nivel === 'propio';
    const conCondiciones = propio || nivel === 'completo' || nivel === 'sin_precios';

    const base = {
        id_proveedor: prov.id_proveedor,
        nombre_comercial: prov.nombre_comercial,
        descripcion: prov.descripcion ?? null,
        logo_url: prov.logo_url ?? null,
        categorias,
        // Contacto: es para lo que sirve un directorio, así que va en todos los niveles.
        persona_contacto: prov.persona_contacto ?? null,
        telefono: prov.telefono ?? null,
        whatsapp: prov.whatsapp ?? null,
        email: prov.email ?? null,
        sitio_web: prov.sitio_web ?? null,
        redes: prov.redes ?? {},
        ciudad: prov.ciudad ?? null,
        region: prov.region ?? null,
        pais: prov.pais ?? null,
        tipo_atencion: prov.tipo_atencion,
        // Marca de agua de la vista, no de la ficha: dice qué está viendo quien pregunta.
        es_propio: propio,
        nivel_acceso: nivel,
    };

    if (conCondiciones) {
        Object.assign(base, {
            direccion: prov.direccion ?? null,
            zonas_cobertura: prov.zonas_cobertura ?? [],
            pedido_minimo: Number(prov.pedido_minimo ?? 0),
            dias_entrega: prov.dias_entrega ?? [],
            tiempo_entrega_hrs: prov.tiempo_entrega_hrs ?? null,
            metodos_pago: prov.metodos_pago ?? null,
            precios_mayoristas: Boolean(prov.precios_mayoristas),
            observaciones: prov.observaciones ?? null,
        });
    }

    if (propio) {
        Object.assign(base, {
            // Datos fiscales: solo para quien lo tiene vinculado. En el directorio sobran y
            // son justo lo que no hay que repartir.
            nombre_legal: prov.nombre_legal ?? null,
            identificacion: prov.identificacion ?? null,
            visibilidad: prov.visibilidad,
            estado: prov.estado,
            // Lo estrictamente privado de ESTE negocio.
            es_propietario: Boolean(vinculo?.es_propietario),
            estado_interno: vinculo?.estado_interno ?? 'ACTIVO',
            notas: vinculo?.notas ?? null,
            condiciones_propias: vinculo?.condiciones ?? null,
            calificacion: vinculo?.calificacion ?? null,
            fecha_vinculacion: vinculo?.fecha_vinculacion ?? null,
        });
    }

    return base;
}

/** Un insumo, según si quien pregunta puede ver su precio. */
function proyectarInsumo(ins, { conPrecio, propio }) {
    const salida = {
        id_proveedor_insumo: ins.id_proveedor_insumo,
        id_proveedor: ins.id_proveedor,
        nombre: ins.nombre,
        id_categoria_prov: ins.id_categoria_prov ?? null,
        categoria: ins.categoria_nombre ?? null,
        unidad: ins.unidad,
        presentacion: ins.presentacion ?? null,
        cantidad_presentacion: ins.cantidad_presentacion == null ? null : Number(ins.cantidad_presentacion),
        moneda: ins.moneda,
        disponible: Boolean(ins.disponible),
        marca: ins.marca ?? null,
        es_propio: Boolean(propio),
    };

    if (conPrecio) {
        salida.precio = ins.precio == null ? null : Number(ins.precio);
        salida.fecha_precio = ins.fecha_precio ?? null;
        salida.precio_publico = Boolean(ins.publico);
    } else {
        // No es `precio: null` disfrazado: la pantalla distingue «no tiene precio cargado» de
        // «hay precio pero no se publica», y son dos cosas distintas para quien compara.
        salida.precio = null;
        salida.fecha_precio = null;
        salida.precio_reservado = true;
    }

    if (propio) {
        Object.assign(salida, {
            id_ingrediente: ins.id_ingrediente ?? null,
            ingrediente: ins.ingrediente_nombre ?? null,
            codigo_proveedor: ins.codigo_proveedor ?? null,
            notas: ins.notas ?? null,
        });
    }

    return salida;
}

// ============================================================
// Lecturas auxiliares
// ============================================================

async function vinculoDe(idProveedor, idNegocio, transaction = null) {
    return Models.RestProveedorNegocio.findOne({
        where: { id_proveedor: idProveedor, id_negocio: idNegocio },
        transaction,
    });
}

async function categoriasDe(idsProveedor) {
    if (!idsProveedor.length) return new Map();
    const filas = await Models.sequelize.query(`
        SELECT pc.id_proveedor, c.id_categoria_prov, c.codigo, c.nombre, c.icono
          FROM restaurante.rest_proveedor_categoria pc
          JOIN restaurante.rest_proveedor_categoria_cat c
            ON c.id_categoria_prov = pc.id_categoria_prov
         WHERE pc.id_proveedor IN (:ids)
         ORDER BY c.orden, c.nombre;
    `, { replacements: { ids: idsProveedor }, type: QueryTypes.SELECT });

    const mapa = new Map();
    for (const f of filas) {
        if (!mapa.has(f.id_proveedor)) mapa.set(f.id_proveedor, []);
        mapa.get(f.id_proveedor).push({
            id_categoria_prov: f.id_categoria_prov,
            codigo: f.codigo,
            nombre: f.nombre,
            icono: f.icono,
        });
    }
    return mapa;
}

/** Los códigos de categoría que existen, para validar sin confiar en lo que llega. */
async function resolverCategorias(codigosOIds) {
    if (!Array.isArray(codigosOIds) || !codigosOIds.length) return [];
    const ids = codigosOIds.filter((v) => Number.isInteger(Number(v))).map(Number);
    const codigos = codigosOIds.filter((v) => typeof v === 'string' && !/^\d+$/.test(v));

    const filas = await Models.RestProveedorCategoriaCat.findAll({
        where: {
            estado: 'A',
            [Op.or]: [
                ...(ids.length ? [{ id_categoria_prov: ids }] : []),
                ...(codigos.length ? [{ codigo: codigos }] : []),
            ],
        },
        attributes: ['id_categoria_prov'],
    });
    return filas.map((f) => f.id_categoria_prov);
}

// ============================================================
// Catálogo de categorías
// ============================================================

async function listarCategorias() {
    const filas = await Models.RestProveedorCategoriaCat.findAll({
        where: { estado: 'A' },
        order: [['orden', 'ASC'], ['nombre', 'ASC']],
    });
    return filas.map((f) => ({
        id_categoria_prov: f.id_categoria_prov,
        codigo: f.codigo,
        nombre: f.nombre,
        icono: f.icono,
    }));
}

// ============================================================
// Listado
// ============================================================

/**
 * El listado de proveedores.
 *
 * `ambito` decide de dónde salen las filas y es lo que separa «los míos» del directorio:
 *
 *   mios       → los que este negocio tiene vinculados (los creó o los agregó del directorio).
 *   directorio → los publicados por OTROS y que este negocio todavía no tiene.
 *   todos      → la unión.
 *
 * El filtrado fino (búsqueda, categoría, ciudad, orden) se hace en SQL porque el directorio
 * crecerá con el tiempo y no se puede traer entero a memoria.
 */
async function listar(idUsuario, {
    idNegocio: idNegocioPedido,
    ambito = 'mios',
    busqueda = null,
    categoria = null,
    ciudad = null,
    orden = 'nombre',
    incluirArchivados = false,
    limite = 60,
    offset = 0,
} = {}) {
    const idNegocio = await negocioDe(idUsuario, idNegocioPedido);

    const condiciones = ["p.estado = 'A'"];
    const repl = { idNegocio, limite: Math.min(Number(limite) || 60, 200), offset: Number(offset) || 0 };

    if (ambito === 'mios') {
        condiciones.push('v.id_proveedor_negocio IS NOT NULL');
    } else if (ambito === 'directorio') {
        condiciones.push('v.id_proveedor_negocio IS NULL');
        condiciones.push('p.visibilidad IN (:visibles)');
        repl.visibles = VISIBLES_EN_DIRECTORIO;
    } else {
        // «Todos» no es «todo lo que hay»: es lo mío más lo que otros publicaron.
        condiciones.push('(v.id_proveedor_negocio IS NOT NULL OR p.visibilidad IN (:visibles))');
        repl.visibles = VISIBLES_EN_DIRECTORIO;
    }

    // Archivado es un estado de ESTE negocio: no se le esconde a nadie más.
    if (!incluirArchivados) {
        condiciones.push("(v.id_proveedor_negocio IS NULL OR v.estado_interno = 'ACTIVO')");
    }

    const q = texto(busqueda, 120);
    if (q) {
        condiciones.push(`(
            p.nombre_comercial ILIKE :q
            OR p.ciudad ILIKE :q
            OR EXISTS (
                SELECT 1 FROM restaurante.rest_proveedor_insumo i
                 WHERE i.id_proveedor = p.id_proveedor AND i.estado = 'A'
                   AND i.nombre ILIKE :q
                   AND (i.id_negocio = :idNegocio OR (i.publico AND p.visibilidad = 'DIRECTORIO'))
            )
        )`);
        repl.q = `%${q}%`;
    }

    if (categoria) {
        condiciones.push(`EXISTS (
            SELECT 1 FROM restaurante.rest_proveedor_categoria pc
              JOIN restaurante.rest_proveedor_categoria_cat c ON c.id_categoria_prov = pc.id_categoria_prov
             WHERE pc.id_proveedor = p.id_proveedor AND c.codigo = :categoria
        )`);
        repl.categoria = String(categoria);
    }

    const ciudadLimpia = texto(ciudad, 100);
    if (ciudadLimpia) {
        condiciones.push('(p.ciudad ILIKE :ciudad OR p.zonas_cobertura::text ILIKE :ciudad)');
        repl.ciudad = `%${ciudadLimpia}%`;
    }

    const ordenSql = {
        nombre: 'p.nombre_comercial ASC',
        reciente: 'p.fecha_actualizacion DESC',
        precio: 'precio_min ASC NULLS LAST, p.nombre_comercial ASC',
        uso: 'compras DESC, p.nombre_comercial ASC',
        actualizacion: 'ultimo_precio DESC NULLS LAST, p.nombre_comercial ASC',
    }[orden] || 'p.nombre_comercial ASC';

    const filas = await Models.sequelize.query(`
        SELECT p.id_proveedor, p.nombre_comercial, p.descripcion, p.logo_url, p.visibilidad,
               p.persona_contacto, p.telefono, p.whatsapp, p.email, p.sitio_web, p.redes,
               p.direccion, p.ciudad, p.region, p.pais, p.zonas_cobertura, p.tipo_atencion,
               p.pedido_minimo, p.dias_entrega, p.tiempo_entrega_hrs, p.metodos_pago,
               p.precios_mayoristas, p.observaciones, p.nombre_legal, p.identificacion, p.estado,
               v.id_proveedor_negocio, v.es_propietario, v.estado_interno, v.notas,
               v.condiciones, v.calificacion, v.fecha_vinculacion,
               -- Insumos que ESTE negocio puede ver de este proveedor. El OR es la frontera
               -- de privacidad del módulo entero: los míos, o los publicados por su dueño.
               (SELECT COUNT(*) FROM restaurante.rest_proveedor_insumo i
                 WHERE i.id_proveedor = p.id_proveedor AND i.estado = 'A'
                   AND (i.id_negocio = :idNegocio OR (i.publico AND p.visibilidad = 'DIRECTORIO'))
               )::int AS insumos,
               (SELECT string_agg(x.nombre, ', ') FROM (
                    SELECT i.nombre FROM restaurante.rest_proveedor_insumo i
                     WHERE i.id_proveedor = p.id_proveedor AND i.estado = 'A'
                       AND (i.id_negocio = :idNegocio OR (i.publico AND p.visibilidad = 'DIRECTORIO'))
                     ORDER BY i.nombre LIMIT 3
               ) x)::text AS insumos_destacados,
               (SELECT MAX(i.fecha_precio) FROM restaurante.rest_proveedor_insumo i
                 WHERE i.id_proveedor = p.id_proveedor AND i.estado = 'A'
                   AND i.id_negocio = :idNegocio
               ) AS ultimo_precio,
               (SELECT MIN(i.precio) FROM restaurante.rest_proveedor_insumo i
                 WHERE i.id_proveedor = p.id_proveedor AND i.estado = 'A'
                   AND i.id_negocio = :idNegocio AND i.precio IS NOT NULL
               ) AS precio_min,
               (SELECT COUNT(*) FROM restaurante.rest_compra co
                 WHERE co.id_proveedor = p.id_proveedor AND co.id_negocio = :idNegocio
                   AND co.estado = 'A'
               )::int AS compras,
               (SELECT MAX(co.fecha) FROM restaurante.rest_compra co
                 WHERE co.id_proveedor = p.id_proveedor AND co.id_negocio = :idNegocio
                   AND co.estado = 'A'
               ) AS ultima_compra,
               COUNT(*) OVER()::int AS total_filas
          FROM restaurante.rest_proveedor p
          LEFT JOIN restaurante.rest_proveedor_negocio v
                 ON v.id_proveedor = p.id_proveedor AND v.id_negocio = :idNegocio
         WHERE ${condiciones.join(' AND ')}
         ORDER BY ${ordenSql}
         LIMIT :limite OFFSET :offset;
    `, { replacements: repl, type: QueryTypes.SELECT });

    const cats = await categoriasDe(filas.map((f) => f.id_proveedor));
    const verPrecios = await puedeVerPrecios(idUsuario, idNegocio);

    const items = filas.map((f) => {
        const vinculo = f.id_proveedor_negocio ? f : null;
        const nivel = nivelDeAcceso(f, vinculo);
        const ficha = proyectar(f, { nivel, vinculo, categorias: cats.get(f.id_proveedor) ?? [] });
        return {
            ...ficha,
            insumos: Number(f.insumos ?? 0),
            insumos_destacados: f.insumos_destacados ?? null,
            // El gasto y el precio mínimo son información financiera: detrás de su permiso.
            compras: verPrecios ? Number(f.compras ?? 0) : null,
            ultima_compra: verPrecios ? f.ultima_compra : null,
            precio_min: verPrecios && f.precio_min != null ? Number(f.precio_min) : null,
            ultimo_precio: nivel === 'propio' ? f.ultimo_precio : null,
        };
    });

    return {
        items,
        total: filas.length ? Number(filas[0].total_filas) : 0,
        limite: repl.limite,
        offset: repl.offset,
    };
}

// ============================================================
// Detalle
// ============================================================

async function detalle(idUsuario, idProveedor, idNegocioPedido) {
    const idNegocio = await negocioDe(idUsuario, idNegocioPedido);

    const prov = await Models.RestProveedor.findOne({
        where: { id_proveedor: idProveedor, estado: 'A' },
    });
    if (!prov) throw domainError('Proveedor no encontrado.', 'PROVEEDOR_NO_ENCONTRADO', 404);

    const vinculo = await vinculoDe(idProveedor, idNegocio);
    const nivel = nivelDeAcceso(prov, vinculo);
    // Un proveedor privado de otro negocio no es «prohibido»: no existe. Dar 403 confirmaría
    // que ese id está ocupado, que ya es más de lo que se debe contar.
    if (!nivel) throw domainError('Proveedor no encontrado.', 'PROVEEDOR_NO_ENCONTRADO', 404);

    const cats = await categoriasDe([prov.id_proveedor]);
    const ficha = proyectar(prov, { nivel, vinculo, categorias: cats.get(prov.id_proveedor) ?? [] });

    const insumos = await listarInsumosInterno(prov, idNegocio, nivel, idUsuario);

    return { ...ficha, insumos };
}

// ============================================================
// Alta y edición
// ============================================================

/** Campos de la ficha, ya limpios. Lo comparten crear y editar para no divergir. */
function camposFicha(payload) {
    return {
        nombre_comercial: texto(payload.nombre_comercial, 160),
        nombre_legal: texto(payload.nombre_legal, 160),
        identificacion: texto(payload.identificacion, 40),
        descripcion: texto(payload.descripcion, 2000),
        logo_url: texto(payload.logo_url, 255),
        persona_contacto: texto(payload.persona_contacto, 120),
        telefono: texto(payload.telefono, 40),
        whatsapp: texto(payload.whatsapp, 40),
        email: texto(payload.email, 160),
        sitio_web: texto(payload.sitio_web, 200),
        redes: redesSociales(payload.redes),
        direccion: texto(payload.direccion, 200),
        ciudad: texto(payload.ciudad, 100),
        region: texto(payload.region, 100),
        pais: texto(payload.pais, 80) || 'Colombia',
        zonas_cobertura: listaTextos(payload.zonas_cobertura),
        tipo_atencion: TIPOS_ATENCION.includes(payload.tipo_atencion) ? payload.tipo_atencion : 'AMBOS',
        pedido_minimo: Math.max(0, numero(payload.pedido_minimo, 0) ?? 0),
        dias_entrega: diasSemana(payload.dias_entrega),
        tiempo_entrega_hrs: (() => {
            const n = numero(payload.tiempo_entrega_hrs, null);
            return n == null ? null : Math.max(0, Math.round(n));
        })(),
        metodos_pago: texto(payload.metodos_pago, 200),
        precios_mayoristas: booleano(payload.precios_mayoristas),
        observaciones: texto(payload.observaciones, 2000),
    };
}

/**
 * Avisa del duplicado evidente: el mismo nombre en el mismo negocio.
 *
 * El índice único de la base ya lo impide; esto existe para que el mensaje sea «ya tienes un
 * proveedor con ese nombre» y no un error de restricción.
 */
async function asegurarNombreLibre(idNegocio, nombre, exceptoId = null, transaction = null) {
    const where = {
        id_negocio_origen: idNegocio,
        estado: 'A',
        [Op.and]: [Models.sequelize.where(
            Models.sequelize.fn('lower', Models.sequelize.col('nombre_comercial')),
            nombre.toLowerCase(),
        )],
    };
    if (exceptoId) where.id_proveedor = { [Op.ne]: exceptoId };
    if (await Models.RestProveedor.count({ where, transaction })) {
        throw domainError('Ya tienes un proveedor con ese nombre.', 'PROVEEDOR_DUPLICADO', 409);
    }
}

async function crear(idUsuario, payload = {}) {
    const idNegocio = await negocioDe(idUsuario, payload.id_negocio);
    await exigir(idUsuario, idNegocio, 'proveedores_crear', 'No tienes permiso para crear proveedores.');

    const campos = camposFicha(payload);
    if (!campos.nombre_comercial || campos.nombre_comercial.length < 2) {
        throw domainError('El nombre del proveedor es obligatorio.', 'NOMBRE_REQUERIDO', 400);
    }

    const visibilidad = VISIBILIDADES.includes(payload.visibilidad) ? payload.visibilidad : 'PRIVADO';
    if (visibilidad !== 'PRIVADO') {
        await exigir(idUsuario, idNegocio, 'proveedores_publicar',
            'No tienes permiso para publicar proveedores en el directorio.');
    }

    const idsCategoria = await resolverCategorias(payload.categorias);

    return Models.sequelize.transaction(async (t) => {
        await fijarActor(t, { idUsuario, idNegocio });
        await asegurarNombreLibre(idNegocio, campos.nombre_comercial, null, t);

        const prov = await Models.RestProveedor.create({
            ...campos,
            visibilidad,
            id_negocio_origen: idNegocio,
            id_usuario_creacion: idUsuario,
        }, { transaction: t });

        if (idsCategoria.length) {
            await Models.RestProveedorCategoria.bulkCreate(
                idsCategoria.map((id) => ({ id_proveedor: prov.id_proveedor, id_categoria_prov: id })),
                { transaction: t, ignoreDuplicates: true },
            );
        }

        // Quien lo crea queda vinculado y propietario. Sin esta fila el proveedor no saldría
        // en «Mis proveedores» ni siquiera para quien acaba de registrarlo.
        await Models.RestProveedorNegocio.create({
            id_proveedor: prov.id_proveedor,
            id_negocio: idNegocio,
            es_propietario: true,
            estado_interno: 'ACTIVO',
        }, { transaction: t });

        await Audit.registrarEvento({
            modulo: 'proveedores',
            accion: 'proveedor_creado',
            idUsuario,
            idNegocio,
            detalle: { id_proveedor: prov.id_proveedor, nombre: prov.nombre_comercial, visibilidad },
            transaction: t,
        });

        return detalleEnTransaccion(prov.id_proveedor, idNegocio, idUsuario, t);
    });
}

/** El detalle recién escrito, leído dentro de la misma transacción para devolverlo coherente. */
async function detalleEnTransaccion(idProveedor, idNegocio, idUsuario, t) {
    const prov = await Models.RestProveedor.findByPk(idProveedor, { transaction: t });
    const vinculo = await vinculoDe(idProveedor, idNegocio, t);
    const cats = await Models.sequelize.query(`
        SELECT c.id_categoria_prov, c.codigo, c.nombre, c.icono
          FROM restaurante.rest_proveedor_categoria pc
          JOIN restaurante.rest_proveedor_categoria_cat c ON c.id_categoria_prov = pc.id_categoria_prov
         WHERE pc.id_proveedor = :id ORDER BY c.orden;
    `, { replacements: { id: idProveedor }, type: QueryTypes.SELECT, transaction: t });

    return proyectar(prov, { nivel: nivelDeAcceso(prov, vinculo), vinculo, categorias: cats });
}

async function editar(idUsuario, idProveedor, payload = {}) {
    const idNegocio = await negocioDe(idUsuario, payload.id_negocio);
    await exigir(idUsuario, idNegocio, 'proveedores_editar', 'No tienes permiso para editar proveedores.');

    const campos = camposFicha(payload);
    if (!campos.nombre_comercial || campos.nombre_comercial.length < 2) {
        throw domainError('El nombre del proveedor es obligatorio.', 'NOMBRE_REQUERIDO', 400);
    }

    const idsCategoria = await resolverCategorias(payload.categorias);

    return Models.sequelize.transaction(async (t) => {
        await fijarActor(t, { idUsuario, idNegocio });

        const prov = await Models.RestProveedor.findOne({
            where: { id_proveedor: idProveedor, estado: 'A' },
            transaction: t,
            lock: t.LOCK.UPDATE,
        });
        if (!prov) throw domainError('Proveedor no encontrado.', 'PROVEEDOR_NO_ENCONTRADO', 404);

        // La ficha la edita SOLO quien la creó. Otro negocio que lo tenga vinculado puede
        // cambiar lo suyo (notas, precios, estado interno) pero no el nombre ni el teléfono
        // que ven los demás: sería editar el directorio de todos.
        if (prov.id_negocio_origen !== idNegocio) {
            throw domainError(
                'Este proveedor lo publicó otro negocio: solo puedes editar tus propios datos.',
                'PROVEEDOR_AJENO', 403,
            );
        }

        await asegurarNombreLibre(idNegocio, campos.nombre_comercial, idProveedor, t);

        await prov.update({ ...campos, fecha_actualizacion: new Date() }, { transaction: t });

        // Las categorías se reemplazan enteras: es una lista corta y cerrada, y un diff aquí
        // sería más código del que ahorra.
        await Models.RestProveedorCategoria.destroy({
            where: { id_proveedor: idProveedor }, transaction: t,
        });
        if (idsCategoria.length) {
            await Models.RestProveedorCategoria.bulkCreate(
                idsCategoria.map((id) => ({ id_proveedor: idProveedor, id_categoria_prov: id })),
                { transaction: t, ignoreDuplicates: true },
            );
        }

        return detalleEnTransaccion(idProveedor, idNegocio, idUsuario, t);
    });
}

// ============================================================
// Visibilidad, archivado y vínculo
// ============================================================

async function cambiarVisibilidad(idUsuario, idProveedor, { id_negocio, visibilidad }) {
    const idNegocio = await negocioDe(idUsuario, id_negocio);
    await exigir(idUsuario, idNegocio, 'proveedores_publicar',
        'No tienes permiso para cambiar la visibilidad de un proveedor.');

    if (!VISIBILIDADES.includes(visibilidad)) {
        throw domainError('Visibilidad inválida.', 'VISIBILIDAD_INVALIDA', 400);
    }

    return Models.sequelize.transaction(async (t) => {
        await fijarActor(t, { idUsuario, idNegocio });
        const prov = await Models.RestProveedor.findOne({
            where: { id_proveedor: idProveedor, estado: 'A' },
            transaction: t,
            lock: t.LOCK.UPDATE,
        });
        if (!prov) throw domainError('Proveedor no encontrado.', 'PROVEEDOR_NO_ENCONTRADO', 404);
        if (prov.id_negocio_origen !== idNegocio) {
            throw domainError('Solo el negocio que publicó el proveedor puede cambiar su visibilidad.',
                'PROVEEDOR_AJENO', 403);
        }

        const anterior = prov.visibilidad;
        await prov.update({ visibilidad, fecha_actualizacion: new Date() }, { transaction: t });

        await Audit.registrarEvento({
            modulo: 'proveedores',
            accion: 'visibilidad_cambiada',
            idUsuario,
            idNegocio,
            detalle: { id_proveedor: idProveedor, de: anterior, a: visibilidad },
            transaction: t,
        });

        return { id_proveedor: idProveedor, visibilidad };
    });
}

/**
 * Archivar / desarchivar. Es un estado de ESTE negocio y no toca a los demás: el proveedor
 * sigue en el directorio y en «Mis proveedores» de quien lo tenga.
 */
async function archivar(idUsuario, idProveedor, { id_negocio, archivado = true }) {
    const idNegocio = await negocioDe(idUsuario, id_negocio);
    await exigir(idUsuario, idNegocio, 'proveedores_archivar',
        'No tienes permiso para archivar proveedores.');

    return Models.sequelize.transaction(async (t) => {
        await fijarActor(t, { idUsuario, idNegocio });
        const vinculo = await vinculoDe(idProveedor, idNegocio, t);
        if (!vinculo) throw domainError('No tienes este proveedor en tu lista.', 'SIN_VINCULO', 404);

        const estado_interno = archivado ? 'ARCHIVADO' : 'ACTIVO';
        await vinculo.update({ estado_interno, fecha_actualizacion: new Date() }, { transaction: t });
        return { id_proveedor: idProveedor, estado_interno };
    });
}

/** Agregar a «Mis proveedores» uno que se encontró en el directorio. */
async function vincular(idUsuario, idProveedor, { id_negocio }) {
    const idNegocio = await negocioDe(idUsuario, id_negocio);
    await exigir(idUsuario, idNegocio, 'proveedores_crear',
        'No tienes permiso para agregar proveedores.');

    return Models.sequelize.transaction(async (t) => {
        await fijarActor(t, { idUsuario, idNegocio });
        const prov = await Models.RestProveedor.findOne({
            where: { id_proveedor: idProveedor, estado: 'A' },
            transaction: t,
        });
        if (!prov) throw domainError('Proveedor no encontrado.', 'PROVEEDOR_NO_ENCONTRADO', 404);
        // Solo se puede agregar lo que su dueño publicó. Un privado ajeno no existe.
        if (!VISIBLES_EN_DIRECTORIO.includes(prov.visibilidad)) {
            throw domainError('Proveedor no encontrado.', 'PROVEEDOR_NO_ENCONTRADO', 404);
        }

        const existente = await vinculoDe(idProveedor, idNegocio, t);
        if (existente) {
            // Reaparecer un archivado es lo que quiere quien pulsa «agregar» otra vez.
            if (existente.estado_interno !== 'ACTIVO') {
                await existente.update({ estado_interno: 'ACTIVO' }, { transaction: t });
            }
            return { id_proveedor: idProveedor, ya_estaba: true };
        }

        await Models.RestProveedorNegocio.create({
            id_proveedor: idProveedor,
            id_negocio: idNegocio,
            es_propietario: false,
            estado_interno: 'ACTIVO',
        }, { transaction: t });

        await Audit.registrarEvento({
            modulo: 'proveedores',
            accion: 'proveedor_vinculado',
            idUsuario,
            idNegocio,
            detalle: { id_proveedor: idProveedor },
            transaction: t,
        });

        return { id_proveedor: idProveedor, ya_estaba: false };
    });
}

/** Notas, condiciones y calificación: lo privado del negocio sobre este proveedor. */
async function guardarPrivado(idUsuario, idProveedor, { id_negocio, notas, condiciones, calificacion }) {
    const idNegocio = await negocioDe(idUsuario, id_negocio);
    await exigir(idUsuario, idNegocio, 'proveedores_editar', 'No tienes permiso para editar proveedores.');

    return Models.sequelize.transaction(async (t) => {
        await fijarActor(t, { idUsuario, idNegocio });
        const vinculo = await vinculoDe(idProveedor, idNegocio, t);
        if (!vinculo) throw domainError('No tienes este proveedor en tu lista.', 'SIN_VINCULO', 404);

        const cal = numero(calificacion, null);
        await vinculo.update({
            notas: notas === undefined ? vinculo.notas : texto(notas, 4000),
            condiciones: condiciones === undefined ? vinculo.condiciones : texto(condiciones, 4000),
            calificacion: calificacion === undefined
                ? vinculo.calificacion
                : (cal == null ? null : Math.min(5, Math.max(1, Math.round(cal)))),
            fecha_actualizacion: new Date(),
        }, { transaction: t });

        return {
            id_proveedor: idProveedor,
            notas: vinculo.notas,
            condiciones_propias: vinculo.condiciones,
            calificacion: vinculo.calificacion,
        };
    });
}

/**
 * «Esta información está mal».
 *
 * No hay tabla de reportes y no hace falta: `auditoria.audit_evento` ya es el registro de
 * eventos de aplicación del sistema, lo consulta la vista de super-admin y está particionado
 * y con retención. Una tabla nueva sería un segundo sitio donde mirar.
 */
async function reportar(idUsuario, idProveedor, { id_negocio, motivo }) {
    const idNegocio = await negocioDe(idUsuario, id_negocio);

    const prov = await Models.RestProveedor.findOne({
        where: { id_proveedor: idProveedor, estado: 'A' },
        attributes: ['id_proveedor', 'nombre_comercial', 'visibilidad'],
    });
    if (!prov) throw domainError('Proveedor no encontrado.', 'PROVEEDOR_NO_ENCONTRADO', 404);

    const detalleMotivo = texto(motivo, 500);
    if (!detalleMotivo) throw domainError('Cuéntanos qué está mal.', 'MOTIVO_REQUERIDO', 400);

    await Audit.registrarEvento({
        modulo: 'proveedores',
        accion: 'reporte_directorio',
        idUsuario,
        idNegocio,
        detalle: {
            id_proveedor: idProveedor,
            nombre: prov.nombre_comercial,
            motivo: detalleMotivo,
        },
    });

    return { id_proveedor: idProveedor, reportado: true };
}

// ============================================================
// Insumos ofrecidos
// ============================================================

/**
 * Los insumos que ESTE negocio puede ver de ESTE proveedor.
 *
 * La condición de abajo es la frontera de privacidad del módulo: o la fila es mía, o su dueño
 * la publicó Y la ficha está en visibilidad DIRECTORIO. Nunca una de las dos sola.
 */
async function listarInsumosInterno(prov, idNegocio, nivel, idUsuario) {
    const verPrecios = nivel === 'propio'
        ? await puedeVerPrecios(idUsuario, idNegocio)
        : nivel === 'completo';

    const filas = await Models.sequelize.query(`
        SELECT i.*, c.nombre AS categoria_nombre, g.nombre AS ingrediente_nombre
          FROM restaurante.rest_proveedor_insumo i
          LEFT JOIN restaurante.rest_proveedor_categoria_cat c
                 ON c.id_categoria_prov = i.id_categoria_prov
          LEFT JOIN restaurante.carta_ingrediente g
                 ON g.id_ingrediente = i.id_ingrediente
         WHERE i.id_proveedor = :idProveedor
           AND i.estado = 'A'
           AND (i.id_negocio = :idNegocio OR (i.publico AND :visibilidad = 'DIRECTORIO'))
         ORDER BY i.nombre;
    `, {
        replacements: { idProveedor: prov.id_proveedor, idNegocio, visibilidad: prov.visibilidad },
        type: QueryTypes.SELECT,
    });

    return filas.map((f) => {
        const propio = Number(f.id_negocio) === Number(idNegocio);
        return proyectarInsumo(f, { conPrecio: propio ? verPrecios : verPrecios && f.publico, propio });
    });
}

async function listarInsumos(idUsuario, idProveedor, idNegocioPedido) {
    const idNegocio = await negocioDe(idUsuario, idNegocioPedido);
    const prov = await Models.RestProveedor.findOne({
        where: { id_proveedor: idProveedor, estado: 'A' },
    });
    if (!prov) throw domainError('Proveedor no encontrado.', 'PROVEEDOR_NO_ENCONTRADO', 404);

    const vinculo = await vinculoDe(idProveedor, idNegocio);
    const nivel = nivelDeAcceso(prov, vinculo);
    if (!nivel) throw domainError('Proveedor no encontrado.', 'PROVEEDOR_NO_ENCONTRADO', 404);

    return listarInsumosInterno(prov, idNegocio, nivel, idUsuario);
}

function camposInsumo(payload) {
    return {
        nombre: texto(payload.nombre, 160),
        unidad: unidadValida(payload.unidad),
        presentacion: texto(payload.presentacion, 80),
        cantidad_presentacion: (() => {
            const n = numero(payload.cantidad_presentacion, null);
            return n == null || n <= 0 ? null : n;
        })(),
        precio: (() => {
            const n = numero(payload.precio, null);
            return n == null ? null : Math.max(0, n);
        })(),
        moneda: (texto(payload.moneda, 3) || 'COP').toUpperCase(),
        publico: booleano(payload.publico),
        disponible: booleano(payload.disponible, true),
        marca: texto(payload.marca, 80),
        codigo_proveedor: texto(payload.codigo_proveedor, 60),
        notas: texto(payload.notas, 2000),
    };
}

/** El ingrediente del inventario tiene que ser de ESTE negocio o no se ata. */
async function validarIngrediente(idIngrediente, idNegocio, transaction) {
    if (idIngrediente == null) return null;
    const ing = await Models.CartaIngrediente.findOne({
        where: { id_ingrediente: Number(idIngrediente), id_negocio: idNegocio, estado: 'A' },
        transaction,
    });
    if (!ing) throw domainError('El insumo del inventario no existe.', 'INGREDIENTE_NO_ENCONTRADO', 404);
    return ing;
}

async function crearInsumo(idUsuario, idProveedor, payload = {}) {
    const idNegocio = await negocioDe(idUsuario, payload.id_negocio);
    await exigir(idUsuario, idNegocio, 'proveedores_editar', 'No tienes permiso para editar proveedores.');

    const campos = camposInsumo(payload);
    if (!campos.nombre) throw domainError('El nombre del insumo es obligatorio.', 'NOMBRE_REQUERIDO', 400);

    const [idCategoria] = await resolverCategorias(
        payload.id_categoria_prov != null ? [payload.id_categoria_prov] : [],
    );

    return Models.sequelize.transaction(async (t) => {
        await fijarActor(t, { idUsuario, idNegocio });

        const prov = await Models.RestProveedor.findOne({
            where: { id_proveedor: idProveedor, estado: 'A' }, transaction: t,
        });
        if (!prov) throw domainError('Proveedor no encontrado.', 'PROVEEDOR_NO_ENCONTRADO', 404);
        const vinculo = await vinculoDe(idProveedor, idNegocio, t);
        if (!vinculo) throw domainError('Agrega el proveedor a tu lista antes de cargarle insumos.',
            'SIN_VINCULO', 409);

        if (campos.publico) {
            await exigir(idUsuario, idNegocio, 'proveedores_publicar',
                'No tienes permiso para publicar precios en el directorio.');
        }

        await validarIngrediente(payload.id_ingrediente, idNegocio, t);

        const insumo = await Models.RestProveedorInsumo.create({
            ...campos,
            id_proveedor: idProveedor,
            id_negocio: idNegocio,
            id_categoria_prov: idCategoria ?? null,
            id_ingrediente: payload.id_ingrediente == null ? null : Number(payload.id_ingrediente),
            fecha_precio: campos.precio == null ? null : (texto(payload.fecha_precio, 10) || hoyBogota()),
        }, { transaction: t });

        if (campos.precio != null) {
            await registrarPrecio(insumo, { idNegocio, idUsuario, precio: campos.precio, transaction: t });
        }

        return insumo.get({ plain: true });
    });
}

async function editarInsumo(idUsuario, idInsumo, payload = {}) {
    const idNegocio = await negocioDe(idUsuario, payload.id_negocio);
    await exigir(idUsuario, idNegocio, 'proveedores_editar', 'No tienes permiso para editar proveedores.');

    const campos = camposInsumo(payload);
    if (!campos.nombre) throw domainError('El nombre del insumo es obligatorio.', 'NOMBRE_REQUERIDO', 400);

    const [idCategoria] = await resolverCategorias(
        payload.id_categoria_prov != null ? [payload.id_categoria_prov] : [],
    );

    return Models.sequelize.transaction(async (t) => {
        await fijarActor(t, { idUsuario, idNegocio });

        // El negocio va EN la búsqueda: un insumo de otro negocio no existe para este.
        const insumo = await Models.RestProveedorInsumo.findOne({
            where: { id_proveedor_insumo: idInsumo, id_negocio: idNegocio, estado: 'A' },
            transaction: t,
            lock: t.LOCK.UPDATE,
        });
        if (!insumo) throw domainError('Insumo no encontrado.', 'INSUMO_NO_ENCONTRADO', 404);

        if (campos.publico && !insumo.publico) {
            await exigir(idUsuario, idNegocio, 'proveedores_publicar',
                'No tienes permiso para publicar precios en el directorio.');
        }

        await validarIngrediente(payload.id_ingrediente, idNegocio, t);

        const precioAnterior = insumo.precio == null ? null : Number(insumo.precio);
        const cambioPrecio = campos.precio != null && campos.precio !== precioAnterior;

        await insumo.update({
            ...campos,
            id_categoria_prov: idCategoria ?? null,
            id_ingrediente: payload.id_ingrediente == null ? null : Number(payload.id_ingrediente),
            // La fecha del precio solo se mueve cuando el precio se mueve: si no, un simple
            // cambio de marca haría parecer que el precio se revisó hoy.
            fecha_precio: cambioPrecio
                ? (texto(payload.fecha_precio, 10) || hoyBogota())
                : insumo.fecha_precio,
            fecha_actualizacion: new Date(),
        }, { transaction: t });

        if (cambioPrecio) {
            await registrarPrecio(insumo, { idNegocio, idUsuario, precio: campos.precio, transaction: t });
        }

        return insumo.get({ plain: true });
    });
}

async function eliminarInsumo(idUsuario, idInsumo, idNegocioPedido) {
    const idNegocio = await negocioDe(idUsuario, idNegocioPedido);
    await exigir(idUsuario, idNegocio, 'proveedores_editar', 'No tienes permiso para editar proveedores.');

    return Models.sequelize.transaction(async (t) => {
        await fijarActor(t, { idUsuario, idNegocio });
        // Baja lógica: hay compras que lo referencian y su historial tiene que seguir legible.
        const [n] = await Models.RestProveedorInsumo.update(
            { estado: 'E', fecha_actualizacion: new Date() },
            { where: { id_proveedor_insumo: idInsumo, id_negocio: idNegocio, estado: 'A' }, transaction: t },
        );
        if (!n) throw domainError('Insumo no encontrado.', 'INSUMO_NO_ENCONTRADO', 404);
        return { id_proveedor_insumo: idInsumo };
    });
}

/** Escribe una fila en el histórico. Append-only: nunca se actualiza una existente. */
async function registrarPrecio(insumo, { idNegocio, idUsuario, precio, origen = 'MANUAL', idCompra = null, transaction }) {
    return Models.RestProveedorPrecio.create({
        id_proveedor_insumo: insumo.id_proveedor_insumo ?? insumo,
        id_negocio: idNegocio,
        precio,
        moneda: insumo.moneda ?? 'COP',
        origen,
        id_compra: idCompra,
        id_usuario: idUsuario,
    }, { transaction });
}

async function historicoPrecios(idUsuario, idInsumo, idNegocioPedido) {
    const idNegocio = await negocioDe(idUsuario, idNegocioPedido);
    await exigir(idUsuario, idNegocio, 'proveedores_precios',
        'No tienes permiso para consultar precios.');

    const insumo = await Models.RestProveedorInsumo.findOne({
        where: { id_proveedor_insumo: idInsumo, id_negocio: idNegocio },
    });
    if (!insumo) throw domainError('Insumo no encontrado.', 'INSUMO_NO_ENCONTRADO', 404);

    const filas = await Models.sequelize.query(`
        SELECT h.id_precio, h.precio, h.moneda, h.origen, h.id_compra, h.fecha,
               u.primer_nombre, u.primer_apellido
          FROM restaurante.rest_proveedor_precio h
          LEFT JOIN general.gener_usuario u ON u.id_usuario = h.id_usuario
         WHERE h.id_proveedor_insumo = :id AND h.id_negocio = :idNegocio
         ORDER BY h.fecha DESC
         LIMIT 200;
    `, { replacements: { id: idInsumo, idNegocio }, type: QueryTypes.SELECT });

    return filas.map((f) => ({
        id_precio: f.id_precio,
        precio: Number(f.precio),
        moneda: f.moneda,
        origen: f.origen,
        id_compra: f.id_compra,
        fecha: f.fecha,
        usuario: [f.primer_nombre, f.primer_apellido].filter(Boolean).join(' ') || null,
    }));
}

// ============================================================
// Comparador de precios
// ============================================================

/**
 * El precio llevado a una unidad base comparable, o `null` si no se puede.
 *
 * Nunca inventa: si no se sabe cuánto trae la presentación, se asume 1 y se marca
 * `estimado`, que es lo que la pantalla usa para avisar en vez de presentar una cifra falsa
 * como si fuera un hecho.
 */
function normalizarPrecio({ precio, unidad, cantidad_presentacion }) {
    if (precio == null) return { precio_base: null, unidad_base: null, estimado: false };
    const u = UNIDAD_BASE[unidad] || UNIDAD_BASE.UN;
    const cantidad = cantidad_presentacion == null ? 1 : Number(cantidad_presentacion);
    const contenido = cantidad * u.factor;
    if (!(contenido > 0)) return { precio_base: null, unidad_base: u.base, estimado: true };
    return {
        precio_base: Number(precio) / contenido,
        unidad_base: u.base,
        estimado: cantidad_presentacion == null,
    };
}

function diasDesde(fecha) {
    if (!fecha) return null;
    const d = new Date(fecha);
    if (Number.isNaN(d.getTime())) return null;
    return Math.floor((Date.now() - d.getTime()) / 86_400_000);
}

/**
 * Compara un insumo entre proveedores.
 *
 * Entran dos clases de oferta y se distinguen siempre:
 *   PRIVADA → mis propias filas (mi precio negociado con ese proveedor).
 *   PUBLICA → lo que otro negocio publicó, que es un **precio de referencia**, no una oferta.
 *
 * Las advertencias (`unidades_mixtas`, `fechas_dispares`, `estimado`) no son decoración: una
 * caja de 12 contra una unidad, o un precio de hace ocho meses contra uno de ayer, dan una
 * comparación que parece correcta y no lo es.
 */
async function comparar(idUsuario, { idNegocio: idNegocioPedido, busqueda, idIngrediente = null } = {}) {
    const idNegocio = await negocioDe(idUsuario, idNegocioPedido);
    await exigir(idUsuario, idNegocio, 'proveedores_precios',
        'No tienes permiso para comparar precios.');

    const q = texto(busqueda, 120);
    if (!q && !idIngrediente) {
        throw domainError('Escribe qué insumo quieres comparar.', 'BUSQUEDA_REQUERIDA', 400);
    }

    const condiciones = [
        "i.estado = 'A'",
        "p.estado = 'A'",
        // La frontera de privacidad otra vez: lo mío, o lo que otro publicó con precio.
        "(i.id_negocio = :idNegocio OR (i.publico AND p.visibilidad = 'DIRECTORIO'))",
    ];
    const repl = { idNegocio };

    if (idIngrediente) {
        // Comparar por ingrediente del inventario solo tiene sentido dentro del negocio: el
        // id del insumo de mi inventario no significa nada en la fila de otro.
        condiciones.push('i.id_ingrediente = :idIngrediente AND i.id_negocio = :idNegocio');
        repl.idIngrediente = Number(idIngrediente);
    } else {
        condiciones.push('i.nombre ILIKE :q');
        repl.q = `%${q}%`;
    }

    const filas = await Models.sequelize.query(`
        SELECT i.id_proveedor_insumo, i.id_proveedor, i.id_negocio, i.nombre, i.unidad,
               i.presentacion, i.cantidad_presentacion, i.precio, i.moneda, i.fecha_precio,
               i.disponible, i.marca, i.publico, i.id_ingrediente,
               p.nombre_comercial, p.ciudad, p.visibilidad,
               (v.id_proveedor_negocio IS NOT NULL) AS vinculado
          FROM restaurante.rest_proveedor_insumo i
          JOIN restaurante.rest_proveedor p ON p.id_proveedor = i.id_proveedor
          LEFT JOIN restaurante.rest_proveedor_negocio v
                 ON v.id_proveedor = p.id_proveedor AND v.id_negocio = :idNegocio
         WHERE ${condiciones.join(' AND ')}
           AND i.precio IS NOT NULL
         ORDER BY i.nombre, p.nombre_comercial
         LIMIT 200;
    `, { replacements: repl, type: QueryTypes.SELECT });

    // Se agrupa por NOMBRE normalizado: «Pechuga de pollo» y «pechuga de pollo » son lo mismo
    // para quien compara, y partirlos en dos grupos no ayuda a nadie.
    //
    // Cuando la búsqueda es por insumo del inventario, todo cae en un solo grupo: ahí el
    // criterio lo puso la consulta y agrupar otra vez por nombre volvería a separar «Arroz
    // Diana» de «arroz blanco» cuando el usuario ya dijo que son su mismo insumo.
    const grupos = new Map();
    for (const f of filas) {
        const propio = Number(f.id_negocio) === Number(idNegocio);
        const clave = idIngrediente
            ? `ing:${idIngrediente}`
            : `nom:${f.nombre.trim().toLowerCase()}`;

        if (!grupos.has(clave)) grupos.set(clave, { insumo: f.nombre, ofertas: [] });

        const norm = normalizarPrecio({
            precio: f.precio,
            unidad: f.unidad,
            cantidad_presentacion: f.cantidad_presentacion,
        });

        grupos.get(clave).ofertas.push({
            id_proveedor_insumo: f.id_proveedor_insumo,
            id_proveedor: f.id_proveedor,
            proveedor: f.nombre_comercial,
            ciudad: f.ciudad,
            insumo: f.nombre,
            marca: f.marca,
            unidad: f.unidad,
            presentacion: f.presentacion,
            cantidad_presentacion: f.cantidad_presentacion == null ? null : Number(f.cantidad_presentacion),
            precio: Number(f.precio),
            moneda: f.moneda,
            fecha_precio: f.fecha_precio,
            dias_desde_precio: diasDesde(f.fecha_precio),
            disponible: Boolean(f.disponible),
            // De dónde sale el número, que es lo que decide cuánto se puede confiar en él.
            ambito: propio ? 'PRIVADO' : 'PUBLICO',
            es_propio: propio,
            vinculado: Boolean(f.vinculado),
            ...norm,
        });
    }

    const resultado = [];
    for (const [clave, grupo] of grupos) {
        const bases = new Set(grupo.ofertas.map((o) => o.unidad_base).filter(Boolean));
        const presentaciones = new Set(grupo.ofertas.map((o) => `${o.unidad}|${o.cantidad_presentacion ?? ''}`));
        const dias = grupo.ofertas.map((o) => o.dias_desde_precio).filter((d) => d != null);

        const comparables = grupo.ofertas.filter((o) => o.precio_base != null);
        let idMasBarato = null;
        if (bases.size === 1 && comparables.length) {
            idMasBarato = comparables.reduce((a, b) => (a.precio_base <= b.precio_base ? a : b))
                .id_proveedor_insumo;
        }

        resultado.push({
            clave,
            insumo: grupo.insumo,
            ofertas: grupo.ofertas.sort((a, b) => (a.precio_base ?? Infinity) - (b.precio_base ?? Infinity)),
            // «No se puede señalar el más barato» es una respuesta honesta y es la que se da
            // cuando hay kilos contra cajas: el frontend lo dice con todas las letras.
            id_mas_barato: idMasBarato,
            unidades_mixtas: bases.size > 1,
            presentaciones_distintas: presentaciones.size > 1,
            fechas_dispares: dias.length > 1 && (Math.max(...dias) - Math.min(...dias)) > DIAS_PRECIO_VIEJO,
            precio_mas_viejo_dias: dias.length ? Math.max(...dias) : null,
        });
    }

    return resultado.sort((a, b) => b.ofertas.length - a.ofertas.length || a.insumo.localeCompare(b.insumo));
}

/** La fecha de calendario de hoy en Bogotá, 'YYYY-MM-DD'. */
function hoyBogota() {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota' }).format(new Date());
}

module.exports = {
    // catálogo
    listarCategorias,
    // proveedores
    listar,
    detalle,
    crear,
    editar,
    cambiarVisibilidad,
    archivar,
    vincular,
    guardarPrivado,
    reportar,
    // insumos
    listarInsumos,
    crearInsumo,
    editarInsumo,
    eliminarInsumo,
    historicoPrecios,
    // comparador
    comparar,
    // compartido con compraService
    negocioDe,
    exigir,
    puedeVerPrecios,
    registrarPrecio,
    domainError,
    hoyBogota,
    UNIDADES,
    VISIBILIDADES,
};
