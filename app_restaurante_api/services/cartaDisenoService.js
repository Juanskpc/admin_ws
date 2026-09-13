'use strict';
const Models = require('../../app_core/models/conection');
const ImagenService = require('../../app_reserva_api/services/imagenService');
const { getCaracteristicasNegocio } = require('../../app_core/helpers/planCaracteristicaHelper');
const { resolveAccesoNegocio } = require('./configuracionService');

/**
 * cartaDisenoService — cómo se ve la carta virtual de cada negocio.
 *
 * ## El backend valida, el frontend dibuja
 *
 * Los valores de cada plantilla (colores de fondo, tipografías, radios) viven en el frontend, que
 * es quien los pinta. Aquí solo se conocen los **nombres** válidos, para rechazar lo que no exista
 * y aplicar lo que el plan permite. Duplicar los colores de siete plantillas en dos sitios sería
 * garantizar que un día no coincidan.
 *
 * ## La carta por defecto no es una fila
 *
 * Un negocio sin diseño publicado se sirve con `DISENO_DEFECTO`, que es la carta de siempre. Nada
 * se siembra al registrar un negocio, y por eso un negocio nuevo tiene carta desde el primer día.
 */

const PLANTILLAS = ['esencial', 'neon', 'gaceta', 'medianoche', 'papel', 'vitrina', 'mostrador'];
const FORMATOS = ['cards', 'lista', 'mixto'];
const FUENTES = ['sistema', 'inter', 'poppins', 'lora', 'archivo-narrow', 'dm-serif-display'];
const BORDES = ['recto', 'suave', 'redondo'];

/** La plantilla que existe para todos, pase lo que pase con el plan. */
const PLANTILLA_BASE = 'esencial';

const HEX = /^#[0-9A-F]{6}$/;

function clonarDefecto() {
    return {
        plantilla: PLANTILLA_BASE,
        formato: 'cards',
        marca: {},
        opciones: { mostrar_agotados: false },
    };
}

function error(mensaje, code, statusCode = 422) {
    const e = new Error(mensaje);
    e.code = code;
    e.statusCode = statusCode;
    return e;
}

function esTablaInexistente(err) {
    const code = err?.parent?.code || err?.original?.code;
    return code === '42P01';
}

function normalizarHex(valor) {
    const texto = String(valor ?? '').trim();
    if (!texto) return null;
    const hex = (texto.startsWith('#') ? texto : `#${texto}`).toUpperCase();
    return HEX.test(hex) ? hex : undefined;
}

/**
 * El color de marca que el negocio ya tenía antes de esta sección.
 *
 * `gener_negocio.colores` manda sobre `id_paleta` (ver el modelo), pero en el restaurante la
 * paleta se elige por id y no siempre se copió a `colores`, así que se miran los dos. Es lo que
 * hace que la carta por defecto salga con el color del negocio y no con el índigo de EscalApp.
 */
function extraerColorNegocio(negocio) {
    const propios = negocio?.colores || {};
    const paleta = negocio?.paletaColor?.colores || {};
    const candidatos = [
        propios.primario, propios['color-primary'],
        paleta.primario, paleta['color-primary'],
    ];
    for (const candidato of candidatos) {
        const hex = normalizarHex(candidato);
        if (hex) return hex;
    }
    return null;
}

function normalizarMarca(marca = {}) {
    const limpia = {};

    if (marca.color !== undefined && marca.color !== null && marca.color !== '') {
        const hex = normalizarHex(marca.color);
        if (!hex) {
            throw error(
                'El color debe ser un hexadecimal de 6 dígitos, por ejemplo #C2410C.',
                'COLOR_INVALIDO',
            );
        }
        limpia.color = hex;
    }

    // «plantilla» o vacío significan «el de la plantilla»: no se guarda nada, y así la carta
    // hereda las mejoras futuras de esa plantilla.
    if (marca.fuente_titulos && marca.fuente_titulos !== 'plantilla') {
        if (!FUENTES.includes(marca.fuente_titulos)) {
            throw error('La tipografía elegida no está disponible.', 'FUENTE_INVALIDA');
        }
        limpia.fuente_titulos = marca.fuente_titulos;
    }

    if (marca.borde && marca.borde !== 'plantilla') {
        if (!BORDES.includes(marca.borde)) {
            throw error('El estilo de bordes elegido no existe.', 'BORDE_INVALIDO');
        }
        limpia.borde = marca.borde;
    }

    return limpia;
}

function normalizarOpciones(opciones = {}) {
    return {
        mostrar_agotados: opciones.mostrar_agotados === true || opciones.mostrar_agotados === 'true',
    };
}

function normalizarDiseno({ plantilla, formato, marca, opciones }) {
    if (!PLANTILLAS.includes(plantilla)) {
        throw error('La plantilla elegida no existe.', 'PLANTILLA_INVALIDA');
    }
    if (!FORMATOS.includes(formato)) {
        throw error('El formato de visualización elegido no existe.', 'FORMATO_INVALIDO');
    }
    return {
        plantilla,
        formato,
        marca: normalizarMarca(marca || {}),
        opciones: normalizarOpciones(opciones || {}),
    };
}

function plantillaPermitida(caracteristicas, plantilla) {
    if (plantilla === PLANTILLA_BASE) return true;
    const permitidas = caracteristicas?.carta_plantillas;
    return permitidas === '*' || (Array.isArray(permitidas) && permitidas.includes(plantilla));
}

async function leerFila(idNegocio) {
    try {
        return await Models.CartaDiseno.findOne({ where: { id_negocio: idNegocio } });
    } catch (err) {
        // Sin la migración la carta sigue funcionando con el diseño por defecto.
        if (esTablaInexistente(err)) return null;
        throw err;
    }
}

/** La fila guardada como diseño completo, tolerando valores que ya no existan. */
function aDiseno(fila) {
    const base = clonarDefecto();
    if (!fila) return { ...base, publicado_en: null };

    return {
        plantilla: PLANTILLAS.includes(fila.plantilla) ? fila.plantilla : base.plantilla,
        formato: FORMATOS.includes(fila.formato) ? fila.formato : base.formato,
        marca: { ...(fila.marca || {}) },
        opciones: { ...base.opciones, ...(fila.opciones || {}) },
        publicado_en: fila.publicado_en ?? null,
    };
}

async function getNegocioConColor(idNegocio) {
    return Models.GenerNegocio.findOne({
        where: { id_negocio: idNegocio, estado: 'A' },
        attributes: ['id_negocio', 'nombre', 'logo_url', 'colores', 'id_paleta', 'url_whatsapp'],
        include: [{
            model: Models.GenerPaletaColor,
            as: 'paletaColor',
            required: false,
            attributes: ['colores'],
        }],
    });
}

/**
 * Cuánto material tiene la carta para lucir: fotos, destacados, volumen.
 *
 * Es lo que alimenta los avisos de Configuración («5 de 12 categorías no tienen foto»). Se cuenta
 * lo que el cliente vería —activo y visible—, no todo lo que hay en la base.
 */
async function getEstadisticasCarta(idNegocio) {
    const [fila] = await Models.sequelize.query(`
        WITH cat AS (
            SELECT imagen_url
            FROM restaurante.carta_categoria
            WHERE id_negocio = :idNegocio AND estado = 'A' AND COALESCE(visible, true)
        ),
        prod AS (
            SELECT imagen_url, es_popular
            FROM restaurante.carta_producto
            WHERE id_negocio = :idNegocio AND estado = 'A' AND COALESCE(visible, true)
        )
        SELECT
            (SELECT COUNT(*) FROM cat)::int AS categorias,
            (SELECT COUNT(*) FROM cat WHERE NULLIF(TRIM(imagen_url), '') IS NOT NULL)::int
                AS categorias_con_imagen,
            (SELECT COUNT(*) FROM prod)::int AS productos,
            (SELECT COUNT(*) FROM prod WHERE NULLIF(TRIM(imagen_url), '') IS NOT NULL)::int
                AS productos_con_imagen,
            (SELECT COUNT(*) FROM prod WHERE es_popular IS TRUE)::int AS productos_destacados,
            (SELECT COUNT(*) FROM prod
              WHERE es_popular IS TRUE AND NULLIF(TRIM(imagen_url), '') IS NOT NULL)::int
                AS destacados_con_imagen
    `, {
        replacements: { idNegocio },
        type: Models.sequelize.QueryTypes.SELECT,
    });

    return {
        categorias: Number(fila?.categorias ?? 0),
        categorias_con_imagen: Number(fila?.categorias_con_imagen ?? 0),
        productos: Number(fila?.productos ?? 0),
        productos_con_imagen: Number(fila?.productos_con_imagen ?? 0),
        productos_destacados: Number(fila?.productos_destacados ?? 0),
        destacados_con_imagen: Number(fila?.destacados_con_imagen ?? 0),
    };
}

/** Todo lo que necesita la pestaña Apariencia para editar la carta. */
async function getDisenoAdmin(idUsuario, idNegocio) {
    const acceso = await resolveAccesoNegocio(idUsuario, idNegocio);

    const [fila, negocio, caracteristicas, estadisticas] = await Promise.all([
        leerFila(acceso.idNegocio),
        getNegocioConColor(acceso.idNegocio),
        getCaracteristicasNegocio(acceso.idNegocio),
        getEstadisticasCarta(acceso.idNegocio),
    ]);

    if (!negocio) throw error('Negocio no encontrado.', 'NEGOCIO_NO_ENCONTRADO', 404);

    return {
        diseno: aDiseno(fila),
        personalizado: Boolean(fila),
        negocio: {
            id_negocio: negocio.id_negocio,
            nombre: negocio.nombre,
            logo_url: negocio.logo_url || null,
            url_whatsapp: negocio.url_whatsapp || null,
            color_negocio: extraerColorNegocio(negocio),
        },
        caracteristicas,
        estadisticas,
        can_edit: acceso.canEdit,
    };
}

/**
 * Publica el diseño. No hay borrador en el servidor: lo que el administrador prueba vive en su
 * pantalla, con la vista previa, y el cliente de la carta solo ve lo que pasa por aquí.
 */
async function publicarDiseno(idUsuario, payload) {
    const acceso = await resolveAccesoNegocio(idUsuario, payload.id_negocio);
    if (!acceso.canEdit) {
        throw error(
            'Solo un administrador del negocio puede publicar la carta.',
            'SIN_PERMISO_EDITAR',
            403,
        );
    }

    const diseno = normalizarDiseno(payload);
    const caracteristicas = await getCaracteristicasNegocio(acceso.idNegocio);

    // El frontend ya bloquea estas opciones, pero la regla del plan se cumple aquí: una petición
    // armada a mano no puede publicar lo que el plan no incluye.
    if (!plantillaPermitida(caracteristicas, diseno.plantilla)) {
        throw error('Tu plan no incluye esta plantilla.', 'PLANTILLA_NO_INCLUIDA', 403);
    }
    if (diseno.marca.color && !caracteristicas.carta_color_libre) {
        throw error(
            'Tu plan no incluye color personalizado para la carta.',
            'COLOR_NO_INCLUIDO',
            403,
        );
    }

    await Models.sequelize.transaction(async (t) => {
        const fila = await Models.CartaDiseno.findOne({
            where: { id_negocio: acceso.idNegocio },
            transaction: t,
            lock: t.LOCK.UPDATE,
        });
        const datos = { ...diseno, publicado_en: new Date(), id_usuario: idUsuario };
        if (fila) {
            await fila.update(datos, { transaction: t });
        } else {
            await Models.CartaDiseno.create(
                { id_negocio: acceso.idNegocio, ...datos },
                { transaction: t },
            );
        }
    });

    return getDisenoAdmin(idUsuario, acceso.idNegocio);
}

async function exigirEdicion(idUsuario, idNegocio) {
    const acceso = await resolveAccesoNegocio(idUsuario, idNegocio);
    if (!acceso.canEdit) {
        throw error(
            'Solo un administrador del negocio puede cambiar el logo.',
            'SIN_PERMISO_EDITAR',
            403,
        );
    }
    const negocio = await Models.GenerNegocio.findByPk(acceso.idNegocio);
    if (!negocio) throw error('Negocio no encontrado.', 'NEGOCIO_NO_ENCONTRADO', 404);
    return { acceso, negocio };
}

/**
 * Guarda el logo del negocio.
 *
 * Es el mismo archivo y la misma columna que usa la agenda: un negocio tiene un solo logo en toda
 * la plataforma, y cambiarlo aquí lo cambia también en su sesión y en la vitrina de reservas.
 */
async function subirLogo(idUsuario, { idNegocio, buffer, mimetype }) {
    const { acceso, negocio } = await exigirEdicion(idUsuario, idNegocio);
    const { url } = ImagenService.guardar({
        tipo: 'logo',
        idNegocio: acceso.idNegocio,
        idEntidad: acceso.idNegocio,
        buffer,
        mimetype,
    });
    await negocio.update({ logo_url: url });
    return { logo_url: url };
}

async function eliminarLogo(idUsuario, idNegocio) {
    const { acceso, negocio } = await exigirEdicion(idUsuario, idNegocio);
    ImagenService.eliminar({ tipo: 'logo', idNegocio: acceso.idNegocio, idEntidad: acceso.idNegocio });
    await negocio.update({ logo_url: null });
    return { logo_url: null };
}

/**
 * La carta tal como la ve el cliente: el diseño publicado, recortado por el plan.
 *
 * Si el plan ya no incluye la plantilla publicada, la carta cae a «Esencial» y conserva su color
 * si el plan lo permite. Nunca se apaga: el cliente que escanea el QR sigue viendo el menú. La fila
 * no se toca, así que al volver a un plan que la incluya el diseño reaparece tal cual.
 *
 * @param negocio Instancia con `id_negocio`, `url_whatsapp`, `colores` y `paletaColor`.
 */
async function getCartaPublica(negocio) {
    const [fila, caracteristicas] = await Promise.all([
        leerFila(negocio.id_negocio),
        getCaracteristicasNegocio(negocio.id_negocio),
    ]);

    const diseno = aDiseno(fila);
    if (!plantillaPermitida(caracteristicas, diseno.plantilla)) {
        diseno.plantilla = PLANTILLA_BASE;
    }
    if (!caracteristicas.carta_color_libre) {
        delete diseno.marca.color;
    }

    return {
        plantilla: diseno.plantilla,
        formato: diseno.formato,
        marca: diseno.marca,
        opciones: diseno.opciones,
        color_negocio: extraerColorNegocio(negocio),
        // El botón de pedido necesita las dos cosas: que el plan lo incluya y que el negocio haya
        // publicado un WhatsApp al que escribir. Se decide aquí para que el cliente no recalcule
        // reglas de plan.
        puede_pedir: caracteristicas.carta_whatsapp && Boolean(negocio.url_whatsapp),
    };
}

/**
 * Plan B de la carta pública: si leer el diseño falla, la carta sale con el de siempre en vez de
 * no salir. Conserva el botón de pedido tal como funcionaba antes de existir los planes.
 */
function cartaPorDefecto(negocio) {
    return {
        ...clonarDefecto(),
        color_negocio: extraerColorNegocio(negocio),
        puede_pedir: Boolean(negocio?.url_whatsapp),
    };
}

module.exports = {
    PLANTILLAS,
    FORMATOS,
    FUENTES,
    BORDES,
    getDisenoAdmin,
    publicarDiseno,
    subirLogo,
    eliminarLogo,
    getCartaPublica,
    cartaPorDefecto,
    getEstadisticasCarta,
};
