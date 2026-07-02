/**
 * diag_permisos_negocio.js
 * Diagnostica los permisos efectivos de un usuario, desglosados por tipo_negocio.
 * Uso: node scripts/diag_permisos_negocio.js <num_identificacion>
 */
require('dotenv').config();
const Models = require('../app_core/models/conection');

const numId = process.argv[2];
if (!numId) { console.error('Uso: node scripts/diag_permisos_negocio.js <num_identificacion>'); process.exit(1); }

async function main() {
    await Models.sequelize.authenticate();

    const usuarios = await Models.sequelize.query(
        `SELECT id_usuario, primer_nombre, primer_apellido FROM general.gener_usuario WHERE num_identificacion = :numId`,
        { replacements: { numId }, type: Models.sequelize.QueryTypes.SELECT },
    );
    const usuario = usuarios[0];
    if (!usuario) { console.error('Usuario no encontrado'); process.exit(1); }
    const idUsuario = usuario.id_usuario;
    console.log(`\nUsuario ${idUsuario}: ${usuario.primer_nombre} ${usuario.primer_apellido}\n`);

    // Roles activos del usuario con su negocio + tipo_negocio
    const roles = await Models.sequelize.query(
        `SELECT ur.id_usuario_rol, ur.id_rol, r.descripcion AS rol, ur.id_negocio,
                n.nombre AS negocio, n.id_tipo_negocio, tn.nombre AS tipo_negocio
         FROM general.gener_usuario_rol ur
         JOIN general.gener_rol r ON r.id_rol = ur.id_rol
         LEFT JOIN general.gener_negocio n ON n.id_negocio = ur.id_negocio
         LEFT JOIN general.gener_tipo_negocio tn ON tn.id_tipo_negocio = n.id_tipo_negocio
         WHERE ur.id_usuario = :idUsuario AND ur.estado = 'A'
         ORDER BY ur.id_negocio`,
        { replacements: { idUsuario }, type: Models.sequelize.QueryTypes.SELECT },
    );
    console.log('── Roles activos ──');
    roles.forEach((r) => console.log(`  rol ${r.id_rol} (${r.rol}) → negocio ${r.id_negocio ?? 'global'} "${r.negocio ?? ''}" tipo=${r.id_tipo_negocio ?? '-'} (${r.tipo_negocio ?? 'global'})`));

    // Niveles del usuario agrupados por tipo_negocio
    const niveles = await Models.sequelize.query(
        `SELECT n.id_tipo_negocio, tn.nombre AS tipo, COUNT(*)::int AS total
         FROM general.gener_nivel_usuario nu
         JOIN general.gener_nivel n ON n.id_nivel = nu.id_nivel
         LEFT JOIN general.gener_tipo_negocio tn ON tn.id_tipo_negocio = n.id_tipo_negocio
         WHERE nu.id_usuario = :idUsuario
         GROUP BY n.id_tipo_negocio, tn.nombre
         ORDER BY n.id_tipo_negocio`,
        { replacements: { idUsuario }, type: Models.sequelize.QueryTypes.SELECT },
    );
    console.log('\n── Niveles del usuario por tipo_negocio (gener_nivel_usuario) ──');
    niveles.forEach((n) => console.log(`  tipo ${n.id_tipo_negocio ?? '-'} (${n.tipo ?? 'sin tipo'}): ${n.total} niveles`));

    // Detalle de niveles tipo_nivel=1 (módulos/vistas) por tipo_negocio
    const modulos = await Models.sequelize.query(
        `SELECT n.id_tipo_negocio, n.id_nivel, n.descripcion, n.url, n.id_tipo_nivel
         FROM general.gener_nivel_usuario nu
         JOIN general.gener_nivel n ON n.id_nivel = nu.id_nivel
         WHERE nu.id_usuario = :idUsuario AND n.id_tipo_nivel = 1
         ORDER BY n.id_tipo_negocio, n.descripcion`,
        { replacements: { idUsuario }, type: Models.sequelize.QueryTypes.SELECT },
    );
    console.log('\n── Módulos visibles (tipo_nivel=1) ──');
    let lastTipo = null;
    modulos.forEach((m) => {
        if (m.id_tipo_negocio !== lastTipo) { console.log(`  [tipo ${m.id_tipo_negocio}]`); lastTipo = m.id_tipo_negocio; }
        console.log(`     ${m.id_nivel} — ${m.descripcion} (${m.url ?? 'sin url'})`);
    });

    // ¿Cuál es el tipo_negocio de cada negocio del usuario? ¿Hay niveles para ese tipo?
    console.log('\n── Cobertura por negocio ──');
    for (const r of roles) {
        if (!r.id_negocio || !r.id_tipo_negocio) continue;
        const cov = niveles.find((n) => n.id_tipo_negocio === r.id_tipo_negocio);
        console.log(`  negocio ${r.id_negocio} "${r.negocio}" (tipo ${r.id_tipo_negocio}): ${cov ? cov.total + ' niveles' : 'SIN NIVELES ❌'}`);
    }

    await Models.sequelize.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
