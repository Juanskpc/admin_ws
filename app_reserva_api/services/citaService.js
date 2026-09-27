'use strict';
const Models = require('../../app_core/models/conection');
const { fijarActorAsistente } = require('../../app_core/helpers/auditActor');
const { Op } = Models.Sequelize;
const outboxDao = require('../../app_core/dao/outboxDao');
const personaNegocioDao = require('../../app_core/dao/personaNegocioDao');
const Disponibilidad = require('./disponibilidadService');
const Notificacion = require('./notificacionService');
const Reglas = require('./reglasAgenda');
const EstadoCita = require('./estadoCita');
const CodigoCita = require('./codigoCita');
const Audit = require('../../app_core/helpers/auditHelper');
const Composicion = require('./composicionCita');
const MascotaService = require('./mascotaService');
const { abonoExigible } = require('./abono');
const Perfiles = require('../perfiles');

function errorDominio(mensaje, code, statusCode = 400) {
    const e = new Error(mensaje);
    e.code = code;
    e.statusCode = statusCode;
    return e;
}

/**
 * Compone la cita (duración, precio, tramos de espera, recurso) a partir de los servicios ya
 * validados, **en el orden en que se pidieron**. Ver `composicionCita.js`.
 */
async function componerCita({ idNegocio, idServicios, servicios, variantes, ajustes, funciones }) {
    const ordenados = idServicios.map((id) => servicios.find((s) => s.id_servicio === Number(id))).filter(Boolean);
    return Composicion.componer(ordenados, {
        funciones,
        variantes: await Disponibilidad.variantesElegidas(idNegocio, Composicion.normalizarVariantes(variantes)),
        ajustes: Composicion.normalizarAjustes(ajustes),
    });
}

/**
 * Aparta la cabina o equipo que necesita la cita, si alguno de sus servicios lo pide.
 *
 * Toma el bloqueo del **tipo** de recurso además del del profesional: dos terapeutas distintos
 * no comparten bloqueo, pero sí cabina, y sin esto los dos podrían llevarse la misma a la vez.
 */
async function apartarRecurso({ idNegocio, comp, inicio, fin, bufferMin, preferido = null }, opciones) {
    if (!comp.idTipoRecurso) return null;
    await Models.sequelize.query('SELECT pg_advisory_xact_lock(:espacio, :tipo);', {
        replacements: { espacio: Reglas.ESPACIO_BLOQUEO_RECURSO, tipo: comp.idTipoRecurso },
        transaction: opciones.transaction,
    });
    return Reglas.asignarRecurso(
        { idNegocio, idTipoRecurso: comp.idTipoRecurso, inicio, fin, bufferMin, preferido },
        opciones,
    );
}

/**
 * Un código corto que todavía no tiene ninguna cita. `generar()` es aleatorio (32^8
 * combinaciones), así que un choque es casi imposible — pero "casi" no es "nunca", y aquí es
 * barato comprobarlo antes de intentar el INSERT en vez de que falle contra el índice único.
 */
async function generarCodigoLibre({ transaction } = {}) {
    for (let intento = 0; intento < 5; intento++) {
        const candidato = CodigoCita.generar();
        const existe = await Models.ReservaCita.findOne({
            where: { codigo_publico: candidato },
            attributes: ['id_cita'],
            transaction,
        });
        if (!existe) return candidato;
    }
    const e = new Error('No se pudo generar un código de cita libre'); e.statusCode = 500; throw e;
}

/**
 * Crea una cita aplicando todas las reglas de negocio:
 *  - Anticipación mínima
 *  - Profesional ofrece los servicios pedidos
 *  - **Dentro del horario laboral y fuera de todo bloqueo** (F3: antes no se comprobaba)
 *  - Anti-doble-reserva contra citas y holds, con el buffer de limpieza
 *  - Si cobro_adelantado=true: comprobante obligatorio + estado pago=pendiente_validacion
 *
 * Desde F3 las tres últimas las decide `reglasAgenda`, el mismo módulo que usa
 * `disponibilidadService` para ofrecer horas. Antes cada uno tenía su propia versión y
 * divergieron: se ofrecían horas que aquí se rechazaban con un 409, y aquí se aceptaban
 * citas un domingo a las 3 de la mañana porque nadie miraba el horario. Estaba tapado
 * porque el único cliente era un formulario que solo ofrecía lo válido.
 *
 * @param {Object} params
 * @param {number}   params.idNegocio
 * @param {number}   params.idProfesional
 * @param {number[]} params.idServicios          IDs de servicios a incluir
 * @param {string}   params.fechaHoraInicioISO   "2026-05-08T10:00:00" (hora Bogotá)
 * @param {string}   params.clienteNombre
 * @param {string=}  params.clienteTelefono
 * @param {string=}  params.clientePais    ISO alfa-2 del teléfono del cliente. Sin él, se asume
 *                   el país del negocio (lo de siempre; ver personaNegocioDao.resolverOCrear).
 * @param {string=}  params.clienteEmail
 * @param {string=}  params.notas
 * @param {string=}  params.comprobantePath     Ruta relativa del archivo subido
 * @param {number=}  params.creadoPorIdUsuario  Si la crea el negocio
 * @param {number=}  params.consumirHoldId      Hold que esta cita viene a materializar
 * @param {Object=}  opciones.transaction       Transacción de quien llama. Si viene, este
 *                   servicio NO confirma: la decisión de commit es de quien la abrió.
 */
/**
 * Interpreta una fecha-hora que llega sin huso como hora de pared de Bogotá.
 *
 * Estaba repetida en `crearCita` y `reagendarCita` con la misma expresión; al aparecer un
 * tercer llamante (`actualizarCita`) se saca aquí para que las tres no puedan divergir.
 */
function parsearInicio(fechaHoraInicioISO) {
    const traeHuso = fechaHoraInicioISO.includes('+') || fechaHoraInicioISO.endsWith('Z');
    const inicio = new Date(`${fechaHoraInicioISO}${traeHuso ? '' : '-05:00'}`);
    if (Number.isNaN(inicio.getTime())) {
        const e = new Error('fecha_hora_inicio inválida'); e.statusCode = 400; throw e;
    }
    return inicio;
}

/**
 * Valida que el profesional y los servicios sean utilizables juntos en este negocio, y
 * devuelve las filas ya leídas para que quien llame calcule duración y monto sin repetir
 * las consultas.
 *
 * Se extrae de `crearCita` porque editar una cita tiene que aplicar exactamente las mismas
 * reglas: si al crear no se admite un servicio que el profesional no ofrece, al cambiarlo
 * después tampoco. Tenerlo en dos sitios era la forma segura de que un día dejaran de
 * coincidir.
 */
async function validarProfesionalYServicios(
    { idNegocio, idProfesional, idServicios }, { transaction = null } = {},
) {
    const profesional = await Models.ReservaProfesional.findOne({
        where: { id_profesional: idProfesional, id_negocio: idNegocio, estado: 'A' },
        transaction,
    });
    if (!profesional) {
        const e = new Error('Profesional no válido'); e.statusCode = 404; e.code = 'PROFESIONAL_NO_VALIDO'; throw e;
    }

    const servicios = await Models.ReservaServicio.findAll({
        where: { id_servicio: { [Op.in]: idServicios }, id_negocio: idNegocio, estado: 'A' },
        transaction,
    });
    if (servicios.length !== idServicios.length) {
        const e = new Error('Algún servicio no es válido para este negocio');
        e.statusCode = 400; e.code = 'SERVICIO_NO_VALIDO'; throw e;
    }

    const ofrecidos = await Models.ReservaProfesionalServicio.findAll({
        where: { id_profesional: idProfesional, id_servicio: { [Op.in]: idServicios } },
        transaction,
    });
    // Si el profesional aún no tiene asignaciones, lo permitimos (ofrece todos por defecto).
    // Si ya tiene asignaciones, deben cubrir todos los pedidos.
    const totalAsignados = await Models.ReservaProfesionalServicio.count({
        where: { id_profesional: idProfesional },
        transaction,
    });
    if (totalAsignados > 0 && ofrecidos.length !== idServicios.length) {
        const e = new Error('El profesional no ofrece alguno de los servicios solicitados');
        e.statusCode = 400; e.code = 'SERVICIO_NO_OFRECIDO'; throw e;
    }

    return { profesional, servicios };
}

async function crearCita(params, { transaction: transaccionExterna = null } = {}) {
    const {
        idNegocio, idProfesional, idServicios = [],
        fechaHoraInicioISO, clienteNombre, clienteTelefono, clientePais = null, clienteEmail, notas,
        comprobantePath, creadoPorIdUsuario, consumirHoldId = null,
        // Perfiles de rubro. Todos opcionales: sin ellos la cita es la de siempre.
        variantes = null, ajustes = null, idMascota = null, mascota = null,
    } = params;

    if (!idNegocio || !idProfesional || !idServicios.length || !fechaHoraInicioISO || !clienteNombre) {
        const e = new Error('Datos de cita incompletos'); e.statusCode = 400; throw e;
    }

    const cfg = await Disponibilidad.getConfig(idNegocio);
    const funciones = new Set((await Perfiles.perfilDeNegocio(idNegocio)).funciones);
    const esPublico = creadoPorIdUsuario == null;

    const { profesional, servicios } = await validarProfesionalYServicios(
        { idNegocio, idProfesional, idServicios },
    );

    // Un servicio «a cotizar» no tiene precio hasta que el artista lo fija: desde el portal se
    // pide por WhatsApp y lo agenda el negocio, que es quien puede poner el precio acordado.
    if (esPublico && funciones.has('a_cotizar') && servicios.some((s) => s.a_cotizar)) {
        throw errorDominio(
            'Ese servicio se cotiza antes de agendarlo. Escríbenos por WhatsApp y te damos precio y fecha.',
            'SERVICIO_A_COTIZAR',
        );
    }

    // Duración, monto, tramos de espera y recurso. Con las funciones apagadas —la barbería— es la
    // suma de duraciones y precios de lista de siempre.
    const comp = await componerCita({
        idNegocio, idServicios, servicios, variantes,
        // El precio acordado solo lo pone el negocio, nunca el formulario público.
        ajustes: esPublico ? null : ajustes,
        funciones,
    });
    const duracionTotal = comp.duracion;
    const montoTotal = comp.monto;

    if (funciones.has('mascotas') && !idMascota && !String(mascota?.nombre || '').trim()) {
        throw errorDominio('Indica para qué mascota es la cita.', 'MASCOTA_REQUERIDA');
    }

    const fechaInicio = parsearInicio(fechaHoraInicioISO);
    const fechaFin = new Date(fechaInicio.getTime() + duracionTotal * 60_000);

    // Validar anticipación mínima
    const ahora = new Date();
    const minimoMs = cfg.anticipacion_min_horas * 3600_000;
    if (creadoPorIdUsuario == null && fechaInicio.getTime() < ahora.getTime() + minimoMs) {
        const e = new Error(`Debe reservar con al menos ${cfg.anticipacion_min_horas}h de anticipación`);
        e.statusCode = 400; e.code = 'ANTICIPACION_INSUFICIENTE'; throw e;
    }

    // Validar pago adelantado. Con abono (perfiles con depósito) se pide un porcentaje; sin él,
    // el cobro adelantado de siempre, por el total. Un servicio gratis (la valoración) no pide
    // comprobante aunque el negocio cobre abono: no hay nada que abonar.
    const abono = esPublico ? abonoExigible({ cfg, funciones, monto: montoTotal }) : null;
    const requierePago = esPublico && (abono != null ? abono > 0 : !!cfg.cobro_adelantado);
    if (requierePago && !comprobantePath) {
        const e = new Error('Debe adjuntar el comprobante de pago');
        e.statusCode = 400; e.code = 'COMPROBANTE_REQUERIDO'; throw e;
    }

    // Transacción con anti-doble-reserva. Si quien llama trae la suya, se trabaja dentro:
    // es lo que permite que el dry-run del Policy Gate deshaga esto de verdad. Un servicio
    // que confirma por su cuenta convierte «ejecutar en seco» en «ejecutar».
    const propia = !transaccionExterna;
    const t = transaccionExterna || (await Models.sequelize.transaction());
    try {
        // Lock pesimista sobre la agenda de ESTE profesional. Es un advisory lock y no un
        // `SELECT ... FOR UPDATE` sobre las citas que solapan porque las filas conflictivas
        // pueden no existir todavía: dos peticiones simultáneas para el mismo hueco vacío no
        // tienen ninguna fila que bloquear, y las dos pasarían la comprobación. El lock
        // serializa por profesional, que es el grano al que se reserva.
        await Models.sequelize.query('SELECT pg_advisory_xact_lock(:clave);', {
            replacements: { clave: idProfesional },
            transaction: t,
        });

        await Reglas.verificarReservable(
            {
                idNegocio,
                idProfesional,
                inicio: fechaInicio,
                fin: fechaFin,
                bufferMin: cfg.buffer_limpieza_min,
                tramos: comp.tramos,
            },
            // Si esta cita viene de un hold, su propio hold no cuenta como conflicto: es
            // precisamente el hueco que estaba guardando.
            { transaction: t, excluirHold: consumirHoldId }
        );

        // La cabina, si hace falta. Si el hold ya apartó una, se prefiere esa.
        const holdPrevio = consumirHoldId && comp.idTipoRecurso
            ? await Models.ReservaHold.findByPk(consumirHoldId, { attributes: ['id_recurso'], transaction: t })
            : null;
        const idRecurso = await apartarRecurso(
            {
                idNegocio, comp, inicio: fechaInicio, fin: fechaFin,
                bufferMin: cfg.buffer_limpieza_min, preferido: holdPrevio?.id_recurso ?? null,
            },
            { transaction: t, excluirHold: consumirHoldId },
        );

        // El cliente del negocio (platform.persona_negocio), resuelto por teléfono. Este es
        // el único sitio donde hay que engancharlo: el portal público y la agenda del admin
        // pasan los dos por aquí, y la diferencia entre ellos es solo `creadoPorIdUsuario`.
        //
        // Best-effort a propósito (ADR-006): si la identidad falla, la cita se agenda igual
        // con `id_persona_negocio = NULL`. Nadie se queda sin cita porque el módulo de
        // clientes tenga un problema — y devuelve null también, sin ser un error, cuando el
        // teléfono no es un móvil colombiano utilizable.
        let idPersonaNegocio = clienteTelefono
            ? await personaNegocioDao.resolverOCrearBestEffort(
                  { idNegocio, telefono: clienteTelefono, nombre: clienteNombre, pais: clientePais },
                  { transaction: t }
              )
            : null;

        // La mascota (perfil MASCOTAS). El negocio la elige de la lista del cliente; el portal
        // la describe y se reconoce por nombre si el dueño ya la había traído. Si el teléfono no
        // identifica a nadie no hay a quién colgarla: la cita se agenda igual con el nombre en
        // las notas, que es mejor que dejar al cliente sin cita (misma regla que ADR-006).
        let idMascotaFinal = null;
        let notasFinales = notas || null;
        if (funciones.has('mascotas')) {
            if (idMascota) {
                const m = await MascotaService.obtener(idNegocio, idMascota, { transaction: t });
                if (idPersonaNegocio && m.id_persona_negocio !== idPersonaNegocio) {
                    throw errorDominio('Esa mascota es de otro cliente.', 'MASCOTA_DE_OTRO_CLIENTE');
                }
                idPersonaNegocio = idPersonaNegocio || m.id_persona_negocio;
                idMascotaFinal = m.id_mascota;
            } else if (idPersonaNegocio) {
                idMascotaFinal = (await MascotaService.resolverOCrear(
                    idNegocio, idPersonaNegocio, mascota, { transaction: t },
                )).id_mascota;
            } else {
                const m = mascota || {};
                const detalle = [m.nombre, m.raza, m.tamano].filter(Boolean).join(' · ');
                notasFinales = [`Mascota: ${detalle}`, notasFinales].filter(Boolean).join('\n');
            }
        }

        const codigoPublico = await generarCodigoLibre({ transaction: t });

        const cita = await Models.ReservaCita.create({
            id_negocio: idNegocio,
            id_profesional: idProfesional,
            id_persona_negocio: idPersonaNegocio,
            codigo_publico: codigoPublico,
            fecha_hora_inicio: fechaInicio,
            fecha_hora_fin: fechaFin,
            estado: 'pendiente',
            cliente_nombre: clienteNombre,
            cliente_telefono: clienteTelefono || null,
            cliente_pais: clientePais || null,
            cliente_email: clienteEmail || null,
            notas: notasFinales,
            creado_por_id_usuario: creadoPorIdUsuario || null,
            requiere_pago: requierePago,
            monto_total: montoTotal,
            comprobante_pago_url: comprobantePath || null,
            pago_estado: requierePago ? 'pendiente_validacion' : 'no_aplica',
            proceso_tramos: comp.tramos,
            monto_abono: requierePago && abono != null ? abono : null,
            id_mascota: idMascotaFinal,
            id_recurso: idRecurso,
        }, { transaction: t });

        // Detalle de servicios con snapshot: precio, duración y variante del momento, para que
        // cambiar la tarifa mañana no reescriba lo que ya se prometió.
        const detalles = comp.lineas.map(l => ({ id_cita: cita.id_cita, ...l }));
        await Models.ReservaCitaServicio.bulkCreate(detalles, { transaction: t });

        // El primer evento de dominio que emite una vertical (ADR-013). Va DENTRO de la
        // transacción de la cita, que es todo el punto del outbox (ADR-012): si la cita no
        // llega a existir, el evento tampoco, y no hay forma de que se despeguen.
        //
        // Delgado a propósito: solo el identificador. Quien lo consume relee lo que necesite —
        // hoy el programador de recordatorios de F8-B, que además vuelve a leer la cita al
        // vencer, así que un evento con la hora dentro envejecería en cuanto alguien reagende.
        //
        // Nótese que NO se emite en un try/catch: un evento que se pierde en silencio deja al
        // cliente sin recordatorio y a nadie enterado. Si el outbox no puede escribir, la cita
        // no se crea, que es lo que ADR-012 pide y lo que hace que este mecanismo valga algo.
        await outboxDao.emitir(
            { tipo: 'cita.creada.v1', idNegocio, payload: { id_cita: cita.id_cita } },
            { transaction: t }
        );

        // El hold se consume en la MISMA transacción que la cita: o existen los dos, o
        // ninguno. Si se marcara después, un fallo entre medias dejaría un hold activo
        // bloqueando un hueco que ya tiene cita.
        if (consumirHoldId) {
            await Models.ReservaHold.update(
                { estado: 'confirmado', id_cita: cita.id_cita },
                { where: { id_hold: consumirHoldId, id_negocio: idNegocio }, transaction: t }
            );
        }

        if (propia) {
            await t.commit();

            // Notificación post-commit (no rompe la transacción si falla).
            //
            // Solo cuando la transacción es nuestra: con una externa todavía no sabemos si
            // la cita va a existir. Notificar antes del commit ajeno es prometerle al
            // cliente una cita que un rollback puede borrar — y un correo enviado no se
            // deshace. Quien abra la transacción notifica después de confirmarla.
            Notificacion.enviar(requierePago ? 'cita_pendiente_pago' : 'cita_creada', {
                cita: cita.toJSON(), servicios, profesional: profesional.toJSON(),
            }).catch(err => console.error('[Reserva] notif error:', err.message));
        }

        return await getCitaConDetalle(cita.id_cita, { transaction: propia ? null : t });
    } catch (err) {
        if (propia && t.finished !== 'commit' && t.finished !== 'rollback') await t.rollback();
        throw err;
    }
}

async function getCitaConDetalle(idCita, { transaction = null } = {}) {
    return Models.ReservaCita.findOne({
        transaction,
        where: { id_cita: idCita },
        include: [
            { model: Models.ReservaProfesional, as: 'profesional',
              attributes: ['id_profesional', 'nombre', 'foto_url', 'color_hex', 'especialidad'] },
            { model: Models.ReservaCitaServicio, as: 'servicios',
              include: [{ model: Models.ReservaServicio, as: 'servicio',
                          attributes: ['id_servicio', 'nombre', 'requiere_consentimiento', 'a_cotizar'] }] },
            { model: Models.ReservaMascota, as: 'mascota', required: false,
              attributes: ['id_mascota', 'nombre', 'especie', 'raza', 'tamano', 'comportamiento'] },
            { model: Models.ReservaRecurso, as: 'recurso', required: false,
              attributes: ['id_recurso', 'nombre'] },
        ],
    });
}

/**
 * Recompone una cita ya existente a partir de sus líneas: mismos servicios, mismas variantes y,
 * en los servicios «a cotizar», la duración y el precio que se acordaron. Lo usa reagendar, que
 * mueve la cita sin cambiar lo que se va a prestar.
 */
async function recomponerDesdeLineas(idNegocio, idCita, funciones, transaction) {
    const lineas = await Models.ReservaCitaServicio.findAll({
        where: { id_cita: idCita },
        attributes: ['id_servicio', 'id_variante', 'precio_snapshot', 'duracion_snapshot_min'],
        transaction,
    });
    const idServicios = lineas.map((l) => l.id_servicio);
    const servicios = await Models.ReservaServicio.findAll({
        where: { id_servicio: idServicios, id_negocio: idNegocio },
        transaction,
    });
    const variantes = Object.fromEntries(
        lineas.filter((l) => l.id_variante).map((l) => [l.id_servicio, l.id_variante]),
    );
    // Solo con la función encendida: si el dueño la apagó, esos servicios vuelven a su precio y
    // duración de lista, igual que al crear.
    const ajustes = lineas
        .filter((l) => funciones.has('a_cotizar')
            && servicios.find((s) => s.id_servicio === l.id_servicio)?.a_cotizar)
        .map((l) => ({
            id_servicio: l.id_servicio,
            precio: Number(l.precio_snapshot),
            duracion_min: l.duracion_snapshot_min,
        }));
    return componerCita({ idNegocio, idServicios, servicios, variantes, ajustes, funciones });
}

async function getCitaPorCodigo(codigoPublico) {
    const normalizado = CodigoCita.normalizar(codigoPublico);
    if (!normalizado) return null;
    return Models.ReservaCita.findOne({
        where: { codigo_publico: normalizado },
        include: [
            { model: Models.ReservaProfesional, as: 'profesional',
              attributes: ['id_profesional', 'nombre', 'foto_url', 'color_hex', 'especialidad'] },
            { model: Models.ReservaCitaServicio, as: 'servicios',
              include: [{ model: Models.ReservaServicio, as: 'servicio',
                          attributes: ['id_servicio', 'nombre'] }] },
            { model: Models.GenerNegocio, as: 'negocio',
              attributes: ['id_negocio', 'nombre'] },
        ],
    });
}

/**
 * Cancela una cita a petición del cliente, identificándola por su código público.
 *
 * `idNegocio` es opcional porque el enlace público de cancelación no sabe a qué negocio
 * pertenece la cita: el código uuid es toda su credencial. Quien SÍ conoce el negocio —el
 * panel, y el asistente a través del Policy Gate— debe pasarlo, y entonces la búsqueda queda
 * acotada al inquilino. Sin ese filtro, un código de otro negocio se cancelaría igual: la
 * probabilidad de acertar un uuid es despreciable, pero el aislamiento no debe depender de
 * una probabilidad (ADR-002).
 */
async function cancelarPorCliente(codigoPublico, motivo, { idNegocio = null, transaction = null } = {}) {
    const normalizado = CodigoCita.normalizar(codigoPublico);
    if (!normalizado) {
        const e = new Error('Cita no encontrada'); e.statusCode = 404; throw e;
    }
    const where = { codigo_publico: normalizado };
    if (idNegocio) where.id_negocio = idNegocio;

    const cita = await Models.ReservaCita.findOne({ where, transaction });
    if (!cita) {
        const e = new Error('Cita no encontrada'); e.statusCode = 404; throw e;
    }
    // Con transacción externa esto lo llama el bot (sin request ni JWT): el actor de auditoría es
    // el usuario asistente del negocio. Sin transacción (la web pública) no hay actor que fijar.
    await fijarActorAsistente(transaction, cita.id_negocio);
    // Antes esta comprobación estaba escrita a mano aquí y en ningún otro sitio. Ahora es la
    // misma máquina de estados que usan el panel y (en F4-B) el asistente.
    EstadoCita.exigirTransicion(cita.estado, EstadoCita.ESTADO.CANCELADA);

    const cfg = await Disponibilidad.getConfig(cita.id_negocio);
    const ahora = new Date();
    const ventanaMs = cfg.ventana_cancelacion_horas * 3600_000;
    if (new Date(cita.fecha_hora_inicio).getTime() - ahora.getTime() < ventanaMs) {
        const e = new Error(`Solo se puede cancelar con ${cfg.ventana_cancelacion_horas}h de anticipación`);
        e.statusCode = 400; e.code = 'CANCELACION_TARDE'; throw e;
    }

    await cita.update(
        {
            estado: 'cancelada',
            cancelado_por: 'cliente',
            cancelado_motivo: motivo || null,
            fecha_actualizacion: new Date(),
        },
        { transaction }
    );

    // Con transacción externa todavía no se sabe si la cancelación va a existir: notificar
    // antes del commit ajeno es avisar de algo que un rollback puede deshacer, y un correo
    // enviado no se deshace.
    if (!transaction) {
        Notificacion.enviar('cita_cancelada', { cita: cita.toJSON() })
            .catch(err => console.error('[Reserva] notif error:', err.message));
    }

    return cita;
}

/**
 * Mueve una cita a otra hora, del mismo o de otro profesional.
 *
 * Pasa por la **misma puerta** que crear (`reglasAgenda.verificarReservable`): reagendar es
 * crear en otro sitio, y sería absurdo que se pudiera mover una cita a un domingo por el
 * hecho de que ya existía.
 *
 * Se relee y revalida el estado **dentro de la transacción**, sin fiarse de lo que sepa
 * quien llama: entre que alguien decide reagendar y lo ejecuta, la cita pudo cancelarse
 * desde el panel (ADR-010, «el contexto es una pista, nunca un hecho»).
 *
 * La duración se recalcula desde los servicios ya asociados a la cita, no se hereda del
 * intervalo anterior: si un servicio cambió de duración, la cita movida debe ocupar lo que
 * ocupa hoy, no lo que ocupaba el día que se creó.
 */
async function reagendarCita(
    { idCita, idNegocio, nuevaFechaHoraInicioISO, idProfesional = null, consumirHoldId = null },
    { transaction: transaccionExterna = null } = {}
) {
    if (!idCita || !idNegocio || !nuevaFechaHoraInicioISO) {
        const e = new Error('Datos incompletos para reagendar'); e.statusCode = 400; throw e;
    }

    const cfg = await Disponibilidad.getConfig(idNegocio);
    const propia = !transaccionExterna;
    const t = transaccionExterna || (await Models.sequelize.transaction());

    try {
        const cita = await Models.ReservaCita.findOne({
            where: { id_cita: idCita, id_negocio: idNegocio },
            transaction: t,
            lock: t.LOCK.UPDATE,
        });
        if (!cita) {
            const e = new Error('Cita no encontrada'); e.statusCode = 404; throw e;
        }
        // Transacción ajena = el bot (sin request): el actor de auditoría es el usuario asistente.
        if (transaccionExterna) await fijarActorAsistente(t, idNegocio);
        if (EstadoCita.esTerminal(cita.estado)) {
            const e = new Error(`Una cita "${cita.estado}" ya está cerrada y no se puede reagendar.`);
            e.statusCode = 409; e.code = 'TRANSICION_INVALIDA'; throw e;
        }

        // La duración sale de las líneas de la cita: con variantes o precio acordado no es la del
        // catálogo. Sin ellas (la barbería) es exactamente la suma de duraciones de lista de antes.
        const funciones = new Set((await Perfiles.perfilDeNegocio(idNegocio, { transaction: t })).funciones);
        const comp = await recomponerDesdeLineas(idNegocio, idCita, funciones, t);
        const duracionTotal = comp.duracion;

        const inicio = parsearInicio(nuevaFechaHoraInicioISO);
        const fin = new Date(inicio.getTime() + duracionTotal * 60_000);
        const profesionalDestino = idProfesional || cita.id_profesional;

        await Models.sequelize.query('SELECT pg_advisory_xact_lock(:clave);', {
            replacements: { clave: profesionalDestino },
            transaction: t,
        });

        await Reglas.verificarReservable(
            {
                idNegocio, idProfesional: profesionalDestino, inicio, fin,
                bufferMin: cfg.buffer_limpieza_min, tramos: comp.tramos,
            },
            // La propia cita no cuenta como conflicto consigo misma: mover una cita 15
            // minutos dentro de su propio buffer es legítimo y si no se excluyera fallaría.
            { transaction: t, excluirCita: idCita, excluirHold: consumirHoldId }
        );

        const idRecurso = await apartarRecurso(
            {
                idNegocio, comp, inicio, fin, bufferMin: cfg.buffer_limpieza_min,
                preferido: cita.id_recurso,
            },
            { transaction: t, excluirCita: idCita, excluirHold: consumirHoldId },
        );

        await cita.update(
            {
                id_profesional: profesionalDestino,
                fecha_hora_inicio: inicio,
                fecha_hora_fin: fin,
                proceso_tramos: comp.tramos,
                id_recurso: idRecurso,
                fecha_actualizacion: new Date(),
            },
            { transaction: t }
        );

        if (consumirHoldId) {
            await Models.ReservaHold.update(
                { estado: 'confirmado', id_cita: idCita },
                { where: { id_hold: consumirHoldId, id_negocio: idNegocio }, transaction: t }
            );
        }

        if (propia) {
            await t.commit();
            Notificacion.enviar('cita_reagendada', { cita: cita.toJSON() })
                .catch(err => console.error('[Reserva] notif error:', err.message));
        }

        return await getCitaConDetalle(idCita, { transaction: propia ? null : t });
    } catch (err) {
        if (propia && t.finished !== 'commit' && t.finished !== 'rollback') await t.rollback();
        throw err;
    }
}

/**
 * Edita una cita ya agendada: sus servicios, su profesional y su hora.
 *
 * Es lo que faltaba para poder corregir un pedido sin borrarlo y volverlo a crear —que era
 * la única salida y perdía el histórico, el código público y los recordatorios ya
 * programados—.
 *
 * ## Por qué recalcula y revalida siempre
 *
 * Cambiar de servicio cambia la duración, y la duración cambia la hora de fin. Un corte de
 * 30 min que pasa a corte + barba de 50 ocupa veinte minutos que pueden ser de la cita
 * siguiente. Por eso no basta con reescribir las líneas: hay que recolocar el fin y volver a
 * pasar por `verificarReservable`, igual que si se estuviera creando. Se excluye la propia
 * cita del choque, porque de lo contrario colisionaría consigo misma.
 *
 * ## Qué NO toca
 *
 * Ni el estado ni el cobro. Una cita en estado terminal (completada, cancelada, no_show) se
 * rechaza: la completada ya pasó por caja con su `monto_total`, y moverlo ahora descuadraría
 * un turno que quizá ya se cerró. Para eso están las acciones de estado, no esta.
 *
 * Los datos del cliente tampoco se tocan aquí: esta operación es sobre lo que se presta y
 * cuándo, que es lo que compite por la agenda.
 *
 * @param {number}   params.idCita
 * @param {number}   params.idNegocio
 * @param {number[]} params.idServicios          Lista COMPLETA que debe quedar (reemplaza).
 * @param {number=}  params.idProfesional        Si se omite, conserva el actual.
 * @param {string=}  params.fechaHoraInicioISO   Si se omite, conserva la hora actual.
 * @param {number=}  params.idUsuario            Quién edita, para el evento de auditoría.
 */
async function actualizarCita(
    {
        idCita, idNegocio, idServicios = [], idProfesional = null, fechaHoraInicioISO = null, idUsuario = null,
        variantes = null, ajustes = null, idMascota,
    },
    { transaction: transaccionExterna = null } = {},
) {
    if (!idCita || !idNegocio || !idServicios.length) {
        const e = new Error('Datos incompletos para editar la cita'); e.statusCode = 400; throw e;
    }

    const cfg = await Disponibilidad.getConfig(idNegocio);
    const propia = !transaccionExterna;
    const t = transaccionExterna || (await Models.sequelize.transaction());

    try {
        const cita = await Models.ReservaCita.findOne({
            where: { id_cita: idCita, id_negocio: idNegocio },
            transaction: t,
            lock: t.LOCK.UPDATE,
        });
        if (!cita) {
            const e = new Error('Cita no encontrada'); e.statusCode = 404; throw e;
        }
        if (EstadoCita.esTerminal(cita.estado)) {
            const e = new Error(`Una cita "${cita.estado}" ya está cerrada y no se puede editar.`);
            e.statusCode = 409; e.code = 'TRANSICION_INVALIDA'; throw e;
        }

        const profesionalDestino = idProfesional || cita.id_profesional;

        const { servicios } = await validarProfesionalYServicios(
            { idNegocio, idProfesional: profesionalDestino, idServicios },
            { transaction: t },
        );

        const funciones = new Set((await Perfiles.perfilDeNegocio(idNegocio, { transaction: t })).funciones);
        const comp = await componerCita({ idNegocio, idServicios, servicios, variantes, ajustes, funciones });
        const duracionTotal = comp.duracion;
        const montoTotal = comp.monto;

        // Cambiar la mascota (o quitarla) solo si viene en la petición: `undefined` la conserva.
        let idMascotaFinal = cita.id_mascota;
        if (idMascota !== undefined && funciones.has('mascotas')) {
            if (idMascota) {
                const m = await MascotaService.obtener(idNegocio, idMascota, { transaction: t });
                if (cita.id_persona_negocio && m.id_persona_negocio !== cita.id_persona_negocio) {
                    throw errorDominio('Esa mascota es de otro cliente.', 'MASCOTA_DE_OTRO_CLIENTE');
                }
                idMascotaFinal = m.id_mascota;
            } else {
                throw errorDominio('Indica para qué mascota es la cita.', 'MASCOTA_REQUERIDA');
            }
        }

        const inicio = fechaHoraInicioISO
            ? parsearInicio(fechaHoraInicioISO)
            : new Date(cita.fecha_hora_inicio);
        const fin = new Date(inicio.getTime() + duracionTotal * 60_000);

        // Mismo grano de bloqueo que al crear: la agenda de un profesional.
        await Models.sequelize.query('SELECT pg_advisory_xact_lock(:clave);', {
            replacements: { clave: profesionalDestino },
            transaction: t,
        });

        await Reglas.verificarReservable(
            {
                idNegocio, idProfesional: profesionalDestino, inicio, fin,
                bufferMin: cfg.buffer_limpieza_min, tramos: comp.tramos,
            },
            { transaction: t, excluirCita: idCita },
        );

        const idRecurso = await apartarRecurso(
            { idNegocio, comp, inicio, fin, bufferMin: cfg.buffer_limpieza_min, preferido: cita.id_recurso },
            { transaction: t, excluirCita: idCita },
        );

        // Huella del antes, para que el evento diga qué cambió y no solo que se editó.
        const antes = {
            id_profesional: cita.id_profesional,
            fecha_hora_inicio: cita.fecha_hora_inicio,
            fecha_hora_fin: cita.fecha_hora_fin,
            monto_total: Number(cita.monto_total),
            servicios: (await Models.ReservaCitaServicio.findAll({
                where: { id_cita: idCita },
                attributes: ['id_servicio'],
                transaction: t,
            })).map(l => l.id_servicio),
        };

        // Las líneas se reemplazan enteras y con snapshot nuevo: si el precio de lista
        // cambió desde que se agendó, lo que se cobra es lo que vale hoy el servicio que
        // realmente se va a prestar.
        await Models.ReservaCitaServicio.destroy({ where: { id_cita: idCita }, transaction: t });
        await Models.ReservaCitaServicio.bulkCreate(
            comp.lineas.map(l => ({ id_cita: idCita, ...l })),
            { transaction: t },
        );

        await cita.update(
            {
                id_profesional: profesionalDestino,
                fecha_hora_inicio: inicio,
                fecha_hora_fin: fin,
                monto_total: montoTotal,
                proceso_tramos: comp.tramos,
                id_recurso: idRecurso,
                id_mascota: idMascotaFinal,
                fecha_actualizacion: new Date(),
            },
            { transaction: t },
        );

        await Audit.registrarEvento({
            modulo: 'reserva',
            accion: 'cita_editada',
            idUsuario,
            idNegocio,
            detalle: {
                id_cita: idCita,
                antes,
                despues: {
                    id_profesional: profesionalDestino,
                    fecha_hora_inicio: inicio,
                    fecha_hora_fin: fin,
                    monto_total: montoTotal,
                    servicios: comp.lineas.map(l => l.id_servicio),
                },
            },
            transaction: t,
        });

        if (propia) {
            await t.commit();
            // Al cliente le cambió lo que va a recibir o cuándo: se le avisa con el mismo
            // canal del reagendado, que es el aviso que ya entiende.
            Notificacion.enviar('cita_reagendada', { cita: cita.toJSON() })
                .catch(err => console.error('[Reserva] notif error:', err.message));
        }

        return await getCitaConDetalle(idCita, { transaction: propia ? null : t });
    } catch (err) {
        if (propia && t.finished !== 'commit' && t.finished !== 'rollback') await t.rollback();
        throw err;
    }
}

/**
 * Aprueba el comprobante del cliente.
 *
 * Con **abono** (perfiles con depósito) la aprobación también dice por dónde llegó el dinero
 * (`idMetodoPago`) y, si hay un turno de caja abierto, lo asienta en él en ese momento: es
 * dinero que ya está en la cuenta del negocio. Si la caja está cerrada se aprueba igual y el
 * abono queda por asentar; `completarYCobrar` lo mete en el turno en que se cobre el saldo. Así
 * el abono entra en una caja exactamente una vez.
 *
 * Sin abono (el cobro adelantado de siempre, por el total) no toca la caja, como antes.
 */
async function aprobarPago(idCita, idNegocio, idUsuario, { idMetodoPago = null } = {}) {
    const cita = await Models.sequelize.transaction(async (t) => {
        const c = await Models.ReservaCita.findOne({
            where: { id_cita: idCita, id_negocio: idNegocio }, transaction: t, lock: t.LOCK.UPDATE,
        });
        if (!c) { const e = new Error('Cita no encontrada'); e.statusCode = 404; throw e; }
        if (c.pago_estado !== 'pendiente_validacion') {
            const e = new Error('La cita no está pendiente de validación de pago'); e.statusCode = 409; throw e;
        }
        EstadoCita.exigirTransicion(c.estado, EstadoCita.ESTADO.CONFIRMADA);

        const cambios = {
            pago_estado: 'aprobado',
            estado: 'confirmada',
            pago_validado_por_id_usuario: idUsuario,
            pago_validado_en: new Date(),
            fecha_actualizacion: new Date(),
        };

        if (c.monto_abono != null && Number(c.monto_abono) > 0) {
            if (idMetodoPago) {
                await require('./metodoPagoService').validarDelNegocio(idNegocio, [Number(idMetodoPago)], { transaction: t });
                cambios.id_metodo_pago_abono = Number(idMetodoPago);
            }
            const CajaService = require('./cajaService');
            const caja = await CajaService.getCajaAbiertaRaw(idNegocio, { transaction: t });
            if (caja) {
                await CajaService.registrarMovimiento({
                    idCaja: caja.id_caja,
                    tipo: 'INGRESO',
                    monto: Number(c.monto_abono),
                    concepto: `Abono cita #${c.id_cita} · ${c.cliente_nombre}`,
                    idUsuario,
                    idCita: c.id_cita,
                    idProfesional: c.id_profesional,
                    idMetodoPago: cambios.id_metodo_pago_abono ?? c.id_metodo_pago_abono ?? null,
                    transaction: t,
                });
                cambios.id_caja_abono = caja.id_caja;
            }
        }

        return c.update(cambios, { transaction: t });
    });

    Notificacion.enviar('pago_aprobado', { cita: cita.toJSON() })
        .catch(err => console.error('[Reserva] notif error:', err.message));

    return cita;
}

/**
 * Asienta en la caja abierta un abono aprobado que aún no entró en ningún turno: el de una cita
 * cancelada o sin asistencia cuyo abono **no se devuelve** (el tatuador que pierde seis horas
 * se queda la seña), o el de una aprobada con la caja cerrada que no se va a completar.
 */
async function asentarAbono(idCita, idNegocio, idUsuario, { idMetodoPago = null } = {}) {
    return Models.sequelize.transaction(async (t) => {
        const c = await Models.ReservaCita.findOne({
            where: { id_cita: idCita, id_negocio: idNegocio }, transaction: t, lock: t.LOCK.UPDATE,
        });
        if (!c) throw errorDominio('Cita no encontrada', 'CITA_NO_ENCONTRADA', 404);
        if (c.monto_abono == null || c.pago_estado !== 'aprobado') {
            throw errorDominio('Esta cita no tiene un abono aprobado.', 'SIN_ABONO', 409);
        }
        if (c.id_caja_abono) throw errorDominio('El abono ya está en la caja.', 'ABONO_YA_ASENTADO', 409);

        const CajaService = require('./cajaService');
        const caja = await CajaService.requireCajaAbierta(idNegocio, { transaction: t });
        const metodo = idMetodoPago ?? c.id_metodo_pago_abono ?? null;
        if (metodo) await require('./metodoPagoService').validarDelNegocio(idNegocio, [Number(metodo)], { transaction: t });
        await CajaService.registrarMovimiento({
            idCaja: caja.id_caja, tipo: 'INGRESO', monto: Number(c.monto_abono),
            concepto: `Abono retenido cita #${c.id_cita} · ${c.cliente_nombre}`,
            idUsuario, idCita: c.id_cita, idProfesional: c.id_profesional,
            idMetodoPago: metodo, transaction: t,
        });
        return c.update({ id_caja_abono: caja.id_caja, id_metodo_pago_abono: metodo }, { transaction: t });
    });
}

/**
 * Devuelve un abono ya asentado de una cita cancelada: un egreso en la caja abierta. Solo una
 * vez por cita —se reconoce por el egreso ya registrado— porque devolver dos veces es regalar.
 */
async function devolverAbono(idCita, idNegocio, idUsuario, { idMetodoPago = null } = {}) {
    return Models.sequelize.transaction(async (t) => {
        const c = await Models.ReservaCita.findOne({
            where: { id_cita: idCita, id_negocio: idNegocio }, transaction: t, lock: t.LOCK.UPDATE,
        });
        if (!c) throw errorDominio('Cita no encontrada', 'CITA_NO_ENCONTRADA', 404);
        if (!['cancelada', 'no_show'].includes(c.estado)) {
            throw errorDominio('Solo se devuelve el abono de una cita cancelada o sin asistencia.', 'TRANSICION_INVALIDA', 409);
        }
        if (!c.id_caja_abono) throw errorDominio('El abono no está en ninguna caja: no hay nada que devolver.', 'ABONO_NO_ASENTADO', 409);
        const yaDevuelto = await Models.ReservaMovimientoCaja.count({
            where: { id_cita: c.id_cita, tipo: 'EGRESO' }, transaction: t,
        });
        if (yaDevuelto > 0) throw errorDominio('Ese abono ya se devolvió.', 'ABONO_YA_DEVUELTO', 409);

        const CajaService = require('./cajaService');
        const caja = await CajaService.requireCajaAbierta(idNegocio, { transaction: t });
        await CajaService.registrarMovimiento({
            idCaja: caja.id_caja, tipo: 'EGRESO', monto: Number(c.monto_abono),
            concepto: `Devolución abono cita #${c.id_cita} · ${c.cliente_nombre}`,
            idUsuario, idCita: c.id_cita, idProfesional: c.id_profesional,
            idMetodoPago: idMetodoPago ?? c.id_metodo_pago_abono ?? null, transaction: t,
        });
        return c;
    });
}

async function rechazarPago(idCita, idNegocio, idUsuario, motivo) {
    const cita = await Models.ReservaCita.findOne({ where: { id_cita: idCita, id_negocio: idNegocio } });
    if (!cita) { const e = new Error('Cita no encontrada'); e.statusCode = 404; throw e; }
    if (cita.pago_estado !== 'pendiente_validacion') {
        const e = new Error('La cita no está pendiente de validación de pago'); e.statusCode = 409; throw e;
    }
    EstadoCita.exigirTransicion(cita.estado, EstadoCita.ESTADO.CANCELADA);
    await Models.sequelize.transaction((t) => cita.update({
        pago_estado: 'rechazado',
        estado: 'cancelada',
        pago_validado_por_id_usuario: idUsuario,
        pago_validado_en: new Date(),
        pago_rechazo_motivo: motivo || null,
        fecha_actualizacion: new Date(),
    }, { transaction: t }));

    Notificacion.enviar('pago_rechazado', { cita: cita.toJSON(), motivo })
        .catch(err => console.error('[Reserva] notif error:', err.message));

    return cita;
}

/**
 * Borra una cita **definitivamente**. No es cancelar.
 *
 * Cancelar deja la cita en el histórico con su motivo, que es lo que hay que hacer el 99% de
 * las veces. Esto es para el 1% restante: la cita de prueba, la que se creó dos veces, la que
 * no debería existir. Por eso cuelga de su propio permiso (`agenda_eliminar`) y por defecto
 * solo lo tiene el administrador.
 *
 * ## Qué se lleva por delante
 *
 * Las FK ya lo deciden: `reserva_cita_servicio` y `reserva_pago_cita` van en CASCADE (son
 * detalle de la cita y sin ella no significan nada) y `reserva_hold`/`reserva_movimiento_caja`
 * quedan con `id_cita = NULL`. Eso último es deliberado: **el dinero no se borra**. Un
 * movimiento de caja ya asentado forma parte del cuadre de un turno; si se fuera con la cita,
 * la caja dejaría de cuadrar sola y nadie sabría por qué. Se queda, huérfano y con su concepto,
 * y para quitarlo hay que borrarlo aparte con `caja_eliminar`.
 *
 * ## Auditoría
 *
 * El trigger `trg_audit` de `reserva_cita` guarda el snapshot completo de la fila borrada. Aquí
 * se añade el evento de aplicación —quién, cuándo, cuánto— porque el snapshot dice *qué* fila
 * desapareció pero no que fue una decisión deliberada de una persona.
 */
async function eliminarCita(idCita, idNegocio, { idUsuario = null } = {}) {
    return Models.sequelize.transaction(async (t) => {
        const cita = await Models.ReservaCita.findOne({
            where: { id_cita: idCita, id_negocio: idNegocio },
            transaction: t,
            lock: t.LOCK.UPDATE,
        });
        if (!cita) return null;

        const huella = {
            id_cita: cita.id_cita,
            cliente_nombre: cita.cliente_nombre,
            estado: cita.estado,
            monto_total: Number(cita.monto_total ?? 0),
            fecha_hora_inicio: cita.fecha_hora_inicio,
            id_profesional: cita.id_profesional,
            id_caja: cita.id_caja,
        };

        await cita.destroy({ transaction: t });

        await Audit.registrarEvento({
            modulo: 'reserva',
            accion: 'cita_eliminada',
            idUsuario,
            idNegocio,
            detalle: huella,
            transaction: t,
        });

        return huella;
    });
}

module.exports = {
    crearCita, actualizarCita, reagendarCita, getCitaConDetalle, getCitaPorCodigo,
    cancelarPorCliente, aprobarPago, rechazarPago, eliminarCita,
    asentarAbono, devolverAbono, componerCita,
};
