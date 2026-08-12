/**
 * F4-B — Clave de idempotencia de las invocaciones de capacidad (ADR-010).
 *
 * Ejecutar con:
 *   npm run migrate:platform-idempotencia
 *
 * ## Para qué
 *
 * Criterio de aceptación de F4: «ejecutar dos veces la misma capacidad con la misma clave de
 * idempotencia produce **una sola** cita».
 *
 * El problema no es teórico. Un canal conversacional reintenta: el webhook se entrega dos
 * veces, el cliente pulsa dos veces, el relay reenvía. Sin esta tabla, «sí, confírmame la
 * cita» ejecutado dos veces crea dos citas — y la segunda ni siquiera falla por solape,
 * porque la primera ya ocupó el hueco y el cliente vería un error donde debería ver su cita.
 *
 * ## La clave NO es un parámetro del modelo
 *
 * Viaja en el sobre de la invocación, junto a `dryRun`, no en `parametros`. Si el modelo
 * pudiera elegirla, podría cambiarla en el reintento y romper justo la garantía que aporta.
 * En F5 la clave natural es el identificador del turno de conversación.
 *
 * ## Por qué se guarda el resultado y no solo la clave
 *
 * Un reintento tiene que recibir **la misma respuesta**, no un «ya lo hiciste». Para quien
 * llama, la segunda invocación debe ser indistinguible de la primera: ésa es la definición
 * de idempotente. Guardar solo la clave obligaría a inventarse la respuesta.
 */
require('dotenv').config();
const db = require('../app_core/models/conection');
const sequelize = db.sequelize;

async function migrate() {
    const t = await sequelize.transaction();

    try {
        console.log('→ Migración F4-B: platform.capacidad_idempotencia\n');

        const [schema] = await sequelize.query(
            `SELECT 1 FROM information_schema.schemata WHERE schema_name = 'platform';`,
            { type: sequelize.QueryTypes.SELECT, transaction: t }
        );
        if (!schema) {
            throw new Error('Falta el esquema platform. Ejecuta antes: npm run migrate:platform-persona');
        }

        console.log('1. Tabla platform.capacidad_idempotencia...');
        await sequelize.query(
            `
            CREATE TABLE IF NOT EXISTS platform.capacidad_idempotencia (
                id_negocio integer NOT NULL
                           REFERENCES general.gener_negocio(id_negocio) ON DELETE CASCADE,
                capacidad  varchar(80) NOT NULL,
                clave      varchar(120) NOT NULL,
                resultado  jsonb NOT NULL,
                creado_en  timestamptz NOT NULL DEFAULT now(),
                -- La PK ES la garantía: dos invocaciones concurrentes con la misma clave
                -- compiten por esta clave primaria y solo una gana el INSERT. La otra recibe
                -- una violación de unicidad, que el Gate traduce en «devuelve lo que guardó
                -- la ganadora». No hace falta ningún lock adicional.
                --
                -- La clave incluye la capacidad: el mismo turno de conversación puede
                -- invocar consultar_disponibilidad y luego reservar_turno, y son cosas
                -- distintas aunque compartan identificador de turno.
                PRIMARY KEY (id_negocio, capacidad, clave)
            );
            `,
            { transaction: t }
        );
        console.log('   OK\n');

        console.log('2. Índice para la purga por antigüedad...');
        // Estas filas caducan: una clave de hace un mes no la va a reintentar nadie. El
        // índice existe para poder borrarlas sin escanear la tabla entera el día que estorbe.
        await sequelize.query(
            `
            CREATE INDEX IF NOT EXISTS idx_idempotencia_creado_en
                ON platform.capacidad_idempotencia (creado_en);
            `,
            { transaction: t }
        );
        console.log('   OK\n');

        console.log('3. Comentarios...');
        await sequelize.query(
            `
            COMMENT ON TABLE platform.capacidad_idempotencia IS
            'Resultado de una invocación de capacidad con clave de idempotencia (ADR-010). '
            'Un reintento con la misma clave devuelve ESTE resultado sin volver a ejecutar. '
            'La clave viaja en el sobre de la invocación, nunca en los parámetros del modelo.';
            `,
            { transaction: t }
        );
        console.log('   OK\n');

        await t.commit();
        console.log('✓ platform.capacidad_idempotencia creada.\n');
    } catch (error) {
        await t.rollback();
        console.error('\nError en la migración:', error.message);
        process.exitCode = 1;
    } finally {
        await sequelize.close();
    }
}

migrate();
