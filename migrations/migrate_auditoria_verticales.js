/**
 * Migración: Auditoría de verticales — parqueadero, gym, tienda, reserva (Hito 3)
 *
 * Replica el patrón validado en el piloto de restaurante (Hito 2):
 * triggers auditoria.fn_audit() + baseline 'B' en las tablas con dinero/estado
 * de los 4 verticales restantes. Overhead medido en el piloto: ~0.4 ms/op.
 *
 * Tablas de detalle (venta_detalle, mov_detalle, cita_servicio) y de alta
 * rotación/bajo valor (gym_asistencia, parq_capacidad, catálogos estáticos)
 * quedan deliberadamente FUERA — ver propuesta de auditoría.
 *
 * parq_movimiento_caja no tiene columna id_negocio: el tenant del baseline se
 * resuelve con JOIN a parq_caja (mismo caso que rest_movimiento_caja).
 *
 * Eventos Tipo B por vertical: pendientes hasta que cada vertical entre en
 * operación real (los triggers ya capturan todos los cambios de datos).
 *
 * Requiere: migrate:auditoria-base (Hito 0) y migrate:auditoria-restaurante
 * (Hito 2, define fn_audit v2).
 * Idempotente. Ejecutar con: npm run migrate:auditoria-verticales
 */
require('dotenv').config();
const db = require('../app_core/models/conection');
const sequelize = db.sequelize;

/**
 * Tablas a auditar por esquema.
 *  - pk: columna PK (TG_ARGV[0] del trigger).
 *  - tenantExpr: SQL para resolver id_negocio en el baseline (alias `t`);
 *    default: columna id_negocio de la propia fila.
 */
const TENANT_DEFAULT = `(to_jsonb(t) ->> 'id_negocio')::integer`;
const TABLAS = [
    // ── Parqueadero ──
    { esquema: 'parqueadero', tabla: 'parq_caja',            pk: 'id_caja' },
    { esquema: 'parqueadero', tabla: 'parq_movimiento_caja', pk: 'id_movimiento',
      tenantExpr: `(SELECT c.id_negocio FROM parqueadero.parq_caja c WHERE c.id_caja = t.id_caja)` },
    { esquema: 'parqueadero', tabla: 'parq_factura',         pk: 'id_factura' },
    { esquema: 'parqueadero', tabla: 'parq_tarifa',          pk: 'id_tarifa' },
    { esquema: 'parqueadero', tabla: 'parq_abonado',         pk: 'id_abonado' },
    { esquema: 'parqueadero', tabla: 'parq_vehiculo',        pk: 'id_vehiculo' },
    { esquema: 'parqueadero', tabla: 'parq_configuracion',   pk: 'id_configuracion' },
    // ── Gym ──
    { esquema: 'gym', tabla: 'gym_pago',      pk: 'id_pago' },
    { esquema: 'gym', tabla: 'gym_venta',     pk: 'id_venta' },
    { esquema: 'gym', tabla: 'gym_membresia', pk: 'id_membresia' },
    { esquema: 'gym', tabla: 'gym_plan',      pk: 'id_plan' },
    { esquema: 'gym', tabla: 'gym_producto',  pk: 'id_producto' },
    { esquema: 'gym', tabla: 'gym_miembro',   pk: 'id_miembro' },
    // ── Tienda ──
    { esquema: 'tienda', tabla: 'tienda_venta',      pk: 'id_venta' },
    { esquema: 'tienda', tabla: 'tienda_movimiento', pk: 'id_movimiento' },
    { esquema: 'tienda', tabla: 'tienda_producto',   pk: 'id_producto' },
    { esquema: 'tienda', tabla: 'tienda_cliente',    pk: 'id_cliente' },
    // ── Reserva ──
    { esquema: 'reserva', tabla: 'reserva_cita',        pk: 'id_cita' },
    { esquema: 'reserva', tabla: 'reserva_servicio',    pk: 'id_servicio' },
    { esquema: 'reserva', tabla: 'reserva_config',      pk: 'id_negocio' },
    { esquema: 'reserva', tabla: 'reserva_profesional', pk: 'id_profesional' },
    { esquema: 'reserva', tabla: 'reserva_horario',     pk: 'id_horario' },
];

async function migrate() {
    const t = await sequelize.transaction();
    try {
        console.log('→ Migración: Auditoría de verticales (Hito 3)\n');

        // 0. Precondición: infraestructura del Hito 0
        const [[infra]] = await sequelize.query(
            `SELECT EXISTS (
                 SELECT 1 FROM information_schema.tables
                  WHERE table_schema = 'auditoria' AND table_name = 'audit_dato'
             ) AS ok;`,
            { transaction: t }
        );
        if (!infra.ok) {
            throw new Error('Falta la infraestructura de auditoría. Ejecute primero: npm run migrate:auditoria-base');
        }

        for (const { esquema, tabla, pk, tenantExpr = TENANT_DEFAULT } of TABLAS) {
            console.log(`• ${esquema}.${tabla} (pk: ${pk})`);

            const [[existe]] = await sequelize.query(
                `SELECT EXISTS (
                     SELECT 1 FROM information_schema.tables
                      WHERE table_schema = :esquema AND table_name = :tabla
                 ) AS ok;`,
                { replacements: { esquema, tabla }, transaction: t }
            );
            if (!existe.ok) {
                console.log(`  ⚠️  No existe en la BD — omitida.`);
                continue;
            }

            await sequelize.query(
                `DROP TRIGGER IF EXISTS trg_audit ON ${esquema}.${tabla};`,
                { transaction: t }
            );
            await sequelize.query(
                `CREATE TRIGGER trg_audit
                     AFTER INSERT OR UPDATE OR DELETE ON ${esquema}.${tabla}
                     FOR EACH ROW EXECUTE FUNCTION auditoria.fn_audit('${pk}');`,
                { transaction: t }
            );
            console.log('  ✓ trigger trg_audit');

            await sequelize.query(
                `INSERT INTO auditoria.audit_dato
                     (esquema, tabla, operacion, id_negocio, id_usuario, pk_registro, datos_despues)
                 SELECT '${esquema}', '${tabla}', 'B',
                        ${tenantExpr},
                        NULL,
                        to_jsonb(t) ->> '${pk}',
                        to_jsonb(t) - 'password'
                   FROM ${esquema}.${tabla} t
                  WHERE NOT EXISTS (
                        SELECT 1 FROM auditoria.audit_dato d
                         WHERE d.esquema = '${esquema}'
                           AND d.tabla = '${tabla}'
                           AND d.operacion = 'B'
                  );`,
                { transaction: t }
            );
            // rowCount de INSERT...SELECT no es confiable en sequelize.query: contar directo
            const [[{ n }]] = await sequelize.query(
                `SELECT count(*)::int AS n FROM auditoria.audit_dato
                  WHERE esquema = :esquema AND tabla = :tabla AND operacion = 'B';`,
                { replacements: { esquema, tabla }, transaction: t }
            );
            console.log(`  ✓ baseline: ${n} filas`);
        }

        await t.commit();
        console.log('\n✅ Auditoría activa en los 4 verticales (triggers + baseline).');
    } catch (error) {
        await t.rollback();
        console.error('\n❌ Error en la migración:', error.message);
        process.exitCode = 1;
    } finally {
        await sequelize.close();
    }
}

migrate();
