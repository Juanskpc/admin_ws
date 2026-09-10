/**
 * reparar_roles_negocio.js — devuelve el acceso a un negocio al que se le cambió el tipo.
 *
 *   node scripts/reparar_roles_negocio.js <id_negocio>              # solo diagnostica
 *   node scripts/reparar_roles_negocio.js <id_negocio> --aplicar    # además lo arregla
 *
 * ## Qué arregla
 *
 * Los roles cuelgan del tipo de negocio: `gener_rol` tiene un ADMINISTRADOR distinto por cada
 * tipo. Cambiar `gener_negocio.id_tipo_negocio` deja a los usuarios con el rol del tipo viejo, y
 * la consulta de permisos exige que el nivel pertenezca al tipo **actual**, así que no casa nada:
 * la sesión llega con cero vistas y la app se queda mirando sin decir por qué.
 *
 * Desde 2026-09-09 `updateNegocio` hace esta traducción sola. Este script existe para los
 * negocios a los que ya les pasó antes de que existiera ese arreglo.
 *
 * Por defecto **no escribe**: imprime lo que haría. Solo con `--aplicar` toca la base.
 */
require('dotenv').config();

const Models = require('../app_core/models/conection');
const { remapearRolesDeNegocio, getTiposOperativos } = require('../app_core/helpers/tipoNegocioOperativo');

const sequelize = Models.sequelize;
const idNegocio = Number(process.argv[2]);
const aplicar = process.argv.includes('--aplicar');

if (!Number.isInteger(idNegocio) || idNegocio < 1) {
    console.error('Uso: node scripts/reparar_roles_negocio.js <id_negocio> [--aplicar]');
    process.exit(1);
}

async function main() {
    const [negocio] = await sequelize.query(
        `SELECT n.id_negocio, n.nombre, n.id_tipo_negocio, n.estado, tn.nombre AS tipo
           FROM general.gener_negocio n
           LEFT JOIN general.gener_tipo_negocio tn ON tn.id_tipo_negocio = n.id_tipo_negocio
          WHERE n.id_negocio = :idNegocio;`,
        { replacements: { idNegocio }, type: sequelize.QueryTypes.SELECT },
    );
    if (!negocio) {
        console.error(`No existe el negocio ${idNegocio}.`);
        process.exitCode = 1;
        return;
    }

    console.log(`\nNegocio ${negocio.id_negocio}: "${negocio.nombre}"`);
    console.log(`  tipo actual : ${negocio.id_tipo_negocio} (${negocio.tipo ?? '?'})   estado: ${negocio.estado}`);

    const operativos = await getTiposOperativos();
    const tieneModulo = operativos.has(Number(negocio.id_tipo_negocio));
    console.log(`  ¿tiene módulo? ${tieneModulo ? 'sí' : 'NO — ningún permiso sembrado para este tipo'}`);

    const desajustados = await sequelize.query(
        `SELECT ur.id_usuario_rol, ur.id_usuario, u.num_identificacion,
                u.primer_nombre || ' ' || u.primer_apellido AS usuario,
                ur.id_rol, r.descripcion AS rol, r.id_tipo_negocio AS tipo_del_rol
           FROM general.gener_usuario_rol ur
           JOIN general.gener_rol r ON r.id_rol = ur.id_rol
           JOIN general.gener_usuario u ON u.id_usuario = ur.id_usuario
          WHERE ur.id_negocio = :idNegocio AND ur.estado = 'A'
            AND r.id_tipo_negocio IS NOT NULL
            AND r.id_tipo_negocio <> :tipo
          ORDER BY ur.id_usuario;`,
        { replacements: { idNegocio, tipo: negocio.id_tipo_negocio }, type: sequelize.QueryTypes.SELECT },
    );

    if (desajustados.length === 0) {
        console.log('\n✓ Ningún usuario tiene un rol de otro tipo. Nada que reparar aquí.');
        if (!tieneModulo) {
            console.log('  Pero el tipo no tiene módulo: cámbialo a uno que sí lo tenga antes de nada.');
        }
        return;
    }

    console.log(`\n⚠ ${desajustados.length} asignación(es) de rol apuntan a otro tipo de negocio:`);
    desajustados.forEach((d) => console.log(
        `   ${d.num_identificacion} (${d.usuario}) → rol ${d.id_rol} "${d.rol}" del tipo ${d.tipo_del_rol}`,
    ));

    if (!aplicar) {
        console.log('\nEsto es solo un diagnóstico. Para arreglarlo, repite con --aplicar.');
        return;
    }

    const t = await sequelize.transaction();
    try {
        const r = await remapearRolesDeNegocio(idNegocio, negocio.id_tipo_negocio, { transaction: t });
        await t.commit();
        console.log(`\n✓ ${r.remapeados} rol(es) traducidos al tipo ${negocio.id_tipo_negocio}.`);
        console.log(`  ${r.ajustesDesactivados} ajuste(s) de menú del tipo viejo desactivados.`);
        console.log('  El usuario debe volver a entrar para que la sesión se reconstruya.');
    } catch (error) {
        await t.rollback();
        console.error(`\n✗ No se aplicó nada: ${error.message}`);
        process.exitCode = 1;
    }
}

main()
    .catch((e) => { console.error('✗', e.message); process.exitCode = 1; })
    .finally(() => sequelize.close());
