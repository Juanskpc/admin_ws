'use strict';
/**
 * Barrios y veredas con precio de domicilio, agrupados por comuna o corregimiento.
 *
 * Quién manda: **el servidor**. El barrio que llega en un pedido (carta, bot) es una sugerencia
 * del cliente; el valor que se cobra sale de aquí, releído por (id_negocio, id_barrio), nunca de
 * lo que venga en el mensaje. Ver `resolverBarrio`.
 *
 * ## El precio de un barrio (desde 2026-10-15)
 *
 * `COALESCE(barrio.valor, zona.valor)`: el suyo si lo tiene y, si no, el de su comuna o
 * corregimiento (`rest_zona_domicilio`). Sin ninguno de los dos el barrio **no se ofrece**: no hay
 * un valor que decirle al cliente. Así un negocio puede cargar la ciudad entera del catálogo y
 * ponerle precio solo a las comunas a las que de verdad lleva. Los barrios de antes (sin zona y con
 * valor) siguen igual.
 *
 * Todo esto solo aplica si el negocio tiene `permite_pago_domicilio` encendido; apagado, no hay
 * barrios que preguntar ni domicilio que cobrar (comportamiento de siempre).
 */
const ExcelJS = require('exceljs');
const Models = require('../../app_core/models/conection');
const ConfiguracionService = require('./configuracionService');

const SELECT = Models.sequelize.QueryTypes.SELECT;
const VALOR_MAXIMO = 1000000;

function domainError(message, code, statusCode) {
    const err = new Error(message);
    err.code = code;
    err.statusCode = statusCode;
    return err;
}

function limpiarNombre(nombre) {
    return String(nombre ?? '').trim().replace(/\s+/g, ' ');
}

/** Sin tildes, minúsculas, espacios simples: para comparar lo que escribe una persona. */
function normalizar(texto) {
    return String(texto ?? '')
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();
}

/** `null`/`''` → null; un número válido → número; lo demás es error. */
function valorONull(valor, campo = 'El valor') {
    if (valor === null || valor === undefined || String(valor).trim() === '') return null;
    const n = Number(String(valor).replace(/[$.\s]/g, '').replace(',', '.'));
    if (!Number.isFinite(n) || n < 0 || n > VALOR_MAXIMO) {
        throw domainError(`${campo} debe ser un número entre 0 y ${VALOR_MAXIMO}.`, 'VALOR_INVALIDO', 400);
    }
    return Math.round(n);
}

const numeroONull = (v) => (v === null || v === undefined ? null : Number(v));

/** Acceso de escritura = administrador del negocio, igual que Configuración. */
async function accesoEscritura(idUsuario, idNegocio) {
    const acceso = await ConfiguracionService.resolveAccesoNegocio(idUsuario, idNegocio);
    if (!acceso.canEdit) {
        throw domainError('No tienes permiso para editar los barrios.', 'SIN_PERMISO', 403);
    }
    return acceso.idNegocio;
}

/** Todos los barrios activos del negocio con su zona y su valor efectivo. */
async function leerBarrios(idNegocio, { transaction = null, soloConPrecio = false } = {}) {
    const filas = await Models.sequelize.query(
        `SELECT b.id_barrio, b.nombre, b.tipo, b.valor, b.id_zona_domicilio,
                z.nombre AS zona, z.tipo AS zona_tipo, z.valor AS valor_zona,
                COALESCE(b.valor, z.valor) AS valor_efectivo
           FROM restaurante.rest_barrio_domicilio b
      LEFT JOIN restaurante.rest_zona_domicilio z
             ON z.id_zona_domicilio = b.id_zona_domicilio AND z.estado = 'A'
          WHERE b.id_negocio = :idNegocio AND b.estado = 'A'
            ${soloConPrecio ? 'AND COALESCE(b.valor, z.valor) IS NOT NULL' : ''}
          ORDER BY (b.id_zona_domicilio IS NOT NULL), z.orden, z.nombre, lower(b.nombre);`,
        { replacements: { idNegocio }, type: SELECT, transaction }
    );
    return filas.map((f) => ({
        id_barrio: f.id_barrio,
        nombre: f.nombre,
        tipo: f.tipo,
        valor: numeroONull(f.valor),
        id_zona_domicilio: f.id_zona_domicilio,
        zona: f.zona ?? null,
        zona_tipo: f.zona_tipo ?? null,
        valor_efectivo: numeroONull(f.valor_efectivo),
    }));
}

/** Lo que devuelve el CRUD de un barrio: lo de siempre más su zona y su valor efectivo. */
async function unBarrio(idNegocio, idBarrio, transaction = null) {
    const todos = await leerBarrios(idNegocio, { transaction });
    return todos.find((b) => b.id_barrio === idBarrio) ?? null;
}

async function zonaDelNegocio(idNegocio, idZona, transaction = null) {
    const zona = await Models.RestZonaDomicilio.findOne({
        where: { id_zona_domicilio: Number(idZona), id_negocio: idNegocio, estado: 'A' },
        transaction,
    });
    if (!zona) throw domainError('Esa comuna o corregimiento no existe.', 'ZONA_NO_ENCONTRADA', 404);
    return zona;
}

async function asegurarNombreLibre(idNegocio, nombre, idZona, exceptoId = null, transaction = null) {
    const [fila] = await Models.sequelize.query(
        `SELECT 1 AS hay FROM restaurante.rest_barrio_domicilio
          WHERE id_negocio = :idNegocio AND estado = 'A'
            AND COALESCE(id_zona_domicilio, 0) = :zona AND lower(nombre) = lower(:nombre)
            ${exceptoId ? 'AND id_barrio <> :exceptoId' : ''}
          LIMIT 1;`,
        { replacements: { idNegocio, nombre, zona: Number(idZona) || 0, exceptoId }, type: SELECT, transaction }
    );
    if (fila) {
        throw domainError(
            idZona ? 'Ya tienes un barrio con ese nombre en esa zona.' : 'Ya tienes un barrio con ese nombre.',
            'BARRIO_DUPLICADO',
            409
        );
    }
}

// ── Barrios ─────────────────────────────────────────────────────────────────────────────

/** La lista del negocio, plana: cada barrio con `zona` y `valor_efectivo`. */
async function listar(idUsuario, idNegocio) {
    const acceso = await ConfiguracionService.resolveAccesoNegocio(idUsuario, idNegocio);
    return leerBarrios(acceso.idNegocio);
}

async function crear(idUsuario, { id_negocio, nombre, valor, id_zona_domicilio = null, tipo }) {
    const idNegocio = await accesoEscritura(idUsuario, id_negocio);
    const limpio = limpiarNombre(nombre);
    const zona = id_zona_domicilio ? await zonaDelNegocio(idNegocio, id_zona_domicilio) : null;
    const precio = valorONull(valor);
    // Un barrio suelto necesita su propio precio: no hay zona de la que heredarlo.
    if (precio === null && !zona) {
        throw domainError('Ponle un valor al barrio, o elige la comuna de la que toma el precio.', 'VALOR_INVALIDO', 400);
    }
    await asegurarNombreLibre(idNegocio, limpio, zona?.id_zona_domicilio);
    const fila = await Models.RestBarrioDomicilio.create({
        id_negocio: idNegocio,
        nombre: limpio,
        valor: precio,
        id_zona_domicilio: zona?.id_zona_domicilio ?? null,
        tipo: tipo === 'VEREDA' || zona?.tipo === 'CORREGIMIENTO' ? 'VEREDA' : 'BARRIO',
    });
    return unBarrio(idNegocio, fila.id_barrio);
}

/**
 * `valor: null` = que use el de su zona (solo si tiene zona). `valor` ausente = no tocarlo.
 */
async function editar(idUsuario, idBarrio, { id_negocio, nombre, valor }) {
    const idNegocio = await accesoEscritura(idUsuario, id_negocio);
    const fila = await Models.RestBarrioDomicilio.findOne({
        where: { id_barrio: idBarrio, id_negocio: idNegocio, estado: 'A' },
    });
    if (!fila) throw domainError('Barrio no encontrado.', 'BARRIO_NO_ENCONTRADO', 404);

    if (nombre !== undefined) {
        const limpio = limpiarNombre(nombre);
        await asegurarNombreLibre(idNegocio, limpio, fila.id_zona_domicilio, idBarrio);
        fila.nombre = limpio;
    }
    if (valor !== undefined) {
        const precio = valorONull(valor);
        if (precio === null && !fila.id_zona_domicilio) {
            throw domainError('Un barrio sin comuna necesita su propio valor.', 'VALOR_INVALIDO', 400);
        }
        fila.valor = precio;
    }
    await Models.sequelize.transaction((t) => fila.save({ transaction: t }));
    return unBarrio(idNegocio, idBarrio);
}

async function eliminar(idUsuario, idBarrio, idNegocioSolicitado) {
    const idNegocio = await accesoEscritura(idUsuario, idNegocioSolicitado);
    const [n] = await Models.RestBarrioDomicilio.update(
        { estado: 'E' },
        { where: { id_barrio: idBarrio, id_negocio: idNegocio, estado: 'A' } },
    );
    if (!n) throw domainError('Barrio no encontrado.', 'BARRIO_NO_ENCONTRADO', 404);
    return { id_barrio: idBarrio };
}

// ── Zonas (comuna / corregimiento) ──────────────────────────────────────────────────────

/** Las zonas del negocio con cuántos barrios tienen y cuántos llevan precio propio. */
async function listarZonas(idUsuario, idNegocio) {
    const acceso = await ConfiguracionService.resolveAccesoNegocio(idUsuario, idNegocio);
    const filas = await Models.sequelize.query(
        `SELECT z.id_zona_domicilio, z.nombre, z.tipo, z.valor,
                count(b.id_barrio)::int AS barrios,
                count(b.valor)::int AS con_precio_propio
           FROM restaurante.rest_zona_domicilio z
      LEFT JOIN restaurante.rest_barrio_domicilio b
             ON b.id_zona_domicilio = z.id_zona_domicilio AND b.estado = 'A'
          WHERE z.id_negocio = :idNegocio AND z.estado = 'A'
       GROUP BY z.id_zona_domicilio
       ORDER BY z.orden, z.nombre;`,
        { replacements: { idNegocio: acceso.idNegocio }, type: SELECT }
    );
    const catalogos = await Models.sequelize.query(
        `SELECT z.ciudad, count(DISTINCT z.id_geo_zona)::int AS zonas, count(l.id_geo_lugar)::int AS lugares
           FROM general.gener_geo_zona z
      LEFT JOIN general.gener_geo_lugar l ON l.id_geo_zona = z.id_geo_zona
       GROUP BY z.ciudad ORDER BY z.ciudad;`,
        { type: SELECT }
    );
    return {
        zonas: filas.map((z) => ({
            id_zona_domicilio: z.id_zona_domicilio,
            nombre: z.nombre,
            tipo: z.tipo,
            valor: numeroONull(z.valor),
            barrios: z.barrios,
            con_precio_propio: z.con_precio_propio,
        })),
        catalogos,
    };
}

/**
 * El precio de una comuna o corregimiento. Todos sus barrios sin precio propio pasan a costar
 * esto. Con `aplicar_a_todos` además se les quita el propio a los que lo tenían: la zona entera
 * queda a un solo precio. `valor: null` = la zona deja de tener precio.
 */
async function editarZona(idUsuario, idZona, { id_negocio, valor, aplicar_a_todos = false }) {
    const idNegocio = await accesoEscritura(idUsuario, id_negocio);
    return Models.sequelize.transaction(async (t) => {
        const zona = await zonaDelNegocio(idNegocio, idZona, t);
        await zona.update({ valor: valorONull(valor, 'El valor de la zona') }, { transaction: t });
        let igualados = 0;
        if (aplicar_a_todos === true || aplicar_a_todos === 'true') {
            const [, meta] = await Models.sequelize.query(
                `UPDATE restaurante.rest_barrio_domicilio SET valor = NULL
                  WHERE id_zona_domicilio = :idZona AND estado = 'A' AND valor IS NOT NULL;`,
                { replacements: { idZona: zona.id_zona_domicilio }, transaction: t }
            );
            igualados = meta?.rowCount ?? 0;
        }
        return {
            id_zona_domicilio: zona.id_zona_domicilio,
            nombre: zona.nombre,
            valor: numeroONull(zona.valor),
            igualados,
        };
    });
}

/** Quita una zona y todos sus barrios (no se borran: quedan en estado E, como un barrio suelto). */
async function eliminarZona(idUsuario, idZona, idNegocioSolicitado) {
    const idNegocio = await accesoEscritura(idUsuario, idNegocioSolicitado);
    return Models.sequelize.transaction(async (t) => {
        const zona = await zonaDelNegocio(idNegocio, idZona, t);
        await Models.RestBarrioDomicilio.update(
            { estado: 'E' },
            { where: { id_zona_domicilio: zona.id_zona_domicilio, estado: 'A' }, transaction: t }
        );
        await zona.update({ estado: 'E' }, { transaction: t });
        return { id_zona_domicilio: zona.id_zona_domicilio };
    });
}

/**
 * Copia el catálogo de una ciudad (comunas/corregimientos con sus barrios/veredas) a las tablas
 * del negocio, **sin precios**. Idempotente: lo que ya tiene (por nombre, dentro de su zona) no se
 * duplica ni se toca, así que se puede volver a correr si el catálogo crece.
 */
async function importarCatalogo(idUsuario, { id_negocio, ciudad }) {
    const idNegocio = await accesoEscritura(idUsuario, id_negocio);
    return Models.sequelize.transaction(async (t) => {
        const zonasGeo = await Models.sequelize.query(
            `SELECT id_geo_zona, tipo, nombre, orden FROM general.gener_geo_zona
              WHERE lower(ciudad) = lower(:ciudad) ORDER BY orden;`,
            { replacements: { ciudad: String(ciudad || '') }, type: SELECT, transaction: t }
        );
        if (zonasGeo.length === 0) {
            throw domainError('No tenemos el listado de esa ciudad.', 'CIUDAD_SIN_CATALOGO', 404);
        }
        let zonasNuevas = 0;
        let barriosNuevos = 0;
        for (const zg of zonasGeo) {
            const zona = await asegurarZona(idNegocio, { nombre: zg.nombre, tipo: zg.tipo, idGeoZona: zg.id_geo_zona, orden: zg.orden }, t);
            if (zona.nueva) zonasNuevas += 1;
            const lugares = await Models.sequelize.query(
                `SELECT id_geo_lugar, tipo, nombre FROM general.gener_geo_lugar
                  WHERE id_geo_zona = :id ORDER BY nombre;`,
                { replacements: { id: zg.id_geo_zona }, type: SELECT, transaction: t }
            );
            for (const l of lugares) {
                const [r] = await Models.sequelize.query(
                    `INSERT INTO restaurante.rest_barrio_domicilio
                         (id_negocio, nombre, valor, id_zona_domicilio, id_geo_lugar, tipo, estado)
                     SELECT :idNegocio, :nombre, NULL, :idZona, :idLugar, :tipo, 'A'
                      WHERE NOT EXISTS (
                          SELECT 1 FROM restaurante.rest_barrio_domicilio
                           WHERE id_negocio = :idNegocio AND estado = 'A'
                             AND id_zona_domicilio = :idZona AND lower(nombre) = lower(:nombre))
                     RETURNING id_barrio;`,
                    {
                        replacements: {
                            idNegocio,
                            nombre: l.nombre,
                            idZona: zona.id_zona_domicilio,
                            idLugar: l.id_geo_lugar,
                            tipo: l.tipo,
                        },
                        type: SELECT,
                        transaction: t,
                    }
                );
                if (r) barriosNuevos += 1;
            }
        }
        return { zonas_nuevas: zonasNuevas, barrios_nuevos: barriosNuevos };
    });
}

/** La zona del negocio con ese nombre; la crea (sin precio) si no existe. */
async function asegurarZona(idNegocio, { nombre, tipo, idGeoZona = null, orden = null }, t) {
    const limpio = limpiarNombre(nombre);
    const [existente] = await Models.sequelize.query(
        `SELECT id_zona_domicilio, tipo FROM restaurante.rest_zona_domicilio
          WHERE id_negocio = :idNegocio AND estado = 'A' AND lower(nombre) = lower(:nombre) LIMIT 1;`,
        { replacements: { idNegocio, nombre: limpio }, type: SELECT, transaction: t }
    );
    if (existente) return { id_zona_domicilio: existente.id_zona_domicilio, tipo: existente.tipo, nueva: false };

    // Si no viene del catálogo, se intenta casar por nombre con él (una sola coincidencia).
    let idGeo = idGeoZona;
    if (!idGeo) {
        const geo = await Models.sequelize.query(
            `SELECT id_geo_zona FROM general.gener_geo_zona WHERE lower(nombre) = lower(:nombre);`,
            { replacements: { nombre: limpio }, type: SELECT, transaction: t }
        );
        if (geo.length === 1) idGeo = geo[0].id_geo_zona;
    }
    const [maximo] = await Models.sequelize.query(
        `SELECT COALESCE(max(orden), -1) + 1 AS siguiente FROM restaurante.rest_zona_domicilio WHERE id_negocio = :idNegocio;`,
        { replacements: { idNegocio }, type: SELECT, transaction: t }
    );
    const tipoFinal = tipo === 'CORREGIMIENTO' || /^corregimiento$/i.test(String(tipo || '')) ? 'CORREGIMIENTO' : 'COMUNA';
    const zona = await Models.RestZonaDomicilio.create(
        {
            id_negocio: idNegocio,
            id_geo_zona: idGeo,
            tipo: tipoFinal,
            nombre: limpio,
            valor: null,
            orden: orden ?? Number(maximo.siguiente),
            estado: 'A',
        },
        { transaction: t }
    );
    return { id_zona_domicilio: zona.id_zona_domicilio, tipo: tipoFinal, nueva: true };
}

/**
 * Sube (o baja, con `monto` negativo) TODOS los precios del negocio a la vez: los de cada zona y
 * los propios de cada barrio. Lo que no tiene precio sigue sin tenerlo, y nada baja de 0.
 */
async function ajustarPrecios(idUsuario, { id_negocio, monto }) {
    const idNegocio = await accesoEscritura(idUsuario, id_negocio);
    const delta = Math.round(Number(monto));
    if (!Number.isFinite(delta) || delta === 0 || Math.abs(delta) > VALOR_MAXIMO) {
        throw domainError('Escribe cuánto sumar (o restar) a los domicilios.', 'VALOR_INVALIDO', 400);
    }
    return Models.sequelize.transaction(async (t) => {
        const [, zonas] = await Models.sequelize.query(
            `UPDATE restaurante.rest_zona_domicilio
                SET valor = LEAST(GREATEST(valor + :delta, 0), :max)
              WHERE id_negocio = :idNegocio AND estado = 'A' AND valor IS NOT NULL;`,
            { replacements: { idNegocio, delta, max: VALOR_MAXIMO }, transaction: t }
        );
        const [, barrios] = await Models.sequelize.query(
            `UPDATE restaurante.rest_barrio_domicilio
                SET valor = LEAST(GREATEST(valor + :delta, 0), :max)
              WHERE id_negocio = :idNegocio AND estado = 'A' AND valor IS NOT NULL;`,
            { replacements: { idNegocio, delta, max: VALOR_MAXIMO }, transaction: t }
        );
        return { monto: delta, zonas: zonas?.rowCount ?? 0, barrios: barrios?.rowCount ?? 0 };
    });
}

// ── Plantilla de Excel ──────────────────────────────────────────────────────────────────

const HOJA_ZONAS = 'Comunas y corregimientos';
const HOJA_BARRIOS = 'Barrios y veredas';

/**
 * La plantilla para llenar los precios en Excel. Lleva lo que el negocio ya tiene; si aún no tiene
 * nada y hay catálogo de `ciudad`, lleva el catálogo con los precios vacíos.
 */
async function exportarPlantilla(idUsuario, { id_negocio, ciudad = null }) {
    const acceso = await ConfiguracionService.resolveAccesoNegocio(idUsuario, id_negocio);
    const idNegocio = acceso.idNegocio;

    let zonas = (await listarZonas(idUsuario, idNegocio)).zonas;
    let barrios = await leerBarrios(idNegocio);
    if (zonas.length === 0 && barrios.length === 0 && ciudad) {
        const geo = await Models.sequelize.query(
            `SELECT z.tipo AS zona_tipo, z.nombre AS zona, l.tipo, l.nombre
               FROM general.gener_geo_zona z JOIN general.gener_geo_lugar l ON l.id_geo_zona = z.id_geo_zona
              WHERE lower(z.ciudad) = lower(:ciudad) ORDER BY z.orden, lower(l.nombre);`,
            { replacements: { ciudad }, type: SELECT }
        );
        const vistas = new Map();
        for (const g of geo) vistas.set(g.zona, { nombre: g.zona, tipo: g.zona_tipo, valor: null });
        zonas = [...vistas.values()];
        barrios = geo.map((g) => ({ nombre: g.nombre, tipo: g.tipo, zona: g.zona, valor: null }));
    }

    const libro = new ExcelJS.Workbook();
    libro.creator = 'EscalApp';

    const ayuda = libro.addWorksheet('Instrucciones');
    ayuda.columns = [{ width: 110 }];
    [
        'Precios de domicilio por comuna/corregimiento y por barrio/vereda.',
        '',
        `1. En «${HOJA_ZONAS}» escribe el precio de cada zona. Todos sus barrios toman ese precio.`,
        `2. En «${HOJA_BARRIOS}», escribe un precio SOLO en los barrios que cuesten distinto a su zona.`,
        '   Déjalo vacío para que use el de su zona.',
        '3. Una zona sin precio (y sin barrios con precio) no se le ofrece al cliente: úsalo para las zonas a las que no llevas.',
        '4. Puedes agregar filas nuevas (zonas o barrios que no estén). No borres ni cambies los nombres de las columnas.',
        '5. Los precios van en pesos, sin puntos ni signo: 5000.',
        '6. Súbela en Configuración → Cobros → Barrios y veredas → «Subir Excel». Lo que no esté en el archivo no se toca.',
    ].forEach((linea) => ayuda.addRow([linea]));
    ayuda.getRow(1).font = { bold: true, size: 13 };

    const hojaZonas = libro.addWorksheet(HOJA_ZONAS);
    hojaZonas.columns = [
        { header: 'Tipo', key: 'tipo', width: 18 },
        { header: 'Comuna/Corregimiento', key: 'nombre', width: 30 },
        { header: 'Precio', key: 'valor', width: 14 },
    ];
    for (const z of zonas) {
        hojaZonas.addRow({ tipo: z.tipo === 'CORREGIMIENTO' ? 'Corregimiento' : 'Comuna', nombre: z.nombre, valor: z.valor });
    }

    const hojaBarrios = libro.addWorksheet(HOJA_BARRIOS);
    hojaBarrios.columns = [
        { header: 'Comuna/Corregimiento', key: 'zona', width: 28 },
        { header: 'Tipo', key: 'tipo', width: 12 },
        { header: 'Barrio/Vereda', key: 'nombre', width: 36 },
        { header: 'Precio propio (vacío = el de la zona)', key: 'valor', width: 34 },
    ];
    for (const b of barrios) {
        hojaBarrios.addRow({ zona: b.zona ?? '', tipo: b.tipo === 'VEREDA' ? 'Vereda' : 'Barrio', nombre: b.nombre, valor: b.valor });
    }
    for (const hoja of [hojaZonas, hojaBarrios]) {
        hoja.getRow(1).font = { bold: true };
        hoja.views = [{ state: 'frozen', ySplit: 1 }];
    }
    return libro.xlsx.writeBuffer();
}

/** El texto de una celda, venga como número, fórmula o texto enriquecido. */
function textoCelda(celda) {
    const v = celda?.value;
    if (v === null || v === undefined) return '';
    if (typeof v === 'object') {
        if ('result' in v) return String(v.result ?? '');
        if ('richText' in v) return v.richText.map((r) => r.text).join('');
        if ('text' in v) return String(v.text);
    }
    return String(v);
}

/**
 * Lee la plantilla y aplica sus precios. Crea las zonas y barrios que no existan; lo que no está
 * en el archivo no se toca. Todo o nada: con una fila inválida no se guarda nada y se dice cuál.
 */
async function importarPlantilla(idUsuario, { id_negocio, buffer }) {
    const idNegocio = await accesoEscritura(idUsuario, id_negocio);
    const libro = new ExcelJS.Workbook();
    try {
        await libro.xlsx.load(buffer);
    } catch (e) {
        throw domainError('No pudimos leer el archivo. Sube la plantilla en formato .xlsx.', 'PLANTILLA_INVALIDA', 400);
    }
    const hojaZonas = libro.getWorksheet(HOJA_ZONAS);
    const hojaBarrios = libro.getWorksheet(HOJA_BARRIOS);
    if (!hojaZonas && !hojaBarrios) {
        throw domainError(
            `El archivo no tiene las hojas «${HOJA_ZONAS}» ni «${HOJA_BARRIOS}». Descarga la plantilla y llénala.`,
            'PLANTILLA_INVALIDA',
            400
        );
    }

    const errores = [];
    const zonasArchivo = [];
    hojaZonas?.eachRow((fila, n) => {
        if (n === 1) return;
        const nombre = limpiarNombre(textoCelda(fila.getCell(2)));
        if (!nombre) return;
        try {
            zonasArchivo.push({
                fila: n,
                nombre,
                tipo: /correg/i.test(textoCelda(fila.getCell(1))) ? 'CORREGIMIENTO' : 'COMUNA',
                valor: valorONull(textoCelda(fila.getCell(3)), `Fila ${n} de «${HOJA_ZONAS}»: el precio`),
            });
        } catch (e) {
            errores.push(e.message);
        }
    });
    const barriosArchivo = [];
    hojaBarrios?.eachRow((fila, n) => {
        if (n === 1) return;
        const nombre = limpiarNombre(textoCelda(fila.getCell(3)));
        if (!nombre) return;
        try {
            barriosArchivo.push({
                fila: n,
                zona: limpiarNombre(textoCelda(fila.getCell(1))),
                tipo: /vereda/i.test(textoCelda(fila.getCell(2))) ? 'VEREDA' : 'BARRIO',
                nombre,
                valor: valorONull(textoCelda(fila.getCell(4)), `Fila ${n} de «${HOJA_BARRIOS}»: el precio`),
            });
        } catch (e) {
            errores.push(e.message);
        }
    });
    for (const b of barriosArchivo) {
        if (!b.zona && b.valor === null) {
            errores.push(`Fila ${b.fila} de «${HOJA_BARRIOS}»: «${b.nombre}» no tiene zona ni precio.`);
        }
    }
    if (errores.length) {
        const e = domainError(errores.slice(0, 5).join(' '), 'PLANTILLA_INVALIDA', 400);
        throw e;
    }

    return Models.sequelize.transaction(async (t) => {
        const resumen = { zonas_creadas: 0, zonas_actualizadas: 0, barrios_creados: 0, barrios_actualizados: 0 };
        const idZonaPorNombre = new Map();

        for (const z of zonasArchivo) {
            const zona = await asegurarZona(idNegocio, { nombre: z.nombre, tipo: z.tipo }, t);
            if (zona.nueva) resumen.zonas_creadas += 1;
            else resumen.zonas_actualizadas += 1;
            await Models.RestZonaDomicilio.update(
                { valor: z.valor },
                { where: { id_zona_domicilio: zona.id_zona_domicilio }, transaction: t }
            );
            idZonaPorNombre.set(normalizar(z.nombre), zona.id_zona_domicilio);
        }

        for (const b of barriosArchivo) {
            let idZona = null;
            if (b.zona) {
                idZona = idZonaPorNombre.get(normalizar(b.zona));
                if (!idZona) {
                    const zona = await asegurarZona(idNegocio, { nombre: b.zona, tipo: b.tipo === 'VEREDA' ? 'CORREGIMIENTO' : 'COMUNA' }, t);
                    if (zona.nueva) resumen.zonas_creadas += 1;
                    idZona = zona.id_zona_domicilio;
                    idZonaPorNombre.set(normalizar(b.zona), idZona);
                }
            }
            const [existente] = await Models.sequelize.query(
                `SELECT id_barrio FROM restaurante.rest_barrio_domicilio
                  WHERE id_negocio = :idNegocio AND estado = 'A'
                    AND COALESCE(id_zona_domicilio, 0) = :zona AND lower(nombre) = lower(:nombre) LIMIT 1;`,
                { replacements: { idNegocio, zona: idZona || 0, nombre: b.nombre }, type: SELECT, transaction: t }
            );
            if (existente) {
                await Models.RestBarrioDomicilio.update(
                    { valor: b.valor },
                    { where: { id_barrio: existente.id_barrio }, transaction: t }
                );
                resumen.barrios_actualizados += 1;
            } else {
                await Models.RestBarrioDomicilio.create(
                    { id_negocio: idNegocio, nombre: b.nombre, valor: b.valor, id_zona_domicilio: idZona, tipo: b.tipo },
                    { transaction: t }
                );
                resumen.barrios_creados += 1;
            }
        }
        return resumen;
    });
}

// ── Lo que ven el cliente y el asistente ────────────────────────────────────────────────

/**
 * Lo que ve el cliente en la carta pública: `habilitado` dice si el negocio cobra domicilio por
 * barrio (flag `permite_pago_domicilio`) y la lista lleva id, nombre, valor y su zona (null en un
 * barrio suelto). Solo los barrios que tienen precio, propio o de su zona.
 */
async function listarPublico(idNegocio) {
    const negocio = await Models.GenerNegocio.findByPk(idNegocio, {
        attributes: ['id_negocio', 'permite_pago_domicilio'],
    });
    if (!negocio || !negocio.permite_pago_domicilio) return { habilitado: false, barrios: [] };
    const barrios = await leerBarrios(idNegocio, { soloConPrecio: true });
    return {
        habilitado: true,
        barrios: barrios.map((b) => ({
            id_barrio: b.id_barrio,
            nombre: b.nombre,
            valor: b.valor_efectivo,
            zona: b.zona,
        })),
    };
}

/**
 * El barrio que dijo el cliente, releído de la base: debe ser de ESTE negocio, estar activo y tener
 * precio (el suyo o el de su zona). Lanza `ZONA_INVALIDA` (400) si no; el bot lo traduce a «¿en
 * qué barrio estás?».
 */
async function resolverBarrio({ idNegocio, idBarrio, transaction = null }) {
    const [fila] = await Models.sequelize.query(
        `SELECT b.id_barrio, b.nombre, z.nombre AS zona, COALESCE(b.valor, z.valor) AS valor
           FROM restaurante.rest_barrio_domicilio b
      LEFT JOIN restaurante.rest_zona_domicilio z
             ON z.id_zona_domicilio = b.id_zona_domicilio AND z.estado = 'A'
          WHERE b.id_barrio = :idBarrio AND b.id_negocio = :idNegocio AND b.estado = 'A'
            AND COALESCE(b.valor, z.valor) IS NOT NULL;`,
        { replacements: { idBarrio: Number(idBarrio) || 0, idNegocio }, type: SELECT, transaction }
    );
    if (!fila) throw domainError('Ese barrio no está en nuestra lista.', 'ZONA_INVALIDA', 400);
    return { id_barrio: fila.id_barrio, nombre: fila.nombre, valor: Number(fila.valor), zona: fila.zona ?? null };
}

/**
 * El barrio y lo que cuesta llevarle un pedido: `{ barrio, valor }`. `valor` es 0 si el negocio
 * tiene apagado `permite_pago_domicilio` (mismo criterio que `pedidoService.resolverValorDomicilio`,
 * que además lo vuelve a aplicar al crear la orden). Lo usan la pregunta de confirmación y la
 * creación del pedido, para que digan lo mismo.
 */
async function valorDomicilioDe({ idNegocio, idBarrio, transaction = null }) {
    const barrio = await resolverBarrio({ idNegocio, idBarrio, transaction });
    const negocio = await Models.GenerNegocio.findByPk(idNegocio, {
        attributes: ['id_negocio', 'permite_pago_domicilio'],
        transaction,
    });
    return { barrio, valor: negocio?.permite_pago_domicilio ? barrio.valor : 0 };
}

module.exports = {
    listar,
    crear,
    editar,
    eliminar,
    listarZonas,
    editarZona,
    eliminarZona,
    importarCatalogo,
    ajustarPrecios,
    exportarPlantilla,
    importarPlantilla,
    listarPublico,
    resolverBarrio,
    valorDomicilioDe,
    normalizar,
};
