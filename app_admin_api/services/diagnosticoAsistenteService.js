/**
 * Diagnóstico a fondo: ¿está la CARTA lista para que el asistente la entienda?
 *
 * ## Por qué existe (2026-10-05)
 *
 * `preparacionAsistenteService` revisa que las cosas EXISTAN (hay horario, hay carta…). Zona Burger
 * la pasaba entera y aun así el asistente tropezaba cada noche: una gaseosa que se llamaba «cuatro»,
 * una Cigarra a $1, la «familiar» con tres sabores en la descripción, el tamaño pequeño sin decir
 * que era pequeño. Encontrarlo costó tres auditorías a mano y dinero en llamadas al modelo. Todo eso
 * se puede revisar ANTES de encender WhatsApp, y casi todo sin IA.
 *
 * Dos capas, las dos deterministas (la capa con IA —redactar las recomendaciones— es la fase 2):
 *   1. `analizarCarta`   — reglas sobre los nombres, precios y descripciones. Pura: no toca la base.
 *   2. `pruebaDeHumo`    — se le pregunta al buscador del asistente como pregunta un cliente
 *                          («gaseosa personal», «perro caliente», «viciosa pequeña») y se mira si
 *                          encuentra algo. Es la misma `buscar_producto` que usa el modelo.
 *
 * Es bajo demanda (un botón): la prueba de humo hace decenas de búsquedas y no puede correr cada
 * vez que se abre la Bandeja, que es donde vive la revisión ligera.
 *
 * Cada hallazgo dice QUÉ pasa, POR QUÉ le importa al cliente y DÓNDE se arregla, con los productos
 * concretos. Nada se cambia solo: es una lista para que una persona decida.
 */
'use strict';

const Models = require('../../app_core/models/conection');
const contextoNegocio = require('../../intelligence/core/contextoNegocio');

const sequelize = Models.sequelize;
const SELECT = { type: sequelize.QueryTypes.SELECT };

const MENU = 'App del restaurante → Menú';
const MAX_DETALLES = 12;

/** Sin tildes, en minúsculas, sin signos. */
function plano(texto) {
    return String(texto || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9ñ\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}
const palabras = (texto) => plano(texto).split(' ').filter(Boolean);

/** Palabras que dicen un tamaño MAYOR que el básico, y las del básico. */
const TAMANO_MAYOR = new Set(['mediana', 'mediano', 'grande', 'grandes', 'familiar', 'doble', 'dobles', 'xl', 'jumbo', 'gigante', 'pareja']);
const TAMANO_BASICO = new Set(['pequena', 'pequeno', 'personal', 'sencilla', 'sencillo', 'individual', 'chica', 'chico']);
const esTamano = (w) => TAMANO_MAYOR.has(w) || TAMANO_BASICO.has(w);
/** Nombres de una palabra que se explican solos: «Agua» no necesita apellido. */
const SE_EXPLICA_SOLO = new Set(['agua', 'cerveza', 'limonada', 'cafe', 'tinto', 'aromatica', 'leche', 'michelada', 'chocolate', 'helado']);

const enPesos = (v) => `$${Number(v).toLocaleString('es-CO')}`;
const lista = (nombres) => nombres.map((n) => `«${n}»`).join(', ');

/**
 * Capa 1: lo que se ve mirando la carta. Pura, para poder probarla sin base.
 *
 * @param {Array<{nombre, visible, productos: Array<{nombre, descripcion, precio, visible, disponible}>}>} categorias
 * @returns {Array<{clave, titulo, estado, por_que, donde, detalles: string[]}>}
 */
function analizarCarta(categorias) {
    const hallazgos = [];
    const agregar = (clave, titulo, estado, porQue, detalles) => {
        if (detalles.length === 0) return;
        hallazgos.push({
            clave, titulo, estado, por_que: porQue, donde: MENU,
            total: detalles.length,
            detalles: detalles.slice(0, MAX_DETALLES),
        });
    };

    // Solo lo que el cliente ve: categorías y productos visibles (EMPAQUES, lo oculto… fuera).
    const visibles = (categorias || [])
        .filter((c) => c.visible !== false)
        .map((c) => ({ ...c, productos: (c.productos || []).filter((p) => p.visible !== false) }));
    const todos = visibles.flatMap((c) => c.productos.map((p) => ({ ...p, categoria: c.nombre })));

    // 1. Precios que no pueden ser.
    agregar(
        'carta_precios',
        'Precios que parecen un error',
        'falta',
        'El asistente cobra lo que dice la carta: un producto a $1 se vende a $1.',
        todos.filter((p) => !(Number(p.precio) > 100)).map((p) => `«${p.nombre}» vale ${enPesos(p.precio || 0)}`)
    );

    // 2. Unidades mal escritas («1.5 ml»).
    agregar(
        'carta_unidades',
        'Tamaños con la unidad mal escrita',
        'recomendado',
        'El asistente repite el nombre tal cual: «1.5 ml» en vez de «1,5 L» confunde al cliente.',
        todos.filter((p) => /\d+[.,]\d+\s*ml\b/i.test(p.nombre)).map((p) => `«${p.nombre}»`)
    );

    // 3. El tamaño pequeño que no dice que es pequeño.
    const sinTamano = [];
    for (const c of visibles) {
        const familias = new Map(); // base → nombres con tamaño mayor
        for (const p of c.productos) {
            const w = palabras(p.nombre);
            if (!w.some((x) => TAMANO_MAYOR.has(x))) continue;
            const base = w.filter((x) => !esTamano(x)).join(' ');
            if (!base) continue;
            familias.set(base, [...(familias.get(base) || []), p.nombre]);
        }
        for (const p of c.productos) {
            const w = palabras(p.nombre);
            if (w.some(esTamano)) continue;
            const hermanos = familias.get(w.join(' '));
            if (hermanos) sinTamano.push(`«${p.nombre}» no dice su tamaño (existen ${lista(hermanos)})`);
        }
    }
    agregar(
        'carta_tamanos',
        'Productos que no dicen su tamaño',
        'recomendado',
        'Los clientes piden «pequeña» o «personal». Si el nombre no lo dice, el asistente tiene que adivinar o preguntar de más.',
        sinTamano
    );

    // 4. Varios sabores dentro de una descripción.
    agregar(
        'carta_sabores',
        'Un solo producto con varios sabores',
        'recomendado',
        'El sabor que pide el cliente llega a cocina como una nota. Mejor un producto por sabor.',
        todos
            .filter((p) => /\bsabor(es)?\b/i.test(p.descripcion || '') && /,|\so\s/.test(p.descripcion || ''))
            .map((p) => `«${p.nombre}»: ${String(p.descripcion).slice(0, 90)}`)
    );

    // 5. Nombres de una palabra que no dicen qué son (y sin descripción que lo aclare).
    const noDiceQueEs = [];
    for (const c of visibles) {
        const deLaCategoria = palabras(c.nombre);
        for (const p of c.productos) {
            const w = palabras(p.nombre).filter((x) => !esTamano(x) && !/^\d/.test(x));
            if (w.length !== 1 || String(p.descripcion || '').trim() || SE_EXPLICA_SOLO.has(w[0])) continue;
            // «michelada» en MICHELADA sí dice qué es.
            if (deLaCategoria.some((k) => k.startsWith(w[0]) || w[0].startsWith(k))) continue;
            noDiceQueEs.push(`«${p.nombre}» (en ${c.nombre})`);
        }
    }
    agregar(
        'carta_nombres',
        'Nombres que no dicen qué es el producto',
        'recomendado',
        'Si un cliente pide «una gaseosa» o «un hervido de mora», el asistente busca esas palabras: con «cuatro» o «mora» a secas no lo encuentra.',
        noDiceQueEs
    );

    // 6. Dos productos con el mismo nombre.
    const porNombre = new Map();
    for (const p of todos) porNombre.set(plano(p.nombre), [...(porNombre.get(plano(p.nombre)) || []), p]);
    agregar(
        'carta_duplicados',
        'Productos distintos con el mismo nombre',
        'recomendado',
        'El asistente no puede saber cuál quiere el cliente y pregunta, o elige el que no era.',
        [...porNombre.values()]
            .filter((g) => g.length > 1)
            .map((g) => `«${g[0].nombre}» está en ${g.map((p) => p.categoria).join(' y ')}`)
    );

    // 7. Sin descripción.
    agregar(
        'carta_descripciones',
        'Productos sin descripción',
        'recomendado',
        'Sin descripción el asistente no sabe contestar «¿qué trae?» y le pasa el chat a una persona.',
        // Una bebida embotellada se explica con su nombre («Coca-Cola 1,5 L»): pedirle descripción es ruido.
        todos
            .filter((p) => !String(p.descripcion || '').trim())
            .filter((p) => !/\b(gaseosa|bebida|cerveza|licor)/.test(plano(p.categoria)) && !/\d\s*(ml|l|lt|litro|litros)\b/.test(plano(p.nombre)))
            .map((p) => `«${p.nombre}»`)
    );

    // 8. Categorías que el cliente ve pero no tienen nada que pedir.
    agregar(
        'carta_categorias',
        'Categorías sin nada disponible',
        'recomendado',
        'El cliente pide de esa categoría y el asistente solo puede decir que no hay.',
        visibles
            .filter((c) => !c.productos.some((p) => p.disponible !== false))
            .map((c) =>
                c.productos.length === 0
                    ? `«${c.nombre}» no tiene productos`
                    : `«${c.nombre}»: sus ${c.productos.length} productos están marcados como no disponibles`
            )
    );

    return hallazgos;
}

/** «HAMBURGUESAS» → «hamburguesa»: como lo pide un cliente. */
function singular(nombreCategoria) {
    // Solo la «s» final: «carnes» → «carne», «naturales» → «naturale». El buscador casa por prefijo,
    // así que no hace falta acertar el singular exacto (y «es» → "" rompía «carnes»).
    return palabras(nombreCategoria)
        .map((w) => (w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w))
        .join(' ');
}

/** Cómo pide la gente cosas que la carta suele llamar de otra forma. Solo si el negocio las vende. */
const COMO_PIDE_LA_GENTE = [
    { frase: 'perro caliente', si: /\b(dog|perro)/ },
    { frase: 'gaseosa personal', si: /\b(gaseosa|coca|postobon|cuatro|pepsi|colombiana)/ },
    { frase: 'gaseosa grande', si: /\b(gaseosa|coca|postobon|cuatro|pepsi|colombiana)/ },
    { frase: 'jugo natural', si: /\b(jugo|limonada)/ },
    { frase: 'agua', si: /\bagua\b/ },
    { frase: 'cerveza', si: /\b(cerveza|poker|aguila|club colombia|corona)/ },
];

/**
 * Capa 2: se le pregunta al buscador del asistente como preguntaría un cliente.
 *
 * @param {Function} buscar — async (termino) => { productos: [{nombre}] }; la capacidad real.
 * @returns {Promise<{pruebas: number, fallidas: string[]}>}
 */
async function pruebaDeHumo(categorias, buscar) {
    const visibles = (categorias || []).filter((c) => c.visible !== false);
    const vendibles = (c) => (c.productos || []).filter((p) => p.visible !== false && p.disponible !== false);
    const consultas = []; // { frase, sirve(productos) , queEsperaba }

    for (const c of visibles) {
        const productos = vendibles(c);
        if (productos.length === 0) continue;
        const nombres = new Set(productos.map((p) => plano(p.nombre)));

        // La categoría, como la pide un cliente: «una hamburguesa», «una gaseosa».
        consultas.push({
            frase: singular(c.nombre),
            sirve: (r) => r.length > 0,
            esperaba: `algo de ${c.nombre}`,
        });

        for (const p of productos) {
            const w = palabras(p.nombre);
            // Cada producto por su nombre, sin tildes ni mayúsculas.
            consultas.push({ frase: plano(p.nombre), sirve: (r) => r.some((x) => plano(x.nombre) === plano(p.nombre)), esperaba: `«${p.nombre}»` });

            // Y el básico de cada familia, como se pide: «viciosa pequeña», «alitas personal».
            const base = w.filter((x) => !esTamano(x)).join(' ');
            if (!base || !w.some((x) => TAMANO_MAYOR.has(x))) continue;
            const tieneBasico = [...nombres].some((n) => {
                const wn = n.split(' ');
                return wn.filter((x) => !esTamano(x)).join(' ') === base && !wn.some((x) => TAMANO_MAYOR.has(x));
            });
            if (!tieneBasico) continue;
            for (const tamano of ['pequeña', 'personal']) {
                consultas.push({
                    frase: `${base} ${tamano}`,
                    sirve: (r) => r.some((x) => plano(x.nombre).includes(base.split(' ')[0])),
                    esperaba: `la presentación básica de «${base}»`,
                });
            }
        }
    }

    const textoDeLaCarta = visibles
        .filter((c) => vendibles(c).length > 0)
        .map((c) => `${plano(c.nombre)} ${vendibles(c).map((p) => plano(p.nombre)).join(' ')}`)
        .join(' ');
    for (const { frase, si } of COMO_PIDE_LA_GENTE) {
        if (si.test(textoDeLaCarta)) consultas.push({ frase, sirve: (r) => r.length > 0, esperaba: 'algún producto' });
    }

    // Sin repetir frases: «viciosa pequeña» sale una vez aunque la familia tenga tres tamaños.
    const unicas = [...new Map(consultas.map((c) => [c.frase, c])).values()];
    const fallidas = [];
    for (const c of unicas) {
        let productos = [];
        try {
            productos = (await buscar(c.frase))?.productos || [];
        } catch (_) {
            productos = [];
        }
        if (!c.sirve(productos)) {
            fallidas.push(
                productos.length === 0
                    ? `Si escriben «${c.frase}», el asistente no encuentra nada (debía salir ${c.esperaba})`
                    : `Si escriben «${c.frase}», no sale ${c.esperaba} (sale ${lista(productos.slice(0, 3).map((p) => p.nombre))})`
            );
        }
    }
    return { pruebas: unicas.length, fallidas };
}

/** La carta entera del negocio, también lo no disponible (lo oculto se filtra al analizar). */
async function leerCarta(idNegocio) {
    const filas = await sequelize.query(
        `SELECT c.id_categoria, c.nombre AS categoria, COALESCE(c.visible, true) AS categoria_visible, c.orden,
                p.id_producto, p.nombre, p.descripcion, p.precio,
                COALESCE(p.visible, true) AS visible, COALESCE(p.disponible, true) AS disponible
           FROM restaurante.carta_categoria c
           LEFT JOIN restaurante.carta_producto p
                  ON p.id_categoria = c.id_categoria AND p.estado = 'A'
          WHERE c.id_negocio = :idNegocio AND c.estado = 'A'
          ORDER BY c.orden, c.id_categoria, p.nombre;`,
        { replacements: { idNegocio }, ...SELECT }
    );
    const porId = new Map();
    for (const f of filas) {
        if (!porId.has(f.id_categoria)) {
            porId.set(f.id_categoria, { nombre: f.categoria, visible: f.categoria_visible, productos: [] });
        }
        if (f.id_producto) {
            porId.get(f.id_categoria).productos.push({
                nombre: f.nombre, descripcion: f.descripcion, precio: f.precio, visible: f.visible, disponible: f.disponible,
            });
        }
    }
    return [...porId.values()];
}

/** Lo que el asistente necesita del negocio para no rechazar pedidos (no es de la carta). */
async function revisarOperacion(idNegocio) {
    const hallazgos = [];
    try {
        const pedidoService = require('../../app_restaurante_api/services/pedidoService');
        const domiciliarios = await pedidoService.listarDomiciliarios(idNegocio);
        if (domiciliarios.length === 0) {
            hallazgos.push({
                clave: 'operacion_domiciliarios',
                titulo: 'No hay ningún domiciliario registrado',
                estado: 'falta',
                por_que: 'Sin domiciliario el asistente rechaza todos los pedidos a domicilio («llama al restaurante»).',
                donde: 'App del restaurante → Usuarios (rol Domiciliario), o Configuración → domicilio con personal propio',
                total: 1,
                detalles: [],
            });
        }
    } catch (error) {
        console.warn(`[diagnostico] domiciliarios del negocio ${idNegocio}: ${error.message}`);
    }
    try {
        const [mesas] = await sequelize.query(
            `SELECT count(*)::int AS n FROM restaurante.rest_mesa WHERE id_negocio = :idNegocio AND estado = 'A';`,
            { replacements: { idNegocio }, ...SELECT }
        );
        if (mesas.n === 0) {
            hallazgos.push({
                clave: 'operacion_mesas',
                titulo: 'No hay mesas creadas',
                estado: 'recomendado',
                por_que: 'Cuando un cliente pide «para servir» el asistente le guarda una mesa; sin mesas solo puede ofrecer «para recoger».',
                donde: 'App del restaurante → Mesas',
                total: 1,
                detalles: [],
            });
        }
    } catch (error) {
        console.warn(`[diagnostico] mesas del negocio ${idNegocio}: ${error.message}`);
    }
    return hallazgos;
}

/**
 * El diagnóstico completo de un negocio. Hoy cubre la vertical de restaurante; las demás devuelven
 * la lista vacía con `aplica: false` (la revisión ligera sí las cubre).
 */
async function diagnosticar(idNegocio, { buscar = null } = {}) {
    const tipo = (await contextoNegocio.obtener(idNegocio))?.tipoNegocio || null;
    const base = { tipo, generado_en: new Date().toISOString() };
    if (tipo !== 'RESTAURANTE') {
        return { ...base, aplica: false, hallazgos: [], pruebas: { total: 0, fallidas: 0 }, criticos: 0, pendientes: 0 };
    }

    const categorias = await leerCarta(idNegocio);
    const hallazgos = [...analizarCarta(categorias), ...(await revisarOperacion(idNegocio))];

    // La prueba de humo usa la MISMA búsqueda que el modelo. Si el asistente no está montado en
    // este proceso (tests, un script), el diagnóstico sale sin ella en vez de fallar.
    let buscador = buscar;
    if (!buscador) {
        try {
            const capacidad = require('../../intelligence/core/registry').obtener('buscar_producto');
            if (capacidad) buscador = (termino) => capacidad.ejecutar({ idNegocio, args: { termino }, contexto: {} });
        } catch (_) {
            buscador = null;
        }
    }
    let pruebas = { total: 0, fallidas: 0, hecha: false };
    if (buscador) {
        const humo = await pruebaDeHumo(categorias, buscador);
        pruebas = { total: humo.pruebas, fallidas: humo.fallidas.length, hecha: true };
        if (humo.fallidas.length > 0) {
            hallazgos.push({
                clave: 'busqueda_clientes',
                titulo: 'Formas de pedir que el asistente no entiende',
                estado: 'recomendado',
                por_que: 'Probamos el buscador del asistente con las formas más comunes de pedir. Estas no encuentran lo que deberían; casi siempre se arregla con un nombre más claro.',
                donde: MENU,
                total: humo.fallidas.length,
                detalles: humo.fallidas.slice(0, MAX_DETALLES),
            });
        }
    }

    const orden = { falta: 0, recomendado: 1 };
    hallazgos.sort((a, b) => orden[a.estado] - orden[b.estado]);
    return {
        ...base,
        aplica: true,
        hallazgos,
        pruebas,
        criticos: hallazgos.filter((h) => h.estado === 'falta').length,
        pendientes: hallazgos.length,
    };
}

module.exports = { diagnosticar, analizarCarta, pruebaDeHumo, singular, leerCarta };
