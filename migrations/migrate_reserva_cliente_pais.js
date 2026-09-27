/**
 * `reserva.reserva_cita.cliente_pais` — el país del teléfono del cliente, si el portal
 * público lo capturó (selector de país al agendar).
 *
 * Sin esta columna, `personaNegocioDao.resolverOCrear` solo sabía asumir el país del
 * negocio: un turista peruano agendando en un salón colombiano perdía su ficha de cliente
 * en silencio (ADR-006: la cita se agenda igual, pero sin enlazar con `persona_negocio`).
 * Ver `app_reserva_api/services/citaService.js` y `shared/telefono-pais` en el frontend.
 *
 * Solo la columna: las citas existentes quedan con `cliente_pais = NULL`, que el DAO
 * interpreta igual que antes (país del negocio). Idempotente.
 *
 *   npm run migrate:reserva-cliente-pais
 */
require('dotenv').config();
const { sequelize } = require('../app_core/models/conection');

async function columnaExiste(esquema, tabla, columna, t) {
    const [filas] = await sequelize.query(`
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = :esquema AND table_name = :tabla AND column_name = :columna;
    `, { replacements: { esquema, tabla, columna }, transaction: t });
    return filas.length > 0;
}

async function migrar() {
    const t = await sequelize.transaction();
    try {
        console.log('\n=== Migración: reserva_cita.cliente_pais ===\n');

        if (!await columnaExiste('reserva', 'reserva_cita', 'cliente_pais', t)) {
            await sequelize.query(`
                ALTER TABLE reserva.reserva_cita ADD COLUMN cliente_pais VARCHAR(2);
            `, { transaction: t });
            console.log('   + cliente_pais');
        } else {
            console.log('   = cliente_pais ya existía');
        }

        await t.commit();
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
