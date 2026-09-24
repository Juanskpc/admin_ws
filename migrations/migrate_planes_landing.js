/**
 * Migración: los planes de la landing como filas de la base (2026-09-24).
 *
 *   npm run migrate:planes-landing
 *
 * ## Qué hace
 *
 * Añade las 8 filas que faltaban para que `general.gener_plan` coincida con las tarjetas de la
 * landing (`TARJETAS_PLAN`). Cada tarjeta con facturación es UNA FILA POR PAQUETE de documentos
 * (S/M/L/XL: 100/500/1.200/2.500 al mes), porque eso es lo que se ve y se compra:
 *
 *   | código             | nombre                             | usuarios | cajas | features                          |
 *   |--------------------|------------------------------------|----------|-------|-----------------------------------|
 *   | EMPRENDEDOR_FE_S…XL| Emprendedor + Facturación S…XL     |    8     |   2   | facturacion_electronica           |
 *   | EMPRESARIAL_S…XL   | Plan Empresarial S…XL              |   15     |   3   | asistente_ia + facturacion_electr.|
 *
 * y sus precios en `cob_precio_plan` (COP, mensual): el de por defecto —el de Restaurante— y el de
 * Reserva como fila propia por aplicativo (`id_tipo_modulo`).
 *
 *   | paquete | Emprendedor+FE (Rest./Reserva) | Empresarial (Rest./Reserva) |
 *   |---------|--------------------------------|-----------------------------|
 *   | S       | 66.999 / 76.999                | 98.999 / 108.999            |
 *   | M       | 86.999 / 96.999                | 118.999 / 128.999           |
 *   | L       | 106.999 / 116.999              | 138.999 / 148.999           |
 *   | XL      | 126.999 / 136.999              | 158.999 / 168.999           |
 *
 * Y sus características en `gener_plan_caracteristica`: las `carta_*` por defecto (todo incluido,
 * como el resto de planes), `facturacion_electronica` en los ocho y `asistente_ia` en Empresarial.
 *
 * ## Qué NO hace
 *
 * - **Ningún UPDATE sobre filas existentes**: ni nombre, ni precio, ni límites, ni características.
 *   «Plan Básico» y «Plan Avanzado» quedan exactamente como están; ningún cliente actual cambia
 *   de plan, de precio ni de features. Si una fila ya existe (otra corrida, o alguien la tocó a
 *   mano) se deja tal cual.
 * - **Sin precios en CLP**: los planes nuevos no se venden en Chile hasta definirlos.
 * - **Sin ciclo anual**: se crean con precio mensual (ver `docs/precios-y-planes.md` §8).
 *
 * Si `codigo` de `gener_plan` o `id_tipo_modulo` de `cob_precio_plan` no existen, se detiene con
 * un mensaje que dice qué migración correr antes (`migrate:planes-codigo`,
 * `migrate:cobranza-precio-aplicativo`).
 *
 * Todo se resuelve por código y por nombre de tipo, nunca por id: los ids difieren entre dev y
 * producción. Idempotente: comprueba antes de insertar y usa la unicidad de cada tabla.
 */
'use strict';
require('dotenv').config();

const db = require('../app_core/models/conection');
const sequelize = db.sequelize;

/** Paquetes de documentos: sufijo del código y etiqueta. */
const PAQUETES = ['S', 'M', 'L', 'XL'];

/** Los 8 planes, con el precio por aplicativo (`landing.component.ts`: PRECIO_CON_FACTURACION). */
const PLANES = [
    ...PAQUETES.map((p, i) => ({
        codigo: `EMPRENDEDOR_FE_${p}`,
        nombre: `Emprendedor + Facturación ${p}`,
        descripcion: `Plan Emprendedor con facturación electrónica DIAN (paquete ${p}).`,
        usuarios: 8,
        cajas: 2,
        asistente: false,
        precio: [66999, 86999, 106999, 126999][i],
        precioReserva: [76999, 96999, 116999, 136999][i],
    })),
    ...PAQUETES.map((p, i) => ({
        codigo: `EMPRESARIAL_${p}`,
        nombre: `Plan Empresarial ${p}`,
        descripcion: `Sistema completo, asistente de IA en WhatsApp y facturación electrónica DIAN (paquete ${p}).`,
        usuarios: 15,
        cajas: 3,
        asistente: true,
        precio: [98999, 118999, 138999, 158999][i],
        precioReserva: [108999, 128999, 148999, 168999][i],
    })),
];

/** Lo que llevan todos los planes de la carta virtual (`planCaracteristicaHelper.POR_DEFECTO`). */
const CARTA = [['carta_whatsapp', 'true'], ['carta_plantillas', '*'], ['carta_color_libre', 'true']];

async function hay(sql, replacements, transaction) {
    const filas = await sequelize.query(sql, { replacements, type: sequelize.QueryTypes.SELECT, transaction });
    return filas.length > 0;
}

async function migrate() {
    const t = await sequelize.transaction();
    try {
        console.log('→ Migración: planes de la landing\n');

        // ── Requisitos ────────────────────────────────────────────────────────
        if (!await hay(
            `SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'general' AND table_name = 'gener_plan' AND column_name = 'codigo';`, {}, t)) {
            throw new Error('Falta general.gener_plan.codigo. Corre antes: npm run migrate:planes-codigo');
        }
        if (!await hay(
            `SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'cobranza' AND table_name = 'cob_precio_plan' AND column_name = 'id_tipo_modulo';`, {}, t)) {
            throw new Error('Falta cobranza.cob_precio_plan.id_tipo_modulo. Corre antes: npm run migrate:cobranza-precio-aplicativo');
        }

        const [tiposReserva] = await sequelize.query(
            `SELECT id_tipo_negocio FROM general.gener_tipo_negocio WHERE nombre = 'RESERVA' LIMIT 1;`,
            { transaction: t },
        );
        const idReserva = tiposReserva[0]?.id_tipo_negocio ?? null;
        if (!idReserva) console.log('   (no existe el tipo «RESERVA»: no se siembran precios de Reserva)\n');

        let planesNuevos = 0;
        let preciosNuevos = 0;
        let caracteristicasNuevas = 0;

        for (const plan of PLANES) {
            // 1. La fila del plan.
            const creados = await sequelize.query(
                `INSERT INTO general.gener_plan (nombre, descripcion, precio, moneda, estado, usuarios_incluidos, cajas_incluidas, codigo)
                 SELECT :nombre, :descripcion, :precio, 'COP', 'A', :usuarios, :cajas, :codigo
                  WHERE NOT EXISTS (SELECT 1 FROM general.gener_plan WHERE codigo = :codigo)
                    AND NOT EXISTS (SELECT 1 FROM general.gener_plan WHERE nombre = :nombre)
                 RETURNING id_plan;`,
                {
                    replacements: {
                        nombre: plan.nombre, descripcion: plan.descripcion, precio: plan.precio,
                        usuarios: plan.usuarios, cajas: plan.cajas, codigo: plan.codigo,
                    },
                    type: sequelize.QueryTypes.SELECT,
                    transaction: t,
                },
            );
            if (creados.length) planesNuevos += 1;

            const [fila] = await sequelize.query(
                'SELECT id_plan FROM general.gener_plan WHERE codigo = :codigo;',
                { replacements: { codigo: plan.codigo }, type: sequelize.QueryTypes.SELECT, transaction: t },
            );
            if (!fila) {
                throw new Error(`No se pudo crear ni encontrar el plan ${plan.codigo} (¿el nombre «${plan.nombre}» lo usa otra fila?).`);
            }
            const idPlan = fila.id_plan;

            // 2. Precios (COP, mensual): el de por defecto y el de Reserva. Solo si faltan.
            const precios = [{ modulo: null, valor: plan.precio }];
            if (idReserva) precios.push({ modulo: idReserva, valor: plan.precioReserva });
            for (const { modulo, valor } of precios) {
                const insertados = await sequelize.query(
                    `INSERT INTO cobranza.cob_precio_plan (id_plan, moneda, ciclo, precio, estado, id_tipo_modulo)
                     SELECT :idPlan, 'COP', 'mensual', :valor, 'A', ${modulo === null ? 'NULL' : ':modulo'}
                      WHERE NOT EXISTS (
                          SELECT 1 FROM cobranza.cob_precio_plan x
                           WHERE x.id_plan = :idPlan AND x.moneda = 'COP' AND x.ciclo = 'mensual'
                             AND ${modulo === null ? 'x.id_tipo_modulo IS NULL' : 'x.id_tipo_modulo = :modulo'}
                      )
                     RETURNING id_precio;`,
                    {
                        replacements: { idPlan, valor, ...(modulo === null ? {} : { modulo }) },
                        type: sequelize.QueryTypes.SELECT,
                        transaction: t,
                    },
                );
                preciosNuevos += insertados.length;
            }

            // 3. Características: las de la carta, la facturación y (Empresarial) el asistente.
            const caracteristicas = [...CARTA, ['facturacion_electronica', 'true']];
            if (plan.asistente) caracteristicas.push(['asistente_ia', 'true']);
            for (const [codigo, valor] of caracteristicas) {
                const insertadas = await sequelize.query(
                    `INSERT INTO general.gener_plan_caracteristica (id_plan, codigo, valor)
                     VALUES (:idPlan, :codigo, :valor)
                     ON CONFLICT (id_plan, codigo) DO NOTHING
                     RETURNING codigo;`,
                    { replacements: { idPlan, codigo, valor }, type: sequelize.QueryTypes.SELECT, transaction: t },
                );
                caracteristicasNuevas += insertadas.length;
            }
        }

        console.log(`Planes nuevos:            ${planesNuevos} de ${PLANES.length}`);
        console.log(`Precios nuevos:           ${preciosNuevos}`);
        console.log(`Características nuevas:   ${caracteristicasNuevas}`);

        await t.commit();
        console.log('\n✔ Migración completada.');
    } catch (err) {
        await t.rollback();
        console.error(`✖ Migración fallida (se revirtió todo): ${err.message}`);
        process.exitCode = 1;
    } finally {
        await sequelize.close();
    }
}

migrate();
