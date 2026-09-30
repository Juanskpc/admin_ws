'use strict';
/**
 * Estancias: el segundo motor del módulo `reserva` (alojamiento, hotel y guardería de
 * mascotas). Ver `docs/perfiles-de-reserva.md` §2.3.
 *
 * ## Por qué no usa `reglasAgenda`
 *
 * La agenda de citas arma huecos de **un día** desde el horario de cada profesional. Una
 * estancia son noches sobre una unidad, sin horario ni profesional. Meterla allí habría
 * obligado a la función que calcula las horas de la barbería a aprender de noches y
 * temporadas. Aquí comparte con las citas lo que es común de verdad —clientes, caja, formas de
 * pago, abono, permisos— y nada del cálculo de disponibilidad. La ruta de citas no importa este
 * archivo.
 *
 * ## Cómo se impide el sobrecupo
 *
 * Tres capas, de la más blanda a la más dura: la disponibilidad solo ofrece unidades libres;
 * crear toma un bloqueo consultivo por unidad y vuelve a comprobar estancias y bloqueos; y la
 * base tiene `ex_reserva_estancia_sin_sobrecupo`, que rechaza dos estancias vivas que se pisen
 * aunque todo lo anterior fallara.
 *
 * ## Dinero
 *
 * Lo pagado es lo que está en la caja con `id_estancia` (ingresos menos devoluciones): no hay
 * otro contador que pueda descuadrarse. Saldo = total + cargos − pagado. El anticipo del portal
 * entra a la caja al aprobarse el comprobante, y el saldo al hacer el check-out.
 */
const Models = require('../../../app_core/models/conection');
const { Op } = Models.Sequelize;
const personaNegocioDao = require('../../../app_core/dao/personaNegocioDao');
const { duracionLegible } = require('../duracionTexto');
const Audit = require('../../../app_core/helpers/auditHelper');
const CodigoCita = require('../codigoCita');
const ConfigService = require('../configService');
const CajaService = require('../cajaService');
const MetodoPagoService = require('../metodoPagoService');
const MascotaService = require('../mascotaService');
const Reglas = require('../reglasAgenda');
const { abonoExigible } = require('../abono');
const Perfiles = require('../../perfiles');
const T = require('./tarifas');

const ESTADOS_VIVOS = ['pendiente', 'confirmada', 'en_curso'];
const TRANSICIONES = {
    pendiente: ['confirmada', 'en_curso', 'cancelada', 'no_show'],
    confirmada: ['en_curso', 'cancelada', 'no_show'],
    en_curso: ['finalizada'],
    finalizada: [],
    cancelada: [],
    no_show: [],
};
/** Espacio de claves del bloqueo por unidad (dos enteros; no choca con el de profesionales). */
const ESPACIO_BLOQUEO_UNIDAD = 7302;

function error(mensaje, code, statusCode = 400) {
    const e = new Error(mensaje);
    e.code = code;
    e.statusCode = statusCode;
    return e;
}

const hoy = () => Reglas.fechaISOLocal(new Date());

function exigirTransicion(desde, hacia) {
    if (!(TRANSICIONES[desde] || []).includes(hacia)) {
        throw error(`Una estancia «${desde}» no puede pasar a «${hacia}».`, 'TRANSICION_INVALIDA', 409);
    }
}

async function exigirEstancias(idNegocio, opciones = {}) {
    const perfil = await Perfiles.perfilDeNegocio(idNegocio, opciones);
    if (!perfil.funciones.includes('estancias')) {
        throw error('Este negocio no tiene activas las estancias por noches.', 'FUNCION_INACTIVA', 403);
    }
    return perfil;
}

// ─────────────────────────────── Disponibilidad ───────────────────────────────

async function tipoConTemporadas(idNegocio, idUnidadTipo, { transaction } = {}) {
    const tipo = await Models.ReservaUnidadTipo.findOne({
        where: { id_unidad_tipo: idUnidadTipo, id_negocio: idNegocio, estado: 'A' }, transaction,
    });
    if (!tipo) throw error('Tipo de unidad no encontrado.', 'UNIDAD_TIPO_NO_ENCONTRADA', 404);
    const temporadas = await Models.ReservaTarifaTemporada.findAll({
        where: { id_unidad_tipo: idUnidadTipo, estado: 'A' }, raw: true, transaction,
    });
    return { tipo, temporadas };
}

/**
 * Qué tiene ocupado cada unidad en `[entrada, salida)`: estancias vivas y bloqueos (manuales o
 * importados de Airbnb/Booking).
 *
 * @returns {Map<number, {desde:string, hasta:string, origen:string}[]>}
 */
async function ocupacionUnidades(idNegocio, idsUnidad, entrada, salida, { transaction, excluirEstancia = null } = {}) {
    const mapa = new Map(idsUnidad.map((id) => [id, []]));
    if (!idsUnidad.length) return mapa;
    const whereE = {
        id_negocio: idNegocio,
        id_unidad: idsUnidad,
        estado: ESTADOS_VIVOS,
        fecha_entrada: { [Op.lt]: salida },
        fecha_salida: { [Op.gt]: entrada },
    };
    if (excluirEstancia) whereE.id_estancia = { [Op.ne]: excluirEstancia };
    const [estancias, bloqueos] = await Promise.all([
        Models.ReservaEstancia.findAll({ where: whereE, attributes: ['id_unidad', 'fecha_entrada', 'fecha_salida'], raw: true, transaction }),
        Models.ReservaBloqueoUnidad.findAll({
            where: { id_negocio: idNegocio, id_unidad: idsUnidad, fecha_desde: { [Op.lt]: salida }, fecha_hasta: { [Op.gt]: entrada } },
            attributes: ['id_unidad', 'fecha_desde', 'fecha_hasta', 'origen'], raw: true, transaction,
        }),
    ]);
    for (const e of estancias) mapa.get(e.id_unidad)?.push({ desde: e.fecha_entrada, hasta: e.fecha_salida, origen: 'estancia' });
    for (const b of bloqueos) mapa.get(b.id_unidad)?.push({ desde: b.fecha_desde, hasta: b.fecha_hasta, origen: b.origen });
    return mapa;
}

async function unidadesLibres(idNegocio, idUnidadTipo, entrada, salida, opciones = {}) {
    const unidades = await Models.ReservaUnidad.findAll({
        where: { id_negocio: idNegocio, id_unidad_tipo: idUnidadTipo, estado: 'A' },
        order: [['orden', 'ASC'], ['id_unidad', 'ASC']],
        transaction: opciones.transaction,
    });
    const ocupacion = await ocupacionUnidades(idNegocio, unidades.map((u) => u.id_unidad), entrada, salida, opciones);
    return unidades.filter((u) => (ocupacion.get(u.id_unidad) || []).length === 0);
}

/**
 * Qué se puede reservar para esas fechas y ese número de huéspedes: cada tipo de unidad con
 * cuántas quedan libres y su precio total. Lo usan el portal y el formulario del negocio.
 */
async function disponibilidad(idNegocio, { entrada, salida, huespedes = 1 }) {
    await exigirEstancias(idNegocio);
    T.noches(entrada, salida); // valida fechas
    const tipos = await Models.ReservaUnidadTipo.findAll({
        where: { id_negocio: idNegocio, estado: 'A' }, order: [['orden', 'ASC'], ['nombre', 'ASC']],
    });
    const salidaLista = [];
    for (const tipo of tipos) {
        const temporadas = await Models.ReservaTarifaTemporada.findAll({
            where: { id_unidad_tipo: tipo.id_unidad_tipo, estado: 'A' }, raw: true,
        });
        const libres = await unidadesLibres(idNegocio, tipo.id_unidad_tipo, entrada, salida);
        let cotizacion = null;
        let motivo = null;
        try {
            cotizacion = T.cotizar(tipo, temporadas, { entrada, salida, huespedes });
            T.exigirMinimo(cotizacion);
        } catch (err) {
            motivo = err.code;
        }
        salidaLista.push({
            id_unidad_tipo: tipo.id_unidad_tipo,
            nombre: tipo.nombre,
            descripcion: tipo.descripcion,
            capacidad_max: tipo.capacidad_max,
            ocupacion_base: tipo.ocupacion_base,
            imagen_url: tipo.imagen_url,
            comodidades: tipo.comodidades || [],
            libres: libres.length,
            unidades_libres: libres.map((u) => ({ id_unidad: u.id_unidad, nombre: u.nombre })),
            disponible: libres.length > 0 && !motivo,
            motivo: motivo || (libres.length === 0 ? 'SIN_UNIDADES' : null),
            total: cotizacion?.total ?? null,
            noches: cotizacion?.noches ?? [],
            min_noches: cotizacion?.min_noches ?? tipo.min_noches,
        });
    }
    return salidaLista;
}

// ─────────────────────────────── Crear ───────────────────────────────

async function generarCodigoLibre(transaction) {
    for (let i = 0; i < 5; i++) {
        const c = CodigoCita.generar();
        const [enCitas, enEstancias] = await Promise.all([
            Models.ReservaCita.count({ where: { codigo_publico: c }, transaction }),
            Models.ReservaEstancia.count({ where: { codigo_publico: c }, transaction }),
        ]);
        if (!enCitas && !enEstancias) return c;
    }
    throw error('No se pudo generar un código libre.', 'CODIGO', 500);
}

/** Traduce la violación de la exclusión de la base a un error que entiende el usuario. */
function traducirSobrecupo(err) {
    const codigo = err?.original?.code || err?.parent?.code;
    if (codigo === '23P01') {
        return error('Esa unidad acaba de reservarse para esas fechas. Elige otra.', 'UNIDAD_NO_DISPONIBLE', 409);
    }
    return err;
}

/**
 * Crea una estancia.
 *
 * Desde el portal (`creadoPorIdUsuario` nulo) se exige el mínimo de noches, que la entrada no
 * haya pasado y, si el negocio cobra anticipo, el comprobante. El negocio puede saltarse el
 * mínimo (una noche suelta a un cliente de siempre) y elegir la unidad concreta.
 */
async function crear(params, { transaction: externa = null } = {}) {
    const {
        idNegocio, idUnidadTipo, idUnidad = null, entrada, salida, huespedes = 1,
        clienteNombre, clienteTelefono = null, clienteEmail = null, clienteDocumento = null,
        notas = null, comprobantePath = null, creadoPorIdUsuario = null,
        idMascota = null, mascota = null, origen = null,
    } = params;
    if (!idNegocio || !idUnidadTipo || !entrada || !salida || !String(clienteNombre || '').trim()) {
        throw error('Faltan datos para la reserva.', 'DATOS_INCOMPLETOS');
    }
    const esPublico = creadoPorIdUsuario == null;
    const perfil = await exigirEstancias(idNegocio);
    const funciones = new Set(perfil.funciones);
    const cfg = (await ConfigService.get(idNegocio)).toJSON();

    const { tipo, temporadas } = await tipoConTemporadas(idNegocio, idUnidadTipo);
    const cot = T.cotizar(tipo, temporadas, { entrada, salida, huespedes });
    if (esPublico) {
        T.exigirMinimo(cot);
        if (String(entrada) < hoy()) throw error('La fecha de entrada ya pasó.', 'FECHA_PASADA');
    }
    if (funciones.has('mascotas') && !idMascota && !String(mascota?.nombre || '').trim()) {
        throw error('Indica para qué mascota es la estadía.', 'MASCOTA_REQUERIDA');
    }

    const abono = esPublico ? abonoExigible({ cfg, funciones, monto: cot.total }) : null;
    const requierePago = esPublico && (abono != null ? abono > 0 : !!cfg.cobro_adelantado);
    if (requierePago && !comprobantePath) {
        throw error('Debe adjuntar el comprobante del anticipo.', 'COMPROBANTE_REQUERIDO');
    }

    const propia = !externa;
    const t = externa || (await Models.sequelize.transaction());
    try {
        // Unidad: la pedida (el negocio) o la primera libre del tipo. Se bloquea y se vuelve a
        // comprobar dentro de la transacción: entre ofrecerla y reservarla pudo irse.
        const candidatas = idUnidad
            ? [await Models.ReservaUnidad.findOne({
                where: { id_unidad: idUnidad, id_negocio: idNegocio, id_unidad_tipo: idUnidadTipo, estado: 'A' }, transaction: t,
            })].filter(Boolean)
            : await Models.ReservaUnidad.findAll({
                where: { id_negocio: idNegocio, id_unidad_tipo: idUnidadTipo, estado: 'A' },
                order: [['orden', 'ASC'], ['id_unidad', 'ASC']], transaction: t,
            });
        if (!candidatas.length) throw error('No hay unidades de ese tipo.', 'UNIDAD_NO_ENCONTRADA', 404);

        let elegida = null;
        for (const u of candidatas) {
            await Models.sequelize.query('SELECT pg_advisory_xact_lock(:espacio, :unidad);', {
                replacements: { espacio: ESPACIO_BLOQUEO_UNIDAD, unidad: u.id_unidad }, transaction: t,
            });
            const ocup = await ocupacionUnidades(idNegocio, [u.id_unidad], entrada, salida, { transaction: t });
            if ((ocup.get(u.id_unidad) || []).length === 0) { elegida = u; break; }
        }
        if (!elegida) {
            throw error(idUnidad ? 'Esa unidad está ocupada en esas fechas.' : 'No quedan unidades libres para esas fechas.',
                'UNIDAD_NO_DISPONIBLE', 409);
        }

        let idPersona = clienteTelefono
            ? await personaNegocioDao.resolverOCrearBestEffort(
                { idNegocio, telefono: clienteTelefono, nombre: clienteNombre }, { transaction: t })
            : null;

        let idMascotaFinal = null;
        let notasFinales = notas || null;
        if (funciones.has('mascotas')) {
            if (idMascota) {
                const m = await MascotaService.obtener(idNegocio, idMascota, { transaction: t });
                idPersona = idPersona || m.id_persona_negocio;
                idMascotaFinal = m.id_mascota;
            } else if (idPersona) {
                idMascotaFinal = (await MascotaService.resolverOCrear(idNegocio, idPersona, mascota, { transaction: t })).id_mascota;
            } else {
                const m = mascota || {};
                notasFinales = [`Mascota: ${[m.nombre, m.raza, m.tamano].filter(Boolean).join(' · ')}`, notasFinales]
                    .filter(Boolean).join('\n');
            }
        }

        const estancia = await Models.ReservaEstancia.create({
            id_negocio: idNegocio,
            id_unidad: elegida.id_unidad,
            id_unidad_tipo: idUnidadTipo,
            fecha_entrada: entrada,
            fecha_salida: salida,
            // La que toma recepción ya está confirmada: la pidió alguien del negocio. La del
            // portal queda pendiente hasta que se valide el anticipo o se confirme a mano.
            estado: esPublico ? 'pendiente' : 'confirmada',
            huespedes: Number(huespedes) || 1,
            cliente_nombre: String(clienteNombre).trim().slice(0, 150),
            cliente_telefono: clienteTelefono || null,
            cliente_email: clienteEmail || null,
            cliente_documento: clienteDocumento || null,
            id_persona_negocio: idPersona,
            id_mascota: idMascotaFinal,
            notas: notasFinales,
            codigo_publico: await generarCodigoLibre(t),
            detalle_noches: cot.noches.map(({ fecha, precio }) => ({ fecha, precio })),
            monto_total: cot.total,
            monto_abono: requierePago && abono != null ? abono : null,
            requiere_pago: requierePago,
            pago_estado: requierePago ? 'pendiente_validacion' : 'no_aplica',
            comprobante_pago_url: comprobantePath,
            origen: origen || (esPublico ? 'portal' : 'directo'),
            creado_por_id_usuario: creadoPorIdUsuario,
        }, { transaction: t });

        if (propia) await t.commit();
        return getById(idNegocio, estancia.id_estancia, { transaction: propia ? null : t });
    } catch (err) {
        if (propia && !t.finished) await t.rollback();
        throw traducirSobrecupo(err);
    }
}

// ─────────────────────────────── Leer ───────────────────────────────

const INCLUDES = () => [
    { model: Models.ReservaUnidad, as: 'unidad', attributes: ['id_unidad', 'nombre'] },
    { model: Models.ReservaUnidadTipo, as: 'tipo', attributes: ['id_unidad_tipo', 'nombre', 'capacidad_max'] },
    { model: Models.ReservaMascota, as: 'mascota', required: false, attributes: ['id_mascota', 'nombre', 'especie', 'raza', 'tamano'] },
];

async function finanzas(idEstancia, estancia, { transaction } = {}) {
    const [cargos, movimientos] = await Promise.all([
        Models.ReservaEstanciaCargo.findAll({ where: { id_estancia: idEstancia }, order: [['fecha', 'ASC']], transaction }),
        Models.ReservaMovimientoCaja.findAll({
            where: { id_estancia: idEstancia },
            include: [{ model: Models.ReservaMetodoPago, as: 'metodoPago', attributes: ['nombre'], required: false }],
            order: [['fecha', 'ASC']], transaction,
        }),
    ]);
    const totalCargos = cargos.reduce((s, c) => s + Number(c.valor), 0);
    const pagado = movimientos.reduce((s, m) => s + (m.tipo === 'INGRESO' ? 1 : -1) * Number(m.monto), 0);
    const total = Number(estancia.monto_total) + totalCargos;
    return {
        cargos: cargos.map((c) => c.toJSON()),
        pagos: movimientos.map((m) => ({
            id_movimiento: m.id_movimiento, tipo: m.tipo, monto: Number(m.monto), concepto: m.concepto,
            fecha: m.fecha, metodo: m.metodoPago?.nombre || null,
        })),
        total_cargos: totalCargos,
        total,
        pagado,
        saldo: Math.round((total - pagado) * 100) / 100,
    };
}

async function getById(idNegocio, idEstancia, { transaction = null } = {}) {
    const e = await Models.ReservaEstancia.findOne({
        where: { id_estancia: idEstancia, id_negocio: idNegocio }, include: INCLUDES(), transaction,
    });
    if (!e) return null;
    return { ...e.toJSON(), noches: T.noches(e.fecha_entrada, e.fecha_salida).length, ...(await finanzas(idEstancia, e, { transaction })) };
}

async function listar(idNegocio, { desde = null, hasta = null, estado = null, q = null } = {}) {
    const where = { id_negocio: idNegocio };
    if (desde) where.fecha_salida = { [Op.gt]: desde };
    if (hasta) where.fecha_entrada = { [Op.lt]: hasta };
    if (estado) where.estado = estado;
    if (q) {
        const like = `%${String(q).trim()}%`;
        where[Op.or] = [
            { cliente_nombre: { [Op.iLike]: like } },
            { cliente_telefono: { [Op.iLike]: like } },
            { codigo_publico: { [Op.iLike]: like } },
        ];
    }
    const filas = await Models.ReservaEstancia.findAll({
        where, include: INCLUDES(), order: [['fecha_entrada', 'ASC'], ['id_estancia', 'ASC']], limit: 500,
    });
    return filas.map((e) => ({ ...e.toJSON(), noches: T.noches(e.fecha_entrada, e.fecha_salida).length }));
}

/**
 * El tablero de ocupación: todas las unidades, y lo que cada una tiene entre `desde` y `hasta`.
 * El frontend pinta una fila por unidad y una barra por estancia o bloqueo.
 */
async function ocupacion(idNegocio, { desde, hasta }) {
    await exigirEstancias(idNegocio);
    T.noches(desde, hasta);
    const unidades = await Models.ReservaUnidad.findAll({
        where: { id_negocio: idNegocio, estado: 'A' },
        include: [{ model: Models.ReservaUnidadTipo, as: 'tipo', attributes: ['id_unidad_tipo', 'nombre', 'orden'] }],
        order: [[{ model: Models.ReservaUnidadTipo, as: 'tipo' }, 'orden', 'ASC'], ['orden', 'ASC'], ['id_unidad', 'ASC']],
    });
    const ids = unidades.map((u) => u.id_unidad);
    const [estancias, bloqueos] = await Promise.all([
        Models.ReservaEstancia.findAll({
            where: {
                id_negocio: idNegocio, id_unidad: ids, estado: { [Op.in]: [...ESTADOS_VIVOS, 'finalizada'] },
                fecha_entrada: { [Op.lt]: hasta }, fecha_salida: { [Op.gt]: desde },
            },
            attributes: ['id_estancia', 'id_unidad', 'fecha_entrada', 'fecha_salida', 'estado', 'cliente_nombre',
                         'huespedes', 'pago_estado', 'codigo_publico'],
            raw: true,
        }),
        Models.ReservaBloqueoUnidad.findAll({
            where: { id_negocio: idNegocio, id_unidad: ids, fecha_desde: { [Op.lt]: hasta }, fecha_hasta: { [Op.gt]: desde } },
            include: [{ model: Models.ReservaCalendarioExterno, as: 'calendario', attributes: ['nombre'], required: false }],
        }),
    ]);
    return {
        desde, hasta,
        unidades: unidades.map((u) => ({
            id_unidad: u.id_unidad, nombre: u.nombre, id_unidad_tipo: u.id_unidad_tipo, tipo: u.tipo?.nombre,
        })),
        estancias,
        bloqueos: bloqueos.map((b) => ({
            id_bloqueo: b.id_bloqueo, id_unidad: b.id_unidad, fecha_desde: b.fecha_desde, fecha_hasta: b.fecha_hasta,
            motivo: b.motivo, origen: b.origen, calendario: b.calendario?.nombre || null,
        })),
    };
}

// ─────────────────────────────── Cambios ───────────────────────────────

async function conBloqueo(idNegocio, idEstancia, fn) {
    return Models.sequelize.transaction(async (t) => {
        const e = await Models.ReservaEstancia.findOne({
            where: { id_estancia: idEstancia, id_negocio: idNegocio }, transaction: t, lock: t.LOCK.UPDATE,
        });
        if (!e) throw error('Estancia no encontrada.', 'ESTANCIA_NO_ENCONTRADA', 404);
        return fn(e, t);
    });
}

/**
 * Cambia fechas, unidad o huéspedes de una estancia viva. Se recotiza con las tarifas de hoy:
 * si cambian las noches, lo prometido cambia, igual que editar una cita recalcula su precio.
 */
async function actualizar(idNegocio, idEstancia, datos, idUsuario = null) {
    try {
        return await conBloqueo(idNegocio, idEstancia, async (e, t) => {
            if (!ESTADOS_VIVOS.includes(e.estado)) {
                throw error(`Una estancia «${e.estado}» ya está cerrada.`, 'TRANSICION_INVALIDA', 409);
            }
            const entrada = datos.fecha_entrada || e.fecha_entrada;
            const salida = datos.fecha_salida || e.fecha_salida;
            const huespedes = datos.huespedes != null ? Number(datos.huespedes) : e.huespedes;
            let idUnidad = datos.id_unidad ? Number(datos.id_unidad) : e.id_unidad;
            const unidad = await Models.ReservaUnidad.findOne({
                where: { id_unidad: idUnidad, id_negocio: idNegocio, estado: 'A' }, transaction: t,
            });
            if (!unidad) throw error('Unidad no encontrada.', 'UNIDAD_NO_ENCONTRADA', 404);

            await Models.sequelize.query('SELECT pg_advisory_xact_lock(:espacio, :unidad);', {
                replacements: { espacio: ESPACIO_BLOQUEO_UNIDAD, unidad: idUnidad }, transaction: t,
            });
            const ocup = await ocupacionUnidades(idNegocio, [idUnidad], entrada, salida, { transaction: t, excluirEstancia: idEstancia });
            if ((ocup.get(idUnidad) || []).length) throw error('Esa unidad está ocupada en esas fechas.', 'UNIDAD_NO_DISPONIBLE', 409);

            const { tipo, temporadas } = await tipoConTemporadas(idNegocio, unidad.id_unidad_tipo, { transaction: t });
            const cot = T.cotizar(tipo, temporadas, { entrada, salida, huespedes });
            const antes = { fecha_entrada: e.fecha_entrada, fecha_salida: e.fecha_salida, id_unidad: e.id_unidad, monto_total: Number(e.monto_total) };
            await e.update({
                fecha_entrada: entrada, fecha_salida: salida, huespedes, id_unidad: idUnidad, id_unidad_tipo: unidad.id_unidad_tipo,
                detalle_noches: cot.noches.map(({ fecha, precio }) => ({ fecha, precio })),
                monto_total: cot.total,
                notas: datos.notas !== undefined ? (datos.notas || null) : e.notas,
                fecha_actualizacion: new Date(),
            }, { transaction: t });
            await Audit.registrarEvento({
                modulo: 'reserva', accion: 'estancia_editada', idUsuario, idNegocio,
                detalle: { id_estancia: idEstancia, antes, despues: { fecha_entrada: entrada, fecha_salida: salida, id_unidad: idUnidad, monto_total: cot.total } },
                transaction: t,
            });
            return e;
        }).then(() => getById(idNegocio, idEstancia));
    } catch (err) {
        throw traducirSobrecupo(err);
    }
}

async function confirmar(idNegocio, idEstancia) {
    await conBloqueo(idNegocio, idEstancia, (e, t) => {
        exigirTransicion(e.estado, 'confirmada');
        return e.update({ estado: 'confirmada', fecha_actualizacion: new Date() }, { transaction: t });
    });
    return getById(idNegocio, idEstancia);
}

async function checkin(idNegocio, idEstancia) {
    await conBloqueo(idNegocio, idEstancia, (e, t) => {
        exigirTransicion(e.estado, 'en_curso');
        if (String(e.fecha_entrada) > hoy()) {
            throw error('La llegada es antes de la fecha de entrada. Cambia las fechas si llegó antes.', 'CHECKIN_ANTICIPADO', 409);
        }
        return e.update({ estado: 'en_curso', checkin_en: new Date(), fecha_actualizacion: new Date() }, { transaction: t });
    });
    return getById(idNegocio, idEstancia);
}

async function noShow(idNegocio, idEstancia) {
    await conBloqueo(idNegocio, idEstancia, (e, t) => {
        exigirTransicion(e.estado, 'no_show');
        if (String(e.fecha_entrada) > hoy()) throw error('Todavía no es la fecha de entrada.', 'TRANSICION_INVALIDA', 409);
        return e.update({ estado: 'no_show', fecha_actualizacion: new Date() }, { transaction: t });
    });
    return getById(idNegocio, idEstancia);
}

async function cancelar(idNegocio, idEstancia, { motivo = null, por = 'negocio', idUsuario = null } = {}) {
    await conBloqueo(idNegocio, idEstancia, async (e, t) => {
        exigirTransicion(e.estado, 'cancelada');
        await e.update({
            estado: 'cancelada', cancelado_por: por, cancelado_motivo: motivo || null, fecha_actualizacion: new Date(),
        }, { transaction: t });
        await Audit.registrarEvento({
            modulo: 'reserva', accion: 'estancia_cancelada', idUsuario, idNegocio,
            detalle: { id_estancia: idEstancia, por, motivo, monto_total: Number(e.monto_total) }, transaction: t,
        });
    });
    return getById(idNegocio, idEstancia);
}

/** Normaliza pagos `[{ id_metodo_pago, valor }]` o un pago simple. */
function listaDePagos({ pagos, idMetodoPago, valor }) {
    if (Array.isArray(pagos) && pagos.length) {
        return pagos.map((p) => ({ id_metodo_pago: Number(p.id_metodo_pago), valor: Number(p.valor) }));
    }
    if (idMetodoPago && valor != null) return [{ id_metodo_pago: Number(idMetodoPago), valor: Number(valor) }];
    return [];
}

async function asentar({ idNegocio, estancia, pagos, idUsuario, concepto, transaction }) {
    if (!pagos.length) return;
    if (pagos.some((p) => !Number.isInteger(p.id_metodo_pago) || !(p.valor > 0))) {
        throw error('Cada pago necesita forma de pago y un valor mayor que cero.', 'PAGO_NO_VALIDO', 422);
    }
    await MetodoPagoService.validarDelNegocio(idNegocio, pagos.map((p) => p.id_metodo_pago), { transaction });
    const caja = await CajaService.requireCajaAbierta(idNegocio, { transaction });
    const unidad = await Models.ReservaUnidad.findByPk(estancia.id_unidad, { attributes: ['nombre'], transaction });
    for (const p of pagos) {
        await Models.ReservaMovimientoCaja.create({
            id_caja: caja.id_caja,
            tipo: 'INGRESO',
            monto: p.valor,
            concepto: `${concepto} · Estancia #${estancia.id_estancia} · ${estancia.cliente_nombre} · ${unidad?.nombre || ''}`.slice(0, 255),
            id_estancia: estancia.id_estancia,
            id_metodo_pago: p.id_metodo_pago,
            id_usuario: idUsuario,
        }, { transaction });
    }
}

/** Registra un pago a cuenta (anticipo por teléfono, abono a mitad de la estancia). */
async function registrarPago(idNegocio, idEstancia, { pagos, idMetodoPago, valor, idUsuario }) {
    await conBloqueo(idNegocio, idEstancia, async (e, t) => {
        if (['cancelada', 'no_show', 'finalizada'].includes(e.estado)) {
            throw error(`Una estancia «${e.estado}» no recibe pagos a cuenta.`, 'TRANSICION_INVALIDA', 409);
        }
        const lista = listaDePagos({ pagos, idMetodoPago, valor });
        if (!lista.length) throw error('Indica la forma de pago y el valor.', 'PAGO_REQUERIDO', 422);
        const { saldo } = await finanzas(idEstancia, e, { transaction: t });
        const suma = lista.reduce((s, p) => s + p.valor, 0);
        if (Math.round(suma * 100) > Math.round(saldo * 100)) {
            throw error(`El pago supera el saldo pendiente (${saldo}).`, 'PAGO_EXCEDE_SALDO', 422);
        }
        await asentar({ idNegocio, estancia: e, pagos: lista, idUsuario, concepto: 'Pago', transaction: t });
    });
    return getById(idNegocio, idEstancia);
}

/**
 * Cobra lo que falte y registra la salida. El saldo tiene que quedar en cero: una estancia no se
 * cierra debiendo, igual que una cita no se completa sin cobrarse.
 */
async function checkout(idNegocio, idEstancia, { pagos, idMetodoPago, idUsuario }) {
    await conBloqueo(idNegocio, idEstancia, async (e, t) => {
        exigirTransicion(e.estado, 'finalizada');
        const { saldo } = await finanzas(idEstancia, e, { transaction: t });
        let lista = listaDePagos({ pagos, idMetodoPago, valor: saldo });
        if (saldo <= 0) lista = [];
        const suma = lista.reduce((s, p) => s + p.valor, 0);
        if (Math.round(suma * 100) !== Math.round(Math.max(saldo, 0) * 100)) {
            throw error(`El pago no cuadra con el saldo pendiente (${saldo}).`, 'PAGO_NO_CUADRA', 422);
        }
        await asentar({ idNegocio, estancia: e, pagos: lista, idUsuario, concepto: 'Saldo', transaction: t });
        await e.update({ estado: 'finalizada', checkout_en: new Date(), fecha_actualizacion: new Date() }, { transaction: t });
    });
    return getById(idNegocio, idEstancia);
}

async function agregarCargo(idNegocio, idEstancia, { concepto, valor, idUsuario }) {
    await conBloqueo(idNegocio, idEstancia, (e, t) => {
        if (!ESTADOS_VIVOS.includes(e.estado)) throw error('La estancia ya está cerrada.', 'TRANSICION_INVALIDA', 409);
        const c = String(concepto || '').trim().slice(0, 150);
        const v = Number(valor);
        if (!c || !(v > 0)) throw error('El cargo necesita concepto y valor.', 'CARGO_NO_VALIDO', 422);
        return Models.ReservaEstanciaCargo.create({ id_estancia: idEstancia, concepto: c, valor: v, id_usuario: idUsuario }, { transaction: t });
    });
    return getById(idNegocio, idEstancia);
}

async function eliminarCargo(idNegocio, idEstancia, idCargo) {
    await conBloqueo(idNegocio, idEstancia, async (e, t) => {
        if (!ESTADOS_VIVOS.includes(e.estado)) throw error('La estancia ya está cerrada.', 'TRANSICION_INVALIDA', 409);
        const n = await Models.ReservaEstanciaCargo.destroy({ where: { id_cargo: idCargo, id_estancia: idEstancia }, transaction: t });
        if (!n) throw error('Cargo no encontrado.', 'CARGO_NO_ENCONTRADO', 404);
    });
    return getById(idNegocio, idEstancia);
}

/**
 * Aprueba el comprobante del anticipo del portal. El anticipo entra a la caja en ese momento
 * (es dinero que ya está en la cuenta del negocio), así que exige un turno abierto.
 */
async function aprobarPago(idNegocio, idEstancia, { idMetodoPago, idUsuario }) {
    await conBloqueo(idNegocio, idEstancia, async (e, t) => {
        if (e.pago_estado !== 'pendiente_validacion') {
            throw error('La estancia no tiene un comprobante por validar.', 'SIN_COMPROBANTE', 409);
        }
        const monto = Number(e.monto_abono ?? e.monto_total);
        if (monto > 0) {
            if (!idMetodoPago) throw error('Indica por dónde llegó el anticipo.', 'PAGO_REQUERIDO', 422);
            await asentar({
                idNegocio, estancia: e, pagos: [{ id_metodo_pago: Number(idMetodoPago), valor: monto }],
                idUsuario, concepto: 'Anticipo', transaction: t,
            });
        }
        const cambios = {
            pago_estado: 'aprobado', pago_validado_por_id_usuario: idUsuario, pago_validado_en: new Date(),
            fecha_actualizacion: new Date(),
        };
        if (e.estado === 'pendiente') cambios.estado = 'confirmada';
        await e.update(cambios, { transaction: t });
    });
    return getById(idNegocio, idEstancia);
}

async function rechazarPago(idNegocio, idEstancia, { motivo = null, idUsuario }) {
    await conBloqueo(idNegocio, idEstancia, async (e, t) => {
        if (e.pago_estado !== 'pendiente_validacion') {
            throw error('La estancia no tiene un comprobante por validar.', 'SIN_COMPROBANTE', 409);
        }
        exigirTransicion(e.estado, 'cancelada');
        await e.update({
            pago_estado: 'rechazado', estado: 'cancelada', cancelado_por: 'negocio',
            pago_rechazo_motivo: motivo, pago_validado_por_id_usuario: idUsuario, pago_validado_en: new Date(),
            fecha_actualizacion: new Date(),
        }, { transaction: t });
    });
    return getById(idNegocio, idEstancia);
}

/**
 * Devuelve dinero de una estancia cancelada (el anticipo, si la política lo reembolsa): un
 * egreso en la caja abierta, por lo pagado como máximo.
 */
async function devolver(idNegocio, idEstancia, { valor, idMetodoPago, idUsuario }) {
    await conBloqueo(idNegocio, idEstancia, async (e, t) => {
        if (!['cancelada', 'no_show'].includes(e.estado)) {
            throw error('Solo se devuelve dinero de una estancia cancelada o sin llegada.', 'TRANSICION_INVALIDA', 409);
        }
        const { pagado } = await finanzas(idEstancia, e, { transaction: t });
        const v = Number(valor ?? pagado);
        if (!(v > 0) || Math.round(v * 100) > Math.round(pagado * 100)) {
            throw error(`Se puede devolver hasta ${pagado}.`, 'DEVOLUCION_NO_VALIDA', 422);
        }
        const caja = await CajaService.requireCajaAbierta(idNegocio, { transaction: t });
        await Models.ReservaMovimientoCaja.create({
            id_caja: caja.id_caja, tipo: 'EGRESO', monto: v,
            concepto: `Devolución · Estancia #${e.id_estancia} · ${e.cliente_nombre}`.slice(0, 255),
            id_estancia: e.id_estancia, id_metodo_pago: idMetodoPago || null, id_usuario: idUsuario,
        }, { transaction: t });
    });
    return getById(idNegocio, idEstancia);
}

// ─────────────────────────────── Portal ───────────────────────────────

async function porCodigo(codigo) {
    const normalizado = CodigoCita.normalizar(codigo);
    if (!normalizado) return null;
    const e = await Models.ReservaEstancia.findOne({
        where: { codigo_publico: normalizado },
        include: [...INCLUDES(), { model: Models.GenerNegocio, as: 'negocio', attributes: ['id_negocio', 'nombre'], required: false }],
    });
    return e;
}

/**
 * Cancela desde «Mi reserva». Solo antes de la ventana de cancelación del negocio, contada
 * desde la hora de entrada del primer día.
 */
async function cancelarPorCliente(codigo, motivo = null) {
    const e = await porCodigo(codigo);
    if (!e) throw error('Reserva no encontrada.', 'ESTANCIA_NO_ENCONTRADA', 404);
    const cfg = await ConfigService.get(e.id_negocio);
    const llegada = new Date(`${e.fecha_entrada}T${String(cfg.hora_checkin || '15:00').slice(0, 5)}:00-05:00`);
    const limite = llegada.getTime() - Number(cfg.ventana_cancelacion_min || 0) * 60_000;
    if (Date.now() > limite) {
        throw error(`Ya no se puede cancelar en línea: el plazo es de ${duracionLegible(cfg.ventana_cancelacion_min)} antes de la llegada. Escríbenos.`,
            'FUERA_DE_VENTANA', 409);
    }
    return cancelar(e.id_negocio, e.id_estancia, { motivo, por: 'cliente' });
}

// ─────────────────────────────── Resúmenes ───────────────────────────────

/** Lo del día para el dashboard: llegadas, salidas, en casa, ocupación y pagos por validar. */
async function resumenDelDia(idNegocio) {
    const dia = hoy();
    const manana = T.sumarDias(dia, 1);
    const [llegadas, salidas, enCasa, unidades, ocupadas, pendientesPago] = await Promise.all([
        Models.ReservaEstancia.findAll({
            where: { id_negocio: idNegocio, fecha_entrada: dia, estado: ['pendiente', 'confirmada'] },
            include: INCLUDES(), order: [['id_estancia', 'ASC']],
        }),
        Models.ReservaEstancia.findAll({
            where: { id_negocio: idNegocio, fecha_salida: dia, estado: 'en_curso' },
            include: INCLUDES(), order: [['id_estancia', 'ASC']],
        }),
        Models.ReservaEstancia.count({ where: { id_negocio: idNegocio, estado: 'en_curso' } }),
        Models.ReservaUnidad.count({ where: { id_negocio: idNegocio, estado: 'A' } }),
        Models.ReservaEstancia.count({
            where: { id_negocio: idNegocio, estado: ESTADOS_VIVOS, fecha_entrada: { [Op.lt]: manana }, fecha_salida: { [Op.gt]: dia } },
            distinct: true, col: 'id_unidad',
        }),
        Models.ReservaEstancia.count({ where: { id_negocio: idNegocio, pago_estado: 'pendiente_validacion' } }),
    ]);
    return {
        fecha: dia,
        llegadas: llegadas.map((x) => x.toJSON()),
        salidas: salidas.map((x) => x.toJSON()),
        en_casa: enCasa,
        unidades,
        ocupadas,
        ocupacion_pct: unidades ? Math.round((ocupadas / unidades) * 100) : 0,
        pendientes_pago: pendientesPago,
    };
}

/**
 * Informe de un rango: noches vendidas, ocupación, tarifa media por noche vendida y lo que entró
 * a la caja por estancias. Las noches se cuentan dentro del rango, no la estancia entera.
 */
async function informe(idNegocio, { desde, hasta }) {
    const rango = T.noches(desde, hasta);
    const [estancias, unidades, ingresos] = await Promise.all([
        Models.ReservaEstancia.findAll({
            where: {
                id_negocio: idNegocio, estado: ['confirmada', 'en_curso', 'finalizada'],
                fecha_entrada: { [Op.lt]: hasta }, fecha_salida: { [Op.gt]: desde },
            },
            attributes: ['id_estancia', 'detalle_noches', 'id_unidad_tipo'], raw: true,
        }),
        Models.ReservaUnidad.count({ where: { id_negocio: idNegocio, estado: 'A' } }),
        Models.sequelize.query(`
            SELECT COALESCE(SUM(CASE WHEN m.tipo = 'INGRESO' THEN m.monto ELSE -m.monto END), 0)::numeric AS neto
              FROM reserva.reserva_movimiento_caja m
              JOIN reserva.reserva_estancia e ON e.id_estancia = m.id_estancia
             WHERE e.id_negocio = :n AND m.fecha >= :desde AND m.fecha < :hasta;`,
        { replacements: { n: idNegocio, desde, hasta }, type: 'SELECT' }),
    ]);
    let nochesVendidas = 0;
    let ventaNoches = 0;
    for (const e of estancias) {
        for (const n of e.detalle_noches || []) {
            if (n.fecha >= desde && n.fecha < hasta) { nochesVendidas += 1; ventaNoches += Number(n.precio); }
        }
    }
    const disponibles = unidades * rango.length;
    return {
        desde, hasta,
        estancias: estancias.length,
        noches_vendidas: nochesVendidas,
        noches_disponibles: disponibles,
        ocupacion_pct: disponibles ? Math.round((nochesVendidas / disponibles) * 1000) / 10 : 0,
        tarifa_media: nochesVendidas ? Math.round(ventaNoches / nochesVendidas) : 0,
        venta_noches: ventaNoches,
        ingresos_caja: Number(ingresos[0]?.neto || 0),
    };
}

module.exports = {
    ESTADOS_VIVOS, ESPACIO_BLOQUEO_UNIDAD,
    disponibilidad, unidadesLibres, ocupacionUnidades,
    crear, getById, listar, ocupacion, actualizar,
    confirmar, checkin, noShow, cancelar, checkout,
    registrarPago, agregarCargo, eliminarCargo, aprobarPago, rechazarPago, devolver,
    porCodigo, cancelarPorCliente, resumenDelDia, informe,
};
