/**
 * Página pública del negocio («vitrina») del vertical `reserva`.
 *
 * Hasta ahora el flujo público existía a medias: había endpoints `/publico/...` y una ruta
 * `/p/:id_negocio` que solo listaba servicios. Lo que faltaba no era código de reserva sino
 * **lo que un cliente necesita para decidir**: quién es el negocio, dónde está, cómo se le
 * llama, qué ofrece y a qué hora hay hueco con cada profesional.
 *
 * Casi todo eso ya estaba en la base:
 *   - `general.gener_negocio` tiene `telefono`, `direccion`, `url_whatsapp`, `url_facebook`,
 *     `url_instagram`, `logo_url` y `colores` — columnas que existían y nadie estaba llenando.
 *   - `reserva.reserva_servicio.imagen_url` y `reserva.reserva_profesional.foto_url` ya existen.
 *
 * Esta migración añade solo lo que de verdad faltaba, en `reserva.reserva_config`:
 *
 *   - `descripcion_publica` — el texto de presentación del negocio. Va aquí y no en
 *     `gener_negocio` porque es **contenido del vertical**: lo que una barbería cuenta de sí
 *     misma en su página de reservas no es lo mismo que pondría en la carta de un restaurante.
 *     El teléfono y las redes sí son del negocio y por eso se quedan donde ya estaban.
 *
 *   - `publico_activo` — interruptor para publicar o esconder la página. Por defecto **true**:
 *     el negocio que ya tenía servicios activos venía siendo consultable por esos endpoints
 *     públicos desde el primer día, así que ponerlo en false «por seguridad» no protegería nada
 *     y sí apagaría de golpe algo que estaba funcionando.
 *
 * Y registra la acción `/configuracion/vitrina` para que el permiso de editar la página pública
 * se pueda dar o quitar por rol, como el resto.
 *
 * Idempotente.
 *
 *   npm run migrate:reserva-vitrina
 */
require('dotenv').config();
const { sequelize } = require('../app_core/models/conection');

const TIPO_NIVEL_ACCION = 4;

/** [url de la vista, url de la acción, etiqueta, roles que la reciben] */
const ACCIONES = [
    ['/configuracion', '/configuracion/vitrina', 'Editar la página pública', ['ADMINISTRADOR']],
];

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
        console.log('\n=== Migración: página pública del negocio (reserva) ===\n');

        console.log('1. Columnas en reserva.reserva_config...');
        if (!await columnaExiste('reserva', 'reserva_config', 'descripcion_publica', t)) {
            await sequelize.query(`
                ALTER TABLE reserva.reserva_config ADD COLUMN descripcion_publica TEXT;
            `, { transaction: t });
            console.log('   + descripcion_publica');
        } else {
            console.log('   = descripcion_publica ya existía');
        }

        if (!await columnaExiste('reserva', 'reserva_config', 'publico_activo', t)) {
            await sequelize.query(`
                ALTER TABLE reserva.reserva_config
                ADD COLUMN publico_activo BOOLEAN NOT NULL DEFAULT TRUE;
            `, { transaction: t });
            console.log('   + publico_activo (default TRUE)');
        } else {
            console.log('   = publico_activo ya existía');
        }

        // ── Acción de permiso ──
        console.log('\n2. Acción /configuracion/vitrina...');
        const [[tipo]] = await sequelize.query(`
            SELECT id_tipo_negocio FROM general.gener_tipo_negocio WHERE nombre = 'RESERVA';
        `, { transaction: t });
        if (!tipo) throw new Error('No existe el tipo RESERVA. Ejecuta antes `npm run migrate:reserva`.');
        const idTipo = tipo.id_tipo_negocio;

        const vistas = await sequelize.query(`
            SELECT id_nivel, url FROM general.gener_nivel
            WHERE id_tipo_negocio = :tipo AND id_tipo_nivel = 1 AND url IS NOT NULL;
        `, { replacements: { tipo: idTipo }, transaction: t, type: sequelize.QueryTypes.SELECT });
        const vistaPorUrl = new Map(vistas.map(v => [v.url, v.id_nivel]));

        for (const [urlVista, urlAccion, etiqueta] of ACCIONES) {
            const idPadre = vistaPorUrl.get(urlVista);
            if (!idPadre) { console.log(`   ⚠️  ${urlVista} no existe — se omite ${urlAccion}`); continue; }
            const [res] = await sequelize.query(`
                INSERT INTO general.gener_nivel
                    (descripcion, id_nivel_padre, icono, estado, id_tipo_nivel, url, id_tipo_negocio)
                SELECT :desc, :padre, NULL, 'A', :tn, :url, :tipo
                WHERE NOT EXISTS (
                    SELECT 1 FROM general.gener_nivel
                    WHERE id_tipo_negocio = :tipo AND id_tipo_nivel = :tn AND url = :url
                )
                RETURNING id_nivel;
            `, {
                replacements: { desc: etiqueta, padre: idPadre, url: urlAccion, tipo: idTipo, tn: TIPO_NIVEL_ACCION },
                transaction: t,
            });
            console.log(res.length > 0 ? `   + ${urlAccion}` : `   = ${urlAccion} ya existía`);
        }

        const accionesBD = await sequelize.query(`
            SELECT id_nivel, url FROM general.gener_nivel
            WHERE id_tipo_negocio = :tipo AND id_tipo_nivel = :tn;
        `, { replacements: { tipo: idTipo, tn: TIPO_NIVEL_ACCION }, transaction: t, type: sequelize.QueryTypes.SELECT });
        const accionPorUrl = new Map(accionesBD.map(a => [a.url, a.id_nivel]));

        const roles = await sequelize.query(`
            SELECT id_rol, descripcion FROM general.gener_rol
            WHERE id_tipo_negocio = :tipo AND estado = 'A';
        `, { replacements: { tipo: idTipo }, transaction: t, type: sequelize.QueryTypes.SELECT });
        const rolPorNombre = new Map(roles.map(r => [r.descripcion, r.id_rol]));

        console.log('\n3. Concediendo por rol...');
        let concedidas = 0;
        for (const [, urlAccion, , rolesConcedidos] of ACCIONES) {
            const idNivel = accionPorUrl.get(urlAccion);
            if (!idNivel) continue;
            for (const nombreRol of rolesConcedidos) {
                const idRol = rolPorNombre.get(nombreRol);
                if (!idRol) continue;
                const [res] = await sequelize.query(`
                    INSERT INTO general.gener_rol_nivel
                        (id_rol, id_nivel, puede_ver, puede_crear, puede_editar, puede_eliminar, estado)
                    VALUES (:rol, :nivel, true, false, false, false, 'A')
                    ON CONFLICT (id_rol, id_nivel) DO NOTHING
                    RETURNING id_rol;
                `, { replacements: { rol: idRol, nivel: idNivel }, transaction: t });
                concedidas += res.length;
            }
        }
        console.log(`   OK — ${concedidas} concesión(es) nuevas`);

        // Backfill por negocio: sin esto, un negocio con ajustes propios se quedaría sin la
        // acción nueva y ni el dueño podría editar su página.
        console.log('\n4. Backfill gener_nivel_negocio...');
        const [backfill] = await sequelize.query(`
            INSERT INTO general.gener_nivel_negocio
                (id_negocio, id_rol, id_nivel, puede_ver, estado, fecha_creacion, fecha_actualizacion)
            SELECT neg.id_negocio, rn.id_rol, rn.id_nivel, rn.puede_ver, 'A',
                   CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
            FROM general.gener_negocio neg
            JOIN general.gener_rol_nivel rn ON rn.estado = 'A'
            JOIN general.gener_nivel niv ON niv.id_nivel = rn.id_nivel
                                        AND niv.id_tipo_negocio = :tipo
                                        AND niv.id_tipo_nivel = :tn
                                        AND niv.url = '/configuracion/vitrina'
            WHERE neg.id_tipo_negocio = :tipo AND neg.estado = 'A'
            ON CONFLICT (id_negocio, id_rol, id_nivel) DO NOTHING
            RETURNING id_negocio;
        `, { replacements: { tipo: idTipo, tn: TIPO_NIVEL_ACCION }, transaction: t });
        console.log(`   OK — ${backfill.length} fila(s) nuevas`);

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
