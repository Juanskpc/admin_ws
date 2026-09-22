/**
 * Migración: horarios de restaurante — del negocio y de sus domiciliarios.
 *
 * ## Qué es esto, y por qué es la misma idea que ya existe en `reserva`
 *
 * `reserva.reserva_horario` ya resuelve exactamente este problema para esa vertical: una tabla
 * de franjas semanales (día + hora inicio + hora fin) donde `id_profesional IS NULL` es el
 * horario del NEGOCIO y `id_profesional = <id>` es el de una persona. Aquí es la misma forma,
 * con `id_usuario` en vez de `id_profesional` — para el negocio (NULL) y para cada domiciliario.
 *
 * **No se reutiliza la tabla de `reserva` a propósito.** Sería `restaurante` dependiendo del
 * esquema de otra vertical, y ADR-005 lo prohíbe: borrar `reserva` tiene que dejar `restaurante`
 * intacto (el «test del apagón»). Lo que se reutiliza es la FORMA, no la fila.
 *
 * ## Los dos usos, y por qué comparten una sola tabla
 *
 * 1. **Horario del negocio** (`id_usuario IS NULL`): decide si el bot dice «estamos cerrados»
 *    o «ya es hora pero el restaurante aún no ha abierto la caja» al querer tomar un pedido.
 * 2. **Horario de un domiciliario** (`id_usuario = <id>`): decide a quién asignarle un pedido a
 *    domicilio del bot cuando hay más de uno — al que esté EN TURNO ahora mismo, y solo si
 *    ninguno lo está, al azar entre todos (`pedidoService.elegirDomiciliarioAlAzar`).
 *
 * Son la misma pregunta —«¿quién/qué está activo ahora mismo?»— hecha sobre dos sujetos
 * distintos, y por eso es una tabla y no dos.
 *
 * ## Sin fila = sin restricción
 *
 * Un negocio que no ha configurado ningún horario **no queda cerrado por accidente**: la
 * ausencia total de horario del negocio se lee como «abierto siempre», igual que hoy. Obligar a
 * configurar horarios antes de que el bot siga funcionando habría apagado el asistente de
 * cualquier negocio que ya lo usa, sin que nadie lo pidiera. Lo mismo para domiciliarios: sin
 * horarios cargados, `elegirDomiciliarioAlAzar` sigue siendo puramente al azar, como hasta hoy.
 *
 * Aditiva e idempotente. NO destructiva. Ejecutar con:
 *   npm run migrate:restaurante-horario
 */
'use strict';
require('dotenv').config();
const db = require('../app_core/models/conection');
const sequelize = db.sequelize;

const URL_MODULO = '/horarios';

async function unaFila(sql, replacements, transaction) {
    const [filas] = await sequelize.query(sql, { replacements, transaction });
    return filas.length ? filas[0] : null;
}

async function migrate() {
    const t = await sequelize.transaction();
    try {
        console.log('→ Migración Restaurante — Horarios (negocio y domiciliarios)\n');

        const tipo = await unaFila(
            `SELECT id_tipo_negocio FROM general.gener_tipo_negocio
              WHERE estado = 'A' AND UPPER(nombre) LIKE '%RESTAURANTE%'
              ORDER BY id_tipo_negocio LIMIT 1;`,
            {},
            t,
        );
        if (!tipo) throw new Error('No se encontró el tipo de negocio RESTAURANTE.');
        const idTipoNegocio = Number(tipo.id_tipo_negocio);

        // ── 1. La tabla ────────────────────────────────────────────────────────────────
        console.log('1. Creando restaurante.rest_horario...');
        await sequelize.query(`
            CREATE TABLE IF NOT EXISTS restaurante.rest_horario (
                id_horario  SERIAL PRIMARY KEY,
                id_negocio  INTEGER NOT NULL
                    REFERENCES general.gener_negocio(id_negocio) ON DELETE CASCADE,
                -- NULL = horario del negocio. Con valor = horario de ESE usuario (domiciliario).
                id_usuario  INTEGER
                    REFERENCES general.gener_usuario(id_usuario) ON DELETE CASCADE,
                dia_semana  SMALLINT NOT NULL CHECK (dia_semana BETWEEN 0 AND 6), -- 0=Dom..6=Sáb
                hora_inicio TIME NOT NULL,
                hora_fin    TIME NOT NULL,
                CONSTRAINT ck_rest_horario_horas CHECK (hora_fin > hora_inicio)
            );
            CREATE INDEX IF NOT EXISTS ix_rest_horario_negocio
                ON restaurante.rest_horario (id_negocio, id_usuario, dia_semana);
        `, { transaction: t });
        console.log('   ✓');

        // ── 2. El módulo /horarios ────────────────────────────────────────────────────
        console.log('2. Sembrando el módulo /horarios...');
        const nivelRaiz = await unaFila(
            `SELECT id_nivel FROM general.gener_nivel
              WHERE id_tipo_negocio = :idTipoNegocio AND id_tipo_nivel = 1 AND url = '/restaurante'
              ORDER BY id_nivel LIMIT 1;`,
            { idTipoNegocio },
            t,
        );

        await sequelize.query(`
            INSERT INTO general.gener_nivel
                (descripcion, id_nivel_padre, icono, estado, id_tipo_nivel, id_tipo_negocio, url, fecha_creacion)
            SELECT 'HORARIOS', :idNivelPadre, 'clock', 'A', 1, :idTipoNegocio, :url, CURRENT_TIMESTAMP
            WHERE NOT EXISTS (
                SELECT 1 FROM general.gener_nivel
                WHERE id_tipo_negocio = :idTipoNegocio AND id_tipo_nivel = 1 AND url = :url
            );
        `, {
            replacements: {
                idTipoNegocio,
                url: URL_MODULO,
                idNivelPadre: nivelRaiz ? nivelRaiz.id_nivel : null,
            },
            transaction: t,
        });
        console.log('   ✓');

        // ── 3. Permisos: ADMINISTRADOR completo ──────────────────────────────────────
        //
        // Nace cerrado salvo para quien tiene que usarlo, igual que `/clientes`: es un módulo
        // nuevo, no hay nada que conservar. El dueño lo abre a quien más le convenga desde
        // Usuarios → Roles y permisos.
        console.log('3. Asignando permisos (ADMINISTRADOR completo)...');
        await sequelize.query(`
            INSERT INTO general.gener_rol_nivel
                (id_rol, id_nivel, puede_ver, puede_crear, puede_editar, puede_eliminar, estado, fecha_creacion, fecha_actualizacion)
            SELECT r.id_rol, nv.id_nivel, true, true, true, true, 'A', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
            FROM general.gener_rol r
            JOIN general.gener_nivel nv
              ON nv.id_tipo_negocio = r.id_tipo_negocio
             AND nv.estado = 'A'
             AND nv.url = :url
            WHERE r.id_tipo_negocio = :idTipoNegocio
              AND r.estado = 'A'
              AND UPPER(r.descripcion) = 'ADMINISTRADOR'
            ON CONFLICT (id_rol, id_nivel) DO NOTHING;
        `, { replacements: { idTipoNegocio, url: URL_MODULO }, transaction: t });
        console.log('   ✓');

        // ── 4. Los negocios que ya existen ────────────────────────────────────────────
        //
        // `gener_nivel_negocio` manda sobre la visibilidad cuando el negocio tiene ajustes
        // propios. Un restaurante que ya los tenga NO vería el módulo nuevo por no tener fila
        // aquí — la trampa ya documentada en `/clientes` y `/control-inventario`.
        console.log('4. Backfill de gener_nivel_negocio para los restaurantes existentes...');
        await sequelize.query(`
            INSERT INTO general.gener_nivel_negocio
                (id_negocio, id_rol, id_nivel, puede_ver, estado, fecha_creacion, fecha_actualizacion)
            SELECT n.id_negocio, rn.id_rol, rn.id_nivel, rn.puede_ver, 'A',
                   CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
            FROM general.gener_negocio n
            JOIN general.gener_nivel nv
              ON nv.id_tipo_negocio = n.id_tipo_negocio
             AND nv.estado = 'A'
             AND nv.url = :url
            JOIN general.gener_rol_nivel rn
              ON rn.id_nivel = nv.id_nivel
             AND rn.estado = 'A'
            WHERE n.estado = 'A'
              AND n.id_tipo_negocio = :idTipoNegocio
              AND EXISTS (
                  SELECT 1 FROM general.gener_nivel_negocio nn WHERE nn.id_negocio = n.id_negocio
              )
            ON CONFLICT (id_negocio, id_rol, id_nivel) DO NOTHING;
        `, { replacements: { idTipoNegocio, url: URL_MODULO }, transaction: t });
        console.log('   ✓');

        await t.commit();
        console.log('\n✓ Migración de horarios completada.');
    } catch (error) {
        await t.rollback();
        console.error('\nError en la migración:', error.message);
        process.exitCode = 1;
    } finally {
        await sequelize.close();
    }
}

migrate();
