/**
 * Migración: valor del domicilio como RANGO, por negocio.
 *
 *  - general.gener_negocio.domicilio_valor_min   integer NULL        (pesos; «entre X y Y»)
 *  - general.gener_negocio.domicilio_valor_max   integer NULL        (opcional; sin él es «desde X»)
 *  - general.gener_negocio.domicilio_nota        varchar(200) NULL   (p. ej. «Fuera de la ciudad, desde $10.000»)
 *
 * ## Por qué (2026-10-02)
 *
 * Pedirle al negocio el valor del domicilio barrio por barrio (`rest_barrio_domicilio`) resultó
 * tedioso: Zona Burger, en Pasto, no iba a cargar cien barrios. Lo que el negocio sabe decir es
 * un rango —«en la ciudad entre $7.000 y $9.000; fuera, de $10.000 para arriba»— y eso es lo que
 * el asistente contesta. Los barrios con precio siguen existiendo para quien los quiera: cuando
 * el cliente elige uno, ese valor exacto manda sobre el rango.
 *
 * El rango es INFORMATIVO: no se suma al total del pedido (no hay un valor exacto que sumar). El
 * total que confirma el cliente dice «no incluye el domicilio» y nombra el rango.
 *
 * Son columnas y no texto libre por lo mismo que el tiempo estimado: para validar y para que la
 * frase salga siempre bien construida. La nota cubre lo que no cabe en dos números.
 *
 * Idempotente: comprueba `information_schema` antes de cada ALTER.
 * Registrada como `npm run migrate:negocio-domicilio-rango`.
 */
'use strict';
require('dotenv').config();

const Models = require('../app_core/models/conection');

async function columnaExiste(esquema, tabla, columna, transaction) {
    const [fila] = await Models.sequelize.query(
        `SELECT 1 AS hay FROM information_schema.columns
          WHERE table_schema = :esquema AND table_name = :tabla AND column_name = :columna;`,
        {
            replacements: { esquema, tabla, columna },
            type: Models.sequelize.QueryTypes.SELECT,
            transaction,
        }
    );
    return Boolean(fila);
}

async function anadirColumna(columna, definicion, t) {
    if (!(await columnaExiste('general', 'gener_negocio', columna, t))) {
        await Models.sequelize.query(
            `ALTER TABLE general.gener_negocio ADD COLUMN ${columna} ${definicion};`,
            { transaction: t }
        );
        console.log('   añadida (NULL = sin configurar).');
    } else {
        console.log('   ya existía.');
    }
}

async function migrate() {
    const t = await Models.sequelize.transaction();
    try {
        console.log('1. general.gener_negocio.domicilio_valor_min ...');
        await anadirColumna(
            'domicilio_valor_min',
            'integer CHECK (domicilio_valor_min BETWEEN 0 AND 10000000)',
            t
        );

        console.log('2. general.gener_negocio.domicilio_valor_max ...');
        await anadirColumna(
            'domicilio_valor_max',
            'integer CHECK (domicilio_valor_max BETWEEN 0 AND 10000000)',
            t
        );

        console.log('3. general.gener_negocio.domicilio_nota ...');
        await anadirColumna('domicilio_nota', 'varchar(200)', t);

        console.log('4. coherencia (max >= min, y max solo con min) ...');
        const [restriccion] = await Models.sequelize.query(
            `SELECT 1 AS hay FROM information_schema.table_constraints
              WHERE constraint_schema = 'general' AND table_name = 'gener_negocio'
                AND constraint_name = 'chk_negocio_domicilio_rango';`,
            { type: Models.sequelize.QueryTypes.SELECT, transaction: t }
        );
        if (!restriccion) {
            await Models.sequelize.query(
                `ALTER TABLE general.gener_negocio
                     ADD CONSTRAINT chk_negocio_domicilio_rango CHECK (
                         domicilio_valor_max IS NULL
                         OR (domicilio_valor_min IS NOT NULL AND domicilio_valor_max >= domicilio_valor_min));`,
                { transaction: t }
            );
            console.log('   añadida.');
        } else {
            console.log('   ya existía.');
        }

        await t.commit();
        console.log('✓ Migración rango de domicilio completada.');
    } catch (error) {
        await t.rollback();
        console.error('✗ Falló la migración (revertida):', error.message);
        process.exitCode = 1;
    } finally {
        await Models.sequelize.close();
    }
}

migrate();
