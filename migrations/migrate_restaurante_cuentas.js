/**
 * Migración: Cuentas de cliente del restaurante — tiqueteras y fiado.
 *
 * ## Qué es esto
 *
 * En Colombia es corriente que un cliente de confianza **pague por adelantado** la comida del
 * mes (la «tiquetera») o que **coma y pague al final** (el fiado). Las dos cosas son el mismo
 * objeto con el signo cambiado: una cuenta con un saldo.
 *
 *   saldo > 0  → el cliente tiene comida pagada por delante (tiquetera)
 *   saldo < 0  → el cliente le debe al restaurante (fiado), hasta el `cupo`
 *
 * Por eso hay UNA tabla de cuentas y no dos módulos.
 *
 * ## Dos unidades, una sola contabilidad
 *
 * Hay negocios que llevan la tiquetera **en plata** («abonó $400.000») y otros **en tiquetes**
 * («compró 20 almuerzos»). Los tiquetes protegen al cliente si sube el precio; la plata aguanta
 * que pida un almuerzo, una gaseosa y un postre.
 *
 * Se soportan las dos, pero **no como dos contabilidades en paralelo**: es un único libro de
 * movimientos donde cada apunte puede estar expresado en pesos o en tiquetes de un producto.
 * El saldo siempre es la suma de ese libro, nunca un número guardado aparte — así no puede
 * desajustarse, y quién hizo qué queda escrito.
 *
 * `rest_cuenta.modo` decide en qué unidad trabaja ese cliente, y solo se puede cambiar con los
 * dos saldos en cero: cambiarlo con saldo vivo dejaría plata o tiquetes varados sin poder
 * gastarse.
 *
 * ## La plata no se cuenta dos veces (lo importante)
 *
 * Los informes calculan las ventas desde `pedid_orden.total`, y la caja calcula el efectivo
 * desde `rest_movimiento_caja`. La tiquetera rompe la equivalencia «pedido = venta = plata»
 * porque el dinero entra un día y la comida sale otro. El reparto queda así:
 *
 *   Vender tiquetera / recibir abono → INGRESO en caja, SIN pedido    → entra plata, no es venta
 *   Consumir (comer con la cuenta)   → pedido normal, INGRESO+EGRESO  → es venta, no mueve el cajón
 *
 * El segundo es literalmente el mismo truco que ya usa el cobro del domicilio: ingreso y egreso
 * se anulan, el pedido sigue apareciendo en el turno y el arqueo no se entera. Sin eso, al
 * cajero le faltaría plata en el cuadre todos los días y nadie sabría por qué.
 *
 * ## Qué crea
 *
 *   1. restaurante.rest_cuenta              — una por (negocio, cliente)
 *   2. restaurante.rest_cuenta_movimiento   — el libro: abonos y cargos
 *   3. rest_metodo_pago.es_cuenta           — marca la forma de pago «Cuenta / Tiquetera»
 *   4. rest_movimiento_caja.id_metodo_pago  — para saber si el abono entró en efectivo o no
 *   5. El módulo /clientes y sus dos subniveles, con permisos por rol
 *
 * Aditiva e idempotente. NO destructiva. Ejecutar con:
 *   npm run migrate:restaurante-cuentas
 */
require('dotenv').config();
const db = require('../app_core/models/conection');

const sequelize = db.sequelize;

const URL_MODULO = '/clientes';
const SUBNIVELES = [
    {
        codigo: 'clientes_abonar',
        descripcion: 'CLIENTES - VENDER TIQUETERA Y RECIBIR ABONOS',
    },
    {
        codigo: 'clientes_ajustar',
        descripcion: 'CLIENTES - AJUSTAR SALDO Y PERDONAR DEUDA',
    },
];

async function unaFila(sql, replacements, transaction) {
    const [filas] = await sequelize.query(sql, { replacements, transaction });
    return filas.length ? filas[0] : null;
}

async function migrate() {
    const t = await sequelize.transaction();
    try {
        console.log('→ Migración Restaurante — Cuentas de cliente (tiqueteras y fiado)\n');

        const tipo = await unaFila(
            `SELECT id_tipo_negocio FROM general.gener_tipo_negocio
              WHERE estado = 'A' AND UPPER(nombre) LIKE '%RESTAURANTE%'
              ORDER BY id_tipo_negocio LIMIT 1;`,
            {},
            t,
        );
        if (!tipo) throw new Error('No se encontró el tipo de negocio RESTAURANTE.');
        const idTipoNegocio = Number(tipo.id_tipo_negocio);

        // ── 1. La cuenta ────────────────────────────────────────────────────────────────
        console.log('1. Creando restaurante.rest_cuenta...');
        await sequelize.query(`
            CREATE TABLE IF NOT EXISTS restaurante.rest_cuenta (
                id_cuenta           SERIAL PRIMARY KEY,
                id_negocio          INTEGER NOT NULL
                    REFERENCES general.gener_negocio(id_negocio) ON DELETE RESTRICT,
                -- El cliente es platform.persona_negocio: la misma ficha que ya usan los
                -- pedidos y el asistente de WhatsApp (ADR-006). No se inventa otro «cliente».
                id_persona_negocio  UUID NOT NULL,
                modo                VARCHAR(10) NOT NULL DEFAULT 'DINERO'
                    CHECK (modo IN ('DINERO', 'TIQUETES')),
                -- Hasta cuánto puede deber. 0 = no se le fía (solo prepago).
                cupo                NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (cupo >= 0),
                estado              CHAR(1) NOT NULL DEFAULT 'A',
                nota                TEXT,
                fecha_creacion      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                fecha_actualizacion TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                -- Una sola cuenta por cliente y negocio. Dos cuentas del mismo cliente serían
                -- dos saldos que nadie sabría sumar.
                CONSTRAINT uq_rest_cuenta_negocio_persona UNIQUE (id_negocio, id_persona_negocio)
            );
            CREATE INDEX IF NOT EXISTS ix_rest_cuenta_negocio
                ON restaurante.rest_cuenta (id_negocio, estado);
        `, { transaction: t });
        console.log('   ✓');

        // ── 2. El libro de movimientos ──────────────────────────────────────────────────
        console.log('2. Creando restaurante.rest_cuenta_movimiento...');
        await sequelize.query(`
            CREATE TABLE IF NOT EXISTS restaurante.rest_cuenta_movimiento (
                id_movimiento       SERIAL PRIMARY KEY,
                id_cuenta           INTEGER NOT NULL
                    REFERENCES restaurante.rest_cuenta(id_cuenta) ON DELETE RESTRICT,
                -- Redundante con la cuenta a propósito: TODA consulta se acota por negocio
                -- (ADR-002), y tener la columna aquí evita un JOIN en cada una de ellas.
                id_negocio          INTEGER NOT NULL,
                tipo                VARCHAR(10) NOT NULL CHECK (tipo IN ('ABONO', 'CARGO')),
                -- Los importes se guardan SIEMPRE en positivo y el signo lo pone la columna tipo,
                -- igual que en rest_movimiento_caja. Un mismo apunte no mezcla unidades:
                -- o mueve plata, o mueve tiquetes.
                monto               NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (monto >= 0),
                tiquetes            INTEGER NOT NULL DEFAULT 0 CHECK (tiquetes >= 0),
                id_producto         INTEGER
                    REFERENCES restaurante.carta_producto(id_producto) ON DELETE RESTRICT,
                -- El pedido que lo consumió (en un CARGO) — NULL en abonos y ajustes.
                id_orden            INTEGER
                    REFERENCES restaurante.pedid_orden(id_orden) ON DELETE RESTRICT,
                -- El turno donde entró la plata (en un ABONO cobrado en caja).
                id_caja             INTEGER
                    REFERENCES restaurante.rest_caja(id_caja) ON DELETE RESTRICT,
                id_usuario          INTEGER NOT NULL
                    REFERENCES general.gener_usuario(id_usuario) ON DELETE RESTRICT,
                concepto            VARCHAR(255),
                -- La reversa de otro apunte. Nada se borra nunca: se compensa, igual que en
                -- caja, para que el histórico del cliente siga siendo auditable.
                id_movimiento_anula INTEGER
                    REFERENCES restaurante.rest_cuenta_movimiento(id_movimiento) ON DELETE RESTRICT,
                fecha               TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                -- Un apunte que no mueve nada no significa nada y ensucia el saldo.
                CONSTRAINT ck_rest_cuenta_mov_algo_se_mueve
                    CHECK (monto > 0 OR tiquetes > 0),
                -- Los tiquetes son siempre DE ALGO: sin producto no se sabe qué se consumió.
                CONSTRAINT ck_rest_cuenta_mov_tiquetes_con_producto
                    CHECK (tiquetes = 0 OR id_producto IS NOT NULL)
            );
            CREATE INDEX IF NOT EXISTS ix_rest_cuenta_mov_cuenta
                ON restaurante.rest_cuenta_movimiento (id_cuenta, fecha DESC);
            CREATE INDEX IF NOT EXISTS ix_rest_cuenta_mov_negocio
                ON restaurante.rest_cuenta_movimiento (id_negocio, fecha DESC);
            CREATE INDEX IF NOT EXISTS ix_rest_cuenta_mov_orden
                ON restaurante.rest_cuenta_movimiento (id_orden);
        `, { transaction: t });
        console.log('   ✓');

        // ── 2-bis. El interruptor por negocio ───────────────────────────────────────────
        //
        // NACE APAGADO, y eso es lo importante. Sin esto, desplegar le pondría a TODOS los
        // restaurantes un menú nuevo y una forma de pago nueva en el desplegable de cobro, sin
        // que nadie la haya pedido — y el primero que la eligiera sin saber se encontraría
        // pidiéndole una cuenta a un cliente que no existe.
        //
        // Es el mismo patrón que `permite_multipago`, `permite_descuento` y
        // `pregunta_cobro_envio`: opt-in desde Configuración, del dueño del negocio.
        console.log('2-bis. Agregando general.gener_negocio.permite_cuentas_cliente...');
        const colFlag = await unaFila(
            `SELECT 1 AS hay FROM information_schema.columns
              WHERE table_schema='general' AND table_name='gener_negocio'
                AND column_name='permite_cuentas_cliente';`,
            {},
            t,
        );
        if (!colFlag) {
            await sequelize.query(`
                ALTER TABLE general.gener_negocio
                ADD COLUMN permite_cuentas_cliente BOOLEAN NOT NULL DEFAULT false;
            `, { transaction: t });
            console.log('   ✓ columna creada (apagada para todos)');
        } else {
            console.log('   • ya existía');
        }

        // ── 3. La forma de pago «Cuenta / Tiquetera» ────────────────────────────────────
        console.log('3. Marcando la forma de pago de cuenta (rest_metodo_pago.es_cuenta)...');
        const colEsCuenta = await unaFila(
            `SELECT 1 AS hay FROM information_schema.columns
              WHERE table_schema='restaurante' AND table_name='rest_metodo_pago'
                AND column_name='es_cuenta';`,
            {},
            t,
        );
        if (!colEsCuenta) {
            await sequelize.query(`
                ALTER TABLE restaurante.rest_metodo_pago
                ADD COLUMN es_cuenta BOOLEAN NOT NULL DEFAULT false;
            `, { transaction: t });
            console.log('   ✓ columna creada');
        } else {
            console.log('   • ya existía');
        }

        // Una forma de pago así por negocio. No es cosmética: es la que le dice al cobro
        // «esto no entra al cajón, descuéntalo de la cuenta del cliente».
        //
        // Se siembra **INACTIVA**: el listado de formas de pago filtra por estado, así que un
        // negocio que no ha encendido las cuentas ni la ve en el desplegable de cobro. La
        // enciende el interruptor de Configuración, no esta migración.
        await sequelize.query(`
            INSERT INTO restaurante.rest_metodo_pago (id_negocio, nombre, estado, es_cuenta, fecha_creacion)
            SELECT n.id_negocio, 'Cuenta / Tiquetera', 'I', true, CURRENT_TIMESTAMP
            FROM general.gener_negocio n
            WHERE n.id_tipo_negocio = :idTipoNegocio
              AND n.estado = 'A'
              AND NOT EXISTS (
                  SELECT 1 FROM restaurante.rest_metodo_pago mp
                  WHERE mp.id_negocio = n.id_negocio AND mp.es_cuenta = true
              );
        `, { replacements: { idTipoNegocio }, transaction: t });

        // Y se apaga la de cualquier negocio que no tenga el interruptor encendido. Hace falta
        // porque una versión anterior de esta migración la sembraba activa: sin esto, las bases
        // donde ya se ejecutó se quedarían con la forma de pago visible para todo el mundo.
        await sequelize.query(`
            UPDATE restaurante.rest_metodo_pago mp
               SET estado = 'I'
              FROM general.gener_negocio n
             WHERE n.id_negocio = mp.id_negocio
               AND mp.es_cuenta = true
               AND mp.estado = 'A'
               AND n.permite_cuentas_cliente = false;
        `, { transaction: t });
        console.log('   ✓ forma de pago sembrada INACTIVA (la enciende Configuración)');

        // ── 4. De qué forma entró el abono ──────────────────────────────────────────────
        console.log('4. Agregando rest_movimiento_caja.id_metodo_pago...');
        const colMetodoMov = await unaFila(
            `SELECT 1 AS hay FROM information_schema.columns
              WHERE table_schema='restaurante' AND table_name='rest_movimiento_caja'
                AND column_name='id_metodo_pago';`,
            {},
            t,
        );
        if (!colMetodoMov) {
            // Sin esto, un abono de $400.000 caía en el arqueo como «Manual / Sin orden» y el
            // cajero no podía saber si ese dinero estaba en el cajón o había llegado por
            // transferencia. El desglose del turno lo lee ahora de aquí cuando no hay pedido.
            await sequelize.query(`
                ALTER TABLE restaurante.rest_movimiento_caja
                ADD COLUMN id_metodo_pago INTEGER NULL
                    REFERENCES restaurante.rest_metodo_pago(id_metodo_pago) ON DELETE RESTRICT;
            `, { transaction: t });
            console.log('   ✓ columna creada');
        } else {
            console.log('   • ya existía');
        }

        // ── 4-bis. Qué movimiento de caja creó este apunte ──────────────────────────────
        //
        // Sin esta columna, saber con qué pagó el cliente su abono obligaba a cruzar las dos
        // tablas por el texto del concepto — y dos abonos con el mismo texto se cruzaban entre
        // sí, duplicando filas en el historial del cliente.
        console.log('4-bis. Agregando rest_cuenta_movimiento.id_movimiento_caja...');
        const colMovCaja = await unaFila(
            `SELECT 1 AS hay FROM information_schema.columns
              WHERE table_schema='restaurante' AND table_name='rest_cuenta_movimiento'
                AND column_name='id_movimiento_caja';`,
            {},
            t,
        );
        if (!colMovCaja) {
            await sequelize.query(`
                ALTER TABLE restaurante.rest_cuenta_movimiento
                ADD COLUMN id_movimiento_caja INTEGER NULL
                    REFERENCES restaurante.rest_movimiento_caja(id_movimiento) ON DELETE RESTRICT;
            `, { transaction: t });
            console.log('   ✓ columna creada');
        } else {
            console.log('   • ya existía');
        }

        // ── 4-ter. De quién es la cuenta, guardado en el propio pedido ──────────────────
        //
        // El pedido ya guarda la INTENCIÓN de forma de pago (`id_metodo_pago`) y el desglose de
        // multipago desde que se toma, aunque se cobre después. Faltaba lo mismo para la cuenta:
        // sin esta columna, el cajero elegía «la tiquetera de Juan» en el POS y al ir a cobrar
        // la mesa el sistema se lo volvía a preguntar, porque no había dónde recordarlo.
        console.log('4-ter. Agregando pedid_orden.id_cuenta...');
        const colOrdenCuenta = await unaFila(
            `SELECT 1 AS hay FROM information_schema.columns
              WHERE table_schema='restaurante' AND table_name='pedid_orden'
                AND column_name='id_cuenta';`,
            {},
            t,
        );
        if (!colOrdenCuenta) {
            await sequelize.query(`
                ALTER TABLE restaurante.pedid_orden
                ADD COLUMN id_cuenta INTEGER NULL
                    REFERENCES restaurante.rest_cuenta(id_cuenta) ON DELETE RESTRICT;
            `, { transaction: t });
            console.log('   ✓ columna creada');
        } else {
            console.log('   • ya existía');
        }

        // ── 5. Auditoría: las dos tablas mueven dinero ──────────────────────────────────
        console.log('5. Registrando triggers de auditoría...');
        const fnAudit = await unaFila(
            `SELECT 1 AS hay FROM pg_proc p
              JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname='auditoria' AND p.proname='fn_audit';`,
            {},
            t,
        );
        if (fnAudit) {
            for (const [tabla, pk] of [
                ['rest_cuenta', 'id_cuenta'],
                ['rest_cuenta_movimiento', 'id_movimiento'],
            ]) {
                await sequelize.query(
                    `DROP TRIGGER IF EXISTS trg_audit ON restaurante.${tabla};`,
                    { transaction: t },
                );
                await sequelize.query(
                    `CREATE TRIGGER trg_audit
                         AFTER INSERT OR UPDATE OR DELETE ON restaurante.${tabla}
                         FOR EACH ROW EXECUTE FUNCTION auditoria.fn_audit('${pk}');`,
                    { transaction: t },
                );
            }
            console.log('   ✓');
        } else {
            console.log('   ! auditoria.fn_audit no existe; se omite (ejecuta migrate:auditoria-base)');
        }

        // ── 6. El módulo /clientes ──────────────────────────────────────────────────────
        console.log('6. Sembrando el módulo /clientes...');
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
            SELECT 'CLIENTES', :idNivelPadre, 'group', 'A', 1, :idTipoNegocio, :url, CURRENT_TIMESTAMP
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

        // ── 7. Los subniveles ───────────────────────────────────────────────────────────
        console.log('7. Sembrando los subniveles de acción...');
        const tipoAccion = await unaFila(
            `SELECT id_tipo_nivel FROM general.gener_tipo_nivel
              WHERE estado='A' AND UPPER(nombre)='ACCION' ORDER BY id_tipo_nivel LIMIT 1;`,
            {},
            t,
        );
        if (!tipoAccion) throw new Error('No se encontró el tipo de nivel ACCION.');
        const idTipoNivelAccion = Number(tipoAccion.id_tipo_nivel);

        const modulo = await unaFila(
            `SELECT id_nivel FROM general.gener_nivel
              WHERE id_tipo_negocio = :idTipoNegocio AND id_tipo_nivel = 1 AND url = :url
              ORDER BY id_nivel LIMIT 1;`,
            { idTipoNegocio, url: URL_MODULO },
            t,
        );
        const idNivelModulo = Number(modulo.id_nivel);

        for (const sub of SUBNIVELES) {
            await sequelize.query(`
                INSERT INTO general.gener_nivel
                    (descripcion, id_nivel_padre, icono, estado, id_tipo_nivel, id_tipo_negocio, url, fecha_creacion)
                SELECT :descripcion, :idNivelPadre, NULL, 'A', :idTipoNivelAccion, :idTipoNegocio, :codigo, CURRENT_TIMESTAMP
                WHERE NOT EXISTS (
                    SELECT 1 FROM general.gener_nivel
                    WHERE id_tipo_negocio = :idTipoNegocio
                      AND id_tipo_nivel = :idTipoNivelAccion
                      AND url = :codigo
                );
            `, {
                replacements: {
                    descripcion: sub.descripcion,
                    idNivelPadre: idNivelModulo,
                    idTipoNivelAccion,
                    idTipoNegocio,
                    codigo: sub.codigo,
                },
                transaction: t,
            });
        }
        console.log('   ✓');

        // ── 8. Permisos por rol ─────────────────────────────────────────────────────────
        //
        // El módulo nace CERRADO salvo para quien tiene que usarlo. Al contrario que el
        // subnivel `caja_ver_ingresos` —que se sembró abierto porque apagarlo habría quitado
        // de golpe algo que ya funcionaba—, aquí no hay nada que conservar: es nuevo. Quien
        // quiera dárselo a un mesero lo enciende en Usuarios → Roles y permisos.
        console.log('8. Asignando permisos (ADMINISTRADOR completo, CAJERO operativo)...');

        await sequelize.query(`
            INSERT INTO general.gener_rol_nivel
                (id_rol, id_nivel, puede_ver, puede_crear, puede_editar, puede_eliminar, estado, fecha_creacion, fecha_actualizacion)
            SELECT r.id_rol, nv.id_nivel, true, true, true, true, 'A', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
            FROM general.gener_rol r
            JOIN general.gener_nivel nv
              ON nv.id_tipo_negocio = r.id_tipo_negocio
             AND nv.estado = 'A'
             AND nv.url IN (:urls)
            WHERE r.id_tipo_negocio = :idTipoNegocio
              AND r.estado = 'A'
              AND UPPER(r.descripcion) = 'ADMINISTRADOR'
            ON CONFLICT (id_rol, id_nivel) DO NOTHING;
        `, {
            replacements: {
                idTipoNegocio,
                urls: [URL_MODULO, ...SUBNIVELES.map((s) => s.codigo)],
            },
            transaction: t,
        });

        // El cajero ve las cuentas y recibe abonos —es quien está en la caja— pero NO puede
        // ajustar saldos ni perdonar deudas: eso es decisión del dueño.
        await sequelize.query(`
            INSERT INTO general.gener_rol_nivel
                (id_rol, id_nivel, puede_ver, puede_crear, puede_editar, puede_eliminar, estado, fecha_creacion, fecha_actualizacion)
            SELECT r.id_rol, nv.id_nivel, true, true, false, false, 'A', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
            FROM general.gener_rol r
            JOIN general.gener_nivel nv
              ON nv.id_tipo_negocio = r.id_tipo_negocio
             AND nv.estado = 'A'
             AND nv.url IN (:url, 'clientes_abonar')
            WHERE r.id_tipo_negocio = :idTipoNegocio
              AND r.estado = 'A'
              AND UPPER(r.descripcion) = 'CAJERO'
            ON CONFLICT (id_rol, id_nivel) DO NOTHING;
        `, { replacements: { idTipoNegocio, url: URL_MODULO }, transaction: t });
        console.log('   ✓');

        // ── 9. Los negocios que ya existen ──────────────────────────────────────────────
        //
        // `gener_nivel_negocio` manda sobre la visibilidad cuando el negocio tiene ajustes
        // propios. Un restaurante que ya los tenga NO vería el módulo nuevo por no tener fila
        // aquí — es la trampa documentada: la vertical se queda muda sin decir por qué.
        console.log('9. Backfill de gener_nivel_negocio para los restaurantes existentes...');
        await sequelize.query(`
            INSERT INTO general.gener_nivel_negocio
                (id_negocio, id_rol, id_nivel, puede_ver, estado, fecha_creacion, fecha_actualizacion)
            SELECT n.id_negocio, rn.id_rol, rn.id_nivel, rn.puede_ver, 'A',
                   CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
            FROM general.gener_negocio n
            JOIN general.gener_nivel nv
              ON nv.id_tipo_negocio = n.id_tipo_negocio
             AND nv.estado = 'A'
             AND nv.url IN (:urls)
            JOIN general.gener_rol_nivel rn
              ON rn.id_nivel = nv.id_nivel
             AND rn.estado = 'A'
            WHERE n.estado = 'A'
              AND n.id_tipo_negocio = :idTipoNegocio
              -- Solo los que ya tienen ajustes propios: a los demás les basta la matriz global.
              AND EXISTS (
                  SELECT 1 FROM general.gener_nivel_negocio nn WHERE nn.id_negocio = n.id_negocio
              )
            ON CONFLICT (id_negocio, id_rol, id_nivel) DO NOTHING;
        `, {
            replacements: {
                idTipoNegocio,
                urls: [URL_MODULO, ...SUBNIVELES.map((s) => s.codigo)],
            },
            transaction: t,
        });
        console.log('   ✓');

        await t.commit();
        console.log('\n✓ Migración de cuentas de cliente completada');
    } catch (error) {
        await t.rollback();
        console.error('✗ Error:', error.message);
        process.exitCode = 1;
    } finally {
        await sequelize.close();
    }
}

migrate();
