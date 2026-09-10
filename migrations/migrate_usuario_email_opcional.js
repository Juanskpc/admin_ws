/**
 * El **correo deja de ser obligatorio** en `general.gener_usuario`.
 *
 * Quien identifica a una persona al entrar es su documento: el login recibe
 * `num_identificacion` y una contraseña, y el email no participa. Exigirlo al dar de alta a un
 * empleado tenía dos finales posibles, los dos malos: dejar fuera a quien no usa correo —lo
 * normal en la plantilla de un salón o una barbería— o inventarle una dirección falsa que
 * después ocupa el índice único y hace fallar el alta del siguiente.
 *
 * Se cambia solo la **nulabilidad**. El índice único se mantiene tal cual: en PostgreSQL un
 * UNIQUE admite tantos NULL como haga falta, así que dos usuarios sin correo conviven, y dos
 * con el mismo correo siguen sin poder.
 *
 * No se toca ninguna fila: los usuarios que ya tienen email lo conservan. Lo que sí queda
 * fuera de servicio para quien no lo tenga es el «olvidé mi contraseña» por correo — sin
 * dirección no hay a dónde enviarlo. El restablecimiento desde la consola sigue funcionando,
 * que es como se resuelve hoy en el vertical de reservas.
 *
 * Idempotente: comprueba `information_schema` antes del ALTER y no hace nada si ya está.
 *
 *   npm run migrate:usuario-email-opcional
 */
require('dotenv').config();
const { sequelize } = require('../app_core/models/conection');

async function migrar() {
    const t = await sequelize.transaction();
    try {
        console.log('\n=== Migración: email opcional en general.gener_usuario ===\n');

        const [[columna]] = await sequelize.query(`
            SELECT is_nullable
            FROM information_schema.columns
            WHERE table_schema = 'general' AND table_name = 'gener_usuario' AND column_name = 'email';
        `, { transaction: t });

        if (!columna) throw new Error('No existe general.gener_usuario.email. Revisa la base.');

        if (columna.is_nullable === 'YES') {
            console.log('1. La columna ya admite NULL — nada que hacer.\n');
        } else {
            console.log('1. Quitando el NOT NULL...');
            await sequelize.query(`
                ALTER TABLE general.gener_usuario ALTER COLUMN email DROP NOT NULL;
            `, { transaction: t });
            console.log('   OK\n');
        }

        await t.commit();

        const [[estado]] = await sequelize.query(`
            SELECT c.is_nullable,
                   (SELECT count(*) FROM general.gener_usuario WHERE email IS NULL) AS sin_email
            FROM information_schema.columns c
            WHERE c.table_schema = 'general' AND c.table_name = 'gener_usuario'
              AND c.column_name = 'email';
        `);

        console.log('=== Resultado ===');
        console.log(`   email admite NULL: ${estado.is_nullable === 'YES' ? 'sí' : 'NO'}`);
        console.log(`   usuarios sin correo: ${estado.sin_email}`);
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
