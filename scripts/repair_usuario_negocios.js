/**
 * repair_usuario_negocios.js
 *
 * Diagnostica y repara las relaciones negocio/rol de un usuario afectado por el bug
 * de vincularUsuarioANegocio (sincronización destructiva).
 *
 * Uso:
 *   node scripts/repair_usuario_negocios.js <num_identificacion> [--apply]
 *
 * Sin --apply: solo muestra el diagnóstico (modo seguro).
 * Con --apply: reactiva todos los negocios/roles inactivos del usuario y reconstruye niveles.
 */

require('dotenv').config();
const Models = require('../app_core/models/conection');
const { initTransaction } = require('../app_core/helpers/funcionesAdicionales');
const { rebuildNivelesUsuario } = require('../app_core/dao/usuarioAdminDao');

const numId = process.argv[2];
const apply = process.argv.includes('--apply');

if (!numId) {
    console.error('Uso: node scripts/repair_usuario_negocios.js <num_identificacion> [--apply]');
    process.exit(1);
}

async function main() {
    await Models.sequelize.authenticate();

    // 1. Encontrar el usuario
    const usuario = await Models.GenerUsuario.findOne({
        where: { num_identificacion: numId },
        attributes: ['id_usuario', 'primer_nombre', 'primer_apellido', 'email', 'estado'],
    });

    if (!usuario) {
        console.error(`No se encontró usuario con identificación: ${numId}`);
        process.exit(1);
    }

    const idUsuario = usuario.id_usuario;
    console.log(`\nUsuario encontrado:`);
    console.log(`  id_usuario : ${idUsuario}`);
    console.log(`  nombre     : ${usuario.primer_nombre} ${usuario.primer_apellido}`);
    console.log(`  email      : ${usuario.email}`);
    console.log(`  estado     : ${usuario.estado}`);

    // 2. Diagnosticar GenerNegocioUsuario
    const negocioRels = await Models.GenerNegocioUsuario.findAll({
        where: { id_usuario: idUsuario },
        include: [{
            model: Models.GenerNegocio,
            as: 'negocio',
            attributes: ['id_negocio', 'nombre', 'estado'],
            required: false,
        }],
        order: [['estado', 'ASC'], ['id_negocio', 'ASC']],
    });

    const activosNeg   = negocioRels.filter((r) => r.estado === 'A');
    const inactivosNeg = negocioRels.filter((r) => r.estado === 'I');

    console.log(`\n── GenerNegocioUsuario (${negocioRels.length} registros) ──`);
    console.log(`  Activos  (A): ${activosNeg.length}`);
    activosNeg.forEach((r) => console.log(`    [A] negocio ${r.id_negocio} — "${r.negocio?.nombre ?? 'N/A'}"`));
    console.log(`  Inactivos(I): ${inactivosNeg.length}`);
    inactivosNeg.forEach((r) => console.log(`    [I] negocio ${r.id_negocio} — "${r.negocio?.nombre ?? 'N/A'}"`));

    // 3. Diagnosticar GenerUsuarioRol
    const rolRels = await Models.GenerUsuarioRol.findAll({
        where: { id_usuario: idUsuario },
        include: [{
            model: Models.GenerRol,
            as: 'rol',
            attributes: ['id_rol', 'descripcion'],
            required: false,
        }],
        order: [['estado', 'ASC'], ['id_negocio', 'ASC']],
    });

    const activosRol   = rolRels.filter((r) => r.estado === 'A');
    const inactivosRol = rolRels.filter((r) => r.estado === 'I');

    console.log(`\n── GenerUsuarioRol (${rolRels.length} registros) ──`);
    console.log(`  Activos  (A): ${activosRol.length}`);
    activosRol.forEach((r) => console.log(`    [A] rol ${r.id_rol} ("${r.rol?.descripcion ?? 'N/A'}") — negocio ${r.id_negocio ?? 'global'}`));
    console.log(`  Inactivos(I): ${inactivosRol.length}`);
    inactivosRol.forEach((r) => console.log(`    [I] rol ${r.id_rol} ("${r.rol?.descripcion ?? 'N/A'}") — negocio ${r.id_negocio ?? 'global'}`));

    // 4. GenerNivelUsuario actual
    const niveles = await Models.GenerNivelUsuario.findAll({
        where: { id_usuario: idUsuario },
        attributes: ['id_nivel'],
    });
    console.log(`\n── GenerNivelUsuario: ${niveles.length} niveles asignados actualmente`);

    if (!apply) {
        console.log(`\n[DRY-RUN] Para aplicar la reparación, ejecuta con --apply`);
        await Models.sequelize.close();
        return;
    }

    if (inactivosNeg.length === 0 && inactivosRol.length === 0) {
        console.log(`\nNo hay registros inactivos que reparar.`);
        await Models.sequelize.close();
        return;
    }

    // 5. Reparar
    console.log(`\n[APPLY] Iniciando reparación...`);
    const transaction = await initTransaction();
    try {
        // Reactivar todos los GenerNegocioUsuario inactivos
        if (inactivosNeg.length > 0) {
            const ids = inactivosNeg.map((r) => r.id_negocio);
            await Models.GenerNegocioUsuario.update(
                { estado: 'A' },
                { where: { id_usuario: idUsuario, id_negocio: ids }, transaction },
            );
            console.log(`  ✓ Reactivados ${inactivosNeg.length} negocio(s) en GenerNegocioUsuario`);
        }

        // Reactivar todos los GenerUsuarioRol inactivos
        if (inactivosRol.length > 0) {
            const ids = inactivosRol.map((r) => r.id_usuario_rol);
            await Models.GenerUsuarioRol.update(
                { estado: 'A' },
                { where: { id_usuario_rol: ids }, transaction },
            );
            console.log(`  ✓ Reactivados ${inactivosRol.length} rol(es) en GenerUsuarioRol`);
        }

        // Reconstruir niveles con todos los roles activos
        await rebuildNivelesUsuario(idUsuario, transaction);
        console.log(`  ✓ Niveles de usuario reconstruidos`);

        await transaction.commit();
        console.log(`\n[OK] Reparación completada.`);
    } catch (err) {
        await transaction.rollback();
        console.error(`\n[ERROR] Reparación fallida, rollback aplicado:`, err.message);
        process.exit(1);
    }

    await Models.sequelize.close();
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
