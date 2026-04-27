/**
 * Migración: Planes base EscalApp
 * - Inserta/actualiza 2 planes (Básico $27.999, Avanzado $59.999 COP)
 * - Inactiva planes legacy (Prueba gratuita, Emprendedor, Profesional, Empresarial)
 * - Asegura que id_negocio=6 tenga plan Básico activo desde 2026-04-20
 *
 * Idempotente. Ejecutar con: npm run migrate:planes-base
 */
require('dotenv').config();
const db = require('../app_core/models/conection');
const sequelize = db.sequelize;

async function migrate() {
    const t = await sequelize.transaction();
    try {
        console.log('→ Migración: Planes base EscalApp\n');

        // 1. Insertar/actualizar planes base
        console.log('1. Insertando/actualizando planes base...');
        await sequelize.query(`
            INSERT INTO general.gener_plan (nombre, descripcion, precio, moneda, estado)
            VALUES
                ('Plan Básico',
                 'Ideal para negocios pequeños. 1 sucursal, hasta 5 usuarios, funcionalidades esenciales.',
                 27999.00, 'COP', 'A'),
                ('Plan Avanzado',
                 'Para negocios en crecimiento. Múltiples sucursales, usuarios ilimitados y soporte prioritario.',
                 59999.00, 'COP', 'A')
            ON CONFLICT (nombre) DO UPDATE
                SET precio  = EXCLUDED.precio,
                    moneda  = EXCLUDED.moneda,
                    descripcion = EXCLUDED.descripcion,
                    estado  = EXCLUDED.estado;
        `, { transaction: t });

        const planes = await sequelize.query(
            `SELECT id_plan, nombre FROM general.gener_plan
             WHERE estado = 'A' AND nombre IN ('Plan Básico', 'Plan Avanzado');`,
            { transaction: t, type: sequelize.QueryTypes.SELECT }
        );
        console.log('   Planes:', planes.map(p => `${p.nombre} (id=${p.id_plan})`).join(', '));

        const planBasico = planes.find(p => p.nombre === 'Plan Básico');
        if (!planBasico) throw new Error('Plan Básico no encontrado después de insertar.');

        // 2. Asegurar plan activo para id_negocio=6
        console.log('\n2. Verificando plan activo para id_negocio=6...');
        const [planNegocio] = await sequelize.query(`
            SELECT id_negocio_plan FROM general.gener_negocio_plan
            WHERE id_negocio = 6 AND estado = 'A'
            LIMIT 1;
        `, { transaction: t, type: sequelize.QueryTypes.SELECT });

        if (!planNegocio) {
            console.log('   Sin plan activo — asignando Plan Básico desde 2026-04-20...');
            await sequelize.query(`
                INSERT INTO general.gener_negocio_plan
                    (id_negocio, id_plan, fecha_inicio, fecha_fin, estado, auto_renovacion)
                VALUES (6, :idPlan, '2026-04-20', NULL, 'A', true);
            `, { replacements: { idPlan: planBasico.id_plan }, transaction: t });
            console.log('   Plan Básico asignado a id_negocio=6.');
        } else {
            console.log('   id_negocio=6 ya tiene plan activo. Sin cambios.');
        }

        // 3. Inactivar planes legacy
        console.log('\n3. Inactivando planes legacy...');
        const [res] = await sequelize.query(`
            UPDATE general.gener_plan SET estado = 'I'
            WHERE nombre IN ('Prueba gratuita', 'Emprendedor', 'Profesional', 'Empresarial')
              AND estado = 'A';
        `, { transaction: t });
        const inactivados = res?.rowCount ?? 0;
        console.log(`   ${inactivados} plan(es) legacy inactivado(s).`);

        await t.commit();
        console.log('\n✓ Migración de planes completada exitosamente.');
    } catch (err) {
        await t.rollback();
        console.error('\n✗ Error en migración:', err.message);
        process.exit(1);
    } finally {
        await sequelize.close();
    }
}

migrate();
