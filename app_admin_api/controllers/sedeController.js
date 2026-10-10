'use strict';

const { body, param, validationResult } = require('express-validator');

const SedeDao = require('../../app_core/dao/sedeDao');
const Respuesta = require('../../app_core/helpers/respuesta');
const Audit = require('../../app_core/helpers/auditHelper');
const { aplicativoSoportado } = require('../../app_core/sede/clonarConfiguracion');

/**
 * Sedes de un negocio.
 *
 * Son rutas de super admin, como el resto del alta de negocios: abrir una sede crea un cliente
 * pagador nuevo con su propio plan, y eso no lo decide el inquilino desde su panel.
 *
 * Los errores de dominio vienen tipados de `sedeDao` (`.code` + `.statusCode`) y se reenvían sin
 * re-envolver, igual que en `negocioController`.
 */

function responderError(res, error, contexto, mensajePorDefecto) {
    if (error.statusCode && error.code) {
        return Respuesta.error(res, error.message, error.statusCode, null, { code: error.code });
    }
    if (error?.name === 'SequelizeUniqueConstraintError') {
        return Respuesta.error(res, 'Ya existe un registro con esos datos (email o identificación)', 409);
    }
    console.error(`Error en ${contexto}:`, error);
    return Respuesta.error(res, mensajePorDefecto, error.statusCode || 500);
}

/** GET /admin/negocios/:id/sedes */
async function getSedes(req, res) {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return Respuesta.error(res, 'Datos de entrada inválidos', 400, errors.array());
        }

        const idNegocio = Number(req.params.id);
        const matriz = await SedeDao.getMatriz(idNegocio);
        if (!matriz) return Respuesta.error(res, 'Negocio no encontrado', 404);

        const sedes = await SedeDao.listarSedes(idNegocio);
        return Respuesta.success(res, 'Sedes obtenidas', {
            // Un negocio que ya es sede no puede tener sedes: la consola lo necesita para no
            // ofrecer el botón.
            es_sede: matriz.id_negocio_padre !== null,
            id_negocio_padre: matriz.id_negocio_padre,
            // Si el aplicativo no tiene pasos de clonado escritos, la sede se puede abrir igual
            // pero nacería vacía. Mejor decirlo antes que después.
            clona_configuracion: aplicativoSoportado(matriz.aplicativo),
            aplicativo: matriz.aplicativo,
            sedes,
        });
    } catch (error) {
        return responderError(res, error, 'getSedes', 'Error al obtener las sedes');
    }
}

/** POST /admin/negocios/:id/sedes */
async function crearSede(req, res) {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return Respuesta.error(res, 'Datos de entrada inválidos', 400, errors.array());
        }

        const idNegocioPadre = Number(req.params.id);
        const { sede, plan, admin, id_usuario_existente, clonar } = req.body;

        // El correo del administrador es opcional: el login va por identificación.
        const adminNorm = admin
            ? { ...admin, email: admin.email ? String(admin.email).toLowerCase().trim() : null }
            : null;

        const resultado = await SedeDao.crearSede(idNegocioPadre, {
            sede,
            plan,
            admin: adminNorm,
            id_usuario_existente: id_usuario_existente ? Number(id_usuario_existente) : null,
            clonar: clonar !== false,
        });

        await Audit.registrarEvento({
            modulo: 'negocio',
            accion: 'sede_creada',
            idNegocio: resultado.id_negocio,
            detalle: {
                id_negocio_padre: idNegocioPadre,
                nombre: sede?.nombre,
                // Qué se copió y cuánto, y qué NO se copió. Es la respuesta a «¿por qué a esta
                // sede le falta la carta?» seis meses después.
                clonado: resultado.clonado
                    .filter((paso) => paso.insertadas > 0 || paso.omitida || paso.saltadas)
                    .map((paso) => {
                        if (paso.omitida) return `${paso.tabla}: ${paso.omitida}`;
                        const saltadas = paso.saltadas ? ` (${paso.saltadas} saltada/s)` : '';
                        return `${paso.tabla}: ${paso.insertadas}${saltadas}`;
                    }),
            },
        });

        return Respuesta.success(res, 'Sede creada correctamente', resultado, 201);
    } catch (error) {
        return responderError(res, error, 'crearSede', error.message || 'Error al crear la sede');
    }
}

/**
 * ¿La petición está creando un usuario nuevo para la sede?
 *
 * Solo si trajo un bloque `admin` con nombre y no eligió un usuario existente. Sin esto, el
 * modo por defecto —heredar los administradores de la matriz— fallaría exigiendo una contraseña
 * para un usuario que nadie está creando.
 */
const creaUsuarioNuevo = (_, { req }) => !req.body.id_usuario_existente && !!req.body.admin?.primer_nombre;

/** Validadores. `id` es el de la MATRIZ en las dos rutas. */
const idMatrizValidators = [
    param('id').isInt({ min: 1 }).withMessage('Id de negocio inválido'),
];

const crearSedeValidators = [
    ...idMatrizValidators,
    body('sede.nombre').trim().notEmpty().withMessage('El nombre de la sede es requerido'),
    body('sede.email_contacto').optional({ nullable: true, checkFalsy: true })
        .isEmail().withMessage('Email de contacto inválido'),
    body('plan.id_plan').optional({ nullable: true }).isInt({ min: 1 }).withMessage('Plan inválido'),
    body('plan.meses').optional({ nullable: true }).isInt({ min: 1, max: 60 }).withMessage('Duración inválida'),
    body('plan.fecha_inicio').optional({ nullable: true }).isISO8601().withMessage('Fecha de inicio inválida'),
    body('clonar').optional({ nullable: true }).isBoolean().withMessage('clonar debe ser booleano'),
    // Quién administra la sede. Hay tres modos y NINGUNO es obligatorio:
    //   · `id_usuario_existente` — un usuario concreto.
    //   · `admin` — uno nuevo, con las mismas reglas que `registrar-cliente`.
    //   · ninguno de los dos — hereda los administradores de la matriz. Es el caso normal, y
    //     por eso no se exige nada aquí: ver `sedeDao.administradoresDe`.
    body('id_usuario_existente').optional({ nullable: true }).isInt({ min: 1 }).withMessage('ID de usuario inválido'),
    // Las reglas del usuario nuevo solo aplican si de verdad se está creando uno.
    body('admin.primer_nombre')
        .if(creaUsuarioNuevo)
        .trim().notEmpty().withMessage('El nombre del administrador es requerido'),
    body('admin.primer_apellido')
        .if(creaUsuarioNuevo)
        .trim().notEmpty().withMessage('El apellido del administrador es requerido'),
    body('admin.num_identificacion')
        .if(creaUsuarioNuevo)
        .trim().notEmpty().withMessage('La identificación del administrador es requerida'),
    body('admin.email')
        .if(creaUsuarioNuevo)
        .optional({ nullable: true, checkFalsy: true })
        .isEmail().withMessage('Email del administrador inválido'),
    body('admin.password')
        .if(creaUsuarioNuevo)
        .isLength({ min: 8 }).withMessage('La contraseña debe tener mínimo 8 caracteres')
        .matches(/(?=.*[A-Z])/).withMessage('La contraseña debe tener al menos una mayúscula')
        .matches(/(?=.*\d)/).withMessage('La contraseña debe tener al menos un número'),
];

module.exports = { getSedes, crearSede, idMatrizValidators, crearSedeValidators };
