/**
 * Eliminar un usuario tiene que ser distinto de suspenderlo.
 *
 * Hasta ahora `softDeleteUsuario` ponía `estado = 'I'`, exactamente lo mismo que el botón de
 * suspender: el usuario «eliminado» seguía saliendo en la lista, marcado como inactivo, y no
 * había forma de quitarlo de la vista. Tampoco se podía volver a dar de alta a esa persona,
 * porque su correo y su cédula seguían ocupados por la fila vieja.
 *
 * ## Qué cambia
 *
 * `estado` acepta un tercer valor, **'E' (eliminado)**, y el CHECK de la tabla lo permite. Se
 * eligió un estado nuevo y no una columna `eliminado_en` porque TODO el sistema ya filtra por
 * `estado = 'A'` para operar: con un valor nuevo, el usuario borrado queda fuera del login, de
 * los permisos y de los informes sin tocar una sola consulta más. Solo el listado de la consola
 * —el único que mostraba activos e inactivos juntos— tuvo que aprender a excluirlo.
 *
 * El dato no se borra: los pedidos, los turnos de caja y la auditoría siguen apuntando a ese
 * `id_usuario`, y tienen que poder decir quién los hizo. Borrar la fila de verdad dejaría
 * huérfano el historial de dinero del negocio.
 *
 * Idempotente: se mira el CHECK antes de tocarlo.
 *
 * Ejecutar con: npm run migrate:usuario-eliminado
 */
'use strict';
require('dotenv').config();

const db = require('../app_core/models/conection');
const sequelize = db.sequelize;

async function migrate() {
    const t = await sequelize.transaction();
    try {
        console.log('→ Migración: estado «eliminado» para usuarios\n');

        console.log('1. gener_usuario.estado acepta E...');
        const [check] = await sequelize.query(
            `SELECT pg_get_constraintdef(oid) AS def
               FROM pg_constraint
              WHERE conname = 'gener_usuario_estado_check'
                AND conrelid = 'general.gener_usuario'::regclass;`,
            { transaction: t, type: sequelize.QueryTypes.SELECT }
        );

        if (check?.def?.includes("'E'")) {
            console.log('   ya lo aceptaba.');
        } else {
            if (check) {
                await sequelize.query(
                    `ALTER TABLE general.gener_usuario DROP CONSTRAINT gener_usuario_estado_check;`,
                    { transaction: t }
                );
            }
            await sequelize.query(
                `ALTER TABLE general.gener_usuario
                   ADD CONSTRAINT gener_usuario_estado_check
                   CHECK (estado IN ('A', 'I', 'E'));`,
                { transaction: t }
            );
            console.log("   ampliado a ('A','I','E').");
        }

        await sequelize.query(
            `COMMENT ON COLUMN general.gener_usuario.estado IS
             'A = activo. I = suspendido (no entra, pero se ve y se puede reactivar). E = eliminado: no se muestra en ninguna parte y su correo y cédula quedaron liberados para volver a darlo de alta. La fila se conserva porque pedidos, caja y auditoría apuntan a ella.';`,
            { transaction: t }
        );

        await t.commit();
        console.log('\n✅ Listo. Eliminar ya no es lo mismo que suspender.');
    } catch (err) {
        await t.rollback();
        console.error('\n❌ Falló la migración:', err.message);
        throw err;
    } finally {
        await sequelize.close();
    }
}

migrate().catch(() => process.exit(1));
