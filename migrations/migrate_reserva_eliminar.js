/**
 * Permisos de **borrado definitivo** en el vertical `reserva`.
 *
 * Hasta ahora nada se borraba: una cita se cancela y una forma de pago se inactiva. Es la
 * política correcta para el día a día —el histórico es lo que permite cuadrar— pero deja sin
 * salida los casos en que el registro **no debería existir**: la cita de prueba que alguien
 * creó para ver cómo se veía, el movimiento de caja tecleado dos veces. Dejarlos ahí ensucia
 * los informes de un negocio pequeño, donde cinco citas fantasma se notan.
 *
 * Se modela como dos acciones más (`gener_nivel` con `id_tipo_nivel = 4`), igual que el resto
 * del catálogo, para que el dueño las reparta desde Usuarios → Roles y permisos:
 *
 *   - `/agenda/eliminar` → `agenda_eliminar` — borrar una cita definitivamente.
 *   - `/caja/eliminar`   → `caja_eliminar`   — borrar un movimiento de un turno.
 *
 * ## Solo ADMINISTRADOR de partida
 *
 * Borrar no tiene deshacer, así que arranca donde arrancan las decisiones sin vuelta atrás. Un
 * negocio que quiera dárselo a recepción lo marca; lo contrario —repartirlo y que alguien lo
 * descubra— no se puede revertir.
 *
 * ## Auditoría
 *
 * `reserva_cita` y `reserva_movimiento_caja` ya llevan `trg_audit`, así que el DELETE deja el
 * snapshot de la fila en `auditoria.audit_dato` por sí solo. Los servicios añaden encima un
 * evento en `audit_evento` (módulo `reserva`) con quién borró qué y cuánto dinero se llevó por
 * delante: el trigger dice qué fila desapareció, el evento dice que fue una decisión humana.
 *
 * Idempotente.
 *
 *   npm run migrate:reserva-eliminar
 */
require('dotenv').config();
const { sequelize } = require('../app_core/models/conection');

const TIPO_NIVEL_ACCION = 4;

/** [url de la vista, url de la acción, etiqueta, roles que la reciben]. */
const ACCIONES = [
    ['/agenda', '/agenda/eliminar', 'Eliminar citas definitivamente', ['ADMINISTRADOR']],
    ['/caja',   '/caja/eliminar',   'Eliminar movimientos de caja',   ['ADMINISTRADOR']],
];

async function migrar() {
    const t = await sequelize.transaction();
    try {
        console.log('\n=== Migración: permisos de borrado (reserva) ===\n');

        const [[tipo]] = await sequelize.query(`
            SELECT id_tipo_negocio FROM general.gener_tipo_negocio WHERE nombre = 'RESERVA';
        `, { transaction: t });
        if (!tipo) throw new Error('No existe el tipo RESERVA. Ejecuta antes `npm run migrate:reserva`.');
        const idTipo = tipo.id_tipo_negocio;
        console.log(`1. Tipo RESERVA = ${idTipo}`);

        const [[tipoNivel]] = await sequelize.query(`
            SELECT id_tipo_nivel FROM general.gener_tipo_nivel WHERE id_tipo_nivel = :t;
        `, { replacements: { t: TIPO_NIVEL_ACCION }, transaction: t });
        if (!tipoNivel) throw new Error('No existe gener_tipo_nivel = 4. Ejecuta antes `npm run migrate:niveles`.');

        const vistas = await sequelize.query(`
            SELECT id_nivel, url FROM general.gener_nivel
            WHERE id_tipo_negocio = :tipo AND id_tipo_nivel = 1 AND url IS NOT NULL;
        `, { replacements: { tipo: idTipo }, transaction: t, type: sequelize.QueryTypes.SELECT });
        const vistaPorUrl = new Map(vistas.map(v => [v.url, v.id_nivel]));

        console.log('2. Insertando acciones...');
        let nuevas = 0, omitidas = 0;
        for (const [urlVista, urlAccion, etiqueta] of ACCIONES) {
            const idPadre = vistaPorUrl.get(urlVista);
            if (!idPadre) {
                console.log(`   ⚠️  ${urlVista} no existe — se omite ${urlAccion}`);
                omitidas++;
                continue;
            }
            const [res] = await sequelize.query(`
                INSERT INTO general.gener_nivel
                    (descripcion, id_nivel_padre, icono, estado, id_tipo_nivel, url, id_tipo_negocio)
                SELECT :desc, :padre, NULL, 'A', :tn, :url, :tipo
                WHERE NOT EXISTS (
                    SELECT 1 FROM general.gener_nivel
                    WHERE id_tipo_negocio = :tipo AND id_tipo_nivel = :tn AND url = :url
                )
                RETURNING id_nivel;
            `, {
                replacements: { desc: etiqueta, padre: idPadre, url: urlAccion, tipo: idTipo, tn: TIPO_NIVEL_ACCION },
                transaction: t,
            });
            if (res.length > 0) nuevas++;
        }
        console.log(`   OK — ${nuevas} nueva(s), ${omitidas} omitida(s)\n`);

        const accionesBD = await sequelize.query(`
            SELECT id_nivel, url FROM general.gener_nivel
            WHERE id_tipo_negocio = :tipo AND id_tipo_nivel = :tn;
        `, { replacements: { tipo: idTipo, tn: TIPO_NIVEL_ACCION }, transaction: t, type: sequelize.QueryTypes.SELECT });
        const accionPorUrl = new Map(accionesBD.map(a => [a.url, a.id_nivel]));

        const roles = await sequelize.query(`
            SELECT id_rol, descripcion FROM general.gener_rol
            WHERE id_tipo_negocio = :tipo AND estado = 'A';
        `, { replacements: { tipo: idTipo }, transaction: t, type: sequelize.QueryTypes.SELECT });
        const rolPorNombre = new Map(roles.map(r => [r.descripcion, r.id_rol]));

        console.log('3. Concediendo al ADMINISTRADOR...');
        let concedidas = 0;
        const nivelesNuevos = [];
        for (const [, urlAccion, , rolesConcedidos] of ACCIONES) {
            const idNivel = accionPorUrl.get(urlAccion);
            if (!idNivel) continue;
            nivelesNuevos.push(idNivel);
            for (const nombreRol of rolesConcedidos) {
                const idRol = rolPorNombre.get(nombreRol);
                if (!idRol) continue;
                const [res] = await sequelize.query(`
                    INSERT INTO general.gener_rol_nivel
                        (id_rol, id_nivel, puede_ver, puede_crear, puede_editar, puede_eliminar, estado)
                    VALUES (:rol, :nivel, true, false, false, true, 'A')
                    ON CONFLICT (id_rol, id_nivel) DO NOTHING
                    RETURNING id_rol;
                `, { replacements: { rol: idRol, nivel: idNivel }, transaction: t });
                concedidas += res.length;
            }
        }
        console.log(`   OK — ${concedidas} concesión(es) nuevas\n`);

        // Backfill por negocio: un negocio con ajustes propios no vería estas filas y su
        // administrador se quedaría sin la acción recién creada. Se siembra con la plantilla.
        console.log('4. Backfill gener_nivel_negocio...');
        const [backfill] = nivelesNuevos.length === 0 ? [[]] : await sequelize.query(`
            INSERT INTO general.gener_nivel_negocio
                (id_negocio, id_rol, id_nivel, puede_ver, estado, fecha_creacion, fecha_actualizacion)
            SELECT neg.id_negocio, rn.id_rol, rn.id_nivel, rn.puede_ver, 'A',
                   CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
            FROM general.gener_negocio neg
            JOIN general.gener_rol_nivel rn ON rn.estado = 'A' AND rn.id_nivel IN (:niveles)
            WHERE neg.id_tipo_negocio = :tipo AND neg.estado = 'A'
            ON CONFLICT (id_negocio, id_rol, id_nivel) DO NOTHING
            RETURNING id_negocio;
        `, { replacements: { tipo: idTipo, niveles: nivelesNuevos }, transaction: t });
        console.log(`   OK — ${backfill.length} fila(s) nuevas\n`);

        await t.commit();

        const resumen = await sequelize.query(`
            SELECT n.url, r.descripcion AS rol
            FROM general.gener_rol_nivel rn
            JOIN general.gener_rol r ON r.id_rol = rn.id_rol
            JOIN general.gener_nivel n ON n.id_nivel = rn.id_nivel
            WHERE n.id_tipo_negocio = :tipo AND n.url IN (:urls) AND rn.puede_ver
            ORDER BY n.url, r.descripcion;
        `, {
            replacements: { tipo: idTipo, urls: ACCIONES.map(a => a[1]) },
            type: sequelize.QueryTypes.SELECT,
        });

        console.log('=== Resultado ===');
        resumen.forEach(r => console.log(`   ${r.url} → ${r.rol}`));
        console.log('\nMigración completada.\n');
    } catch (err) {
        await t.rollback();
        console.error('\nERROR — se revirtió todo:', err.message, '\n');
        process.exitCode = 1;
    } finally {
        await sequelize.close();
    }
}

migrar();
