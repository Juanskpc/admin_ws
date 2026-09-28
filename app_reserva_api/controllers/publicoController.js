'use strict';
const { validationResult } = require('express-validator');
const Models = require('../../app_core/models/conection');
const DisponibilidadService = require('../services/disponibilidadService');
const CitaService = require('../services/citaService');
const VitrinaService = require('../services/vitrinaService');
const VentaProductoService = require('../services/ventaProductoService');
const AgendaServicio = require('../services/agendaServicioService');
const Respuesta = require('../../app_core/helpers/respuesta');
const Perfiles = require('../perfiles');
const EstanciaService = require('../services/estancia/estanciaService');
const EstanciaCtrl = require('./estanciaController');
const { politicaDePago } = require('../services/abono');

/** Un campo que en multipart llega como texto JSON y en JSON como objeto. */
function objetoDe(valor) {
    if (valor == null || valor === '') return null;
    if (typeof valor === 'object') return valor;
    try { return JSON.parse(String(valor)); } catch { return null; }
}

function check(req, res) {
    const e = validationResult(req);
    if (!e.isEmpty()) { Respuesta.error(res, 'Datos inválidos', 422, e.array()); return false; }
    return true;
}

/** GET /reserva/publico/:id_negocio/info */
async function getInfoNegocio(req, res) {
    try {
        const idNegocio = Number(req.params.id_negocio);
        const negocio = await Models.GenerNegocio.findOne({
            where: { id_negocio: idNegocio, estado: 'A' },
            attributes: ['id_negocio', 'nombre', 'email_contacto', 'id_paleta', 'logo_url', 'colores', 'slug'],
            include: [
                // El módulo, no el nombre: un negocio anterior a los rubros guarda aquí su
                // oficio (BARBERIA) y con el filtro por nombre su página salía «no disponible».
                { model: Models.GenerTipoNegocio, as: 'tipoNegocio', attributes: ['nombre'], required: true,
                  include: [{ model: Models.GenerTipoNegocio, as: 'modulo', attributes: ['nombre'], required: false }] },
                { model: Models.GenerPaletaColor, as: 'paletaColor',
                  attributes: ['id_paleta', 'nombre', 'colores'] },
            ],
        });
        const tipo = negocio?.tipoNegocio;
        if (!negocio || !(tipo?.nombre === 'RESERVA' || tipo?.modulo?.nombre === 'RESERVA')) {
            return Respuesta.error(res, 'Negocio no disponible', 404);
        }

        const cfg = await DisponibilidadService.getConfig(idNegocio);
        const perfil = await Perfiles.perfilDeNegocio(idNegocio, { funciones: cfg.funciones || {} });
        const pago = politicaDePago({ cfg, funciones: perfil.funciones });
        return Respuesta.success(res, 'Info del negocio', {
            id_negocio: negocio.id_negocio,
            nombre: negocio.nombre,
            slug: negocio.slug,
            email_contacto: negocio.email_contacto,
            logo_url: negocio.logo_url,
            // `colores` manda sobre la paleta; ambos viajan para que el cliente no tenga que
            // adivinar cuál aplicar cuando solo hay uno de los dos.
            colores: negocio.colores ?? null,
            paleta: negocio.paletaColor || null,
            cobro_adelantado: cfg.cobro_adelantado,
            instrucciones_pago: pago.modo !== 'ninguno' ? cfg.instrucciones_pago : null,
            pago,
            anticipacion_min_horas: cfg.anticipacion_min_horas,
            ventana_cancelacion_horas: cfg.ventana_cancelacion_horas,
            perfil: { clave: perfil.clave, modos: perfil.modos, terminos: perfil.terminos, portal: perfil.portal },
        });
    } catch (err) {
        console.error('[Reserva/Publico] info:', err.message);
        return Respuesta.error(res, 'Error al obtener info del negocio.');
    }
}

/** GET /reserva/publico/:id_negocio/servicios */
async function listarServicios(req, res) {
    try {
        const idNegocio = Number(req.params.id_negocio);
        const servicios = await Models.ReservaServicio.findAll({
            where: { id_negocio: idNegocio, estado: 'A' },
            attributes: ['id_servicio', 'nombre', 'descripcion', 'duracion_min', 'precio', 'color_hex', 'imagen_url'],
            order: [['nombre', 'ASC']],
        });
        return Respuesta.success(res, 'Servicios disponibles', servicios);
    } catch (err) {
        console.error('[Reserva/Publico] servicios:', err.message);
        return Respuesta.error(res, 'Error al obtener servicios.');
    }
}

/** GET /reserva/publico/:id_negocio/profesionales?id_servicio= */
async function listarProfesionales(req, res) {
    try {
        const idNegocio = Number(req.params.id_negocio);
        const idServicio = req.query.id_servicio ? Number(req.query.id_servicio) : null;

        const where = { id_negocio: idNegocio, estado: 'A' };
        const include = [];
        if (idServicio) {
            // Profesionales que tienen el servicio asignado, o sin asignaciones (consideran ofrecer todos)
            include.push({
                model: Models.ReservaServicio, as: 'servicios',
                attributes: ['id_servicio'], through: { attributes: [] },
                where: { id_servicio: idServicio, estado: 'A' },
                required: false,
            });
        }

        const profesionales = await Models.ReservaProfesional.findAll({
            where, include,
            attributes: ['id_profesional', 'nombre', 'especialidad', 'foto_url', 'color_hex'],
            order: [['nombre', 'ASC']],
        });

        let resultado = profesionales;
        if (idServicio) {
            // Si el profesional tiene servicios asignados pero ninguno coincide, lo excluimos.
            // Si no tiene asignaciones, lo incluimos (ofrece todos).
            const ids = profesionales.map(p => p.id_profesional);
            const conAsignacion = await Models.ReservaProfesionalServicio.findAll({
                where: { id_profesional: ids },
                attributes: ['id_profesional'],
                group: ['id_profesional'],
            });
            const setConAsignacion = new Set(conAsignacion.map(r => r.id_profesional));
            resultado = profesionales.filter(p => {
                const tieneCoincidencia = (p.servicios || []).length > 0;
                return tieneCoincidencia || !setConAsignacion.has(p.id_profesional);
            }).map(p => {
                const o = p.toJSON(); delete o.servicios; return o;
            });
        }

        return Respuesta.success(res, 'Profesionales disponibles', resultado);
    } catch (err) {
        console.error('[Reserva/Publico] profesionales:', err.message);
        return Respuesta.error(res, 'Error al obtener profesionales.');
    }
}

/** GET /reserva/publico/:id_negocio/disponibilidad?fecha=&id_servicio=&id_profesional= */
async function getDisponibilidad(req, res) {
    if (!check(req, res)) return;
    try {
        const idNegocio = Number(req.params.id_negocio);
        const data = await DisponibilidadService.calcularSlots({
            idNegocio,
            idServicio:    req.query.id_servicio ? Number(req.query.id_servicio) : undefined,
            idServicios:   req.query.id_servicios,
            idProfesional: Number(req.query.id_profesional),
            fechaISO:      String(req.query.fecha),
        });
        return Respuesta.success(res, 'Slots calculados', data);
    } catch (err) {
        if (err.statusCode) return Respuesta.error(res, err.message, err.statusCode);
        console.error('[Reserva/Publico] disponibilidad:', err.message);
        return Respuesta.error(res, 'Error al calcular disponibilidad.');
    }
}

/**
 * GET /reserva/publico/:id_negocio/dias?id_profesional=&desde=&hasta=
 *
 * Qué días del rango atiende ese profesional. El calendario del asistente lo necesita para no
 * ofrecer un martes que está bloqueado por vacaciones: el horario semanal que publica la
 * vitrina no sabe de bloqueos, y esto sí —sale de `reglasAgenda`, la misma fuente que decide
 * si una cita se acepta.
 */
async function getDiasDisponibles(req, res) {
    if (!check(req, res)) return;
    try {
        const data = await DisponibilidadService.diasDisponibles({
            idNegocio: Number(req.params.id_negocio),
            idProfesional: req.query.id_profesional ? Number(req.query.id_profesional) : null,
            desde: String(req.query.desde),
            hasta: String(req.query.hasta),
        });
        return Respuesta.success(res, 'Días calculados', data);
    } catch (err) {
        if (err.statusCode) return Respuesta.error(res, err.message, err.statusCode);
        console.error('[Reserva/Publico] dias:', err.message);
        return Respuesta.error(res, 'Error al calcular los días disponibles.');
    }
}

/**
 * GET /reserva/publico/:id_negocio/servicio/:id_servicio/dias?desde=&hasta=
 *
 * Qué días atiende **alguien** que haga ese servicio. Es lo que pinta el calendario de la
 * página del servicio con una sola petición en vez de una por profesional.
 */
async function getDiasDeServicio(req, res) {
    if (!check(req, res)) return;
    try {
        const data = await AgendaServicio.diasDelServicio({
            idNegocio: Number(req.params.id_negocio),
            idServicio: Number(req.params.id_servicio),
            desde: String(req.query.desde),
            hasta: String(req.query.hasta),
            idVariante: req.query.id_variante ? Number(req.query.id_variante) : null,
        });
        return Respuesta.success(res, 'Días del servicio', data);
    } catch (err) {
        if (err.statusCode) return Respuesta.error(res, err.message, err.statusCode);
        console.error('[Reserva/Publico] diasServicio:', err.message);
        return Respuesta.error(res, 'Error al calcular los días disponibles.');
    }
}

/** GET /reserva/publico/:id_negocio/servicio/:id_servicio/slots?fecha= */
async function getSlotsDeServicio(req, res) {
    if (!check(req, res)) return;
    try {
        const data = await AgendaServicio.slotsDelServicio({
            idNegocio: Number(req.params.id_negocio),
            idServicio: Number(req.params.id_servicio),
            fechaISO: String(req.query.fecha),
            idVariante: req.query.id_variante ? Number(req.query.id_variante) : null,
        });
        return Respuesta.success(res, 'Horas disponibles', data);
    } catch (err) {
        if (err.statusCode) return Respuesta.error(res, err.message, err.statusCode);
        console.error('[Reserva/Publico] slotsServicio:', err.message);
        return Respuesta.error(res, 'Error al calcular las horas disponibles.');
    }
}

/** POST /reserva/publico/:id_negocio/cita  (multipart si requiere comprobante) */
async function crearCitaPublica(req, res) {
    if (!check(req, res)) return;
    try {
        const idNegocio = Number(req.params.id_negocio);
        // Cuando es multipart, los arrays llegan como strings repetidos o JSON. Normalizamos:
        let idServicios = req.body.id_servicios;
        if (typeof idServicios === 'string') {
            try { idServicios = JSON.parse(idServicios); }
            catch { idServicios = idServicios.split(',').map(s => Number(s.trim())).filter(Boolean); }
        }
        if (!Array.isArray(idServicios)) idServicios = [Number(idServicios)].filter(Boolean);

        const comprobantePath = req.file
            ? `/uploads/reserva/comprobantes/${idNegocio}/${req.file.filename}`
            : null;

        const cita = await CitaService.crearCita({
            idNegocio,
            idProfesional:      Number(req.body.id_profesional),
            idServicios:        idServicios.map(Number),
            fechaHoraInicioISO: String(req.body.fecha_hora_inicio),
            clienteNombre:      String(req.body.cliente_nombre),
            clienteTelefono:    req.body.cliente_telefono ? String(req.body.cliente_telefono) : null,
            clientePais:        req.body.cliente_pais ? String(req.body.cliente_pais).toUpperCase() : null,
            clienteEmail:       req.body.cliente_email ? String(req.body.cliente_email) : null,
            notas:              req.body.notas ? String(req.body.notas) : null,
            comprobantePath,
            creadoPorIdUsuario: null,    // flujo público
            // Perfiles de rubro: la variante elegida (largo, tamaño) y la mascota descrita por
            // el dueño. En multipart llegan como texto JSON.
            variantes:          objetoDe(req.body.variantes),
            mascota:            objetoDe(req.body.mascota),
        });

        return Respuesta.success(res, 'Cita creada', formatearCitaPublica(cita), 201);
    } catch (err) {
        if (err.statusCode) {
            return Respuesta.error(res, err.message, err.statusCode,
                err.code ? [{ code: err.code }] : null);
        }
        console.error('[Reserva/Publico] crearCita:', err.message);
        return Respuesta.error(res, 'Error al crear la cita.');
    }
}

/**
 * POST /reserva/publico/:id_negocio/venta-producto
 *
 * Comprar productos del portal sin necesidad de una cita: el cliente arma su carrito, elige
 * recoger en el local (única entrega hoy — domicilio queda para más adelante) y dice quién
 * recoge y a qué contacto avisarle. Queda PENDIENTE hasta que el negocio la cobra al entregarla,
 * igual que un pedido de la carta digital en restaurante.
 */
async function crearVentaProductoPublica(req, res) {
    if (!check(req, res)) return;
    try {
        const venta = await VentaProductoService.crear({
            idNegocio: Number(req.params.id_negocio),
            items: req.body.items,
            canal: 'PORTAL',
            entrega: 'RECOGER',
            clienteNombre: String(req.body.cliente_nombre),
            clienteTelefono: req.body.cliente_telefono ? String(req.body.cliente_telefono) : null,
            notas: req.body.notas ? String(req.body.notas) : null,
        });
        return Respuesta.success(res, 'Pedido registrado. Te esperamos para entregarlo.', {
            id_venta: venta.id_venta,
            total: Number(venta.total),
            estado: venta.estado,
        }, 201);
    } catch (err) {
        if (err.statusCode) {
            return Respuesta.error(res, err.message, err.statusCode, err.code ? [{ code: err.code }] : null);
        }
        console.error('[Reserva/Publico] crearVentaProducto:', err.message);
        return Respuesta.error(res, 'Error al registrar el pedido.');
    }
}

/** GET /reserva/publico/cita/:codigo_publico */
async function consultarCita(req, res) {
    try {
        const cita = await CitaService.getCitaPorCodigo(String(req.params.codigo_publico));
        if (cita) return Respuesta.success(res, 'Cita encontrada', formatearCitaPublica(cita));
        // El mismo código sirve para una estancia (alojamiento): «Mi reserva» no tiene por qué
        // saber de antemano cuál de las dos es. Los códigos son únicos entre ambas tablas.
        const estancia = await EstanciaService.porCodigo(String(req.params.codigo_publico));
        if (estancia) return Respuesta.success(res, 'Reserva encontrada', EstanciaCtrl.formatearPublica(estancia));
        return Respuesta.error(res, 'Cita no encontrada', 404);
    } catch (err) {
        console.error('[Reserva/Publico] consultar:', err.message);
        return Respuesta.error(res, 'Error al consultar la cita.');
    }
}

/** POST /reserva/publico/cita/:codigo_publico/cancelar */
async function cancelarCitaPublica(req, res) {
    try {
        const motivo = req.body?.motivo ? String(req.body.motivo) : null;
        const codigo = String(req.params.codigo_publico);
        if (!(await CitaService.getCitaPorCodigo(codigo)) && (await EstanciaService.porCodigo(codigo))) {
            const e = await EstanciaService.cancelarPorCliente(codigo, motivo);
            return Respuesta.success(res, 'Reserva cancelada', { id_estancia: e.id_estancia, estado: e.estado });
        }
        const cita = await CitaService.cancelarPorCliente(codigo, motivo);
        return Respuesta.success(res, 'Cita cancelada', { id_cita: cita.id_cita, estado: cita.estado });
    } catch (err) {
        if (err.statusCode) return Respuesta.error(res, err.message, err.statusCode,
            err.code ? [{ code: err.code }] : null);
        console.error('[Reserva/Publico] cancelar:', err.message);
        return Respuesta.error(res, 'Error al cancelar la cita.');
    }
}

function formatearCitaPublica(cita) {
    const j = cita.toJSON ? cita.toJSON() : cita;
    return {
        id_cita: j.id_cita,
        codigo_publico: j.codigo_publico,
        estado: j.estado,
        pago_estado: j.pago_estado,
        requiere_pago: j.requiere_pago,
        fecha_hora_inicio: j.fecha_hora_inicio,
        fecha_hora_fin: j.fecha_hora_fin,
        cliente_nombre: j.cliente_nombre,
        cliente_telefono: j.cliente_telefono,
        cliente_email: j.cliente_email,
        notas: j.notas,
        monto_total: Number(j.monto_total || 0),
        monto_abono: j.monto_abono == null ? null : Number(j.monto_abono),
        profesional: j.profesional,
        mascota: j.mascota ? { nombre: j.mascota.nombre, especie: j.mascota.especie } : null,
        servicios: (j.servicios || []).map(cs => ({
            id_servicio: cs.id_servicio,
            nombre: cs.servicio?.nombre,
            variante: cs.variante_snapshot || null,
            precio: Number(cs.precio_snapshot),
            duracion_min: cs.duracion_snapshot_min,
        })),
        negocio: j.negocio || undefined,
    };
}


/**
 * GET /reserva/publico/:id_negocio/vitrina
 *
 * Todo lo que la página pública necesita para pintarse de una vez: negocio, contacto, redes,
 * servicios, profesionales y el horario de atención de cada uno. Ver `vitrinaService`.
 */
async function getVitrina(req, res) {
    if (!check(req, res)) return;
    try {
        const data = await VitrinaService.getVitrina(Number(req.params.id_negocio));
        return Respuesta.success(res, 'Vitrina del negocio', data);
    } catch (err) {
        if (err.statusCode) return Respuesta.error(res, err.message, err.statusCode);
        console.error('[Reserva/Publico] vitrina:', err.message);
        return Respuesta.error(res, 'Error al cargar la página del negocio.');
    }
}

/**
 * GET /reserva/publico/dominio/:slug
 *
 * Traduce la URL propia del negocio a su `id_negocio`, para que el front pueda pintar la misma
 * vitrina de `/p/:id_negocio` sin que ese número aparezca nunca en `dalex-barberia.escalapp.cloud`.
 * Ver `subdominio.guard.ts` en `reserva_app`.
 */
async function getPorDominio(req, res) {
    if (!check(req, res)) return;
    try {
        const data = await VitrinaService.resolverSlug(req.params.slug);
        if (!data) return Respuesta.error(res, 'Página no disponible', 404);
        return Respuesta.success(res, 'Negocio', data);
    } catch (err) {
        console.error('[Reserva/Publico] porDominio:', err.message);
        return Respuesta.error(res, 'Error al resolver el dominio.');
    }
}

/**
 * GET /reserva/publico/verificar-dominio?domain=dalex-barberia.escalapp.cloud
 *
 * El `ask` del TLS on-demand de Caddy para el bloque `*.escalapp.cloud`: sin más cuerpo que el
 * código de estado, 200 si el subdominio corresponde a un negocio publicado, 404 si no — así
 * Caddy solo pide un certificado real a Let's Encrypt para subdominios que existen, y no para
 * cualquier cosa que alguien apunte a la IP del servidor.
 */
async function verificarDominio(req, res) {
    try {
        const dominio = String(req.query.domain || '').trim().toLowerCase();
        // El sufijo lo decide el propio dominio de EscalApp, no una lista aparte que se
        // desincronice si algún día cambia.
        const sufijo = '.escalapp.cloud';
        if (!dominio.endsWith(sufijo)) return res.sendStatus(404);

        const slug = dominio.slice(0, -sufijo.length);
        const data = await VitrinaService.resolverSlug(slug);
        return res.sendStatus(data ? 200 : 404);
    } catch (err) {
        console.error('[Reserva/Publico] verificarDominio:', err.message);
        return res.sendStatus(404);
    }
}

/**
 * GET /reserva/publico/:id_negocio/manifest.webmanifest
 *
 * El manifest del portal público con la identidad del negocio: su nombre, su logo como icono, su
 * color como `theme_color`. Se genera al vuelo (no hay un archivo por negocio) porque es la
 * misma información que ya sirve `/vitrina`, solo que en el formato que el navegador espera
 * cuando el cliente hace «Añadir a la pantalla de inicio».
 *
 * El logo ya sale cuadrado y en 512×512 desde el recorte del navegador (`image-cropper`), así que
 * no hay que redimensionar nada en el servidor — ver la nota de `imagenService.js` sobre por qué
 * este proyecto no tiene `sharp`.
 */
async function getManifest(req, res) {
    try {
        const idNegocio = Number(req.params.id_negocio);
        if (!Number.isInteger(idNegocio) || idNegocio < 1) return res.sendStatus(404);

        // Dos accesos directos distintos con la misma marca: el de la VITRINA, que abre el
        // portal del cliente, y el de la CONSOLA, que abre el panel donde el negocio trabaja.
        // Comparten logo y color; cambian a dónde llevan y cómo se llaman.
        const paraConsola = String(req.query.destino || '') === 'consola';
        const data = await VitrinaService.getManifestData(idNegocio, { exigirPublico: !paraConsola });

        // Absoluta con el origen real de ESTA petición (detrás de Caddy, `trust proxy` ya hace
        // que `req.protocol` sea el de fuera): así el manifest sirve igual en local, en un
        // túnel de pruebas o en producción, sin una variable de entorno más que mantener.
        const origen = `${req.protocol}://${req.get('host')}`;
        const logoAbsoluto = data.logo_url
            ? (/^https?:\/\//i.test(data.logo_url) ? data.logo_url : `${origen}${data.logo_url}`)
            : null;

        // Si ya tiene subdominio propio, el icono vuelve a él al reabrirse; si no, a la ruta de
        // siempre. Cualquiera de los dos existe siempre — no hay un tercer sitio al que caer.
        const consola = String(process.env.RESERVA_PORTAL_URL || '/reserva').replace(/\/+$/, '');
        const inicio = paraConsola
            ? `${consola}/dashboard`
            : (data.slug ? `https://${data.slug}.escalapp.cloud/` : `/reserva/p/${data.id_negocio}`);
        const alcance = paraConsola ? `${consola}/` : inicio;

        const manifest = {
            // El nombre largo distingue los dos accesos en el diálogo de instalación; el corto
            // —el que queda bajo el icono— se deja limpio, que es el del negocio y ya.
            name: paraConsola ? `${data.nombre} · Gestión` : data.nombre,
            short_name: data.nombre.length > 20 ? `${data.nombre.slice(0, 19)}…` : data.nombre,
            description: paraConsola
                ? `Agenda, citas y caja de ${data.nombre}, con EscalApp.`
                : `Reserva tu cita en ${data.nombre}, con EscalApp.`,
            start_url: inicio,
            scope: alcance,
            id: inicio,
            display: 'standalone',
            background_color: '#FFFFFF',
            theme_color: data.color_primario || '#4338CA',
            // Sin `purpose: "maskable"`: el logo es un recorte cuadrado plano, sin el margen de
            // seguridad que ese modo exige, y forzarlo haría que algunos lanzadores le cortaran
            // las esquinas al aplicar su propia máscara circular.
            icons: logoAbsoluto
                ? [{ src: logoAbsoluto, sizes: '512x512', type: 'image/webp' }]
                : [],
        };

        res.type('application/manifest+json');
        res.set('Cache-Control', 'public, max-age=300');
        return res.json(manifest);
    } catch (err) {
        if (err.statusCode === 404) return res.sendStatus(404);
        console.error('[Reserva/Publico] manifest:', err.message);
        return res.sendStatus(500);
    }
}

module.exports = {
    getVitrina, getInfoNegocio, listarServicios, listarProfesionales,
    getDisponibilidad, getDiasDisponibles, getDiasDeServicio, getSlotsDeServicio,
    crearCitaPublica, consultarCita, cancelarCitaPublica, crearVentaProductoPublica,
    getPorDominio, verificarDominio, getManifest,
};
