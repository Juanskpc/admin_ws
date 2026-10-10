/**
 * `id_negocio_padre` en `general.gener_negocio`: la sede.
 *
 * Hasta ahora dos negocios del mismo dueño eran desconocidos entre sí. El sistema ya sabía
 * manejarlos —`gener_negocio_usuario` admite N negocios por usuario y el header de
 * `negocio_app` ya trae el selector—, pero nada decía que fueran la misma empresa: la consola
 * los listaba sueltos, no había forma de preguntar «¿cuántas sedes tiene este cliente?» y
 * abrir una obligaba a cargar la carta entera a mano.
 *
 * ## Por qué una columna y no un `id_sede` en las tablas operativas
 *
 * La alternativa era `gener_sede` + `id_sede` en cada tabla de datos. Son **188 tablas** con
 * `id_negocio` y **6.398 referencias** en 461 archivos del backend: cada query, cada informe y
 * cada guard. Además reabre la pregunta de aislamiento del ADR-002, que es la peor clase de
 * incidente del sistema. Con la sede como negocio hijo, el aislamiento que ya existe sirve tal
 * cual: la sede tiene su caja, su inventario y su turno propios, que es justo lo que una
 * sucursal necesita.
 *
 * ## El NIT deja de ser único a secas
 *
 * `gener_negocio_nit_key UNIQUE (nit)` bloquea la segunda sede, porque dos sucursales de la
 * misma empresa comparten NIT — es el mismo contribuyente. Pero dos empresas distintas no
 * pueden compartirlo, así que la unicidad no se tira: se acota a las **matrices**
 * (`id_negocio_padre IS NULL`). La matriz sigue siendo la dueña del NIT; sus sedes lo repiten
 * cuantas veces haga falta. Hoy solo 3 de 25 negocios de desarrollo tienen NIT, así que el
 * cambio no mueve ninguna fila.
 *
 * ## Un solo nivel
 *
 * El `CHECK` impide que un negocio sea su propia sede, y `sedeDao` impide que una sede tenga
 * sedes. Jerarquías de dos niveles no las pide nadie y convierten cada consulta de parentesco
 * en un recursivo.
 *
 * Idempotente: consulta a `information_schema` antes de cada `ALTER`, `IF NOT EXISTS` en
 * índices y restricciones, transacción única.
 *
 *   npm run migrate:negocio-sede
 */
require('dotenv').config();
const { sequelize } = require('../app_core/models/conection');

async function columnaExiste(tabla, columna, t) {
    const [filas] = await sequelize.query(`
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'general' AND table_name = :tabla AND column_name = :columna;
    `, { replacements: { tabla, columna }, transaction: t });
    return filas.length > 0;
}

async function restriccionExiste(nombre, t) {
    const [filas] = await sequelize.query(`
        SELECT 1 FROM pg_constraint
        WHERE conname = :nombre AND conrelid = 'general.gener_negocio'::regclass;
    `, { replacements: { nombre }, transaction: t });
    return filas.length > 0;
}

async function migrar() {
    const t = await sequelize.transaction();
    try {
        console.log('\n=== Migración: sedes de un negocio ===\n');

        console.log('1. Columna gener_negocio.id_negocio_padre...');
        if (!await columnaExiste('gener_negocio', 'id_negocio_padre', t)) {
            await sequelize.query(`
                ALTER TABLE general.gener_negocio
                ADD COLUMN id_negocio_padre INTEGER NULL;
            `, { transaction: t });
            console.log('   + gener_negocio.id_negocio_padre');
        } else {
            console.log('   Ya existía.');
        }

        // ON DELETE RESTRICT a propósito: borrar la matriz y dejar las sedes huérfanas convierte
        // sucursales en negocios sueltos sin que nadie lo decida. La previsualización de
        // eliminación (`GET /negocios/:id/eliminacion`) es el sitio donde se avisa.
        if (!await restriccionExiste('fk_gener_negocio_padre', t)) {
            await sequelize.query(`
                ALTER TABLE general.gener_negocio
                ADD CONSTRAINT fk_gener_negocio_padre
                FOREIGN KEY (id_negocio_padre)
                REFERENCES general.gener_negocio (id_negocio)
                ON DELETE RESTRICT;
            `, { transaction: t });
            console.log('   + fk_gener_negocio_padre');
        }

        if (!await restriccionExiste('ck_gener_negocio_padre_no_si_mismo', t)) {
            await sequelize.query(`
                ALTER TABLE general.gener_negocio
                ADD CONSTRAINT ck_gener_negocio_padre_no_si_mismo
                CHECK (id_negocio_padre IS NULL OR id_negocio_padre <> id_negocio);
            `, { transaction: t });
            console.log('   + ck_gener_negocio_padre_no_si_mismo');
        }

        await sequelize.query(`
            CREATE INDEX IF NOT EXISTS idx_gener_negocio_padre
            ON general.gener_negocio (id_negocio_padre)
            WHERE id_negocio_padre IS NOT NULL;
        `, { transaction: t });
        console.log('   OK\n');

        console.log('2. NIT: único entre matrices, repetible entre sedes...');
        if (await restriccionExiste('gener_negocio_nit_key', t)) {
            await sequelize.query(`
                ALTER TABLE general.gener_negocio DROP CONSTRAINT gener_negocio_nit_key;
            `, { transaction: t });
            console.log('   - gener_negocio_nit_key (UNIQUE (nit) a secas)');
        } else {
            console.log('   La restricción vieja ya no estaba.');
        }

        await sequelize.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS uq_gener_negocio_nit_matriz
            ON general.gener_negocio (nit)
            WHERE nit IS NOT NULL AND id_negocio_padre IS NULL;
        `, { transaction: t });
        console.log('   + uq_gener_negocio_nit_matriz\n');

        await t.commit();

        const [res] = await sequelize.query(`
            SELECT COUNT(*) FILTER (WHERE id_negocio_padre IS NULL) AS matrices,
                   COUNT(*) FILTER (WHERE id_negocio_padre IS NOT NULL) AS sedes
            FROM general.gener_negocio;
        `, { type: sequelize.QueryTypes.SELECT });
        console.log('=== Resultado ===');
        console.log(`   Matrices: ${res.matrices} · Sedes: ${res.sedes}`);
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
