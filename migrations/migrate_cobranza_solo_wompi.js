/**
 * Cobranza — el cliente paga solo por Wompi (2026-09-15).
 *
 * Decisión del dueño: quitar la transferencia bancaria como forma de pago. Obligaba a vigilar
 * extractos, confirmar a mano y correr fechas de vigencia; con Wompi el pago se confirma solo y el
 * plan se extiende sin que nadie intervenga.
 *
 * ## Qué hace
 *
 * 1. `manual` pasa a estado 'I'. **No se borra**: las facturas viejas la referencian por FK, y el
 *    super admin conserva «Registrar pago» en la consola para un caso excepcional. Lo que
 *    desaparece es la opción en el portal del cliente, que solo ofrece pasarelas activas.
 * 2. El valor por defecto de `cob_suscripcion.pasarela` pasa a 'wompi'.
 * 3. Las suscripciones de negocios **colombianos** que estaban en 'manual' pasan a 'wompi'.
 * 4. Sus facturas **pendientes** también (las pagadas conservan con qué se pagaron).
 *
 * ## Lo que NO toca, a propósito
 *
 * Negocios de otros países. Wompi solo cobra en Colombia: pasarlos a 'wompi' les dejaría una
 * pasarela que no les sirve. Se listan al final para que no se olviden — hasta que dLocal esté
 * activo, esos clientes no tienen cómo pagar en línea.
 *
 * Requiere `npm run migrate:cobranza`. Idempotente: se puede correr dos veces seguidas.
 * Ejecutar con: npm run migrate:cobranza-solo-wompi
 */
'use strict';
require('dotenv').config();

const db = require('../app_core/models/conection');
const sequelize = db.sequelize;

async function migrate() {
    const t = await sequelize.transaction();
    try {
        console.log('→ Migración: cobranza solo por Wompi\n');

        const [[infra]] = await sequelize.query(
            `SELECT EXISTS (
                 SELECT 1 FROM information_schema.tables
                  WHERE table_schema = 'cobranza' AND table_name = 'cob_pasarela'
             ) AS ok;`,
            { transaction: t }
        );
        if (!infra.ok) {
            throw new Error('Falta el esquema de cobranza. Ejecute primero: npm run migrate:cobranza');
        }

        console.log('1. Desactivando la transferencia (manual)...');
        const manual = await sequelize.query(
            `UPDATE cobranza.cob_pasarela SET estado = 'I'
              WHERE codigo = 'manual' AND estado <> 'I'
             RETURNING codigo;`,
            { transaction: t, type: sequelize.QueryTypes.SELECT }
        );
        console.log(manual.length ? '   manual → I' : '   ya estaba inactiva.');

        console.log('2. Pasarela por defecto de las suscripciones...');
        const [columna] = await sequelize.query(
            `SELECT column_default
               FROM information_schema.columns
              WHERE table_schema = 'cobranza' AND table_name = 'cob_suscripcion'
                AND column_name = 'pasarela';`,
            { transaction: t, type: sequelize.QueryTypes.SELECT }
        );
        if (!String(columna?.column_default || '').includes('wompi')) {
            await sequelize.query(
                `ALTER TABLE cobranza.cob_suscripcion ALTER COLUMN pasarela SET DEFAULT 'wompi';`,
                { transaction: t }
            );
            console.log("   DEFAULT 'wompi'");
        } else {
            console.log('   ya era wompi.');
        }

        console.log('3. Suscripciones de negocios colombianos en manual → wompi...');
        const suscripciones = await sequelize.query(
            `UPDATE cobranza.cob_suscripcion s
                SET pasarela = 'wompi', actualizado_en = now()
               FROM general.gener_negocio n
              WHERE n.id_negocio = s.id_negocio
                AND n.pais = 'CO'
                AND s.pasarela = 'manual'
             RETURNING s.id_negocio;`,
            { transaction: t, type: sequelize.QueryTypes.SELECT }
        );
        console.log(`   ${suscripciones.length} suscripción(es) actualizadas.`);

        console.log('4. Facturas pendientes de negocios colombianos en manual → wompi...');
        const facturas = await sequelize.query(
            `UPDATE cobranza.cob_factura f
                SET pasarela = 'wompi', actualizado_en = now()
               FROM general.gener_negocio n
              WHERE n.id_negocio = f.id_negocio
                AND n.pais = 'CO'
                AND f.estado = 'pendiente'
                AND f.pasarela = 'manual'
             RETURNING f.referencia;`,
            { transaction: t, type: sequelize.QueryTypes.SELECT }
        );
        console.log(`   ${facturas.length} factura(s) actualizadas.`);

        const sinPasarela = await sequelize.query(
            `SELECT n.id_negocio, n.nombre, n.pais
               FROM cobranza.cob_suscripcion s
               JOIN general.gener_negocio n ON n.id_negocio = s.id_negocio
              WHERE s.pasarela = 'manual';`,
            { transaction: t, type: sequelize.QueryTypes.SELECT }
        );
        if (sinPasarela.length) {
            console.log('\n   ⚠️  Siguen en manual (Wompi no cobra en su país; necesitan dLocal):');
            for (const n of sinPasarela) console.log(`      · ${n.nombre} (id ${n.id_negocio}, ${n.pais})`);
        }

        await t.commit();
        console.log('\n✅ Los clientes colombianos pagan por Wompi.');
    } catch (err) {
        await t.rollback();
        console.error('\n❌ Error en la migración:', err.message);
        process.exitCode = 1;
    } finally {
        await sequelize.close();
    }
}

migrate();
