/**
 * Seed de datos base para pruebas de permisos por rol.
 *
 * Crea un negocio de tipo RESTAURANTE sin datos operativos
 * (sin mesas, sin productos, sin pedidos) y solo usuarios:
 * - ADMINISTRADOR
 * - MESERO
 * - CAJERO
 *
 * Ejecutar con:
 *   node migrations/migrate_seed_restaurante_base.js
 *
 * Variables opcionales:
 *   SEED_TAG=qa01
 *   SEED_PASSWORD=ClaveQA123!
 *   SEED_NEGOCIO_NOMBRE="Restaurante QA"
 */
require('dotenv').config();

const { Op, fn, col, where } = require('sequelize');
const db = require('../app_core/models/conection');

const sequelize = db.sequelize;
const DEFAULT_PASSWORD = process.env.SEED_PASSWORD || 'ClaveQA123!';

function buildSeedTag() {
    const rawTag = process.env.SEED_TAG || new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
    const cleanTag = String(rawTag).toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 20);
    return cleanTag || String(Date.now()).slice(-10);
}

function buildSeedPayload(tag) {
    const nowDigits = String(Date.now()).slice(-9);
    const negocioNombre = process.env.SEED_NEGOCIO_NOMBRE
        ? `${process.env.SEED_NEGOCIO_NOMBRE} ${tag.toUpperCase()}`
        : `Restaurante QA ${tag.toUpperCase()}`;

    return {
        negocio: {
            nombre: negocioNombre,
            nit: `9${nowDigits}`,
            email_contacto: `negocio.${tag}@qa.local`,
            telefono: '3000000000',
            estado: 'A',
        },
        usuarios: [
            {
                key: 'ADMINISTRADOR',
                primer_nombre: 'Admin',
                primer_apellido: 'Pruebas',
                num_identificacion: `10${nowDigits}1`,
                telefono: '3000000001',
                email: `admin.${tag}@qa.local`,
                password: DEFAULT_PASSWORD,
                estado: 'A',
                es_admin_principal: false,
            },
            {
                key: 'MESERO',
                primer_nombre: 'Mesero',
                primer_apellido: 'Pruebas',
                num_identificacion: `10${nowDigits}2`,
                telefono: '3000000002',
                email: `mesero.${tag}@qa.local`,
                password: DEFAULT_PASSWORD,
                estado: 'A',
                es_admin_principal: false,
            },
            {
                key: 'CAJERO',
                primer_nombre: 'Cajero',
                primer_apellido: 'Pruebas',
                num_identificacion: `10${nowDigits}3`,
                telefono: '3000000003',
                email: `cajero.${tag}@qa.local`,
                password: DEFAULT_PASSWORD,
                estado: 'A',
                es_admin_principal: false,
            },
        ],
    };
}

async function findTipoRestaurante(transaction) {
    return db.GenerTipoNegocio.findOne({
        where: {
            estado: 'A',
            [Op.and]: [where(fn('UPPER', col('nombre')), 'RESTAURANTE')],
        },
        transaction,
    });
}

async function findRolRestaurante(descripcion, idTipoNegocio, transaction) {
    return db.GenerRol.findOne({
        where: {
            id_tipo_negocio: idTipoNegocio,
            estado: 'A',
            [Op.and]: [where(fn('UPPER', col('descripcion')), descripcion)],
        },
        transaction,
    });
}

async function validateUniqueUsuario(data, transaction) {
    const existente = await db.GenerUsuario.findOne({
        where: {
            [Op.or]: [
                { email: data.email },
                { num_identificacion: data.num_identificacion },
            ],
        },
        attributes: ['id_usuario', 'email', 'num_identificacion'],
        transaction,
    });

    if (!existente) return;

    throw new Error(
        `Conflicto de usuario para ${data.email}. ` +
        `Ya existe email o identificacion. Usa otro SEED_TAG y vuelve a ejecutar.`
    );
}

async function getNivelesPorRol({ idRol, idTipoNegocio, transaction }) {
    const [nivelesRol] = await sequelize.query(
        `
        SELECT rn.id_nivel
        FROM general.gener_rol_nivel rn
        JOIN general.gener_nivel n ON n.id_nivel = rn.id_nivel
        WHERE rn.id_rol = :idRol
          AND rn.estado = 'A'
          AND rn.puede_ver = TRUE
          AND n.estado = 'A'
          AND n.id_tipo_negocio = :idTipoNegocio
          AND COALESCE(n.url, '') NOT LIKE '/auth%'
        ORDER BY rn.id_nivel;
        `,
        {
            replacements: { idRol, idTipoNegocio },
            transaction,
        }
    );

    if (nivelesRol.length > 0) {
        return nivelesRol.map((row) => Number(row.id_nivel));
    }

    // Fallback: si no hay matriz rol_nivel configurada, habilitar niveles no-auth
    // del tipo de negocio para evitar sesión sin rutas de entrada.
    const [nivelesFallback] = await sequelize.query(
        `
        SELECT n.id_nivel
        FROM general.gener_nivel n
        WHERE n.id_tipo_negocio = :idTipoNegocio
          AND n.estado = 'A'
          AND COALESCE(n.url, '') NOT LIKE '/auth%'
        ORDER BY n.id_nivel;
        `,
        {
            replacements: { idTipoNegocio },
            transaction,
        }
    );

    return nivelesFallback.map((row) => Number(row.id_nivel));
}

async function assignNivelesUsuario({ idUsuario, idRol, idTipoNegocio, transaction }) {
    const niveles = await getNivelesPorRol({ idRol, idTipoNegocio, transaction });
    let inserted = 0;

    for (const idNivel of niveles) {
        const [, meta] = await sequelize.query(
            `
            INSERT INTO general.gener_nivel_usuario (id_usuario, id_nivel)
            VALUES (:idUsuario, :idNivel)
            ON CONFLICT (id_usuario, id_nivel) DO NOTHING;
            `,
            {
                replacements: { idUsuario, idNivel },
                transaction,
            }
        );
        inserted += meta?.rowCount || 0;
    }

    return { totalAsignados: niveles.length, totalInsertados: inserted };
}

async function migrate() {
    const t = await sequelize.transaction();
    const tag = buildSeedTag();
    const payload = buildSeedPayload(tag);

    try {
        console.log('Iniciando seed de negocio restaurante base...');

        const tipoRestaurante = await findTipoRestaurante(t);
        if (!tipoRestaurante) {
            throw new Error('No existe el tipo de negocio RESTAURANTE en general.gener_tipo_negocio.');
        }

        const rolesMap = {};
        for (const rolName of ['ADMINISTRADOR', 'MESERO', 'CAJERO']) {
            const rol = await findRolRestaurante(rolName, tipoRestaurante.id_tipo_negocio, t);
            if (!rol) {
                throw new Error(
                    `No existe rol ${rolName} activo para tipo de negocio RESTAURANTE.`
                );
            }
            rolesMap[rolName] = rol;
        }

        const negocio = await db.GenerNegocio.create(
            {
                ...payload.negocio,
                id_tipo_negocio: tipoRestaurante.id_tipo_negocio,
            },
            { transaction: t }
        );

        const resumen = [];

        for (const userSeed of payload.usuarios) {
            await validateUniqueUsuario(userSeed, t);

            const user = await db.GenerUsuario.create(
                {
                    primer_nombre: userSeed.primer_nombre,
                    segundo_nombre: null,
                    primer_apellido: userSeed.primer_apellido,
                    segundo_apellido: null,
                    num_identificacion: userSeed.num_identificacion,
                    telefono: userSeed.telefono,
                    email: userSeed.email,
                    password: userSeed.password,
                    fecha_nacimiento: null,
                    estado: userSeed.estado,
                    es_admin_principal: userSeed.es_admin_principal,
                },
                { transaction: t }
            );

            await db.GenerNegocioUsuario.create(
                {
                    id_usuario: user.id_usuario,
                    id_negocio: negocio.id_negocio,
                    estado: 'A',
                },
                { transaction: t }
            );

            await db.GenerUsuarioRol.create(
                {
                    id_usuario: user.id_usuario,
                    id_rol: rolesMap[userSeed.key].id_rol,
                    id_negocio: negocio.id_negocio,
                    estado: 'A',
                },
                { transaction: t }
            );

            const nivelesAsignados = await assignNivelesUsuario({
                idUsuario: user.id_usuario,
                idRol: rolesMap[userSeed.key].id_rol,
                idTipoNegocio: tipoRestaurante.id_tipo_negocio,
                transaction: t,
            });

            resumen.push({
                rol: userSeed.key,
                id_usuario: user.id_usuario,
                email: userSeed.email,
                password: userSeed.password,
                niveles: nivelesAsignados.totalInsertados,
            });
        }

        await t.commit();

        console.log('Seed completado correctamente.');
        console.log(`Negocio creado: ${negocio.nombre} (id_negocio=${negocio.id_negocio})`);
        console.log('Credenciales creadas:');
        console.table(resumen);
    } catch (error) {
        await t.rollback();
        console.error('Error en seed:', error.message);
        console.error(error);
        process.exitCode = 1;
    } finally {
        await sequelize.close();
        process.exit();
    }
}

migrate();
