/**
 * Venta de productos en `reserva`: cualquier negocio del vertical (barbería, salón, spa,
 * estética, tatuaje, mascotas, alojamiento) puede publicar un catálogo de productos físicos
 * junto a sus servicios, vender desde el mostrador con o sin cita, y el cliente puede comprarlos
 * en el portal para recoger en el local. Ver `docs/productos-en-reserva.md`.
 *
 *   npm run migrate:reserva-productos
 *
 * ## Es la misma regla que las demás funciones del perfil
 *
 * `productos` es una función más del catálogo (`app_reserva_api/perfiles/definiciones.js`),
 * disponible en los **siete** perfiles y apagada de fábrica en todos: no es que la barbería no
 * la tenga, es que ningún negocio la trae encendida hasta que su dueño la activa en
 * Configuración → Funciones. Con la función apagada, `/productos` no aparece en el menú y las
 * rutas responden 403 (`exigirFuncion('productos')`).
 *
 * `reserva` tiene cliente en producción desde el 2026-09-09 (ADR-003): todo lo de aquí es
 * aditivo — tablas nuevas y columnas nuevas nullable o con default neutro.
 *
 * ## Qué crea
 *
 * 1. `reserva_producto_categoria` — secciones del catálogo de productos (independiente de
 *    `reserva_categoria`, que es de servicios: mezclar las dos habría obligado a filtrar por
 *    tipo en cada consulta que ya usa `reserva_categoria`, con el riesgo de colar una categoría
 *    de productos en el listado de servicios).
 * 2. `reserva_producto` — el catálogo. `controla_stock` nace en `false`: la mayoría de negocios
 *    no va a mantener un inventario al día, y un stock sin mantener cayendo a negativo es peor
 *    que no tener stock.
 * 3. `reserva_venta_producto` + `reserva_venta_producto_detalle` — la venta (mostrador o
 *    portal), opcionalmente ligada a una cita (`id_cita` nullable: se puede comprar sin cita).
 * 4. `reserva_movimiento_caja.id_venta_producto` — para que una venta de producto se vea en el
 *    cuadre de caja exactamente como un cobro de cita.
 * 5. `reserva_config.comision_productos_pct` — 0 por defecto: la comisión es una decisión del
 *    negocio, no algo que se enciende solo.
 * 6. La vista `/productos` en el catálogo de permisos.
 *
 * Las **acciones** (`productos_editar`, `productos_vender`) se siembran en
 * `migrate_reserva_subniveles.js`, que debe correrse DESPUÉS de esta (las acciones cuelgan de una
 * vista que tiene que existir primero).
 *
 * Idempotente: guardas `IF NOT EXISTS` / `information_schema` en cada paso.
 */
'use strict';
require('dotenv').config();
const { sequelize } = require('../app_core/models/conection');
const { publicarVista, asegurarColumna } = require('./lib_vistas_reserva');

async function migrar() {
    const t = await sequelize.transaction();
    try {
        console.log('\n=== Migración: venta de productos (reserva) ===\n');

        console.log('1. reserva_producto_categoria...');
        await sequelize.query(`
            CREATE TABLE IF NOT EXISTS reserva.reserva_producto_categoria (
                id_categoria        SERIAL PRIMARY KEY,
                id_negocio          INTEGER NOT NULL REFERENCES general.gener_negocio(id_negocio),
                nombre              VARCHAR(120) NOT NULL,
                descripcion         TEXT,
                orden               INTEGER NOT NULL DEFAULT 0,
                estado              CHAR(1) NOT NULL DEFAULT 'A',
                fecha_creacion      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                fecha_actualizacion TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE INDEX IF NOT EXISTS idx_reserva_prod_categoria_negocio
                ON reserva.reserva_producto_categoria (id_negocio);
        `, { transaction: t });
        console.log('   OK');

        console.log('\n2. reserva_producto...');
        await sequelize.query(`
            CREATE TABLE IF NOT EXISTS reserva.reserva_producto (
                id_producto         SERIAL PRIMARY KEY,
                id_negocio          INTEGER NOT NULL REFERENCES general.gener_negocio(id_negocio),
                id_categoria        INTEGER NULL REFERENCES reserva.reserva_producto_categoria(id_categoria),
                nombre              VARCHAR(150) NOT NULL,
                descripcion         TEXT,
                precio              NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (precio >= 0),
                imagen_url          VARCHAR(500),
                controla_stock      BOOLEAN NOT NULL DEFAULT false,
                stock_actual        NUMERIC(14,3) NOT NULL DEFAULT 0,
                publico_activo      BOOLEAN NOT NULL DEFAULT true,
                estado              CHAR(1) NOT NULL DEFAULT 'A',
                fecha_creacion      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                fecha_actualizacion TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE INDEX IF NOT EXISTS idx_reserva_producto_negocio
                ON reserva.reserva_producto (id_negocio, estado);
            CREATE INDEX IF NOT EXISTS idx_reserva_producto_categoria
                ON reserva.reserva_producto (id_categoria);
        `, { transaction: t });
        console.log('   OK');

        console.log('\n3. reserva_venta_producto / detalle...');
        await sequelize.query(`
            CREATE TABLE IF NOT EXISTS reserva.reserva_venta_producto (
                id_venta            SERIAL PRIMARY KEY,
                id_negocio          INTEGER NOT NULL REFERENCES general.gener_negocio(id_negocio),
                id_cita             INTEGER NULL REFERENCES reserva.reserva_cita(id_cita) ON DELETE SET NULL,
                id_persona_negocio  UUID NULL REFERENCES platform.persona_negocio(id_persona_negocio),
                id_profesional      INTEGER NULL REFERENCES reserva.reserva_profesional(id_profesional),
                id_usuario          INTEGER NULL REFERENCES general.gener_usuario(id_usuario),
                canal               VARCHAR(10) NOT NULL DEFAULT 'MOSTRADOR'
                                        CHECK (canal IN ('MOSTRADOR', 'PORTAL')),
                entrega             VARCHAR(10) NOT NULL DEFAULT 'MOSTRADOR'
                                        CHECK (entrega IN ('MOSTRADOR', 'RECOGER')),
                estado              VARCHAR(12) NOT NULL DEFAULT 'PENDIENTE'
                                        CHECK (estado IN ('PENDIENTE', 'COMPLETADA', 'CANCELADA')),
                total               NUMERIC(14,2) NOT NULL DEFAULT 0,
                cliente_nombre      VARCHAR(150),
                cliente_telefono    VARCHAR(30),
                notas               TEXT,
                id_caja             INTEGER NULL REFERENCES reserva.reserva_caja(id_caja),
                fecha_creacion      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                fecha_completada    TIMESTAMP
            );
            CREATE INDEX IF NOT EXISTS idx_reserva_venta_prod_negocio
                ON reserva.reserva_venta_producto (id_negocio, estado, fecha_creacion DESC);
            CREATE INDEX IF NOT EXISTS idx_reserva_venta_prod_cita
                ON reserva.reserva_venta_producto (id_cita) WHERE id_cita IS NOT NULL;

            CREATE TABLE IF NOT EXISTS reserva.reserva_venta_producto_detalle (
                id_detalle          SERIAL PRIMARY KEY,
                id_venta            INTEGER NOT NULL REFERENCES reserva.reserva_venta_producto(id_venta) ON DELETE CASCADE,
                id_producto         INTEGER NOT NULL REFERENCES reserva.reserva_producto(id_producto),
                nombre_snapshot     VARCHAR(150) NOT NULL,
                precio_snapshot     NUMERIC(14,2) NOT NULL,
                cantidad            NUMERIC(10,2) NOT NULL DEFAULT 1 CHECK (cantidad > 0),
                subtotal            NUMERIC(14,2) NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_reserva_venta_prod_detalle_venta
                ON reserva.reserva_venta_producto_detalle (id_venta);
        `, { transaction: t });
        console.log('   OK');

        console.log('\n4. reserva_movimiento_caja.id_venta_producto...');
        await asegurarColumna(sequelize, t, 'reserva', 'reserva_movimiento_caja', 'id_venta_producto',
            'INTEGER NULL REFERENCES reserva.reserva_venta_producto(id_venta)');

        console.log('\n5. reserva_config.comision_productos_pct...');
        await asegurarColumna(sequelize, t, 'reserva', 'reserva_config', 'comision_productos_pct',
            'SMALLINT NOT NULL DEFAULT 0 CHECK (comision_productos_pct BETWEEN 0 AND 100)');

        console.log('\n6. Vista del catálogo de permisos...');
        const productos = await publicarVista(sequelize, t, {
            url: '/productos', descripcion: 'PRODUCTOS', icono: 'shopping-bag',
            roles: {
                ADMINISTRADOR: { crear: true, editar: true, eliminar: true },
                RECEPCIONISTA: { crear: true, editar: true },
                PROFESIONAL: {},
            },
        });
        console.log(`   /productos (${productos.ajustes} ajuste(s) de negocio)`);

        await t.commit();
        console.log('\n✓ Migración de productos completada.');
        console.log('  Siguiente: npm run migrate:reserva-subniveles (acciones productos_editar / productos_vender)\n');
    } catch (err) {
        await t.rollback();
        console.error('\n✗ Error — se revirtió todo:', err.message, '\n');
        process.exitCode = 1;
    } finally {
        await sequelize.close();
    }
}

migrar();
