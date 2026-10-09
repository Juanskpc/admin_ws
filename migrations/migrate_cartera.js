/**
 * Cartera — el libro de caja de EscalApp como empresa (solo los dueños / super admin).
 *
 * Ver `docs/cartera.md`. Cobranza responde «¿quién nos paga y quién nos debe?»; esto responde
 * la pregunta siguiente: **«¿cuánta plata entró, cuánta salió, y cuánta se quedó por el camino?»**
 * — comisiones de Wompi y dLocal Go, el 4x1000 de cada salida y las retenciones que nos
 * practican los clientes empresa.
 *
 * ## Qué crea
 *
 *   cartera.car_cuenta           dónde vive la plata: el banco, el saldo en Wompi, el de dLocal…
 *   cartera.car_categoria        de qué es cada entrada o salida (catálogo editable)
 *   cartera.car_tarifa_pasarela  la tarifa de lista de cada pasarela, para ESTIMAR su comisión
 *   cartera.car_movimiento       el libro: ingresos, egresos y traslados entre cuentas
 *
 * ## Los pagos de los clientes NO se copian a mano
 *
 * Cada `cob_factura` pagada se vuelve un movimiento de ingreso la primera vez que alguien abre
 * la Cartera (`carteraService.sincronizarAutomaticos`), con la llave `id_factura` UNIQUE como
 * idempotencia. No hay gancho dentro de `aplicarPagoAprobado`, y es a propósito: ese es el
 * camino más delicado de cobranza (extiende planes) y meterle una escritura en un esquema nuevo
 * habría hecho que un fallo de la Cartera tumbara un pago. Lo mismo con las recargas de OpenAI
 * que ya se anotan en Terceros (`general.gener_recarga_ia`).
 *
 * ## Por qué el 4x1000 y la comisión son COLUMNAS y no movimientos aparte
 *
 * Porque nacen de un movimiento y mueren con él: anular un pago a un proveedor tiene que anular
 * también su 4x1000. Como columnas, el total de GMF del mes es un SUM y nunca queda huérfano.
 *
 * Idempotente: `IF NOT EXISTS` en todo, seeds con `ON CONFLICT DO NOTHING` (lo que el dueño
 * renombre o ajuste no se pisa al volver a correrla), triggers con `DROP ... IF EXISTS`.
 * Ejecutar con: npm run migrate:cartera
 */
'use strict';
require('dotenv').config();

const db = require('../app_core/models/conection');
const sequelize = db.sequelize;

/**
 * Las cuentas de partida. `pasarela` dice a qué cuenta llega lo que cobra cada pasarela; la que
 * tiene `manual` es donde caen las transferencias directas. Solo la del banco paga 4x1000: los
 * saldos en las pasarelas no son cuentas bancarias (el retiro hacia el banco sí puede llevar
 * cargos, y se anotan en el traslado).
 */
const CUENTAS = [
    { codigo: 'BANCO', nombre: 'Bancolombia', tipo: 'banco', moneda: 'COP', aplica_gmf: true, pasarela: 'manual', orden: 1 },
    { codigo: 'WOMPI', nombre: 'Saldo en Wompi', tipo: 'pasarela', moneda: 'COP', aplica_gmf: false, pasarela: 'wompi', orden: 2 },
    { codigo: 'DLOCAL', nombre: 'Saldo en dLocal Go', tipo: 'pasarela', moneda: 'COP', aplica_gmf: false, pasarela: 'dlocal', orden: 3 },
    { codigo: 'EFECTIVO', nombre: 'Efectivo', tipo: 'efectivo', moneda: 'COP', aplica_gmf: false, pasarela: null, orden: 4 },
];

/** `sistema` = la llena la plataforma sola; se puede renombrar pero no desactivar. */
const CATEGORIAS = [
    // Ingresos
    ['MENSUALIDADES', 'Mensualidades de clientes', 'ingreso', true],
    ['DESARROLLO', 'Desarrollo de software a la medida', 'ingreso', false],
    ['FE_TERCEROS', 'Facturación electrónica a terceros', 'ingreso', false],
    ['IMPLEMENTACION', 'Implementación y capacitación', 'ingreso', false],
    ['SOPORTE', 'Soporte y consultoría', 'ingreso', false],
    ['APORTE_SOCIOS', 'Aporte de socios', 'ingreso', false],
    ['PRESTAMO_RECIBIDO', 'Préstamo recibido', 'ingreso', false],
    ['RENDIMIENTOS', 'Intereses y rendimientos', 'ingreso', false],
    ['OTROS_INGRESOS', 'Otros ingresos', 'ingreso', false],
    // Egresos
    ['INFRAESTRUCTURA', 'Servidores e infraestructura', 'egreso', false],
    ['IA', 'Inteligencia artificial (OpenAI)', 'egreso', true],
    ['WHATSAPP', 'WhatsApp (Meta)', 'egreso', false],
    ['PROVEEDOR_FE', 'Proveedor de facturación electrónica', 'egreso', false],
    ['DOMINIO_CORREO', 'Dominio, correo y hosting', 'egreso', false],
    ['SOFTWARE', 'Licencias y herramientas', 'egreso', false],
    ['PUBLICIDAD', 'Publicidad y marketing', 'egreso', false],
    ['NOMINA', 'Nómina y honorarios', 'egreso', false],
    ['SEGURIDAD_SOCIAL', 'Seguridad social', 'egreso', false],
    ['CONTADOR', 'Contador', 'egreso', false],
    ['LEGAL', 'Legal y Cámara de Comercio', 'egreso', false],
    ['IMPUESTOS', 'Impuestos (renta, ICA, IVA)', 'egreso', false],
    ['BANCARIOS', 'Cuota de manejo y gastos bancarios', 'egreso', false],
    ['PAGO_PRESTAMO', 'Pago de préstamo', 'egreso', false],
    ['RETIRO_SOCIOS', 'Retiro de socios / dividendos', 'egreso', false],
    ['OTROS_EGRESOS', 'Otros egresos', 'egreso', false],
];

/**
 * Tarifas de lista consultadas el 2026-09-08 (docs/cobro-mensualidades.md §2). Sirven para
 * ESTIMAR la comisión de un pago cuando la pasarela no la devuelve (Wompi no la devuelve): el
 * movimiento queda marcado «estimado» hasta que alguien lo cuadre con el extracto.
 *
 * Las retenciones quedan en 0: si la pasarela retiene renta/ICA/IVA depende de nuestra
 * condición tributaria y del contrato — pregunta de contadora, no de una migración.
 */
const TARIFAS = [
    { pasarela: 'wompi', porcentaje: 2.65, fijo: 700, fijo_moneda: 'COP', iva_pct: 19,
      nota: 'Tarifa de lista: 2,65% + $700 + IVA, igual para todos los métodos.' },
    { pasarela: 'dlocal', porcentaje: 1.99, fijo: 0.2, fijo_moneda: 'USD', iva_pct: 0,
      nota: 'Colombia: 1,99% + USD 0,20, sin IVA (factura desde el exterior). Chile: 2,99% sin fijo.' },
    { pasarela: 'manual', porcentaje: 0, fijo: 0, fijo_moneda: 'COP', iva_pct: 0,
      nota: 'Transferencia directa: sin comisión.' },
];

const TABLAS_AUDITADAS = [
    { tabla: 'car_cuenta', pk: 'id_cuenta' },
    { tabla: 'car_movimiento', pk: 'id_movimiento' },
    { tabla: 'car_tarifa_pasarela', pk: 'pasarela' },
];

async function migrate() {
    const t = await sequelize.transaction();
    const q = (sql, replacements) => sequelize.query(sql, { replacements, transaction: t });
    try {
        console.log('→ Migración: Cartera (libro de caja de EscalApp)\n');

        console.log('1. Esquema cartera...');
        await q('CREATE SCHEMA IF NOT EXISTS cartera;');

        // ── Cuentas ──────────────────────────────────────────────────────────────────────
        console.log('2. cartera.car_cuenta...');
        await q(`
            CREATE TABLE IF NOT EXISTS cartera.car_cuenta (
                id_cuenta     serial        PRIMARY KEY,
                -- Solo las sembradas lo llevan: es la llave del seed, para que renombrarlas no
                -- haga que la migración siguiente las vuelva a crear.
                codigo        varchar(30)   UNIQUE,
                nombre        varchar(80)   NOT NULL,
                tipo          varchar(15)   NOT NULL DEFAULT 'banco',
                moneda        char(3)       NOT NULL DEFAULT 'COP',

                -- ¿Cada salida de esta cuenta paga 4x1000? Las cuentas bancarias sí (salvo la
                -- marcada exenta ante el banco); los saldos en pasarelas y el efectivo, no.
                aplica_gmf    boolean       NOT NULL DEFAULT false,

                -- A qué cuenta llega lo que cobra cada pasarela. UNIQUE: una pasarela, un destino.
                pasarela      varchar(20)   UNIQUE REFERENCES cobranza.cob_pasarela(codigo),

                saldo_inicial numeric(14,2) NOT NULL DEFAULT 0,
                -- Desde qué día cuenta el saldo inicial: lo anterior no suma al saldo.
                fecha_saldo   date,
                nota          varchar(300),
                estado        char(1)       NOT NULL DEFAULT 'A',
                orden         smallint      NOT NULL DEFAULT 0,
                creado_en     timestamp     NOT NULL DEFAULT now(),

                CONSTRAINT chk_car_cuenta_tipo   CHECK (tipo IN ('banco','pasarela','billetera','efectivo','tarjeta')),
                CONSTRAINT chk_car_cuenta_estado CHECK (estado IN ('A','I'))
            );
        `);
        for (const c of CUENTAS) {
            await q(
                `INSERT INTO cartera.car_cuenta (codigo, nombre, tipo, moneda, aplica_gmf, pasarela, orden)
                 SELECT :codigo, :nombre, :tipo, :moneda, :aplica_gmf, :pasarela, :orden
                  WHERE NOT EXISTS (SELECT 1 FROM cartera.car_cuenta WHERE codigo = :codigo)
                    AND (:pasarela::text IS NULL
                         OR NOT EXISTS (SELECT 1 FROM cartera.car_cuenta WHERE pasarela = :pasarela));`,
                c
            );
        }

        // ── Categorías ───────────────────────────────────────────────────────────────────
        console.log('3. cartera.car_categoria...');
        await q(`
            CREATE TABLE IF NOT EXISTS cartera.car_categoria (
                id_categoria serial      PRIMARY KEY,
                codigo       varchar(40) NOT NULL UNIQUE,
                nombre       varchar(80) NOT NULL,
                tipo         varchar(10) NOT NULL,
                sistema      boolean     NOT NULL DEFAULT false,
                estado       char(1)     NOT NULL DEFAULT 'A',
                orden        smallint    NOT NULL DEFAULT 0,

                CONSTRAINT chk_car_categoria_tipo   CHECK (tipo IN ('ingreso','egreso')),
                CONSTRAINT chk_car_categoria_estado CHECK (estado IN ('A','I'))
            );
        `);
        let orden = 0;
        for (const [codigo, nombre, tipo, sistema] of CATEGORIAS) {
            orden += 1;
            await q(
                `INSERT INTO cartera.car_categoria (codigo, nombre, tipo, sistema, orden)
                 VALUES (:codigo, :nombre, :tipo, :sistema, :orden)
                 ON CONFLICT (codigo) DO NOTHING;`,
                { codigo, nombre, tipo, sistema, orden }
            );
        }

        // ── Tarifas de pasarela ──────────────────────────────────────────────────────────
        console.log('4. cartera.car_tarifa_pasarela...');
        await q(`
            CREATE TABLE IF NOT EXISTS cartera.car_tarifa_pasarela (
                pasarela      varchar(20)   PRIMARY KEY REFERENCES cobranza.cob_pasarela(codigo),
                porcentaje    numeric(6,3)  NOT NULL DEFAULT 0,
                fijo          numeric(12,2) NOT NULL DEFAULT 0,
                fijo_moneda   char(3)       NOT NULL DEFAULT 'COP',
                iva_pct       numeric(5,2)  NOT NULL DEFAULT 0,
                -- Retención que practica la pasarela sobre lo que nos liquida (renta+ICA+IVA),
                -- en % del pago. 0 hasta que la contadora diga otra cosa.
                retencion_pct numeric(6,3)  NOT NULL DEFAULT 0,
                nota          varchar(300),
                actualizado_en timestamp    NOT NULL DEFAULT now(),

                CONSTRAINT chk_car_tarifa_valores CHECK (
                    porcentaje >= 0 AND porcentaje < 100 AND fijo >= 0
                    AND iva_pct >= 0 AND iva_pct < 100 AND retencion_pct >= 0 AND retencion_pct < 100)
            );
        `);
        for (const tarifa of TARIFAS) {
            await q(
                `INSERT INTO cartera.car_tarifa_pasarela (pasarela, porcentaje, fijo, fijo_moneda, iva_pct, nota)
                 SELECT :pasarela, :porcentaje, :fijo, :fijo_moneda, :iva_pct, :nota
                  WHERE EXISTS (SELECT 1 FROM cobranza.cob_pasarela WHERE codigo = :pasarela)
                 ON CONFLICT (pasarela) DO NOTHING;`,
                tarifa
            );
        }

        // ── Movimientos ──────────────────────────────────────────────────────────────────
        //
        // Todo importe guardado en pesos (`*_cop`) salvo `monto`, que va en la moneda original
        // (una recarga de OpenAI son USD). `tasa_cop` NULL = falta la tasa: el movimiento se
        // ve, pero no suma, y la pantalla lo pide. Sumar con una tasa inventada es peor.
        //
        // Efecto sobre la cuenta (lo calcula `carteraService.efectoEnCuentas`):
        //   ingreso        cuenta  += monto_cop − comision − iva_comision − retencion − gmf
        //   egreso         cuenta  −= monto_cop + comision + iva_comision + gmf
        //   transferencia  origen  −= monto_cop + comision + iva_comision + gmf ; destino += monto_cop
        console.log('5. cartera.car_movimiento...');
        await q(`
            CREATE TABLE IF NOT EXISTS cartera.car_movimiento (
                id_movimiento     serial        PRIMARY KEY,
                tipo              varchar(15)   NOT NULL,
                fecha             date          NOT NULL,
                id_categoria      integer       REFERENCES cartera.car_categoria(id_categoria),
                id_cuenta         integer       NOT NULL REFERENCES cartera.car_cuenta(id_cuenta),
                id_cuenta_destino integer       REFERENCES cartera.car_cuenta(id_cuenta),

                -- Quién nos pagó o a quién le pagamos («JDD Consultores», «Vultr»…).
                tercero           varchar(120),
                id_negocio        integer       REFERENCES general.gener_negocio(id_negocio) ON DELETE SET NULL,
                descripcion       varchar(300),
                -- N.º de la factura del proveedor o del comprobante: lo que pide la contadora.
                soporte           varchar(80),

                moneda            char(3)       NOT NULL DEFAULT 'COP',
                monto             numeric(14,2) NOT NULL,
                tasa_cop          numeric(14,4),
                monto_cop         numeric(14,2),

                comision          numeric(14,2) NOT NULL DEFAULT 0,
                iva_comision      numeric(14,2) NOT NULL DEFAULT 0,
                -- Lo que NOS retienen (anticipo de renta/ICA/IVA). No es gasto: se descuenta al
                -- declarar. Por eso va aparte de la comisión.
                retencion         numeric(14,2) NOT NULL DEFAULT 0,
                -- IVA incluido en el monto. Informativo: hoy no causamos IVA (obligaciones §2).
                iva               numeric(14,2) NOT NULL DEFAULT 0,
                gmf               numeric(14,2) NOT NULL DEFAULT 0,
                exento_gmf        boolean       NOT NULL DEFAULT false,

                -- Alguna cifra salió de una tarifa o de la TRM del día, no del extracto.
                estimado          boolean       NOT NULL DEFAULT false,

                origen            varchar(15)   NOT NULL DEFAULT 'manual',
                id_factura        integer       UNIQUE REFERENCES cobranza.cob_factura(id_factura) ON DELETE SET NULL,
                id_recarga        integer       UNIQUE REFERENCES general.gener_recarga_ia(id_recarga) ON DELETE SET NULL,

                estado            char(1)       NOT NULL DEFAULT 'A',
                motivo_anulacion  varchar(300),
                id_usuario        integer,
                creado_en         timestamp     NOT NULL DEFAULT now(),
                actualizado_en    timestamp     NOT NULL DEFAULT now(),

                CONSTRAINT chk_car_mov_tipo    CHECK (tipo IN ('ingreso','egreso','transferencia')),
                CONSTRAINT chk_car_mov_origen  CHECK (origen IN ('manual','cobranza','recarga_ia')),
                CONSTRAINT chk_car_mov_estado  CHECK (estado IN ('A','E')),
                CONSTRAINT chk_car_mov_monto   CHECK (monto > 0),
                CONSTRAINT chk_car_mov_cargos  CHECK (comision >= 0 AND iva_comision >= 0
                                                      AND retencion >= 0 AND iva >= 0 AND gmf >= 0),
                CONSTRAINT chk_car_mov_forma   CHECK (
                    (tipo = 'transferencia' AND id_cuenta_destino IS NOT NULL
                                            AND id_cuenta_destino <> id_cuenta)
                    OR (tipo <> 'transferencia' AND id_categoria IS NOT NULL
                                                AND id_cuenta_destino IS NULL))
            );
        `);
        await q(`CREATE INDEX IF NOT EXISTS idx_car_mov_fecha
                     ON cartera.car_movimiento (fecha DESC) WHERE estado = 'A';`);
        await q(`CREATE INDEX IF NOT EXISTS idx_car_mov_cuenta
                     ON cartera.car_movimiento (id_cuenta) WHERE estado = 'A';`);

        // ── Auditoría ────────────────────────────────────────────────────────────────────
        console.log('6. Triggers de auditoría...');
        const [[infra]] = await q(
            `SELECT EXISTS (SELECT 1 FROM information_schema.routines
                             WHERE routine_schema = 'auditoria' AND routine_name = 'fn_audit') AS ok;`
        );
        if (!infra.ok) {
            console.log('   ⚠️  auditoria.fn_audit no existe — triggers omitidos.');
        } else {
            for (const { tabla, pk } of TABLAS_AUDITADAS) {
                await q(`DROP TRIGGER IF EXISTS trg_audit ON cartera.${tabla};`);
                await q(`CREATE TRIGGER trg_audit
                             AFTER INSERT OR UPDATE OR DELETE ON cartera.${tabla}
                             FOR EACH ROW EXECUTE FUNCTION auditoria.fn_audit('${pk}');`);
                console.log(`   ✓ cartera.${tabla}`);
            }
        }

        await t.commit();
        console.log('\n✅ Cartera lista. Los pagos de clientes se copian solos al abrir la vista.');
    } catch (err) {
        await t.rollback();
        console.error('\n❌ Error en la migración:', err.message);
        process.exitCode = 1;
    } finally {
        await sequelize.close();
    }
}

migrate();
