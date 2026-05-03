/**
 * registroTrialService.js — Creación automática de cuenta trial.
 *
 * Flujo:
 *   1. verificarYCrearCuentaTrial(email, code)
 *      a) Verifica el OTP almacenado
 *      b) Recupera datos del solicitante (nombre, cédula, tipo_negocio)
 *      c) Crea usuario (cédula = contraseña temporal, debe_cambiar_password = true)
 *      d) Crea una sucursal (negocio) asociada al usuario
 *      e) Asigna Plan Básico por 7 días sin auto-renovación
 *      f) Envía correo de bienvenida y notificación al admin
 */

const bcrypt = require('bcrypt');
const { Op }  = require('sequelize');

const Models         = require('../../app_core/models/conection');
const CodigoVerifDao = require('../../app_core/dao/codigoVerificacionDao');
const MailService    = require('./mailService');
const { initTransaction } = require('../../app_core/helpers/funcionesAdicionales');
const { syncUsuarioRolActivo, rebuildNivelesUsuario } = require('../../app_core/dao/usuarioAdminDao');

const TIPO        = 'REGISTRO';
const MAX_ATTEMPTS = parseInt(process.env.OTP_MAX_ATTEMPTS || '5', 10);
const TRIAL_DAYS    = 7;

// Mapa tipo_negocio → nombre en la DB (general.gener_tipo_negocio.nombre)
const TIPO_NEGOCIO_LABELS = {
    RESTAURANTE: 'Mi Restaurante',
    PARQUEADERO: 'Mi Parqueadero',
    GIMNASIO:    'Mi Gimnasio',
    TIENDA:      'Mi Tienda',
};

/**
 * Divide un nombre completo en sus partes (primer_nombre, segundo_nombre?, primer_apellido).
 * Heurística simple: primera parte = primer nombre, última = primer apellido.
 */
function parsearNombreCompleto(nombreCompleto) {
    const partes = nombreCompleto.trim().split(/\s+/).filter(Boolean);
    if (partes.length === 1) return { primer_nombre: partes[0], primer_apellido: partes[0] };
    if (partes.length === 2) return { primer_nombre: partes[0], primer_apellido: partes[1] };
    return {
        primer_nombre:   partes[0],
        segundo_nombre:  partes.slice(1, -1).join(' '),
        primer_apellido: partes[partes.length - 1],
    };
}

/**
 * Verifica el OTP de registro y, si es válido, crea automáticamente la cuenta trial:
 * usuario + sucursal + plan de 7 días.
 *
 * @param {string} email - Email verificado
 * @param {string} code  - OTP de 6 dígitos
 * @returns {Promise<{ ok: boolean, data?: { nombre: string, numIdentificacion: string }, error?: string }>}
 */
async function verificarYCrearCuentaTrial(email, code) {
    const normalizedEmail = email.toLowerCase().trim();

    // 1. Buscar código activo
    const tokenRecord = await CodigoVerifDao.findActiveByEmailAndTipo(normalizedEmail, TIPO);
    if (!tokenRecord) {
        return { ok: false, error: 'Código inválido o expirado.' };
    }

    // 2. Verificar límite de intentos
    if (tokenRecord.attempts >= MAX_ATTEMPTS) {
        await CodigoVerifDao.markUsed(tokenRecord.id);
        return { ok: false, error: `Superaste el máximo de ${MAX_ATTEMPTS} intentos. Solicita un nuevo código.` };
    }

    // 3. Comparar OTP con hash
    const isValid = await bcrypt.compare(String(code), tokenRecord.token_hash);
    if (!isValid) {
        await CodigoVerifDao.incrementAttempts(tokenRecord.id);
        const remaining = MAX_ATTEMPTS - (tokenRecord.attempts + 1);
        return {
            ok: false,
            error: `Código incorrecto. ${remaining > 0 ? `Te quedan ${remaining} intentos.` : 'Código invalidado.'}`,
        };
    }

    // 4. Validar que el OTP tenga los datos necesarios para crear la cuenta
    if (!tokenRecord.nombre_completo || !tokenRecord.num_identificacion_reg) {
        return { ok: false, error: 'Datos incompletos. Por favor inicia el proceso de registro nuevamente.' };
    }

    // 5. Marcar código como usado
    await CodigoVerifDao.markUsed(tokenRecord.id);

    const nombreCompleto   = tokenRecord.nombre_completo;
    const numIdentificacion = tokenRecord.num_identificacion_reg;
    const tipoNegocioStr   = tokenRecord.tipo_negocio || 'RESTAURANTE';

    // 6. Verificar nuevamente que el usuario/cedula no exista (double-check)
    const [emailExiste, cedulaExiste] = await Promise.all([
        Models.GenerUsuario.findOne({ where: { email: normalizedEmail }, attributes: ['id_usuario'] }),
        Models.GenerUsuario.findOne({ where: { num_identificacion: numIdentificacion }, attributes: ['id_usuario'] }),
    ]);

    if (emailExiste) return { ok: false, error: 'Ya existe una cuenta con ese correo electrónico.' };
    if (cedulaExiste) return { ok: false, error: 'Ya existe una cuenta con ese número de cédula.' };

    // 7. Preparar datos del usuario
    const { primer_nombre, segundo_nombre, primer_apellido } = parsearNombreCompleto(nombreCompleto);

    // 8. Buscar Plan Básico
    const planBasico = await Models.GenerPlan.findOne({
        where: { nombre: 'Plan Básico', estado: 'A' },
        attributes: ['id_plan', 'nombre'],
    });

    // 9. Buscar tipo de negocio en la DB
    let idTipoNegocio = null;
    try {
        const tipoNegocio = await Models.GenerTipoNegocio.findOne({
            where: { nombre: { [Op.iLike]: tipoNegocioStr }, estado: 'A' },
            attributes: ['id_tipo_negocio'],
        });
        idTipoNegocio = tipoNegocio?.id_tipo_negocio ?? null;
    } catch {
        // GenerTipoNegocio no crítico — continuamos sin tipo
    }

    // 10. Transacción: crear usuario, sucursal y plan
    const transaction = await initTransaction();
    let idUsuario;
    let idNegocio;
    try {
        // Crear usuario con cédula como contraseña temporal
        const nuevoUsuario = await Models.GenerUsuario.create({
            primer_nombre,
            segundo_nombre:        segundo_nombre || null,
            primer_apellido,
            num_identificacion:    numIdentificacion,
            email:                 normalizedEmail,
            password:              numIdentificacion,   // hook beforeCreate aplica bcrypt
            debe_cambiar_password: true,
            estado:                'A',
        }, { transaction });
        idUsuario = nuevoUsuario.id_usuario;

        // Crear sucursal (negocio)
        const nombreNegocio = TIPO_NEGOCIO_LABELS[tipoNegocioStr.toUpperCase()] || 'Mi Sucursal';
        const nuevoNegocio  = await Models.GenerNegocio.create({
            nombre:          nombreNegocio,
            id_tipo_negocio: idTipoNegocio,
            email_contacto:  normalizedEmail,
            estado:          'A',
        }, { transaction });
        idNegocio = nuevoNegocio.id_negocio;

        // Vincular usuario a negocio
        await Models.GenerNegocioUsuario.create({
            id_usuario: idUsuario,
            id_negocio: idNegocio,
            estado:     'A',
        }, { transaction });

        // Asignar rol ADMINISTRADOR para que el usuario vea todos los módulos del negocio
        const rolAdmin = idTipoNegocio
            ? await Models.GenerRol.findOne({
                where: {
                    id_tipo_negocio: idTipoNegocio,
                    descripcion:     { [Op.iLike]: '%ADMINISTRADOR%' },
                    estado:          'A',
                },
                attributes: ['id_rol'],
                transaction,
            })
            : null;

        if (rolAdmin) {
            await syncUsuarioRolActivo(idUsuario, rolAdmin.id_rol, idNegocio, transaction);
            await rebuildNivelesUsuario(idUsuario, transaction);
        } else {
            console.warn('[RegistroTrial] Rol ADMINISTRADOR no encontrado para tipo_negocio', idTipoNegocio, '— usuario sin permisos.');
        }

        // Asignar Plan Básico por 7 días (sin auto-renovación)
        if (planBasico) {
            const fechaInicio = new Date();
            const fechaFin    = new Date(Date.now() + TRIAL_DAYS * 24 * 60 * 60 * 1000);
            await Models.GenerNegocioPlan.create({
                id_negocio:     idNegocio,
                id_plan:        planBasico.id_plan,
                fecha_inicio:   fechaInicio,
                fecha_fin:      fechaFin,
                estado:         'A',
                auto_renovacion: false,
            }, { transaction });
        } else {
            console.warn('[RegistroTrial] Plan Básico no encontrado — sucursal creada sin plan.');
        }

        await transaction.commit();
        console.info(`[RegistroTrial] Cuenta trial creada: email=${normalizedEmail}, id_usuario=${idUsuario}, id_negocio=${idNegocio}`);
    } catch (err) {
        await transaction.rollback();
        console.error('[RegistroTrial] Error creando cuenta:', err.message);
        throw err;
    }

    // 11. Enviar correo de bienvenida (no bloqueante)
    MailService.sendWelcomeEmail(normalizedEmail, primer_nombre, numIdentificacion)
        .catch(e => console.error('[RegistroTrial] Error enviando bienvenida:', e.message));

    // 12. Notificar al admin (no bloqueante)
    MailService.sendAdminNotificationEmail({
        nombre:           nombreCompleto,
        numIdentificacion,
        email:            normalizedEmail,
        tipoNegocio:      tipoNegocioStr,
        fechaRegistro:    new Date().toLocaleString('es-CO', { timeZone: 'America/Bogota' }),
    }).catch(e => console.error('[RegistroTrial] Error notificando admin:', e.message));

    return {
        ok: true,
        data: {
            nombre:           primer_nombre,
            numIdentificacion,
        },
    };
}

module.exports = { verificarYCrearCuentaTrial };
