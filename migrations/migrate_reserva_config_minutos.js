/**
 * Reglas de reserva en MINUTOS y nuevos valores por defecto (2026-09-29).
 *
 * - `anticipacion_min_minutos` (default 15) sustituye a `anticipacion_min_horas`.
 * - `ventana_cancelacion_min`  (default 60) sustituye a `ventana_cancelacion_horas`.
 * - `buffer_limpieza_min` («Tiempo de limpieza») pasa a default 0.
 *
 * Los negocios que ya existen NO cambian de regla: al crear cada columna se rellena con
 * horas × 60. Ese relleno se hace **solo en el momento de crearla**: repetirlo después del
 * despliegue convertiría unos 15 minutos nuevos en 60 (a partir del espejo en horas, que se
 * redondea hacia arriba). Por eso cada columna se comprueba antes en `information_schema`.
 *
 * Las columnas viejas en horas se quedan (el modelo las mantiene como espejo) para que volver
 * al backend anterior no rompa nada. Sus defaults también se ajustan a los nuevos valores.
 *
 * Idempotente. Correr ANTES de desplegar el backend que las lee.
 *
 *   npm run migrate:reserva-config-minutos
 */
require('dotenv').config();
const { sequelize } = require('../app_core/models/conection');

const COLUMNAS = [
    { nueva: 'anticipacion_min_minutos', vieja: 'anticipacion_min_horas', porDefecto: 15 },
    { nueva: 'ventana_cancelacion_min', vieja: 'ventana_cancelacion_horas', porDefecto: 60 },
];

async function existe(columna, t) {
    const [[fila]] = await sequelize.query(`
        SELECT 1 AS si FROM information_schema.columns
         WHERE table_schema = 'reserva' AND table_name = 'reserva_config' AND column_name = :columna;
    `, { replacements: { columna }, transaction: t });
    return Boolean(fila);
}

async function migrar() {
    const t = await sequelize.transaction();
    try {
        console.log('\n=== Migración: reglas de reserva en minutos ===\n');

        for (const { nueva, vieja, porDefecto } of COLUMNAS) {
            if (await existe(nueva, t)) {
                console.log(`· ${nueva} ya existe: no se rellena otra vez.`);
                continue;
            }
            await sequelize.query(
                `ALTER TABLE reserva.reserva_config ADD COLUMN ${nueva} INTEGER NOT NULL DEFAULT ${porDefecto};`,
                { transaction: t },
            );
            const [, meta] = await sequelize.query(
                `UPDATE reserva.reserva_config SET ${nueva} = ${vieja} * 60;`,
                { transaction: t },
            );
            console.log(`· ${nueva} creada (default ${porDefecto}) y rellenada desde ${vieja}: ${meta?.rowCount ?? '?'} negocio(s).`);
        }

        // Defaults para las filas que nazcan por SQL crudo (la app ya usa los del modelo).
        await sequelize.query(`
            ALTER TABLE reserva.reserva_config ALTER COLUMN buffer_limpieza_min SET DEFAULT 0;
            ALTER TABLE reserva.reserva_config ALTER COLUMN ventana_cancelacion_horas SET DEFAULT 1;
        `, { transaction: t });
        console.log('· Defaults: tiempo de limpieza 0, espejo de ventana 1 h.');

        await t.commit();
        console.log('\nListo.\n');
    } catch (err) {
        await t.rollback();
        console.error('\nError, se revirtió todo:', err.message);
        process.exitCode = 1;
    } finally {
        await sequelize.close();
    }
}

migrar();
