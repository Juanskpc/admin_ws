/**
 * Restaurante — varias cajas por negocio (2026-09-22).
 *
 * ## Qué es una «caja» aquí
 *
 * Un **rubro de ingreso**, no un computador. Un restaurante grande que además tiene una
 * mini-tienda quiere ver la plata de la comida por un lado y la de la tienda por otro: dos cajas,
 * dos arqueos, dos cuentas de resultados. Que dos cajeros cobren a la vez desde equipos distintos
 * ya se podía —entran con su usuario y cobran contra el mismo turno—; lo que no se podía era
 * separar los ingresos.
 *
 * ## El lío de nombres que hay que deshacer
 *
 * Hasta hoy `rest_caja` NO era una caja: era un **turno** (apertura, cierre, montos, diferencia),
 * y el código asumía **uno solo abierto por negocio** (`requireCajaAbierta(idNegocio)`). Esta
 * migración mete el concepto que faltaba y deja los nombres en su sitio:
 *
 *   rest_punto_caja  → la caja de verdad: «Restaurante», «Tienda». Tiene nombre y dueños.
 *   rest_caja        → sigue siendo el turno, pero ahora cuelga de una caja.
 *   pedid_orden      → cada pedido nace con su caja: es lo que separa los rubros.
 *
 * ## Producción no cambia de comportamiento
 *
 * Cada negocio existente recibe **una** caja llamada «Caja principal», y todo lo que ya existe
 * —turnos, pedidos y usuarios— queda colgado de ella. Con una sola caja la app no pregunta nada
 * ni enseña selectores: se comporta exactamente como hoy. La segunda caja solo aparece el día que
 * el administrador la crea, y solo si su plan se lo permite (`app_core/helpers/limitesNegocio.js`).
 *
 * ## Un turno abierto por caja, no por negocio
 *
 * El índice único parcial sobre `(id_punto_caja) WHERE estado = 'A'` es lo que sustituye a la
 * comprobación que hoy hace el servicio en JavaScript. Con una caja por negocio la regla es la
 * misma de siempre; con dos, cada una abre y cierra su turno por separado, que es justo el punto.
 *
 * Idempotente: `IF NOT EXISTS`, `information_schema` antes de cada ALTER y `ON CONFLICT DO NOTHING`
 * en las siembras. Ejecutar con: npm run migrate:restaurante-cajas
 */
'use strict';
require('dotenv').config();

const db = require('../app_core/models/conection');
const sequelize = db.sequelize;

/** El módulo de restaurante. Los niveles y los negocios cuelgan de él. */
const MODULO_RESTAURANTE = 1;

/** El nombre de la caja que hereda todo lo que ya existe. */
const CAJA_PRINCIPAL = 'Caja principal';

async function existeColumna(esquema, tabla, columna, t) {
    const filas = await sequelize.query(
        `SELECT 1 FROM information_schema.columns
          WHERE table_schema = :esquema AND table_name = :tabla AND column_name = :columna
          LIMIT 1;`,
        { replacements: { esquema, tabla, columna }, transaction: t, type: sequelize.QueryTypes.SELECT }
    );
    return filas.length > 0;
}

async function migrate() {
    const t = await sequelize.transaction();
    try {
        console.log('→ Migración: varias cajas por negocio (restaurante)\n');

        // ── 1. La caja de verdad ─────────────────────────────────────────────────────────
        console.log('1. restaurante.rest_punto_caja...');
        await sequelize.query(
            `CREATE TABLE IF NOT EXISTS restaurante.rest_punto_caja (
                id_punto_caja  serial        PRIMARY KEY,
                id_negocio     integer       NOT NULL
                               REFERENCES general.gener_negocio(id_negocio) ON DELETE CASCADE,
                nombre         varchar(60)   NOT NULL,
                descripcion    varchar(160),
                orden          smallint      NOT NULL DEFAULT 0,
                estado         char(1)       NOT NULL DEFAULT 'A',
                creado_en      timestamp     NOT NULL DEFAULT now(),
                actualizado_en timestamp     NOT NULL DEFAULT now(),

                CONSTRAINT uq_rest_punto_caja_nombre UNIQUE (id_negocio, nombre),
                CONSTRAINT chk_rest_punto_caja_estado CHECK (estado IN ('A','I'))
            );
            COMMENT ON TABLE restaurante.rest_punto_caja IS
              'Rubro de ingreso del negocio (Restaurante, Tienda…). Cada una lleva sus turnos y su arqueo.';`,
            { transaction: t }
        );
        console.log('   lista.');

        // ── 2. Una caja principal para todo lo que ya existe ─────────────────────────────
        //
        // Se crea para cualquier negocio que ya tenga vida en restaurante (turnos o pedidos) y
        // para los que están dados de alta en el módulo. Así ningún negocio se queda sin caja y
        // la app nunca tiene que decidir qué hacer cuando no hay ninguna.
        console.log('2. «Caja principal» por negocio...');
        const creadas = await sequelize.query(
            `INSERT INTO restaurante.rest_punto_caja (id_negocio, nombre, descripcion, orden)
             SELECT n.id_negocio, :nombre, 'Creada al separar las cajas por rubro.', 0
               FROM general.gener_negocio n
              WHERE (n.id_tipo_negocio = :modulo
                     OR EXISTS (SELECT 1 FROM restaurante.rest_caja c WHERE c.id_negocio = n.id_negocio)
                     OR EXISTS (SELECT 1 FROM restaurante.pedid_orden o WHERE o.id_negocio = n.id_negocio))
             ON CONFLICT (id_negocio, nombre) DO NOTHING
             RETURNING id_negocio;`,
            {
                replacements: { nombre: CAJA_PRINCIPAL, modulo: MODULO_RESTAURANTE },
                transaction: t,
                type: sequelize.QueryTypes.SELECT,
            }
        );
        console.log(`   ${creadas.length} negocio(s) estrenan caja principal.`);

        // ── 3. El turno pasa a colgar de una caja ────────────────────────────────────────
        console.log('3. rest_caja.id_punto_caja...');
        if (await existeColumna('restaurante', 'rest_caja', 'id_punto_caja', t)) {
            console.log('   ya existía.');
        } else {
            await sequelize.query(
                `ALTER TABLE restaurante.rest_caja
                   ADD COLUMN id_punto_caja integer
                   REFERENCES restaurante.rest_punto_caja(id_punto_caja);`,
                { transaction: t }
            );
            await sequelize.query(
                `UPDATE restaurante.rest_caja c
                    SET id_punto_caja = p.id_punto_caja
                   FROM restaurante.rest_punto_caja p
                  WHERE p.id_negocio = c.id_negocio AND p.nombre = :nombre
                    AND c.id_punto_caja IS NULL;`,
                { replacements: { nombre: CAJA_PRINCIPAL }, transaction: t }
            );
            await sequelize.query(
                `ALTER TABLE restaurante.rest_caja ALTER COLUMN id_punto_caja SET NOT NULL;`,
                { transaction: t }
            );
            console.log('   añadida y rellenada.');
        }

        // Un turno abierto por caja. Sustituye a la comprobación que hoy vive en el servicio:
        // una carrera entre dos aperturas la resolvía la suerte, y esto la resuelve la base.
        const [[dobles]] = await sequelize.query(
            `SELECT COUNT(*)::int AS n FROM (
                 SELECT id_punto_caja FROM restaurante.rest_caja
                  WHERE estado = 'A' GROUP BY id_punto_caja HAVING COUNT(*) > 1
             ) x;`,
            { transaction: t }
        );
        if (dobles.n > 0) {
            throw new Error(
                `Hay ${dobles.n} caja(s) con más de un turno abierto. Ciérrelos antes de migrar.`
            );
        }
        await sequelize.query(
            `CREATE UNIQUE INDEX IF NOT EXISTS uq_rest_caja_turno_abierto
                 ON restaurante.rest_caja (id_punto_caja) WHERE estado = 'A';`,
            { transaction: t }
        );
        console.log('   un turno abierto por caja garantizado por la base.');

        // La regla vieja («un turno abierto por NEGOCIO») tiene que irse, o la segunda caja no
        // podría abrir nunca su turno mientras la primera tuviera el suyo. Se quita DESPUÉS de
        // crear la nueva para que el negocio no quede ni un instante sin ninguna de las dos.
        await sequelize.query(
            `DROP INDEX IF EXISTS restaurante.uq_rest_caja_abierta_por_negocio;`,
            { transaction: t }
        );
        console.log('   regla vieja «un turno por negocio» retirada.');

        // ── 4. Cada pedido nace con su caja ──────────────────────────────────────────────
        //
        // Es la columna que separa los rubros. NO se reutiliza `pedid_orden.id_caja`: esa apunta
        // al TURNO en el que se cobró el pedido y solo existe desde que se cobra. La caja se
        // elige al tomarlo, y los pedidos abiertos también tienen que saber a qué rubro van.
        console.log('4. pedid_orden.id_punto_caja...');
        if (await existeColumna('restaurante', 'pedid_orden', 'id_punto_caja', t)) {
            console.log('   ya existía.');
        } else {
            await sequelize.query(
                `ALTER TABLE restaurante.pedid_orden
                   ADD COLUMN id_punto_caja integer
                   REFERENCES restaurante.rest_punto_caja(id_punto_caja);`,
                { transaction: t }
            );
            await sequelize.query(
                `UPDATE restaurante.pedid_orden o
                    SET id_punto_caja = p.id_punto_caja
                   FROM restaurante.rest_punto_caja p
                  WHERE p.id_negocio = o.id_negocio AND p.nombre = :nombre
                    AND o.id_punto_caja IS NULL;`,
                { replacements: { nombre: CAJA_PRINCIPAL }, transaction: t }
            );
            await sequelize.query(
                `ALTER TABLE restaurante.pedid_orden ALTER COLUMN id_punto_caja SET NOT NULL;`,
                { transaction: t }
            );
            await sequelize.query(
                `CREATE INDEX IF NOT EXISTS ix_pedid_orden_punto_caja
                     ON restaurante.pedid_orden (id_punto_caja);`,
                { transaction: t }
            );
            console.log('   añadida, rellenada e indexada.');
        }

        // ── 5. Qué cajas puede usar cada usuario ─────────────────────────────────────────
        console.log('5. restaurante.rest_punto_caja_usuario...');
        await sequelize.query(
            `CREATE TABLE IF NOT EXISTS restaurante.rest_punto_caja_usuario (
                id_asignacion serial     PRIMARY KEY,
                id_punto_caja integer    NOT NULL
                              REFERENCES restaurante.rest_punto_caja(id_punto_caja) ON DELETE CASCADE,
                id_usuario    integer    NOT NULL
                              REFERENCES general.gener_usuario(id_usuario) ON DELETE CASCADE,
                id_negocio    integer    NOT NULL
                              REFERENCES general.gener_negocio(id_negocio) ON DELETE CASCADE,
                estado        char(1)    NOT NULL DEFAULT 'A',
                creado_en     timestamp  NOT NULL DEFAULT now(),

                CONSTRAINT uq_rest_punto_caja_usuario UNIQUE (id_punto_caja, id_usuario),
                CONSTRAINT chk_rest_pcu_estado CHECK (estado IN ('A','I'))
            );
            CREATE INDEX IF NOT EXISTS ix_rest_pcu_usuario
                ON restaurante.rest_punto_caja_usuario (id_usuario, id_negocio);
            COMMENT ON TABLE restaurante.rest_punto_caja_usuario IS
              'Cajas que puede usar cada usuario. Sin filas: solo puede usar la caja única del negocio, si la hay.';`,
            { transaction: t }
        );

        // La tabla nace VACÍA a propósito. «Sin asignación» significa «puede usar todas las
        // cajas activas» (ver puntoCajaService.cajasDeUsuario), así que sembrar una fila por
        // usuario no añadiría nada y sí quitaría: al crear la segunda caja, quien tuviera
        // asignada solo la primera no podría usar la nueva hasta que alguien lo repartiera a
        // mano. Lo natural es al revés — la caja nueva la ven todos, y se restringe después si
        // el negocio quiere. La asignación explícita es opt-in.
        console.log('   vacía: sin asignación = todas las cajas activas.');

        // ── 6. Permiso para gestionar cajas ──────────────────────────────────────────────
        //
        // Acción (tipo 4) colgada de CONFIGURACION. Se siembra en TRUE para los roles que ya
        // administran el negocio: un permiso nuevo que nadie tiene es un permiso que nadie usa,
        // y el administrador daría por hecho que la función no llegó.
        console.log('6. Permiso «gestionar cajas»...');
        const [vista] = await sequelize.query(
            `SELECT id_nivel FROM general.gener_nivel
              WHERE id_tipo_negocio = :modulo AND url = '/configuracion' AND id_tipo_nivel = 1
              LIMIT 1;`,
            { replacements: { modulo: MODULO_RESTAURANTE }, transaction: t, type: sequelize.QueryTypes.SELECT }
        );
        if (!vista) {
            console.log('   ⚠️  no se encontró la vista CONFIGURACION del módulo: permiso omitido.');
        } else {
            await sequelize.query(
                `INSERT INTO general.gener_nivel
                        (descripcion, url, id_tipo_nivel, id_nivel_padre, id_tipo_negocio, estado)
                 SELECT 'CAJAS - GESTIONAR', 'caja_gestionar', 4, :padre, :modulo, 'A'
                  WHERE NOT EXISTS (
                        SELECT 1 FROM general.gener_nivel
                         WHERE url = 'caja_gestionar' AND id_tipo_negocio = :modulo
                  );`,
                { replacements: { padre: vista.id_nivel, modulo: MODULO_RESTAURANTE }, transaction: t }
            );
            const [nivel] = await sequelize.query(
                `SELECT id_nivel FROM general.gener_nivel
                  WHERE url = 'caja_gestionar' AND id_tipo_negocio = :modulo LIMIT 1;`,
                { replacements: { modulo: MODULO_RESTAURANTE }, transaction: t, type: sequelize.QueryTypes.SELECT }
            );
            const roles = await sequelize.query(
                `INSERT INTO general.gener_rol_nivel (id_rol, id_nivel, estado)
                 SELECT r.id_rol, :idNivel, 'A'
                   FROM general.gener_rol r
                  WHERE r.id_tipo_negocio = :modulo
                    AND r.estado = 'A'
                    AND r.descripcion ILIKE '%ADMINISTRADOR%'
                    AND NOT EXISTS (
                          SELECT 1 FROM general.gener_rol_nivel rn
                           WHERE rn.id_rol = r.id_rol AND rn.id_nivel = :idNivel
                    )
                 RETURNING id_rol;`,
                {
                    replacements: { idNivel: nivel.id_nivel, modulo: MODULO_RESTAURANTE },
                    transaction: t,
                    type: sequelize.QueryTypes.SELECT,
                }
            );
            console.log(`   nivel ${nivel.id_nivel} creado y concedido a ${roles.length} rol(es) de administrador.`);
        }

        // ── 7. Auditoría ─────────────────────────────────────────────────────────────────
        //
        // Las dos tablas llevan estado y deciden acceso y dinero: quién creó una caja y a quién se
        // la asignaron es justo lo que se pregunta cuando un arqueo no cuadra.
        console.log('7. Triggers de auditoría...');
        const [[fn]] = await sequelize.query(
            `SELECT EXISTS (
                 SELECT 1 FROM information_schema.routines
                  WHERE routine_schema = 'auditoria' AND routine_name = 'fn_audit'
             ) AS ok;`,
            { transaction: t }
        );
        if (!fn.ok) {
            console.log('   ⚠️  auditoria.fn_audit no existe — triggers omitidos.');
        } else {
            for (const [tabla, pk] of [
                ['rest_punto_caja', 'id_punto_caja'],
                ['rest_punto_caja_usuario', 'id_asignacion'],
            ]) {
                await sequelize.query(`DROP TRIGGER IF EXISTS trg_audit ON restaurante.${tabla};`, {
                    transaction: t,
                });
                await sequelize.query(
                    `CREATE TRIGGER trg_audit
                         AFTER INSERT OR UPDATE OR DELETE ON restaurante.${tabla}
                         FOR EACH ROW EXECUTE FUNCTION auditoria.fn_audit('${pk}');`,
                    { transaction: t }
                );
                console.log(`   ✓ restaurante.${tabla}`);
            }
        }

        await t.commit();
        console.log('\n✅ Cajas por rubro listas. Cada negocio arranca con una: nada cambia hasta que cree la segunda.');
    } catch (err) {
        await t.rollback();
        console.error('\n❌ Error en la migración:', err.message);
        process.exitCode = 1;
    } finally {
        await sequelize.close();
    }
}

migrate();
