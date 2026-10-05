/**
 * Migración: Proveedores de insumos del restaurante.
 *
 * ## Qué es esto
 *
 * Un restaurante le compra a diez o quince proveedores —el de la carne, el de la papa, el del
 * gas, el de los desechables— y hoy esa información vive en una libreta o en los contactos del
 * teléfono del dueño. Este módulo la guarda, la pone al lado del inventario y responde la
 * pregunta que importa: **«¿quién me vende esto más barato y cuándo fue la última vez que
 * actualizó el precio?»**.
 *
 * ## La decisión de diseño que manda sobre todas las demás
 *
 * Un proveedor **no pertenece a un negocio**: pertenece al mundo. El mismo distribuidor de
 * pollo le vende a tres restaurantes del mismo barrio, y cada uno le negocia su precio. Por eso
 * hay DOS tablas y no una:
 *
 *   rest_proveedor          → la ficha pública. Nombre, contacto, cobertura, condiciones.
 *                             Puede verla otro negocio (si su dueño lo permite).
 *   rest_proveedor_negocio  → la relación privada. Notas, calificación, condiciones propias,
 *                             estado interno. **Nunca sale del negocio que la escribió.**
 *
 * Esa separación es la que permite que un negocio archive un proveedor sin que desaparezca para
 * los demás: archivar escribe en `rest_proveedor_negocio.estado_interno`, no en la ficha.
 *
 * `rest_proveedor.id_negocio_origen` dice quién la creó, y es **dato interno**: el directorio
 * compartido no lo expone nunca. Saber qué restaurante registró a un proveedor es saber a quién
 * le compra la competencia.
 *
 * ## Los precios
 *
 * `rest_proveedor_insumo` es «este proveedor me vende esto a este precio», y la fila es **del
 * negocio que la escribió** (`id_negocio`). Dos restaurantes pueden tener su propia fila del
 * mismo insumo del mismo proveedor con precios distintos, y ninguno ve la del otro salvo que
 * se marque `publico = true` Y la ficha esté publicada con precios.
 *
 * El precio actual vive en la fila; el histórico, en `rest_proveedor_precio`. Se escribe una
 * fila de histórico en cada cambio de precio y en cada compra, que es lo que hace posible la
 * gráfica «cómo subió el kilo de pollo este año».
 *
 * ## Las compras
 *
 * `rest_compra` + `rest_compra_detalle`. Una compra con un renglón ligado a un insumo del
 * inventario (`carta_ingrediente`) **suma stock**: es la entrada de mercancía que al inventario
 * del restaurante le faltaba. Un renglón sin ligar solo queda como gasto.
 *
 * Anular una compra no la borra (`estado = 'N'`): revierte el stock que sumó y deja el rastro.
 *
 * ## Qué crea
 *
 *   1. restaurante.rest_proveedor_categoria_cat  — catálogo estándar (15 categorías del sistema)
 *   2. restaurante.rest_proveedor                — la ficha
 *   3. restaurante.rest_proveedor_categoria      — ficha ↔ categorías (N:M)
 *   4. restaurante.rest_proveedor_negocio        — la relación privada por negocio
 *   5. restaurante.rest_proveedor_insumo         — qué vende y a qué precio
 *   6. restaurante.rest_proveedor_precio         — histórico de precios
 *   7. restaurante.rest_compra + rest_compra_detalle
 *   8. Triggers de auditoría (todas mueven dinero o estado)
 *   9. El módulo /proveedores y sus 6 subniveles, con permisos por rol
 *
 * Aditiva e idempotente. NO destructiva. Ejecutar con:
 *   node scripts/migrar.js restaurante-proveedores
 */
require('dotenv').config();
const db = require('../app_core/models/conection');

const sequelize = db.sequelize;

const URL_MODULO = '/proveedores';

/**
 * Categorías estándar del sistema. El usuario NO puede inventarse categorías: si cada
 * restaurante escribe la suya, el directorio compartido deja de poder filtrarse y el
 * comparador no encuentra nada. Se amplían desde aquí, con una migración.
 */
const CATEGORIAS = [
    ['frutas_verduras', 'Frutas y verduras', 'carrot', 10],
    ['carnes', 'Carnes y proteínas', 'beef', 20],
    ['pescados', 'Pescados y mariscos', 'fish', 30],
    ['lacteos_huevos', 'Lácteos y huevos', 'milk', 40],
    ['abarrotes', 'Abarrotes', 'wheat', 50],
    ['bebidas', 'Bebidas', 'cup-soda', 60],
    ['panaderia', 'Panadería y repostería', 'croissant', 70],
    ['congelados', 'Productos congelados', 'snowflake', 80],
    ['limpieza', 'Productos de limpieza', 'spray-can', 90],
    ['desechables', 'Desechables y empaques', 'package', 100],
    ['equipos', 'Equipos y utensilios', 'utensils', 110],
    ['tecnologia', 'Tecnología para restaurantes', 'monitor', 120],
    ['servicios', 'Servicios técnicos', 'wrench', 130],
    ['mayoristas', 'Distribuidores mayoristas', 'truck', 140],
    ['otros', 'Otros', 'ellipsis', 999],
];

/**
 * Los subniveles cubren, uno a uno, lo que el módulo deja hacer. Van separados porque en un
 * restaurante los hace gente distinta: el administrativo registra proveedores, el dueño es el
 * único que ve lo que paga, y publicar en el directorio es una decisión que sale del negocio.
 */
const SUBNIVELES = [
    { codigo: 'proveedores_crear', descripcion: 'PROVEEDORES - CREAR PROVEEDOR' },
    { codigo: 'proveedores_editar', descripcion: 'PROVEEDORES - EDITAR PROVEEDOR E INSUMOS' },
    { codigo: 'proveedores_archivar', descripcion: 'PROVEEDORES - ARCHIVAR PROVEEDOR' },
    { codigo: 'proveedores_compras', descripcion: 'PROVEEDORES - REGISTRAR COMPRAS' },
    { codigo: 'proveedores_precios', descripcion: 'PROVEEDORES - VER PRECIOS Y GASTO PRIVADOS' },
    { codigo: 'proveedores_publicar', descripcion: 'PROVEEDORES - PUBLICAR EN EL DIRECTORIO' },
];

async function unaFila(sql, replacements, transaction) {
    const [filas] = await sequelize.query(sql, { replacements, transaction });
    return filas.length ? filas[0] : null;
}

async function migrate() {
    const t = await sequelize.transaction();
    try {
        console.log('→ Migración Restaurante — Proveedores de insumos\n');

        const tipo = await unaFila(
            `SELECT id_tipo_negocio FROM general.gener_tipo_negocio
              WHERE estado = 'A' AND UPPER(nombre) LIKE '%RESTAURANTE%'
              ORDER BY id_tipo_negocio LIMIT 1;`,
            {},
            t,
        );
        if (!tipo) throw new Error('No se encontró el tipo de negocio RESTAURANTE.');
        const idTipoNegocio = Number(tipo.id_tipo_negocio);

        // ── 1. Catálogo estándar de categorías ──────────────────────────────────────────
        //
        // Sin id_negocio a propósito: es del SISTEMA. Es lo que hace que «Carnes y proteínas»
        // signifique lo mismo en los 20 restaurantes y que el filtro del directorio sirva.
        console.log('1. Creando restaurante.rest_proveedor_categoria_cat...');
        await sequelize.query(`
            CREATE TABLE IF NOT EXISTS restaurante.rest_proveedor_categoria_cat (
                id_categoria_prov SERIAL PRIMARY KEY,
                codigo            VARCHAR(40)  NOT NULL UNIQUE,
                nombre            VARCHAR(80)  NOT NULL,
                icono             VARCHAR(40),
                orden             INTEGER      NOT NULL DEFAULT 500,
                estado            CHAR(1)      NOT NULL DEFAULT 'A',
                fecha_creacion    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
        `, { transaction: t });

        for (const [codigo, nombre, icono, orden] of CATEGORIAS) {
            await sequelize.query(`
                INSERT INTO restaurante.rest_proveedor_categoria_cat (codigo, nombre, icono, orden)
                VALUES (:codigo, :nombre, :icono, :orden)
                ON CONFLICT (codigo) DO UPDATE
                    SET nombre = EXCLUDED.nombre,
                        icono  = EXCLUDED.icono,
                        orden  = EXCLUDED.orden;
            `, { replacements: { codigo, nombre, icono, orden }, transaction: t });
        }
        console.log(`   ✓ ${CATEGORIAS.length} categorías del sistema`);

        // ── 2. La ficha del proveedor ───────────────────────────────────────────────────
        console.log('2. Creando restaurante.rest_proveedor...');
        await sequelize.query(`
            CREATE TABLE IF NOT EXISTS restaurante.rest_proveedor (
                id_proveedor        SERIAL PRIMARY KEY,
                -- Quién lo registró. DATO INTERNO: el directorio compartido no lo expone jamás.
                id_negocio_origen   INTEGER NOT NULL
                    REFERENCES general.gener_negocio(id_negocio) ON DELETE RESTRICT,

                -- Información básica
                nombre_comercial    VARCHAR(160) NOT NULL,
                nombre_legal        VARCHAR(160),
                identificacion      VARCHAR(40),
                descripcion         TEXT,
                logo_url            VARCHAR(255),

                -- Contacto
                persona_contacto    VARCHAR(120),
                telefono            VARCHAR(40),
                whatsapp            VARCHAR(40),
                email               VARCHAR(160),
                sitio_web           VARCHAR(200),
                -- { "instagram": "...", "facebook": "..." }. JSONB y no columnas: las redes
                -- cambian cada dos años y no se va a migrar la tabla por cada una.
                redes               JSONB NOT NULL DEFAULT '{}'::jsonb,

                -- Ubicación y cobertura
                direccion           VARCHAR(200),
                ciudad              VARCHAR(100),
                region              VARCHAR(100),
                pais                VARCHAR(80) NOT NULL DEFAULT 'Colombia',
                -- Array de textos libres: "Centro", "Norte", "Área metropolitana".
                zonas_cobertura     JSONB NOT NULL DEFAULT '[]'::jsonb,
                tipo_atencion       VARCHAR(10) NOT NULL DEFAULT 'AMBOS'
                    CHECK (tipo_atencion IN ('ENTREGA', 'RECOGIDA', 'AMBOS')),

                -- Condiciones comerciales
                pedido_minimo       NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (pedido_minimo >= 0),
                -- Array de enteros 0..6 (0 = domingo), igual criterio que rest_horario.
                dias_entrega        JSONB NOT NULL DEFAULT '[]'::jsonb,
                tiempo_entrega_hrs  INTEGER CHECK (tiempo_entrega_hrs IS NULL OR tiempo_entrega_hrs >= 0),
                metodos_pago        VARCHAR(200),
                precios_mayoristas  BOOLEAN NOT NULL DEFAULT false,
                observaciones       TEXT,

                -- Visibilidad. Cuatro niveles, de menos a más abierto:
                --   PRIVADO                → solo el negocio que lo creó.
                --   DIRECTORIO_BASICO      → otros ven nombre, categorías, ciudad, contacto e
                --                            insumos; NI precios NI condiciones comerciales.
                --   DIRECTORIO_SIN_PRECIOS → todo lo anterior + cobertura y condiciones; sin precios.
                --   DIRECTORIO             → además, los precios marcados como públicos.
                visibilidad         VARCHAR(24) NOT NULL DEFAULT 'PRIVADO'
                    CHECK (visibilidad IN ('PRIVADO', 'DIRECTORIO_BASICO', 'DIRECTORIO_SIN_PRECIOS', 'DIRECTORIO')),

                estado              CHAR(1) NOT NULL DEFAULT 'A',
                id_usuario_creacion INTEGER
                    REFERENCES general.gener_usuario(id_usuario) ON DELETE RESTRICT,
                fecha_creacion      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                fecha_actualizacion TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE INDEX IF NOT EXISTS ix_rest_proveedor_origen
                ON restaurante.rest_proveedor (id_negocio_origen, estado);
            CREATE INDEX IF NOT EXISTS ix_rest_proveedor_directorio
                ON restaurante.rest_proveedor (visibilidad, estado);
            CREATE INDEX IF NOT EXISTS ix_rest_proveedor_ciudad
                ON restaurante.rest_proveedor (lower(ciudad));
        `, { transaction: t });

        // Dos fichas con el mismo nombre en el mismo negocio son el duplicado que de verdad
        // pasa (se registra, se olvida, se vuelve a registrar). Entre negocios distintos SÍ se
        // permite: son dos relaciones con el mismo proveedor del mundo real, y el directorio
        // es lo que las une.
        await sequelize.query(`
            CREATE UNIQUE INDEX IF NOT EXISTS uq_rest_proveedor_nombre_negocio
                ON restaurante.rest_proveedor (id_negocio_origen, lower(nombre_comercial))
                WHERE estado = 'A';
        `, { transaction: t });
        console.log('   ✓');

        // ── 3. Ficha ↔ categorías ───────────────────────────────────────────────────────
        console.log('3. Creando restaurante.rest_proveedor_categoria...');
        await sequelize.query(`
            CREATE TABLE IF NOT EXISTS restaurante.rest_proveedor_categoria (
                id_proveedor      INTEGER NOT NULL
                    REFERENCES restaurante.rest_proveedor(id_proveedor) ON DELETE CASCADE,
                id_categoria_prov INTEGER NOT NULL
                    REFERENCES restaurante.rest_proveedor_categoria_cat(id_categoria_prov) ON DELETE RESTRICT,
                PRIMARY KEY (id_proveedor, id_categoria_prov)
            );
            CREATE INDEX IF NOT EXISTS ix_rest_prov_cat_categoria
                ON restaurante.rest_proveedor_categoria (id_categoria_prov);
        `, { transaction: t });
        console.log('   ✓');

        // ── 4. La relación privada negocio ↔ proveedor ──────────────────────────────────
        //
        // Aquí vive TODO lo que no puede salir del negocio. Un negocio sin fila aquí no tiene
        // al proveedor en «Mis proveedores», aunque lo vea en el directorio.
        console.log('4. Creando restaurante.rest_proveedor_negocio...');
        await sequelize.query(`
            CREATE TABLE IF NOT EXISTS restaurante.rest_proveedor_negocio (
                id_proveedor_negocio SERIAL PRIMARY KEY,
                id_proveedor         INTEGER NOT NULL
                    REFERENCES restaurante.rest_proveedor(id_proveedor) ON DELETE CASCADE,
                id_negocio           INTEGER NOT NULL
                    REFERENCES general.gener_negocio(id_negocio) ON DELETE RESTRICT,
                -- true para el negocio que creó la ficha: es el único que puede editarla.
                es_propietario       BOOLEAN NOT NULL DEFAULT false,
                -- ACTIVO / ARCHIVADO. Archivar es de ESTE negocio y no toca a los demás.
                estado_interno       VARCHAR(12) NOT NULL DEFAULT 'ACTIVO'
                    CHECK (estado_interno IN ('ACTIVO', 'ARCHIVADO')),
                notas                TEXT,
                condiciones          TEXT,
                calificacion         SMALLINT CHECK (calificacion IS NULL OR calificacion BETWEEN 1 AND 5),
                fecha_vinculacion    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                fecha_actualizacion  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                CONSTRAINT uq_rest_proveedor_negocio UNIQUE (id_proveedor, id_negocio)
            );
            CREATE INDEX IF NOT EXISTS ix_rest_proveedor_negocio_neg
                ON restaurante.rest_proveedor_negocio (id_negocio, estado_interno);
        `, { transaction: t });
        console.log('   ✓');

        // ── 5. Qué vende y a qué precio ─────────────────────────────────────────────────
        console.log('5. Creando restaurante.rest_proveedor_insumo...');
        await sequelize.query(`
            CREATE TABLE IF NOT EXISTS restaurante.rest_proveedor_insumo (
                id_proveedor_insumo SERIAL PRIMARY KEY,
                id_proveedor        INTEGER NOT NULL
                    REFERENCES restaurante.rest_proveedor(id_proveedor) ON DELETE CASCADE,
                -- De quién es ESTA fila. El precio es una negociación, no un hecho del mundo:
                -- dos negocios tienen su propia fila del mismo insumo del mismo proveedor.
                id_negocio          INTEGER NOT NULL
                    REFERENCES general.gener_negocio(id_negocio) ON DELETE RESTRICT,
                nombre              VARCHAR(160) NOT NULL,
                id_categoria_prov   INTEGER
                    REFERENCES restaurante.rest_proveedor_categoria_cat(id_categoria_prov) ON DELETE RESTRICT,
                -- El insumo del inventario al que corresponde, si lo tiene cargado. Es lo que
                -- permite que una compra sume stock y que el comparador hable del mismo insumo.
                id_ingrediente      INTEGER
                    REFERENCES restaurante.carta_ingrediente(id_ingrediente) ON DELETE SET NULL,

                unidad              VARCHAR(10) NOT NULL DEFAULT 'UN'
                    CHECK (unidad IN ('KG','G','L','ML','UN','CAJA','BULTO','PAQUETE','OTRA')),
                presentacion        VARCHAR(80),
                -- Cuántas unidades base trae la presentación: una caja de 12 → 12. Es lo único
                -- que permite comparar «caja de 12» contra «unidad» sin mentir. NULL = no se
                -- sabe, y entonces el comparador AVISA en vez de normalizar a ciegas.
                cantidad_presentacion NUMERIC(12,3)
                    CHECK (cantidad_presentacion IS NULL OR cantidad_presentacion > 0),

                precio              NUMERIC(12,2) CHECK (precio IS NULL OR precio >= 0),
                moneda              CHAR(3) NOT NULL DEFAULT 'COP',
                fecha_precio        DATE,
                -- ¿Se publica en el directorio? Solo sirve si además la ficha está en
                -- visibilidad DIRECTORIO: las dos condiciones, nunca una sola.
                publico             BOOLEAN NOT NULL DEFAULT false,
                disponible          BOOLEAN NOT NULL DEFAULT true,
                marca               VARCHAR(80),
                codigo_proveedor    VARCHAR(60),
                notas               TEXT,
                estado              CHAR(1) NOT NULL DEFAULT 'A',
                fecha_creacion      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                fecha_actualizacion TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE INDEX IF NOT EXISTS ix_rest_prov_insumo_proveedor
                ON restaurante.rest_proveedor_insumo (id_proveedor, estado);
            CREATE INDEX IF NOT EXISTS ix_rest_prov_insumo_negocio
                ON restaurante.rest_proveedor_insumo (id_negocio, estado);
            CREATE INDEX IF NOT EXISTS ix_rest_prov_insumo_ingrediente
                ON restaurante.rest_proveedor_insumo (id_ingrediente);
            CREATE INDEX IF NOT EXISTS ix_rest_prov_insumo_nombre
                ON restaurante.rest_proveedor_insumo (lower(nombre));
        `, { transaction: t });
        console.log('   ✓');

        // ── 6. Histórico de precios ─────────────────────────────────────────────────────
        //
        // Una fila por cambio. Es append-only: nunca se actualiza ni se borra, porque lo que
        // vale de un histórico es que no se pueda reescribir.
        console.log('6. Creando restaurante.rest_proveedor_precio...');
        await sequelize.query(`
            CREATE TABLE IF NOT EXISTS restaurante.rest_proveedor_precio (
                id_precio           SERIAL PRIMARY KEY,
                id_proveedor_insumo INTEGER NOT NULL
                    REFERENCES restaurante.rest_proveedor_insumo(id_proveedor_insumo) ON DELETE CASCADE,
                id_negocio          INTEGER NOT NULL,
                precio              NUMERIC(12,2) NOT NULL CHECK (precio >= 0),
                moneda              CHAR(3) NOT NULL DEFAULT 'COP',
                -- MANUAL: alguien lo escribió. COMPRA: salió de una factura, y por eso vale más.
                origen              VARCHAR(10) NOT NULL DEFAULT 'MANUAL'
                    CHECK (origen IN ('MANUAL', 'COMPRA')),
                id_compra           INTEGER,
                id_usuario          INTEGER
                    REFERENCES general.gener_usuario(id_usuario) ON DELETE RESTRICT,
                fecha               TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE INDEX IF NOT EXISTS ix_rest_prov_precio_insumo
                ON restaurante.rest_proveedor_precio (id_proveedor_insumo, fecha DESC);
        `, { transaction: t });
        console.log('   ✓');

        // ── 7. Compras ──────────────────────────────────────────────────────────────────
        console.log('7. Creando restaurante.rest_compra y rest_compra_detalle...');
        await sequelize.query(`
            CREATE TABLE IF NOT EXISTS restaurante.rest_compra (
                id_compra        SERIAL PRIMARY KEY,
                id_negocio       INTEGER NOT NULL
                    REFERENCES general.gener_negocio(id_negocio) ON DELETE RESTRICT,
                id_proveedor     INTEGER NOT NULL
                    REFERENCES restaurante.rest_proveedor(id_proveedor) ON DELETE RESTRICT,
                -- Hora de pared de Bogotá, como todo en este sistema. La fecha es la de la
                -- factura, que no tiene por qué ser la de hoy.
                fecha            DATE NOT NULL DEFAULT CURRENT_DATE,
                referencia       VARCHAR(60),
                subtotal         NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (subtotal >= 0),
                descuento        NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (descuento >= 0),
                impuesto         NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (impuesto >= 0),
                total            NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (total >= 0),
                id_metodo_pago   INTEGER
                    REFERENCES restaurante.rest_metodo_pago(id_metodo_pago) ON DELETE RESTRICT,
                observaciones    TEXT,
                adjunto_url      VARCHAR(255),
                -- ¿Sumó stock al inventario? Se guarda para poder revertir exactamente lo que
                -- se sumó al anular, sin recalcular ni adivinar.
                afecta_inventario BOOLEAN NOT NULL DEFAULT true,
                -- A: registrada · N: anulada (no se borra nunca)
                estado           CHAR(1) NOT NULL DEFAULT 'A' CHECK (estado IN ('A', 'N')),
                motivo_anulacion VARCHAR(200),
                id_usuario       INTEGER NOT NULL
                    REFERENCES general.gener_usuario(id_usuario) ON DELETE RESTRICT,
                fecha_creacion   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                fecha_anulacion  TIMESTAMP
            );
            CREATE INDEX IF NOT EXISTS ix_rest_compra_negocio
                ON restaurante.rest_compra (id_negocio, fecha DESC);
            CREATE INDEX IF NOT EXISTS ix_rest_compra_proveedor
                ON restaurante.rest_compra (id_proveedor, fecha DESC);

            CREATE TABLE IF NOT EXISTS restaurante.rest_compra_detalle (
                id_detalle          SERIAL PRIMARY KEY,
                id_compra           INTEGER NOT NULL
                    REFERENCES restaurante.rest_compra(id_compra) ON DELETE CASCADE,
                id_proveedor_insumo INTEGER
                    REFERENCES restaurante.rest_proveedor_insumo(id_proveedor_insumo) ON DELETE SET NULL,
                -- El insumo del inventario al que suma. NULL = la compra solo es gasto.
                id_ingrediente      INTEGER
                    REFERENCES restaurante.carta_ingrediente(id_ingrediente) ON DELETE SET NULL,
                -- Siempre se guarda el texto: el renglón tiene que seguir leyéndose dentro de
                -- un año aunque el insumo se haya borrado o renombrado.
                descripcion         VARCHAR(160) NOT NULL,
                cantidad            NUMERIC(12,3) NOT NULL CHECK (cantidad > 0),
                unidad              VARCHAR(10) NOT NULL DEFAULT 'UN',
                precio_unitario     NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (precio_unitario >= 0),
                descuento           NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (descuento >= 0),
                total               NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (total >= 0),
                -- Cuánto stock sumó de verdad (en la unidad del ingrediente). Lo que se resta
                -- al anular. 0 si el renglón no tocó el inventario.
                stock_sumado        NUMERIC(12,3) NOT NULL DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS ix_rest_compra_det_compra
                ON restaurante.rest_compra_detalle (id_compra);
            CREATE INDEX IF NOT EXISTS ix_rest_compra_det_insumo
                ON restaurante.rest_compra_detalle (id_proveedor_insumo);
            CREATE INDEX IF NOT EXISTS ix_rest_compra_det_ingrediente
                ON restaurante.rest_compra_detalle (id_ingrediente);
        `, { transaction: t });

        // La FK de `rest_proveedor_precio.id_compra` se añade aquí porque `rest_compra` se crea
        // después. Separada y con guarda para que la migración siga siendo idempotente.
        const fkPrecioCompra = await unaFila(
            `SELECT 1 AS hay FROM information_schema.table_constraints
              WHERE table_schema='restaurante' AND table_name='rest_proveedor_precio'
                AND constraint_name='fk_rest_prov_precio_compra';`,
            {},
            t,
        );
        if (!fkPrecioCompra) {
            await sequelize.query(`
                ALTER TABLE restaurante.rest_proveedor_precio
                ADD CONSTRAINT fk_rest_prov_precio_compra
                    FOREIGN KEY (id_compra) REFERENCES restaurante.rest_compra(id_compra) ON DELETE SET NULL;
            `, { transaction: t });
        }
        console.log('   ✓');

        // ── 8. Auditoría ────────────────────────────────────────────────────────────────
        //
        // Regla fija del proyecto: tabla con dinero o estado → trigger en la MISMA migración.
        // Quedan fuera `rest_proveedor_categoria` (N:M sin valor propio) y
        // `rest_proveedor_precio` (ya es un histórico append-only: auditarlo sería guardar dos
        // veces lo mismo).
        console.log('8. Registrando triggers de auditoría...');
        const fnAudit = await unaFila(
            `SELECT 1 AS hay FROM pg_proc p
              JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname='auditoria' AND p.proname='fn_audit';`,
            {},
            t,
        );
        if (fnAudit) {
            for (const [tabla, pk] of [
                ['rest_proveedor', 'id_proveedor'],
                ['rest_proveedor_negocio', 'id_proveedor_negocio'],
                ['rest_proveedor_insumo', 'id_proveedor_insumo'],
                ['rest_compra', 'id_compra'],
                ['rest_compra_detalle', 'id_detalle'],
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
            console.log('   ✓ 5 triggers');
        } else {
            console.log('   ! auditoria.fn_audit no existe; se omite (ejecuta migrate:auditoria-base)');
        }

        // ── 9. El módulo /proveedores ───────────────────────────────────────────────────
        console.log('9. Sembrando el módulo /proveedores...');
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
            SELECT 'PROVEEDORES', :idNivelPadre, 'truck', 'A', 1, :idTipoNegocio, :url, CURRENT_TIMESTAMP
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

        // ── 10. Los subniveles ──────────────────────────────────────────────────────────
        console.log('10. Sembrando los subniveles de acción...');
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
        console.log(`   ✓ ${SUBNIVELES.length} subniveles`);

        // ── 11. Permisos por rol ────────────────────────────────────────────────────────
        //
        // ADMINISTRADOR: todo. Nadie más, de salida — un mesero no necesita saber a cuánto
        // compra el dueño la carne. Quien quiera dárselo a su administrativo lo enciende en
        // Personal → Roles y permisos, que es donde se toman esas decisiones.
        console.log('11. Asignando permisos (ADMINISTRADOR)...');
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
        console.log('   ✓');

        // ── 12. Los negocios que ya existen ─────────────────────────────────────────────
        //
        // La trampa documentada: `gener_nivel_negocio` manda cuando el negocio tiene ajustes
        // propios, así que un restaurante con ajustes NO vería el módulo nuevo por no tener
        // fila aquí — y se quedaría mudo sin decir por qué.
        console.log('12. Backfill de gener_nivel_negocio...');
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
        console.log('\n✓ Migración de proveedores completada');
    } catch (error) {
        await t.rollback();
        console.error('✗ Error:', error.message);
        process.exitCode = 1;
    } finally {
        await sequelize.close();
    }
}

migrate();
