/**
 * fix_trial_permisos.js
 *
 * Asigna rol ADMINISTRADOR a un usuario trial que fue creado sin permisos.
 * Uso: node scripts/fix_trial_permisos.js [num_identificacion]
 *
 * Ejemplo: node scripts/fix_trial_permisos.js 27087114
 */

require('dotenv').config();
const { Op } = require('sequelize');
const Models  = require('../app_core/models/conection');
const { syncUsuarioRolActivo, rebuildNivelesUsuario } = require('../app_core/dao/usuarioAdminDao');
const { initTransaction } = require('../app_core/helpers/funcionesAdicionales');

const cedula = process.argv[2];
if (!cedula) {
    console.error('Uso: node scripts/fix_trial_permisos.js <num_identificacion>');
    process.exit(1);
}

async function main() {
    // 1. Encontrar el usuario
    const usuario = await Models.GenerUsuario.findOne({
        where: { num_identificacion: cedula },
        attributes: ['id_usuario', 'primer_nombre', 'primer_apellido', 'num_identificacion', 'email'],
    });

    if (!usuario) {
        console.error(`❌ No existe ningún usuario con cédula: ${cedula}`);
        process.exit(1);
    }

    console.log(`✔ Usuario encontrado: ${usuario.primer_nombre} ${usuario.primer_apellido} (id=${usuario.id_usuario})`);

    // 2. Encontrar su negocio activo
    const negocioLink = await Models.GenerNegocioUsuario.findOne({
        where: { id_usuario: usuario.id_usuario, estado: 'A' },
        attributes: ['id_negocio'],
    });

    if (!negocioLink) {
        console.error('❌ El usuario no tiene ningún negocio activo vinculado.');
        process.exit(1);
    }

    const negocio = await Models.GenerNegocio.findByPk(negocioLink.id_negocio, {
        attributes: ['id_negocio', 'nombre', 'id_tipo_negocio'],
    });

    console.log(`✔ Negocio: ${negocio.nombre} (id=${negocio.id_negocio}, tipo=${negocio.id_tipo_negocio})`);

    // 3. Verificar permisos actuales
    const nivelesActuales = await Models.GenerNivelUsuario.count({
        where: { id_usuario: usuario.id_usuario },
    });
    console.log(`  Módulos con permiso actualmente: ${nivelesActuales}`);

    // 4. Encontrar rol ADMINISTRADOR para ese tipo de negocio
    const whereRol = {
        descripcion: { [Op.iLike]: '%ADMINISTRADOR%' },
        estado: 'A',
    };
    if (negocio.id_tipo_negocio) {
        whereRol.id_tipo_negocio = negocio.id_tipo_negocio;
    }

    const rolAdmin = await Models.GenerRol.findOne({
        where: whereRol,
        attributes: ['id_rol', 'descripcion'],
    });

    if (!rolAdmin) {
        console.error('❌ No se encontró el rol ADMINISTRADOR para este tipo de negocio.');
        process.exit(1);
    }

    console.log(`✔ Rol ADMINISTRADOR encontrado: "${rolAdmin.descripcion}" (id=${rolAdmin.id_rol})`);

    // 5. Aplicar en transacción
    const transaction = await initTransaction();
    try {
        await syncUsuarioRolActivo(usuario.id_usuario, rolAdmin.id_rol, negocio.id_negocio, transaction);
        await rebuildNivelesUsuario(usuario.id_usuario, transaction);
        await transaction.commit();
    } catch (err) {
        await transaction.rollback();
        throw err;
    }

    // 6. Verificar resultado
    const nivelesPost = await Models.GenerNivelUsuario.count({
        where: { id_usuario: usuario.id_usuario },
    });

    console.log(`✅ Listo. Módulos habilitados ahora: ${nivelesPost}`);
    console.log(`   El usuario puede iniciar sesión con usuario="${cedula}" y contraseña="${cedula}"`);
}

main()
    .then(() => process.exit(0))
    .catch((err) => {
        console.error('❌ Error:', err.message);
        process.exit(1);
    });
