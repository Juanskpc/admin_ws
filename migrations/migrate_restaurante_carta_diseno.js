/**
 * Migración: diseño de la carta virtual y características por plan.
 *
 * ## restaurante.carta_diseno
 *
 * Una fila por negocio: plantilla, formato de lista, ajustes de marca (color, tipografía de
 * títulos, bordes) y opciones de la carta pública.
 *
 * **No se siembra ninguna fila.** Un negocio sin diseño se sirve con la plantilla «Esencial», que
 * es la carta de siempre. Así el despliegue no le cambia la carta a nadie, y un negocio nuevo abre
 * su carta el primer día sin haber pasado por Configuración.
 *
 * ## general.gener_plan_caracteristica
 *
 * Qué incluye cada plan. Hasta ahora `gener_plan` solo sabía nombre y precio, así que el sistema
 * podía responder «¿tiene plan activo?» pero no «¿qué incluye su plan?». Sin esto, limitar el botón
 * de WhatsApp o las plantillas por plan obligaba a escribir el nombre del plan en el código.
 *
 * Se siembra **permisivo**: todo incluido en todos los planes. Hoy todos los negocios tienen el
 * botón de pedido y color propio, y sembrar restrictivo se lo apagaría a clientes que ya lo usan.
 * Para limitar un plan se cambia su fila, sin desplegar:
 *
 *   UPDATE general.gener_plan_caracteristica
 *      SET valor = 'false'
 *    WHERE id_plan = 5 AND codigo = 'carta_whatsapp';
 *
 *   -- Lista separada por comas, o '*' para todas. «esencial» se permite siempre.
 *   UPDATE general.gener_plan_caracteristica
 *      SET valor = 'esencial,papel,mostrador'
 *    WHERE id_plan = 5 AND codigo = 'carta_plantillas';
 *
 * ## Auditoría
 *
 * `carta_diseno` lleva `trg_audit`: guarda estado y conviene saber quién cambió la marca de un
 * negocio. `gener_plan_caracteristica` no: es catálogo de plataforma, de cambio casi nulo, y su
 * clave compuesta no encaja con el identificador único que registra `fn_audit`.
 *
 * Idempotente. npm run migrate:restaurante-carta-diseno
 */
require('dotenv').config();
const db = require('../app_core/models/conection');

const sequelize = db.sequelize;

/** Lo que incluye cada plan al sembrar. Ver la cabecera: permisivo a propósito. */
const CARACTERISTICAS_INICIALES = [
    ['carta_whatsapp', 'true'],
    ['carta_plantillas', '*'],
    ['carta_color_libre', 'true'],
];

async function migrar() {
    const t = await sequelize.transaction();
    try {
        console.log('1. restaurante.carta_diseno...');
        await sequelize.query(`
            CREATE TABLE IF NOT EXISTS restaurante.carta_diseno (
                id_diseno      SERIAL PRIMARY KEY,
                id_negocio     INTEGER NOT NULL
                               REFERENCES general.gener_negocio(id_negocio) ON DELETE CASCADE,
                plantilla      VARCHAR(40) NOT NULL DEFAULT 'esencial',
                formato        VARCHAR(20) NOT NULL DEFAULT 'cards',
                marca          JSONB       NOT NULL DEFAULT '{}'::jsonb,
                opciones       JSONB       NOT NULL DEFAULT '{}'::jsonb,
                publicado_en   TIMESTAMP   NULL,
                id_usuario     INTEGER     NULL REFERENCES general.gener_usuario(id_usuario),
                fecha_creacion TIMESTAMP   NOT NULL DEFAULT now()
            );
        `, { transaction: t });
        await sequelize.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS ux_carta_diseno_negocio
                ON restaurante.carta_diseno (id_negocio);
        `, { transaction: t });
        console.log('   OK\n');

        console.log('2. general.gener_plan_caracteristica...');
        await sequelize.query(`
            CREATE TABLE IF NOT EXISTS general.gener_plan_caracteristica (
                id_plan INTEGER      NOT NULL
                        REFERENCES general.gener_plan(id_plan) ON DELETE CASCADE,
                codigo  VARCHAR(60)  NOT NULL,
                valor   VARCHAR(255) NOT NULL,
                PRIMARY KEY (id_plan, codigo)
            );
        `, { transaction: t });
        console.log('   OK\n');

        console.log('3. Características por plan (permisivas)...');
        const valores = CARACTERISTICAS_INICIALES
            .map((_, i) => `(:codigo${i}, :valor${i})`)
            .join(', ');
        const replacements = {};
        CARACTERISTICAS_INICIALES.forEach(([codigo, valor], i) => {
            replacements[`codigo${i}`] = codigo;
            replacements[`valor${i}`] = valor;
        });
        // ON CONFLICT DO NOTHING: si alguien ya restringió un plan a mano, volver a correr la
        // migración no le devuelve lo que quitó.
        const [insertadas] = await sequelize.query(`
            INSERT INTO general.gener_plan_caracteristica (id_plan, codigo, valor)
            SELECT p.id_plan, c.codigo, c.valor
            FROM general.gener_plan p
            CROSS JOIN (VALUES ${valores}) AS c(codigo, valor)
            ON CONFLICT (id_plan, codigo) DO NOTHING
            RETURNING id_plan;
        `, { replacements, transaction: t });
        console.log(`   ✓ ${insertadas.length} fila(s) nuevas\n`);

        console.log('4. Trigger de auditoría...');
        const [[fnAudit]] = await sequelize.query(`
            SELECT 1 AS ok FROM pg_proc p
            JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'auditoria' AND p.proname = 'fn_audit';
        `, { transaction: t });

        if (!fnAudit) {
            console.log('   ⚠️  auditoria.fn_audit no existe — se omite el trigger.');
        } else {
            await sequelize.query(
                'DROP TRIGGER IF EXISTS trg_audit ON restaurante.carta_diseno;',
                { transaction: t },
            );
            await sequelize.query(`
                CREATE TRIGGER trg_audit
                    AFTER INSERT OR UPDATE OR DELETE ON restaurante.carta_diseno
                    FOR EACH ROW EXECUTE FUNCTION auditoria.fn_audit('id_diseno');
            `, { transaction: t });
            console.log('   ✓ carta_diseno');
        }
        console.log('   OK\n');

        await t.commit();
        console.log('✅ Migración de diseño de carta completada.');
    } catch (err) {
        await t.rollback();
        console.error('❌ Error en la migración:', err.message);
        process.exitCode = 1;
    } finally {
        await sequelize.close();
    }
}

migrar();
