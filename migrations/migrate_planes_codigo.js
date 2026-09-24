/**
 * Migración: código estable de plan y features desde datos (ADR-021).
 *
 *  - general.gener_plan.codigo   varchar(40), único cuando no es NULL
 *  - 'BASICO' y 'AVANZADO' resueltos por nombre (una sola vez, aquí)
 *  - general.gener_plan_caracteristica: asistente_ia = 'true' en AVANZADO
 *
 * ## Por qué
 *
 * El plan se buscaba por NOMBRE en cinco sitios (features, compra en línea, registro de prueba,
 * prueba desde la consola y una regex del editor de negocios), y el nombre es una etiqueta comercial
 * que marketing puede cambiar. Los ids tampoco sirven: difieren por entorno (en dev Básico=1 y
 * Avanzado=2; en producción 5 y 6). El código es lo único que es igual en todos los entornos y no
 * cambia cuando el plan se renombra.
 *
 * ## Qué NO toca
 *
 * Ni nombre, ni precio, ni límites de ninguna fila. Solo añade `codigo` a las dos filas que existen
 * hoy y una característica a Avanzado.
 *
 * ## Las features
 *
 * Las features de un plan salen de `gener_plan_caracteristica` (codigo = nombre de la feature,
 * valor = 'true'). `intelligence/core/features.js` conserva el mapa por nombre como RESPALDO
 * durante la transición: a un plan sin la fila se le sigue aplicando el mapa, así nadie pierde el
 * asistente si esta migración aún no corrió en su entorno.
 *
 * Idempotente: comprueba `information_schema` antes del ALTER y usa ON CONFLICT DO NOTHING (si
 * alguien puso `asistente_ia = 'false'` a mano, volver a correr esto no se lo revierte).
 * Registrada como `npm run migrate:planes-codigo`.
 */
'use strict';
require('dotenv').config();

const Models = require('../app_core/models/conection');

const CODIGOS_POR_NOMBRE = [
    ['BASICO', 'Plan Básico'],
    ['AVANZADO', 'Plan Avanzado'],
];

async function existe(sql, replacements, transaction) {
    const filas = await Models.sequelize.query(sql, {
        replacements,
        type: Models.sequelize.QueryTypes.SELECT,
        transaction,
    });
    return filas.length > 0;
}

async function migrate() {
    const t = await Models.sequelize.transaction();
    try {
        console.log('1. general.gener_plan.codigo ...');
        const hayColumna = await existe(
            `SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'general' AND table_name = 'gener_plan' AND column_name = 'codigo';`,
            {},
            t
        );
        if (!hayColumna) {
            await Models.sequelize.query(
                `ALTER TABLE general.gener_plan ADD COLUMN codigo varchar(40);`,
                { transaction: t }
            );
            console.log('   añadida.');
        } else {
            console.log('   ya existía.');
        }

        await Models.sequelize.query(
            `CREATE UNIQUE INDEX IF NOT EXISTS ux_gener_plan_codigo
                 ON general.gener_plan (codigo) WHERE codigo IS NOT NULL;`,
            { transaction: t }
        );

        console.log('2. Códigos BASICO y AVANZADO (resueltos por nombre, una sola vez) ...');
        for (const [codigo, nombre] of CODIGOS_POR_NOMBRE) {
            // Solo si el plan existe, no tiene código y nadie más lo usa: la migración no
            // pisa una decisión ya tomada.
            const [, meta] = await Models.sequelize.query(
                `UPDATE general.gener_plan
                    SET codigo = :codigo
                  WHERE nombre = :nombre AND codigo IS NULL
                    AND NOT EXISTS (SELECT 1 FROM general.gener_plan WHERE codigo = :codigo);`,
                { replacements: { codigo, nombre }, transaction: t }
            );
            console.log(`   ${codigo}: ${meta?.rowCount ? 'asignado a «' + nombre + '»' : 'sin cambios'}.`);
        }

        console.log('3. asistente_ia = true en AVANZADO (gener_plan_caracteristica) ...');
        const hayTabla = await existe(
            `SELECT 1 FROM information_schema.tables
              WHERE table_schema = 'general' AND table_name = 'gener_plan_caracteristica';`,
            {},
            t
        );
        if (!hayTabla) {
            console.log('   la tabla no existe en este entorno (falta migrate:restaurante-carta-diseno): se omite;');
            console.log('   features.js seguirá resolviendo por el mapa de respaldo.');
        } else {
            const [filas] = await Models.sequelize.query(
                `INSERT INTO general.gener_plan_caracteristica (id_plan, codigo, valor)
                 SELECT id_plan, 'asistente_ia', 'true'
                   FROM general.gener_plan WHERE codigo = 'AVANZADO'
                 ON CONFLICT (id_plan, codigo) DO NOTHING
                 RETURNING id_plan;`,
                { transaction: t }
            );
            console.log(`   ${filas.length} fila(s) nueva(s).`);
        }

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
