/**
 * Registro de migraciones aplicadas — `general.gener_migracion`.
 *
 * ## Qué problema resuelve
 *
 * Hay **132 migraciones**, cada una con su propio script en `package.json`, todas idempotentes
 * y ninguna registrada en ninguna parte. Eso deja una pregunta sin respuesta posible:
 * *¿esta base tiene aplicada `migrate_reserva_asesoria`?* Hoy solo se puede contestar mirando a
 * mano si existe la columna que esa migración añade — y hay que saber cuál es.
 *
 * De ahí sale el «drift de entorno» que `CLAUDE.md` ya nombra como sospecha habitual cuando
 * local y producción no se parecen. Lo paga sobre todo el despliegue: la nota de
 * `docs/despliegue-pendiente-2026-09-24.md` avisa de cuatro migraciones que van ANTES del
 * backend y en un orden fijo, y la única garantía de que se corrieron es que alguien se acuerde.
 *
 * ## Por qué una tabla y no un gestor de migraciones de verdad
 *
 * Porque las 132 ya existen, son idempotentes y funcionan. Reescribirlas para Umzug o
 * `sequelize-cli` es un proyecto con riesgo real y cero ganancia funcional. Esto solo añade la
 * pieza que falta —la memoria— sin tocar ni una de las migraciones existentes: el que las corre
 * es `scripts/migrar.js`, que las lanza como proceso hijo y apunta el resultado.
 *
 * ## Sin trigger de auditoría, a propósito
 *
 * La regla fija del repo es que una tabla con dinero o estado lleva su `trg_audit` en la misma
 * migración. Esta no lo lleva porque **es ella misma el registro**: cada fila ya dice qué se
 * aplicó, cuándo y cuánto tardó, y auditar una bitácora con otra bitácora no añade nada.
 */
require('dotenv').config();
const db = require('../app_core/models/conection');
const sequelize = db.sequelize;

async function migrate() {
    const t = await sequelize.transaction();
    try {
        console.log('Creando el registro de migraciones...\n');

        await sequelize.query(
            `
            CREATE TABLE IF NOT EXISTS general.gener_migracion (
                id_migracion   SERIAL PRIMARY KEY,
                -- El nombre del script SIN el prefijo ni la extensión, como se escribe en
                -- "npm run migrate:<nombre>": 'restaurante-cajas', no
                -- 'migrate_restaurante_cajas.js'. Es la forma que usa una persona.
                nombre         VARCHAR(150) NOT NULL UNIQUE,
                -- Hora de pared de Bogotá, como todo el resto del esquema.
                aplicada_en    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                duracion_ms    INTEGER,
                -- 'aplicada'  → la corrió el runner y terminó bien.
                -- 'registrada' → se marcó sin correrla, al adoptar el registro en una base que
                --                ya las tenía todas. La distinción importa: 'registrada' es una
                --                afirmación de una persona, no una comprobación.
                origen         VARCHAR(20) NOT NULL DEFAULT 'aplicada',
                -- Quién la corrió, para saber a quién preguntar. Usuario del sistema operativo,
                -- no un id de la plataforma: esto se ejecuta desde una consola, no desde la app.
                ejecutada_por  VARCHAR(100),
                notas          TEXT
            );
            `,
            { transaction: t }
        );
        console.log('   ✓ general.gener_migracion');

        // Consultar `information_schema` antes de cualquier ALTER es la regla del repo; aquí la
        // tabla se acaba de crear con sus columnas, así que no hay ALTER que guardar.
        await sequelize.query(
            `CREATE INDEX IF NOT EXISTS idx_gener_migracion_aplicada
                 ON general.gener_migracion (aplicada_en DESC);`,
            { transaction: t }
        );
        console.log('   ✓ índice por fecha');

        await t.commit();
        console.log(
            '\n✅ Registro listo.\n' +
            '   Siguiente paso en una base que YA tiene las migraciones aplicadas:\n' +
            '     node scripts/migrar.js --adoptar\n' +
            '   Y para ver el estado en cualquier momento:\n' +
            '     node scripts/migrar.js --estado\n'
        );
    } catch (err) {
        await t.rollback();
        console.error('\n❌ Error en la migración:', err.message);
        process.exitCode = 1;
    } finally {
        await sequelize.close();
    }
}

migrate();
