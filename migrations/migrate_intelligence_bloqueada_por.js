/**
 * `intelligence.conversacion.bloqueada_por` — quién disparó `estado = 'bloqueada'`.
 *
 * ## Por qué hace falta
 *
 * Hasta ahora solo el propio cliente podía llegar a `bloqueada`, escribiendo STOP/BAJA
 * (`optout.js`) — es irrevocable por él a propósito (ADR-023) y solo un super admin puede
 * deshacerlo desde la Consola (`desbloquearConversacion`).
 *
 * Ahora el NEGOCIO también puede bloquear un número desde su propia Bandeja —un cliente que
 * abusa del sistema pero nunca escribió STOP—, y eso es una decisión completamente distinta:
 * no es un opt-out legal, es moderación del propio negocio, y el negocio tiene que poder
 * deshacer SU PROPIO error sin pedirle a EscalApp que le abra un ticket.
 *
 * Sin esta columna, un bloqueo del negocio y una baja legal del cliente se ven exactamente
 * igual —`estado = 'bloqueada'`, nada más—, y no hay forma de dejar que el negocio deshaga lo
 * primero sin, sin querer, dejarle deshacer también lo segundo.
 *
 *   'cliente' → lo puso el propio cliente (STOP/BAJA). Sigue irrevocable salvo por un super
 *               admin (Consola).
 *   'negocio' → lo puso el negocio desde la Bandeja. Lo puede deshacer el propio negocio.
 *
 * Aditiva e idempotente. NO destructiva. Ejecutar con:
 *   npm run migrate:intelligence-bloqueada-por
 */
'use strict';
require('dotenv').config();

const Models = require('../app_core/models/conection');

async function migrate() {
    const t = await Models.sequelize.transaction();
    try {
        console.log('1. Añadiendo intelligence.conversacion.bloqueada_por...');
        await Models.sequelize.query(
            `ALTER TABLE intelligence.conversacion
                 ADD COLUMN IF NOT EXISTS bloqueada_por varchar(10)
                 CHECK (bloqueada_por IN ('cliente', 'negocio'));`,
            { transaction: t }
        );

        // Las que ya estaban bloqueadas ANTES de esto solo pudieron llegar ahí por STOP/BAJA:
        // la Bandeja todavía no sabía bloquear nada. Marcarlas 'cliente' conserva la regla de
        // irrevocabilidad para el pasado, no solo para lo nuevo.
        console.log('2. Marcando las bloqueadas de antes como "cliente"...');
        const [, meta] = await Models.sequelize.query(
            `UPDATE intelligence.conversacion
                SET bloqueada_por = 'cliente'
              WHERE estado = 'bloqueada' AND bloqueada_por IS NULL;`,
            { transaction: t }
        );
        console.log(`   ${meta?.rowCount ?? 0} conversación(es) marcadas.`);

        await t.commit();
        console.log('\n✓ Listo.');
    } catch (error) {
        await t.rollback();
        throw error;
    }
}

migrate()
    .then(() => Models.sequelize.close())
    .catch(async (error) => {
        console.error('Falló la migración:', error.message);
        await Models.sequelize.close();
        process.exit(1);
    });
