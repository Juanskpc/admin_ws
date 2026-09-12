/**
 * TikTok en las redes del negocio + el teléfono con indicativo de país (vertical `reserva`).
 *
 * Dos cambios que llegan juntos porque los pidió la misma tarde, y uno de ellos es sobre todo
 * un arreglo de datos:
 *
 * 1. **`general.gener_negocio.url_tiktok`** — la cuarta red. Va junto a `url_facebook` y
 *    `url_instagram` y no en `reserva_config` por el mismo motivo que aquéllas: el perfil de
 *    TikTok es del negocio, no del vertical, y un restaurante lo querrá igual que un salón.
 *
 * 2. **El teléfono deja de estar en dos sitios a la vez.** `general.gener_usuario.telefono` y
 *    `reserva.reserva_profesional.telefono` guardaban la misma persona por separado: se
 *    escribía en Usuarios y la ficha de la agenda seguía vacía, así que el portal público no
 *    tenía número con el que armar el botón de WhatsApp. A partir de ahora el servicio propaga
 *    en las dos direcciones; aquí se arregla lo que ya está escrito.
 *
 * 3. **Los números se guardan en E.164** (`+573188887013`), que es lo que `wa.me` necesita.
 *    Un `3188887013` suelto abre un chat con un número que no existe. La normalización usa
 *    `app_core/helpers/telefono.js` —la misma que el camino de escritura— con el país del
 *    negocio, y **solo escribe cuando el número se reconoce**: un fijo o un número mal
 *    apuntado se queda como está en vez de convertirse en basura con un '+' delante.
 *
 * Idempotente: la columna se comprueba antes de crearla y renormalizar un número ya en E.164
 * devuelve el mismo valor.
 *
 *   npm run migrate:reserva-tiktok-telefono
 */
require('dotenv').config();
const { sequelize } = require('../app_core/models/conection');
const { normalizarE164 } = require('../app_core/helpers/telefono');

async function columnaExiste(esquema, tabla, columna, t) {
    const [filas] = await sequelize.query(`
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = :esquema AND table_name = :tabla AND column_name = :columna;
    `, { replacements: { esquema, tabla, columna }, transaction: t });
    return filas.length > 0;
}

async function migrar() {
    const t = await sequelize.transaction();
    try {
        console.log('\n=== Migración: TikTok + teléfono con indicativo (reserva) ===\n');

        // ── 1. La columna de TikTok ──
        console.log('1. general.gener_negocio.url_tiktok...');
        if (!await columnaExiste('general', 'gener_negocio', 'url_tiktok', t)) {
            await sequelize.query(`
                ALTER TABLE general.gener_negocio ADD COLUMN url_tiktok VARCHAR(300);
            `, { transaction: t });
            console.log('   + url_tiktok');
        } else {
            console.log('   = url_tiktok ya existía');
        }

        // ── 2. La ficha de agenda hereda el contacto de su usuario ──
        //
        // Solo donde la ficha está vacía: si alguien escribió un número distinto en la ficha,
        // es un dato que no estaba en el usuario y machacarlo sería perderlo.
        console.log('\n2. Teléfono y email del usuario → su ficha de profesional...');
        const [heredados] = await sequelize.query(`
            UPDATE reserva.reserva_profesional p
               SET telefono = COALESCE(p.telefono, u.telefono),
                   email    = COALESCE(p.email, u.email),
                   fecha_actualizacion = CURRENT_TIMESTAMP
              FROM general.gener_usuario u
             WHERE u.id_usuario = p.id_usuario
               AND (
                    (p.telefono IS NULL AND u.telefono IS NOT NULL) OR
                    (p.email    IS NULL AND u.email    IS NOT NULL)
                   )
            RETURNING p.id_profesional;
        `, { transaction: t });
        console.log(`   OK — ${heredados.length} ficha(s) completadas`);

        // ── 3. Normalización a E.164 ──
        //
        // En JS y no en SQL: las reglas de qué es un móvil en cada país viven en
        // `helpers/paises.js`, y reescribirlas aquí en PL/pgSQL sería la copia que se
        // desincroniza. Solo alcanza a los negocios del vertical RESERVA: es donde el número
        // se usa para escribir por WhatsApp, y tocar los teléfonos de toda la plataforma en
        // una migración de reserva sería pasarse de largo.
        console.log('\n3. Normalizando a E.164 (solo negocios de RESERVA)...');

        const usuarios = await sequelize.query(`
            SELECT DISTINCT u.id_usuario, u.telefono, COALESCE(n.pais, 'CO') AS pais
              FROM general.gener_usuario u
              JOIN general.gener_negocio_usuario nu ON nu.id_usuario = u.id_usuario
              JOIN general.gener_negocio n          ON n.id_negocio = nu.id_negocio
              JOIN general.gener_tipo_negocio tn    ON tn.id_tipo_negocio = n.id_tipo_negocio
             WHERE tn.nombre = 'RESERVA'
               AND u.telefono IS NOT NULL
               AND u.telefono <> ''
               AND u.telefono NOT LIKE '+%';
        `, { transaction: t, type: sequelize.QueryTypes.SELECT });

        let convertidos = 0, intactos = 0;
        for (const u of usuarios) {
            const e164 = normalizarE164(u.telefono, u.pais);
            if (!e164) { intactos++; continue; }
            await sequelize.query(`
                UPDATE general.gener_usuario SET telefono = :tel WHERE id_usuario = :id;
            `, { replacements: { tel: e164, id: u.id_usuario }, transaction: t });
            convertidos++;
        }
        console.log(`   Usuarios: ${convertidos} convertido(s), ${intactos} sin tocar (no se reconocen como móvil)`);

        const fichas = await sequelize.query(`
            SELECT p.id_profesional, p.telefono, COALESCE(n.pais, 'CO') AS pais
              FROM reserva.reserva_profesional p
              JOIN general.gener_negocio n ON n.id_negocio = p.id_negocio
             WHERE p.telefono IS NOT NULL
               AND p.telefono <> ''
               AND p.telefono NOT LIKE '+%';
        `, { transaction: t, type: sequelize.QueryTypes.SELECT });

        let convertidasF = 0, intactasF = 0;
        for (const f of fichas) {
            const e164 = normalizarE164(f.telefono, f.pais);
            if (!e164) { intactasF++; continue; }
            await sequelize.query(`
                UPDATE reserva.reserva_profesional
                   SET telefono = :tel, fecha_actualizacion = CURRENT_TIMESTAMP
                 WHERE id_profesional = :id;
            `, { replacements: { tel: e164, id: f.id_profesional }, transaction: t });
            convertidasF++;
        }
        console.log(`   Fichas:   ${convertidasF} convertida(s), ${intactasF} sin tocar`);

        await t.commit();
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
