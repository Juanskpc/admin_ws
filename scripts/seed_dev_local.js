/**
 * Siembra los datos mínimos para trabajar en LOCAL sobre una base recién creada.
 *
 * Crea (idempotente): planes base, un negocio demo de tipo RESTAURANTE, un super
 * administrador global y un administrador de ese negocio.
 *
 * Ejecutar con:
 *   node scripts/seed_dev_local.js
 *
 * SOLO corre contra localhost. Ver guarda más abajo.
 */
require('dotenv').config();
const Bcrypt = require('bcrypt');
const db = require('../app_core/models/conection');
const sequelize = db.sequelize;

const HOSTS_PERMITIDOS = ['localhost', '127.0.0.1', '::1'];
const PASSWORD_DEV = 'Admin123*';
const BCRYPT_ROUNDS = 10;

const SUPER_ADMIN = {
    num_identificacion: '1000000001',
    primer_nombre: 'Super',
    primer_apellido: 'Admin',
    email: 'superadmin@escalapp.local',
    telefono: '3000000001',
};

const ADMIN_NEGOCIO = {
    num_identificacion: '1000000002',
    primer_nombre: 'Admin',
    primer_apellido: 'Demo',
    email: 'admin.demo@escalapp.local',
    telefono: '3000000002',
};

const NEGOCIO_DEMO = {
    nombre: 'Restaurante Demo',
    nit: '900000000-1',
    email_contacto: 'contacto@restaurantedemo.local',
    telefono: '3000000010',
    direccion: 'Calle Falsa 123, Bogotá',
};

/**
 * Impide que este script escriba en producción. La comprobación es sobre el host
 * real de la conexión, no sobre NODE_ENV (que es 'development' incluso cuando el
 * .env apunta a la RDS — que es exactamente el accidente que queremos evitar).
 */
function verificarEntornoLocal() {
    const host = (process.env.DB_HOST || '').trim();
    if (!HOSTS_PERMITIDOS.includes(host)) {
        console.error(`\n  ABORTADO: DB_HOST = "${host}"`);
        console.error('  Este seed solo puede ejecutarse contra una base local.');
        console.error(`  Hosts permitidos: ${HOSTS_PERMITIDOS.join(', ')}\n`);
        process.exit(1);
    }
    console.log(`Entorno local verificado (DB_HOST=${host}, DB_NAME=${process.env.DB_NAME}).\n`);
}

async function upsertUsuario(datos, passwordHash, t) {
    const [existente] = await sequelize.query(
        `SELECT id_usuario FROM general.gener_usuario WHERE num_identificacion = :num LIMIT 1;`,
        { replacements: { num: datos.num_identificacion }, type: sequelize.QueryTypes.SELECT, transaction: t }
    );
    if (existente) {
        console.log(`   Usuario ${datos.num_identificacion} ya existe (id=${existente.id_usuario}).`);
        return existente.id_usuario;
    }

    const [creado] = await sequelize.query(
        `INSERT INTO general.gener_usuario
            (primer_nombre, primer_apellido, num_identificacion, telefono, email, password,
             estado, es_admin_principal, debe_cambiar_password)
         VALUES (:nombre, :apellido, :num, :tel, :email, :pass, 'A', :principal, false)
         RETURNING id_usuario;`,
        {
            replacements: {
                nombre: datos.primer_nombre,
                apellido: datos.primer_apellido,
                num: datos.num_identificacion,
                tel: datos.telefono,
                email: datos.email,
                pass: passwordHash,
                principal: Boolean(datos.es_admin_principal),
            },
            type: sequelize.QueryTypes.SELECT,
            transaction: t,
        }
    );
    console.log(`   Usuario ${datos.num_identificacion} creado (id=${creado.id_usuario}).`);
    return creado.id_usuario;
}

/**
 * Vincula un usuario a un negocio. Es una tabla distinta de gener_usuario_rol: el
 * login lista los negocios desde aquí (LoginDao.getUsuarioLogin), y usa los roles
 * solo para saber qué hace el usuario DENTRO de cada negocio. Sin esta fila, el
 * usuario entra pero ve la lista de negocios vacía.
 */
async function vincularANegocio(idUsuario, idNegocio, t) {
    await sequelize.query(
        `INSERT INTO general.gener_negocio_usuario (id_usuario, id_negocio, estado)
         VALUES (:u, :n, 'A')
         ON CONFLICT (id_usuario, id_negocio) DO NOTHING;`,
        { replacements: { u: idUsuario, n: idNegocio }, transaction: t }
    );
    console.log(`   Usuario ${idUsuario} vinculado al negocio ${idNegocio}.`);
}

/**
 * No se usa ON CONFLICT: la restricción única es (id_usuario, id_rol, id_negocio) y
 * Postgres considera distintos dos NULL, así que el rol global se duplicaría.
 */
async function asignarRol(idUsuario, idRol, idNegocio, t) {
    const [existente] = await sequelize.query(
        `SELECT id_usuario_rol FROM general.gener_usuario_rol
          WHERE id_usuario = :u AND id_rol = :r AND id_negocio IS NOT DISTINCT FROM :n LIMIT 1;`,
        {
            replacements: { u: idUsuario, r: idRol, n: idNegocio },
            type: sequelize.QueryTypes.SELECT,
            transaction: t,
        }
    );
    if (existente) {
        console.log(`   Rol ${idRol} ya asignado al usuario ${idUsuario}.`);
        return;
    }
    await sequelize.query(
        `INSERT INTO general.gener_usuario_rol (id_usuario, id_rol, id_negocio, estado)
         VALUES (:u, :r, :n, 'A');`,
        { replacements: { u: idUsuario, r: idRol, n: idNegocio }, transaction: t }
    );
    console.log(`   Rol ${idRol} asignado al usuario ${idUsuario}.`);
}

async function seed() {
    verificarEntornoLocal();
    const t = await sequelize.transaction();

    try {
        console.log('1. Planes base...');
        await sequelize.query(
            `INSERT INTO general.gener_plan (nombre, descripcion, precio, moneda, estado) VALUES
                ('Plan Básico',   'Plan de entrada EscalApp',  27999, 'COP', 'A'),
                ('Plan Avanzado', 'Plan completo EscalApp',    59999, 'COP', 'A')
             ON CONFLICT (nombre) DO NOTHING;`,
            { transaction: t }
        );
        const planes = await sequelize.query(
            `SELECT id_plan, nombre FROM general.gener_plan WHERE estado = 'A' ORDER BY precio;`,
            { type: sequelize.QueryTypes.SELECT, transaction: t }
        );
        console.log(`   ${planes.map((p) => `${p.nombre} (id=${p.id_plan})`).join(', ')}`);

        console.log('\n2. Negocio demo...');
        const [tipoRestaurante] = await sequelize.query(
            `SELECT id_tipo_negocio FROM general.gener_tipo_negocio WHERE nombre = 'RESTAURANTE' LIMIT 1;`,
            { type: sequelize.QueryTypes.SELECT, transaction: t }
        );
        if (!tipoRestaurante) {
            throw new Error('Falta el tipo de negocio RESTAURANTE. Ejecuta antes: npm run migrate');
        }

        let [negocio] = await sequelize.query(
            `SELECT id_negocio FROM general.gener_negocio WHERE nombre = :nombre LIMIT 1;`,
            { replacements: { nombre: NEGOCIO_DEMO.nombre }, type: sequelize.QueryTypes.SELECT, transaction: t }
        );
        if (!negocio) {
            [negocio] = await sequelize.query(
                `INSERT INTO general.gener_negocio
                    (nombre, nit, email_contacto, telefono, direccion, estado, id_tipo_negocio)
                 VALUES (:nombre, :nit, :email, :tel, :dir, 'A', :tipo)
                 RETURNING id_negocio;`,
                {
                    replacements: {
                        nombre: NEGOCIO_DEMO.nombre,
                        nit: NEGOCIO_DEMO.nit,
                        email: NEGOCIO_DEMO.email_contacto,
                        tel: NEGOCIO_DEMO.telefono,
                        dir: NEGOCIO_DEMO.direccion,
                        tipo: tipoRestaurante.id_tipo_negocio,
                    },
                    type: sequelize.QueryTypes.SELECT,
                    transaction: t,
                }
            );
            console.log(`   Negocio "${NEGOCIO_DEMO.nombre}" creado (id=${negocio.id_negocio}).`);
        } else {
            console.log(`   Negocio "${NEGOCIO_DEMO.nombre}" ya existe (id=${negocio.id_negocio}).`);
        }

        console.log('\n3. Plan activo del negocio demo...');
        const [planActivo] = await sequelize.query(
            `SELECT id_negocio_plan FROM general.gener_negocio_plan
              WHERE id_negocio = :n AND estado = 'A' LIMIT 1;`,
            { replacements: { n: negocio.id_negocio }, type: sequelize.QueryTypes.SELECT, transaction: t }
        );
        if (!planActivo) {
            await sequelize.query(
                `INSERT INTO general.gener_negocio_plan
                    (id_negocio, id_plan, fecha_inicio, fecha_fin, estado, auto_renovacion)
                 VALUES (:n, :p, CURRENT_DATE, NULL, 'A', true);`,
                {
                    replacements: { n: negocio.id_negocio, p: planes[planes.length - 1].id_plan },
                    transaction: t,
                }
            );
            console.log(`   Plan asignado al negocio ${negocio.id_negocio}.`);
        } else {
            console.log('   El negocio demo ya tiene plan activo.');
        }

        console.log('\n4. Usuarios...');
        const passwordHash = await Bcrypt.hash(PASSWORD_DEV, BCRYPT_ROUNDS);
        const idSuperAdmin = await upsertUsuario(
            { ...SUPER_ADMIN, es_admin_principal: true },
            passwordHash,
            t
        );
        const idAdminNegocio = await upsertUsuario(ADMIN_NEGOCIO, passwordHash, t);

        console.log('\n5. Roles...');
        const [rolSuper] = await sequelize.query(
            `SELECT id_rol FROM general.gener_rol
              WHERE UPPER(descripcion) = 'SUPER ADMINISTRADOR' AND id_tipo_negocio IS NULL LIMIT 1;`,
            { type: sequelize.QueryTypes.SELECT, transaction: t }
        );
        const [rolAdminRestaurante] = await sequelize.query(
            `SELECT id_rol FROM general.gener_rol
              WHERE UPPER(descripcion) = 'ADMINISTRADOR' AND id_tipo_negocio = :tipo LIMIT 1;`,
            {
                replacements: { tipo: tipoRestaurante.id_tipo_negocio },
                type: sequelize.QueryTypes.SELECT,
                transaction: t,
            }
        );
        if (!rolSuper || !rolAdminRestaurante) {
            throw new Error('Faltan roles base. Ejecuta antes: npm run migrate');
        }

        await asignarRol(idSuperAdmin, rolSuper.id_rol, null, t);
        await asignarRol(idAdminNegocio, rolAdminRestaurante.id_rol, negocio.id_negocio, t);

        console.log('\n6. Vínculo usuario-negocio...');
        await vincularANegocio(idAdminNegocio, negocio.id_negocio, t);

        await t.commit();

        console.log('\n✓ Seed de desarrollo completado.\n');
        console.log('  Credenciales (login por número de identificación):');
        console.log(`    Super admin      → ${SUPER_ADMIN.num_identificacion} / ${PASSWORD_DEV}`);
        console.log(`    Admin del negocio → ${ADMIN_NEGOCIO.num_identificacion} / ${PASSWORD_DEV}`);
        console.log(`    Negocio demo      → id_negocio = ${negocio.id_negocio}\n`);
    } catch (error) {
        await t.rollback();
        console.error('\nError en el seed:', error.message);
        process.exitCode = 1;
    } finally {
        await sequelize.close();
    }
}

seed();
