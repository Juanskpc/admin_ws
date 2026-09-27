'use strict';
const Models = require('../../app_core/models/conection');
const ConfigService = require('./configService');
const { monedaDePais, codigoPais } = require('../../app_core/helpers/paises');
const { urlWhatsapp } = require('../../app_core/helpers/telefono');
const Perfiles = require('../perfiles');
const { politicaDePago } = require('./abono');

/**
 * ¿El tipo guardado en el negocio es el módulo de reserva? Lo es si se llama RESERVA o si es un
 * oficio que el módulo atiende (los negocios anteriores a los rubros tienen ahí BARBERIA): con el
 * filtro por nombre a secas, la página del primer cliente de reserva salía «no disponible».
 */
function esModuloReserva(tipo) {
    return tipo?.nombre === 'RESERVA' || tipo?.modulo?.nombre === 'RESERVA';
}

const INCLUDE_TIPO_RESERVA = {
    model: Models.GenerTipoNegocio, as: 'tipoNegocio', attributes: ['nombre', 'id_tipo_modulo'], required: true,
    include: [{ model: Models.GenerTipoNegocio, as: 'modulo', attributes: ['nombre'], required: false }],
};

/**
 * La página pública del negocio: lo que ve un cliente que llega desde un enlace o un QR.
 *
 * ## Una sola llamada, no seis
 *
 * Los endpoints públicos que ya existían (`/info`, `/servicios`, `/profesionales`) sirven para
 * pedir una cosa concreta, pero la portada las necesita **todas a la vez** y además el horario
 * de cada profesional. Seis peticiones encadenadas desde el móvil de un cliente son seis
 * oportunidades de que la página se vea a medias. `getVitrina` devuelve el paquete completo en
 * una consulta por tabla, y la portada pinta de golpe o no pinta.
 *
 * ## Qué NO sale de aquí
 *
 * Nada que no sea público. El teléfono y las redes del negocio sí (para eso están), pero ni un
 * dato de clientes, ni citas, ni precios de coste, ni el `id_usuario` del profesional. La
 * disponibilidad real —qué huecos quedan— **no** se precalcula aquí: sigue pidiéndose por día a
 * `disponibilidadService`, que es la única fuente que cuenta citas, holds y bloqueos. Lo que
 * publica la vitrina es el horario de atención: «los martes trabaja de 9 a 6», no «el martes 12
 * a las 10:30 está libre».
 *
 * ## El horario efectivo se resuelve igual que en la agenda
 *
 * `reglasAgenda` aplica el horario propio del profesional para el día pedido y, si ese día no
 * tiene filas propias, cae al horario general del negocio. Aquí se replica **día a día** con esa
 * misma regla. Hacerlo «si tiene algún horario propio, usa solo el suyo» sería más simple y
 * estaría mal: un profesional con horario propio solo los sábados aparecería cerrado el resto de
 * la semana en la web y luego la reserva de un martes sí se aceptaría.
 */

const DIAS = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];

function error(mensaje, statusCode = 404) {
    const e = new Error(mensaje);
    e.statusCode = statusCode;
    return e;
}

/** `09:00:00` → `09:00`. La hora sale de un `time` de Postgres y los segundos sobran siempre. */
function hhmm(valor) {
    return String(valor || '').slice(0, 5);
}

/**
 * Agrupa filas de horario por día de la semana, con la regla de precedencia de la agenda.
 *
 * @param {Array} propias  filas del profesional
 * @param {Array} generales filas del negocio (id_profesional NULL)
 */
function horarioEfectivo(propias, generales) {
    const porDia = new Map();
    for (let d = 0; d < 7; d++) porDia.set(d, []);

    const propiasPorDia = new Map();
    for (const h of propias) {
        if (!propiasPorDia.has(h.dia_semana)) propiasPorDia.set(h.dia_semana, []);
        propiasPorDia.get(h.dia_semana).push(h);
    }
    const generalesPorDia = new Map();
    for (const h of generales) {
        if (!generalesPorDia.has(h.dia_semana)) generalesPorDia.set(h.dia_semana, []);
        generalesPorDia.get(h.dia_semana).push(h);
    }

    for (let d = 0; d < 7; d++) {
        const filas = propiasPorDia.get(d)?.length ? propiasPorDia.get(d) : (generalesPorDia.get(d) || []);
        porDia.set(d, filas
            .map(h => ({ hora_inicio: hhmm(h.hora_inicio), hora_fin: hhmm(h.hora_fin) }))
            .sort((a, b) => a.hora_inicio.localeCompare(b.hora_inicio)));
    }

    return [...porDia.entries()].map(([dia_semana, franjas]) => ({
        dia_semana,
        dia: DIAS[dia_semana],
        franjas,
        abierto: franjas.length > 0,
    }));
}

/** Deja fuera lo que esté vacío para que el frontend no tenga que distinguir `''` de `null`. */
function limpio(valor) {
    const v = typeof valor === 'string' ? valor.trim() : valor;
    return v ? v : null;
}

/**
 * Paquete completo de la página pública.
 *
 * Lanza 404 si el negocio no existe, no es del vertical de reservas, está inactivo o tiene la
 * página despublicada. Los cuatro casos dan la misma respuesta a propósito: desde fuera no debe
 * poder distinguirse «no existe» de «existe pero la escondió», que es lo que convertiría este
 * endpoint en un enumerador de negocios.
 */
async function getVitrina(idNegocio) {
    const negocio = await Models.GenerNegocio.findOne({
        where: { id_negocio: idNegocio, estado: 'A' },
        attributes: [
            'id_negocio', 'nombre', 'email_contacto', 'telefono', 'direccion',
            'url_whatsapp', 'url_facebook', 'url_instagram', 'url_tiktok',
            'logo_url', 'banner_url', 'colores', 'id_paleta', 'pais', 'slug',
        ],
        include: [
            INCLUDE_TIPO_RESERVA,
            { model: Models.GenerPaletaColor, as: 'paletaColor',
              attributes: ['id_paleta', 'nombre', 'colores'], required: false },
        ],
    });
    if (!negocio || !esModuloReserva(negocio.tipoNegocio)) throw error('Página no disponible.');

    const cfg = await ConfigService.get(idNegocio);
    if (cfg.publico_activo === false) throw error('Página no disponible.');

    // El perfil del rubro decide cómo se presenta la página: los términos (estilista, artista,
    // huésped), el titular, y qué se muestra (variantes, portafolio, mascota, habitaciones).
    const perfil = await Perfiles.perfilDeNegocio(idNegocio, { funciones: cfg.funciones || {} });
    const fx = new Set(perfil.funciones);

    const [servicios, profesionales, horarios, categorias] = await Promise.all([
        Models.ReservaServicio.findAll({
            where: { id_negocio: idNegocio, estado: 'A' },
            attributes: ['id_servicio', 'nombre', 'descripcion', 'duracion_min', 'precio',
                         'color_hex', 'imagen_url', 'id_categoria', 'a_cotizar',
                         'precio_min', 'precio_max'],
            include: fx.has('variantes')
                ? [{ model: Models.ReservaServicioVariante, as: 'variantes', required: false,
                     where: { estado: 'A' },
                     attributes: ['id_variante', 'nombre', 'clave', 'duracion_min', 'precio', 'orden'] }]
                : [],
            order: [['nombre', 'ASC']],
        }),
        Models.ReservaProfesional.findAll({
            where: { id_negocio: idNegocio, estado: 'A' },
            attributes: ['id_profesional', 'nombre', 'especialidad', 'foto_url', 'color_hex',
                         'telefono'],
            order: [['nombre', 'ASC']],
        }),
        Models.ReservaHorario.findAll({
            where: { id_negocio: idNegocio },
            attributes: ['id_profesional', 'dia_semana', 'hora_inicio', 'hora_fin'],
            raw: true,
        }),
        Models.ReservaCategoria.findAll({
            where: { id_negocio: idNegocio, estado: 'A' },
            attributes: ['id_categoria', 'nombre', 'descripcion', 'orden'],
            order: [['orden', 'ASC'], ['nombre', 'ASC']],
            raw: true,
        }),
    ]);

    // La tabla puente no declara asociación hacia `ReservaProfesional`, así que se filtra por
    // los ids ya cargados en vez de por un join. Da igual: el conjunto es el de este negocio.
    const idsProfesionales = profesionales.map(p => p.id_profesional);
    const relaciones = idsProfesionales.length
        ? await Models.ReservaProfesionalServicio.findAll({
            where: { id_profesional: idsProfesionales },
            attributes: ['id_profesional', 'id_servicio'],
            raw: true,
        })
        : [];

    // Un profesional **sin ninguna** asignación ofrece todo el catálogo: es la misma convención
    // que usa `listarProfesionales` y la que espera `citaService` al validar la reserva. Si aquí
    // se mostrara vacío, el cliente creería que ese profesional no atiende nada.
    const serviciosPorProfesional = new Map();
    for (const r of relaciones) {
        if (!serviciosPorProfesional.has(r.id_profesional)) serviciosPorProfesional.set(r.id_profesional, []);
        serviciosPorProfesional.get(r.id_profesional).push(r.id_servicio);
    }
    const idsServiciosActivos = servicios.map(s => s.id_servicio);
    const setActivos = new Set(idsServiciosActivos);

    const horariosGenerales = horarios.filter(h => h.id_profesional == null);
    const horariosPorProfesional = new Map();
    for (const h of horarios.filter(x => x.id_profesional != null)) {
        if (!horariosPorProfesional.has(h.id_profesional)) horariosPorProfesional.set(h.id_profesional, []);
        horariosPorProfesional.get(h.id_profesional).push(h);
    }

    const profesionalesSalida = profesionales.map(p => {
        const asignados = serviciosPorProfesional.get(p.id_profesional);
        const idsServicios = asignados
            ? asignados.filter(id => setActivos.has(id))
            : [...idsServiciosActivos];
        return {
            id_profesional: p.id_profesional,
            nombre: p.nombre,
            especialidad: limpio(p.especialidad),
            foto_url: p.foto_url,
            color_hex: p.color_hex,
            ofrece_todo: !asignados,
            // El enlace, no el número: la página solo necesita a dónde lleva el botón, y armar el
            // `wa.me` aquí deja la regla —qué es un móvil en cada país— en un único sitio.
            // `null` cuando el teléfono no se reconoce, y eso es lo que hace que el botón no se
            // pinte en vez de pintarse roto.
            whatsapp: urlWhatsapp(p.telefono, negocio.pais),
            id_servicios: idsServicios,
            horario: horarioEfectivo(horariosPorProfesional.get(p.id_profesional) || [], horariosGenerales),
        };
    });

    // El inverso, para que la portada pueda decir «con 3 profesionales» bajo cada servicio sin
    // recorrer el array de profesionales en cada tarjeta.
    const profesionalesPorServicio = new Map();
    for (const p of profesionalesSalida) {
        for (const id of p.id_servicios) {
            if (!profesionalesPorServicio.has(id)) profesionalesPorServicio.set(id, []);
            profesionalesPorServicio.get(id).push(p.id_profesional);
        }
    }

    const serviciosSalida = servicios.map(s => ({
        id_servicio: s.id_servicio,
        nombre: s.nombre,
        descripcion: limpio(s.descripcion),
        duracion_min: s.duracion_min,
        precio: Number(s.precio),
        color_hex: s.color_hex,
        imagen_url: s.imagen_url,
        id_categoria: s.id_categoria ?? null,
        id_profesionales: profesionalesPorServicio.get(s.id_servicio) || [],
        // Solo con la función encendida: sin ella el servicio se reserva con su precio de lista.
        a_cotizar: fx.has('a_cotizar') && !!s.a_cotizar,
        // El rango NO depende de la función «a cotizar»: es una forma de presentar el precio
        // («$25.000 - $40.000» según el largo del cabello) que cualquier negocio puede querer,
        // tenga o no servicios que se cotizan aparte. Lo enciende el servicio, no el rubro.
        precio_min: s.precio_min != null ? Number(s.precio_min) : null,
        precio_max: s.precio_max != null ? Number(s.precio_max) : null,
        variantes: fx.has('variantes')
            ? (s.variantes || [])
                .sort((a, b) => a.orden - b.orden || a.duracion_min - b.duracion_min)
                .map(v => ({
                    id_variante: v.id_variante, nombre: v.nombre, clave: v.clave,
                    duracion_min: v.duracion_min, precio: Number(v.precio),
                }))
            : [],
    }));

    // Galería de cada servicio: varias fotos aparte de la portada (`imagen_url`), para el
    // carrusel del detalle. Sin función que la gatee: es una capacidad general del catálogo, no
    // un perfil de rubro opcional.
    const galerias = new Map();
    if (idsServiciosActivos.length) {
        const imagenes = await Models.ReservaServicioImagen.findAll({
            where: { id_servicio: idsServiciosActivos, id_negocio: idNegocio },
            attributes: ['id_servicio', 'url', 'descripcion'],
            order: [['orden', 'ASC'], ['id_imagen', 'ASC']],
            raw: true,
        });
        for (const i of imagenes) {
            if (!galerias.has(i.id_servicio)) galerias.set(i.id_servicio, []);
            galerias.get(i.id_servicio).push({ url: i.url, descripcion: i.descripcion });
        }
    }
    for (const s of serviciosSalida) s.galeria = galerias.get(s.id_servicio) || [];

    // Portafolio: hasta doce trabajos por profesional, en su orden.
    const portafolios = new Map();
    if (fx.has('portafolio') && idsProfesionales.length) {
        const imagenes = await Models.ReservaProfesionalImagen.findAll({
            where: { id_profesional: idsProfesionales, id_negocio: idNegocio },
            attributes: ['id_profesional', 'url', 'descripcion'],
            order: [['orden', 'ASC'], ['id_imagen', 'ASC']],
            raw: true,
        });
        for (const i of imagenes) {
            if (!portafolios.has(i.id_profesional)) portafolios.set(i.id_profesional, []);
            const lista = portafolios.get(i.id_profesional);
            if (lista.length < 12) lista.push({ url: i.url, descripcion: i.descripcion });
        }
    }
    for (const p of profesionalesSalida) p.portafolio = portafolios.get(p.id_profesional) || [];

    // Alojamiento y hotel de mascotas: los tipos de unidad que se reservan por noches.
    const unidadesTipo = perfil.modos.includes('ESTANCIA')
        ? (await Models.ReservaUnidadTipo.findAll({
            where: { id_negocio: idNegocio, estado: 'A' },
            attributes: ['id_unidad_tipo', 'nombre', 'descripcion', 'ocupacion_base', 'capacidad_max',
                         'tarifa_base', 'tarifa_fin_semana', 'tarifa_persona_extra', 'min_noches',
                         'comodidades', 'imagen_url', 'orden'],
            order: [['orden', 'ASC'], ['nombre', 'ASC']],
        })).map(u => ({
            ...u.toJSON(),
            tarifa_base: Number(u.tarifa_base),
            tarifa_fin_semana: u.tarifa_fin_semana == null ? null : Number(u.tarifa_fin_semana),
            tarifa_persona_extra: Number(u.tarifa_persona_extra),
        }))
        : [];

    // Secciones del portal, en el orden que fijó el negocio. Una categoría sin servicios activos
    // no se publica —una sección vacía solo hace ruido— y los servicios sin clasificar caen en
    // «Otros servicios» al final, para que ninguno desaparezca por no tener categoría.
    const secciones = categorias
        .map(c => ({
            id_categoria: c.id_categoria,
            nombre: c.nombre,
            descripcion: limpio(c.descripcion),
            servicios: serviciosSalida.filter(s => s.id_categoria === c.id_categoria),
        }))
        .filter(sec => sec.servicios.length > 0);

    const sinCategoria = serviciosSalida.filter(s => s.id_categoria == null);
    if (sinCategoria.length) {
        secciones.push({
            id_categoria: null,
            // Si no hay ninguna categoría definida, el catálogo entero cae aquí y llamarlo
            // «Otros» sería absurdo: es, simplemente, los servicios.
            nombre: secciones.length ? 'Otros servicios' : 'Servicios',
            descripcion: null,
            servicios: sinCategoria,
        });
    }

    return {
        negocio: {
            id_negocio: negocio.id_negocio,
            nombre: negocio.nombre,
            slug: negocio.slug ?? null,
            descripcion: limpio(cfg.descripcion_publica),
            logo_url: negocio.logo_url,
            banner_url: negocio.banner_url,
            colores: negocio.colores ?? null,
            paleta: negocio.paletaColor || null,
            email_contacto: limpio(negocio.email_contacto),
            telefono: limpio(negocio.telefono),
            direccion: limpio(negocio.direccion),
            redes: {
                whatsapp: limpio(negocio.url_whatsapp),
                facebook: limpio(negocio.url_facebook),
                instagram: limpio(negocio.url_instagram),
                tiktok: limpio(negocio.url_tiktok),
            },
            // La portada es pública: no hay sesión de la que sacar la moneda, así que viaja
            // aquí. Sin esto, un negocio chileno publicaría sus precios en pesos colombianos.
            moneda: monedaDePais(negocio.pais),
            // Y por lo mismo, el país: es el que sugiere el selector de indicativo al cliente
            // que agenda (ver `TelefonoPaisComponent` / `paisPorMetadatos`).
            pais: codigoPais(negocio.pais) || 'CO',
        },
        reglas: {
            anticipacion_min_horas: cfg.anticipacion_min_horas,
            ventana_cancelacion_horas: cfg.ventana_cancelacion_horas,
            paso_slot_min: cfg.paso_slot_min,
            cobro_adelantado: cfg.cobro_adelantado,
            // Abono (perfiles con depósito) o total (el cobro adelantado de siempre). El portal
            // lo lee de aquí en vez de mirar solo `cobro_adelantado`.
            pago: politicaDePago({ cfg, funciones: fx }),
            instrucciones_pago: politicaDePago({ cfg, funciones: fx }).modo !== 'ninguno'
                ? limpio(cfg.instrucciones_pago) : null,
            requiere_mascota: fx.has('mascotas'),
            hora_checkin: String(cfg.hora_checkin || '15:00').slice(0, 5),
            hora_checkout: String(cfg.hora_checkout || '12:00').slice(0, 5),
        },
        perfil: {
            clave: perfil.clave,
            rubro: perfil.rubro,
            modos: perfil.modos,
            funciones: perfil.funciones,
            terminos: perfil.terminos,
            portal: perfil.portal,
        },
        unidades_tipo: unidadesTipo,
        horario_negocio: horarioEfectivo([], horariosGenerales),
        // `servicios` va plano **además** de `secciones`: el buscador y la página de un servicio
        // suelto lo necesitan sin tener que recorrer las secciones. Las secciones son la misma
        // lista agrupada, no una copia distinta.
        servicios: serviciosSalida,
        secciones,
        profesionales: profesionalesSalida,
    };
}

// ───────────────────────── Edición desde la consola del negocio ─────────────────────────

const URL_MAX = 300;

/**
 * Normaliza lo que el dueño escribe en el campo de una red social.
 *
 * Nadie copia la URL canónica: escriben `@minegocio`, `minegocio`, `fb.com/minegocio` o pegan
 * el enlace entero con `?fbclid=...`. Rechazar todo eso por no ser una URL válida convierte un
 * formulario de dos minutos en una pelea. Se acepta cualquiera de esas formas y se guarda
 * siempre una URL absoluta, que es lo único que el `href` de la página pública puede usar.
 *
 * WhatsApp es aparte: lo que se guarda es un número, y el enlace se arma con `wa.me`.
 */
function normalizarRed(red, valor, pais) {
    const v = String(valor ?? '').trim();
    if (!v) return null;

    if (red === 'whatsapp') {
        // Móvil del país del negocio (el mismo que decide el teléfono de contacto): antes se
        // asumía Colombia siempre, y un WhatsApp chileno o mexicano guardaba un número sin
        // indicativo que `wa.me` no sabía abrir. Ver `app_core/helpers/telefono.js`.
        const enlace = urlWhatsapp(v, pais);
        if (!enlace) throw error('El número de WhatsApp no parece un móvil válido para tu país.', 422);
        return enlace;
    }

    if (/^https?:\/\//i.test(v)) {
        if (v.length > URL_MAX) throw error('El enlace es demasiado largo.', 422);
        return v;
    }
    // `@usuario`, `usuario` o `instagram.com/usuario` → URL absoluta del perfil.
    const usuario = v.replace(/^@/, '').replace(/^(www\.)?(facebook|fb|instagram|tiktok)\.com\/@?/i, '').replace(/\/+$/, '');
    if (!/^[A-Za-z0-9._-]{1,60}$/.test(usuario)) {
        throw error(`El usuario de ${red} solo puede tener letras, números, puntos, guiones o guion bajo.`, 422);
    }
    // TikTok exige la arroba **dentro** de la URL: `tiktok.com/minegocio` es un 404. Quien pegue
    // el enlace de su perfil la traerá ya puesta, y el limpiado de arriba la quita para no
    // acabar con dos.
    if (red === 'tiktok') return `https://www.tiktok.com/@${usuario}`;

    const dominio = red === 'facebook' ? 'facebook.com' : 'instagram.com';
    return `https://${dominio}/${usuario}`;
}

/** Contenido editable de la página pública: contacto, redes, presentación e interruptor. */
async function getVitrinaEdicion(idNegocio) {
    const negocio = await Models.GenerNegocio.findByPk(idNegocio, {
        attributes: ['id_negocio', 'nombre', 'email_contacto', 'telefono', 'direccion', 'pais',
                     'url_whatsapp', 'url_facebook', 'url_instagram', 'url_tiktok'],
    });
    if (!negocio) throw error('Negocio no encontrado.');
    const cfg = await ConfigService.get(idNegocio);

    return {
        id_negocio: negocio.id_negocio,
        nombre: negocio.nombre,
        email_contacto: negocio.email_contacto,
        pais: codigoPais(negocio.pais) || 'CO',
        telefono: negocio.telefono,
        direccion: negocio.direccion,
        url_whatsapp: negocio.url_whatsapp,
        url_facebook: negocio.url_facebook,
        url_instagram: negocio.url_instagram,
        url_tiktok: negocio.url_tiktok,
        descripcion_publica: cfg.descripcion_publica,
        publico_activo: cfg.publico_activo !== false,
    };
}

/**
 * Guarda el contenido de la página pública.
 *
 * ## Un campo ausente no es un campo vacío
 *
 * El formulario manda siempre los siete campos, así que un PUT «de reemplazo total» funciona
 * con él. Pero convierte cualquier otra llamada en una bomba: mandar solo `{telefono}` borraba
 * la dirección, las tres redes y la presentación sin que nadie lo pidiera. Aquí **ausente**
 * (`undefined`) significa «no lo toques» y **vacío** (`''`) significa «bórralo», que es lo que
 * el formulario manda cuando el usuario limpia el campo. Así se puede vaciar a propósito sin
 * que se vacíe por accidente.
 */
async function guardarVitrina(idNegocio, datos) {
    const negocio = await Models.GenerNegocio.findByPk(idNegocio);
    if (!negocio) throw error('Negocio no encontrado.');

    const cambiosNegocio = {};

    if (datos.telefono !== undefined) {
        const telefono = String(datos.telefono ?? '').trim();
        if (telefono && !/^[\d\s+()-]{7,30}$/.test(telefono)) {
            throw error('El teléfono solo puede tener números, espacios y los signos + ( ) -.', 422);
        }
        cambiosNegocio.telefono = telefono || null;
    }

    // El país viaja con el mismo formulario (el selector del teléfono de contacto) pero es
    // columna de `gener_negocio`, la misma que edita Cobros: un negocio tiene un solo país,
    // lo cambie desde la pestaña que lo cambie. Ver configService.js.
    if (datos.pais !== undefined && datos.pais !== null && String(datos.pais).trim() !== '') {
        const codigo = codigoPais(datos.pais);
        if (!codigo) throw error('País no soportado.', 422);
        cambiosNegocio.pais = codigo;
    }

    if (datos.direccion !== undefined) {
        const direccion = String(datos.direccion ?? '').trim();
        if (direccion.length > 255) throw error('La dirección es demasiado larga.', 422);
        cambiosNegocio.direccion = direccion || null;
    }

    // El país para normalizar el WhatsApp: el que llega en esta misma petición si lo cambian
    // aquí, si no el que ya tenía el negocio.
    const paisEfectivo = cambiosNegocio.pais || negocio.pais;

    for (const [campo, red] of [['url_whatsapp', 'whatsapp'], ['url_facebook', 'facebook'],
                                ['url_instagram', 'instagram'], ['url_tiktok', 'tiktok']]) {
        if (datos[campo] !== undefined) cambiosNegocio[campo] = normalizarRed(red, datos[campo], paisEfectivo);
    }

    if (Object.keys(cambiosNegocio).length) await Models.sequelize.transaction((t) => negocio.update(cambiosNegocio, { transaction: t }));

    const cambiosConfig = {};
    if (datos.descripcion_publica !== undefined) {
        const descripcion = String(datos.descripcion_publica ?? '').trim();
        if (descripcion.length > 1200) throw error('La presentación no puede pasar de 1200 caracteres.', 422);
        cambiosConfig.descripcion_publica = descripcion || null;
    }
    if (datos.publico_activo !== undefined) cambiosConfig.publico_activo = datos.publico_activo !== false;

    if (Object.keys(cambiosConfig).length) {
        const cfg = await ConfigService.get(idNegocio);
        await Models.sequelize.transaction((t) => cfg.update({ ...cambiosConfig, fecha_actualizacion: new Date() }, { transaction: t }));
    }

    return getVitrinaEdicion(idNegocio);
}

/**
 * `id_negocio` a partir de su `slug`, con las mismas reglas de visibilidad que `getVitrina`
 * (inactivo o sin publicar = como si no existiera). La usan dos cosas distintas:
 *
 *   - el front, para traducir `dalex-barberia.escalapp.cloud` a `/p/:id_negocio` sin que el
 *     dueño tenga que compartir nunca ese número;
 *   - Caddy, como `ask` del TLS on-demand del bloque `*.escalapp.cloud`: sin esto, cualquiera
 *     podría hacer que el servidor pidiera un certificado para un subdominio inventado.
 */
async function resolverSlug(slug) {
    const limpio = String(slug || '').trim().toLowerCase();
    if (!limpio) return null;

    const negocio = await Models.GenerNegocio.findOne({
        where: Models.sequelize.where(
            Models.sequelize.fn('lower', Models.sequelize.col('slug')), limpio,
        ),
        attributes: ['id_negocio', 'estado'],
        include: [INCLUDE_TIPO_RESERVA],
    });
    if (!negocio || negocio.estado !== 'A' || !esModuloReserva(negocio.tipoNegocio)) return null;

    const cfg = await ConfigService.get(negocio.id_negocio);
    if (cfg.publico_activo === false) return null;

    return { id_negocio: negocio.id_negocio };
}

/**
 * Datos para el manifest del portal público (`Add to Home Screen`): que el acceso directo lleve
 * el logo del negocio, no el pulpo de EscalApp. Mismas reglas de visibilidad que `getVitrina` —
 * un negocio que escondió su página tampoco publica un icono.
 */
async function getManifestData(idNegocio, { exigirPublico = true } = {}) {
    const negocio = await Models.GenerNegocio.findOne({
        where: { id_negocio: idNegocio, estado: 'A' },
        attributes: ['id_negocio', 'nombre', 'logo_url', 'colores', 'slug'],
        include: [
            INCLUDE_TIPO_RESERVA,
            { model: Models.GenerPaletaColor, as: 'paletaColor', attributes: ['colores'], required: false },
        ],
    });
    if (!negocio || !esModuloReserva(negocio.tipoNegocio)) throw error('Página no disponible.');

    // El icono de la CONSOLA no depende de que la vitrina esté publicada: un negocio puede tener
    // su página escondida y aun así querer su marca en el acceso directo con el que su gente
    // entra a trabajar todos los días.
    if (exigirPublico) {
        const cfg = await ConfigService.get(idNegocio);
        if (cfg.publico_activo === false) throw error('Página no disponible.');
    }

    const colores = negocio.colores || negocio.paletaColor?.colores || null;
    return {
        id_negocio: negocio.id_negocio,
        nombre: negocio.nombre,
        logo_url: negocio.logo_url,
        slug: negocio.slug ?? null,
        color_primario: colores?.primario ?? colores?.primary ?? null,
    };
}

module.exports = {
    getVitrina, getVitrinaEdicion, guardarVitrina, normalizarRed, horarioEfectivo,
    resolverSlug, getManifestData,
};
