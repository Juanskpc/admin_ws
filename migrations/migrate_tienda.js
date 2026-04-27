/**
 * Migración inicial del módulo Tienda / Inventario.
 * Crea: tipo_negocio TIENDA + roles + esquema tienda + 8 tablas + niveles + permisos.
 *
 * Idempotente. Ejecutar con: npm run migrate:tienda
 */
require('dotenv').config();
const db = require('../app_core/models/conection');
const sequelize = db.sequelize;

async function migrate() {
    const t = await sequelize.transaction();
    try {
        console.log('→ Migración Tienda / Inventario\n');

        // 1. Tipo de negocio TIENDA
        console.log('1. Insertando tipo de negocio TIENDA...');
        await sequelize.query(`
            INSERT INTO general.gener_tipo_negocio (nombre, descripcion, estado)
            VALUES ('TIENDA', 'Negocio de tipo tienda / inventario bodega', 'A')
            ON CONFLICT (nombre) DO NOTHING;
        `, { transaction: t });

        const [[tipoTienda]] = await sequelize.query(`
            SELECT id_tipo_negocio FROM general.gener_tipo_negocio WHERE nombre='TIENDA';
        `, { transaction: t });
        const idTipoTienda = tipoTienda.id_tipo_negocio;
        console.log(`   id_tipo_negocio = ${idTipoTienda}\n`);

        // 2. Roles de la tienda
        console.log('2. Insertando roles...');
        await sequelize.query(`
            INSERT INTO general.gener_rol (descripcion, id_tipo_negocio, estado) VALUES
                ('ADMINISTRADOR', :tipo, 'A'),
                ('VENDEDOR',      :tipo, 'A'),
                ('BODEGUERO',     :tipo, 'A')
            ON CONFLICT DO NOTHING;
        `, { replacements: { tipo: idTipoTienda }, transaction: t });

        const rolesTienda = await sequelize.query(`
            SELECT id_rol, descripcion FROM general.gener_rol
            WHERE id_tipo_negocio = :tipo AND estado = 'A';
        `, { replacements: { tipo: idTipoTienda }, transaction: t, type: sequelize.QueryTypes.SELECT });
        const rolAdmin     = rolesTienda.find(r => r.descripcion === 'ADMINISTRADOR').id_rol;
        const rolVendedor  = rolesTienda.find(r => r.descripcion === 'VENDEDOR').id_rol;
        const rolBodeguero = rolesTienda.find(r => r.descripcion === 'BODEGUERO').id_rol;
        console.log('   ' + rolesTienda.map(r => `${r.descripcion}=${r.id_rol}`).join(', ') + '\n');

        // 3. Esquema tienda
        console.log('3. Creando esquema tienda...');
        await sequelize.query(`CREATE SCHEMA IF NOT EXISTS tienda;`, { transaction: t });
        console.log('   OK\n');

        // 4. tienda_categoria
        console.log('4. Creando tienda.tienda_categoria...');
        await sequelize.query(`
            CREATE TABLE IF NOT EXISTS tienda.tienda_categoria (
                id_categoria    SERIAL PRIMARY KEY,
                id_negocio      INTEGER NOT NULL REFERENCES general.gener_negocio(id_negocio) ON DELETE CASCADE,
                nombre          VARCHAR(120) NOT NULL,
                descripcion     TEXT,
                icono           VARCHAR(20),
                orden           INTEGER NOT NULL DEFAULT 0,
                estado          CHAR(1) NOT NULL DEFAULT 'A',
                fecha_creacion  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(id_negocio, nombre)
            );
        `, { transaction: t });
        await sequelize.query(`
            CREATE INDEX IF NOT EXISTS ix_tienda_categoria_negocio ON tienda.tienda_categoria (id_negocio, estado);
        `, { transaction: t });
        console.log('   OK\n');

        // 5. tienda_proveedor
        console.log('5. Creando tienda.tienda_proveedor...');
        await sequelize.query(`
            CREATE TABLE IF NOT EXISTS tienda.tienda_proveedor (
                id_proveedor        SERIAL PRIMARY KEY,
                id_negocio          INTEGER NOT NULL REFERENCES general.gener_negocio(id_negocio) ON DELETE CASCADE,
                nombre              VARCHAR(160) NOT NULL,
                nit_rut             VARCHAR(40),
                email               VARCHAR(160),
                telefono            VARCHAR(40),
                direccion           VARCHAR(255),
                contacto            VARCHAR(120),
                notas               TEXT,
                estado              CHAR(1) NOT NULL DEFAULT 'A',
                fecha_creacion      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                fecha_actualizacion TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
        `, { transaction: t });
        await sequelize.query(`
            CREATE INDEX IF NOT EXISTS ix_tienda_proveedor_negocio ON tienda.tienda_proveedor (id_negocio, estado);
        `, { transaction: t });
        console.log('   OK\n');

        // 6. tienda_producto
        console.log('6. Creando tienda.tienda_producto...');
        await sequelize.query(`
            CREATE TABLE IF NOT EXISTS tienda.tienda_producto (
                id_producto         SERIAL PRIMARY KEY,
                id_negocio          INTEGER NOT NULL REFERENCES general.gener_negocio(id_negocio) ON DELETE CASCADE,
                id_categoria        INTEGER REFERENCES tienda.tienda_categoria(id_categoria) ON DELETE SET NULL,
                id_proveedor        INTEGER REFERENCES tienda.tienda_proveedor(id_proveedor) ON DELETE SET NULL,
                nombre              VARCHAR(200) NOT NULL,
                descripcion         TEXT,
                sku                 VARCHAR(80),
                codigo_barras       VARCHAR(80),
                precio_venta        NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (precio_venta >= 0),
                precio_costo        NUMERIC(14,2) DEFAULT 0 CHECK (precio_costo >= 0),
                stock_actual        NUMERIC(14,3) NOT NULL DEFAULT 0,
                stock_minimo        NUMERIC(14,3) NOT NULL DEFAULT 0 CHECK (stock_minimo >= 0),
                unidad_medida       VARCHAR(30) NOT NULL DEFAULT 'und',
                imagen_url          VARCHAR(500),
                ubicacion           VARCHAR(120),
                es_servicio         BOOLEAN NOT NULL DEFAULT FALSE,
                estado              CHAR(1) NOT NULL DEFAULT 'A',
                fecha_creacion      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                fecha_actualizacion TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
        `, { transaction: t });
        await sequelize.query(`
            CREATE INDEX IF NOT EXISTS ix_tienda_producto_negocio   ON tienda.tienda_producto (id_negocio, estado);
            CREATE INDEX IF NOT EXISTS ix_tienda_producto_categoria  ON tienda.tienda_producto (id_negocio, id_categoria);
            CREATE INDEX IF NOT EXISTS ix_tienda_producto_proveedor  ON tienda.tienda_producto (id_negocio, id_proveedor);
            CREATE UNIQUE INDEX IF NOT EXISTS uq_tienda_producto_sku
                ON tienda.tienda_producto (id_negocio, sku)
                WHERE sku IS NOT NULL AND sku <> '';
        `, { transaction: t });
        console.log('   OK\n');

        // 7. tienda_movimiento
        console.log('7. Creando tienda.tienda_movimiento...');
        await sequelize.query(`
            CREATE TABLE IF NOT EXISTS tienda.tienda_movimiento (
                id_movimiento    SERIAL PRIMARY KEY,
                id_negocio       INTEGER NOT NULL REFERENCES general.gener_negocio(id_negocio) ON DELETE CASCADE,
                tipo             VARCHAR(20) NOT NULL CHECK (tipo IN ('ENTRADA','SALIDA','AJUSTE','DEVOLUCION','TRASLADO')),
                referencia       VARCHAR(80),
                observacion      TEXT,
                id_usuario       INTEGER REFERENCES general.gener_usuario(id_usuario),
                total_items      INTEGER NOT NULL DEFAULT 0,
                estado           VARCHAR(20) NOT NULL DEFAULT 'CONFIRMADO' CHECK (estado IN ('BORRADOR','CONFIRMADO','ANULADO')),
                fecha_movimiento TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                fecha_creacion   TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
        `, { transaction: t });
        await sequelize.query(`
            CREATE INDEX IF NOT EXISTS ix_tienda_movimiento_negocio ON tienda.tienda_movimiento (id_negocio, fecha_movimiento DESC);
            CREATE INDEX IF NOT EXISTS ix_tienda_movimiento_tipo    ON tienda.tienda_movimiento (id_negocio, tipo, fecha_movimiento DESC);
        `, { transaction: t });
        console.log('   OK\n');

        // 8. tienda_mov_detalle
        console.log('8. Creando tienda.tienda_mov_detalle...');
        await sequelize.query(`
            CREATE TABLE IF NOT EXISTS tienda.tienda_mov_detalle (
                id_detalle      SERIAL PRIMARY KEY,
                id_movimiento   INTEGER NOT NULL REFERENCES tienda.tienda_movimiento(id_movimiento) ON DELETE CASCADE,
                id_producto     INTEGER NOT NULL REFERENCES tienda.tienda_producto(id_producto),
                id_negocio      INTEGER NOT NULL REFERENCES general.gener_negocio(id_negocio),
                cantidad        NUMERIC(14,3) NOT NULL CHECK (cantidad > 0),
                costo_unitario  NUMERIC(14,2),
                subtotal        NUMERIC(14,2) GENERATED ALWAYS AS (ROUND(cantidad * COALESCE(costo_unitario, 0), 2)) STORED
            );
        `, { transaction: t });
        await sequelize.query(`
            CREATE INDEX IF NOT EXISTS ix_tienda_mov_detalle_movimiento ON tienda.tienda_mov_detalle (id_movimiento);
            CREATE INDEX IF NOT EXISTS ix_tienda_mov_detalle_producto    ON tienda.tienda_mov_detalle (id_producto);
        `, { transaction: t });
        console.log('   OK\n');

        // 9. tienda_cliente
        console.log('9. Creando tienda.tienda_cliente...');
        await sequelize.query(`
            CREATE TABLE IF NOT EXISTS tienda.tienda_cliente (
                id_cliente          SERIAL PRIMARY KEY,
                id_negocio          INTEGER NOT NULL REFERENCES general.gener_negocio(id_negocio) ON DELETE CASCADE,
                nombre              VARCHAR(160) NOT NULL,
                tipo_doc            VARCHAR(20),
                num_doc             VARCHAR(40),
                email               VARCHAR(160),
                telefono            VARCHAR(40),
                direccion           VARCHAR(255),
                notas               TEXT,
                estado              CHAR(1) NOT NULL DEFAULT 'A',
                fecha_creacion      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                fecha_actualizacion TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
        `, { transaction: t });
        await sequelize.query(`
            CREATE INDEX IF NOT EXISTS ix_tienda_cliente_negocio ON tienda.tienda_cliente (id_negocio, estado);
        `, { transaction: t });
        console.log('   OK\n');

        // 10. tienda_venta
        console.log('10. Creando tienda.tienda_venta...');
        await sequelize.query(`
            CREATE TABLE IF NOT EXISTS tienda.tienda_venta (
                id_venta        SERIAL PRIMARY KEY,
                id_negocio      INTEGER NOT NULL REFERENCES general.gener_negocio(id_negocio) ON DELETE CASCADE,
                id_cliente      INTEGER REFERENCES tienda.tienda_cliente(id_cliente) ON DELETE SET NULL,
                id_usuario      INTEGER REFERENCES general.gener_usuario(id_usuario),
                subtotal        NUMERIC(14,2) NOT NULL DEFAULT 0,
                descuento       NUMERIC(14,2) NOT NULL DEFAULT 0,
                total           NUMERIC(14,2) NOT NULL DEFAULT 0,
                metodo_pago     VARCHAR(30) NOT NULL DEFAULT 'EFECTIVO' CHECK (metodo_pago IN ('EFECTIVO','TARJETA','TRANSFERENCIA','OTRO')),
                estado          VARCHAR(20) NOT NULL DEFAULT 'COMPLETADA' CHECK (estado IN ('BORRADOR','COMPLETADA','ANULADA')),
                notas           TEXT,
                fecha_venta     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                fecha_creacion  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
        `, { transaction: t });
        await sequelize.query(`
            CREATE INDEX IF NOT EXISTS ix_tienda_venta_negocio ON tienda.tienda_venta (id_negocio, fecha_venta DESC);
            CREATE INDEX IF NOT EXISTS ix_tienda_venta_cliente  ON tienda.tienda_venta (id_negocio, id_cliente);
        `, { transaction: t });
        console.log('   OK\n');

        // 11. tienda_venta_detalle
        console.log('11. Creando tienda.tienda_venta_detalle...');
        await sequelize.query(`
            CREATE TABLE IF NOT EXISTS tienda.tienda_venta_detalle (
                id_detalle      SERIAL PRIMARY KEY,
                id_venta        INTEGER NOT NULL REFERENCES tienda.tienda_venta(id_venta) ON DELETE CASCADE,
                id_producto     INTEGER NOT NULL REFERENCES tienda.tienda_producto(id_producto),
                id_negocio      INTEGER NOT NULL REFERENCES general.gener_negocio(id_negocio),
                cantidad        NUMERIC(14,3) NOT NULL CHECK (cantidad > 0),
                precio_unitario NUMERIC(14,2) NOT NULL CHECK (precio_unitario >= 0),
                descuento       NUMERIC(14,2) NOT NULL DEFAULT 0,
                subtotal        NUMERIC(14,2) GENERATED ALWAYS AS (ROUND(cantidad * precio_unitario - descuento, 2)) STORED
            );
        `, { transaction: t });
        await sequelize.query(`
            CREATE INDEX IF NOT EXISTS ix_tienda_venta_detalle_venta    ON tienda.tienda_venta_detalle (id_venta);
            CREATE INDEX IF NOT EXISTS ix_tienda_venta_detalle_producto ON tienda.tienda_venta_detalle (id_producto);
        `, { transaction: t });
        console.log('   OK\n');

        // 12. Niveles de navegación
        console.log('12. Insertando niveles de navegación...');
        await sequelize.query(`
            INSERT INTO general.gener_nivel
                (descripcion, id_nivel_padre, icono, estado, id_tipo_nivel, url, id_tipo_negocio)
            SELECT 'TIENDA', NULL, 'shopping-bag', 'A', 1, '/tienda', :tipo
            WHERE NOT EXISTS (
                SELECT 1 FROM general.gener_nivel
                WHERE id_tipo_negocio = :tipo AND id_tipo_nivel = 1 AND url = '/tienda'
            );
        `, { replacements: { tipo: idTipoTienda }, transaction: t });

        const [[nivelRoot]] = await sequelize.query(`
            SELECT id_nivel FROM general.gener_nivel
            WHERE id_tipo_negocio = :tipo AND id_tipo_nivel = 1 AND url = '/tienda';
        `, { replacements: { tipo: idTipoTienda }, transaction: t });
        const idNivelRoot = nivelRoot.id_nivel;

        const modulos = [
            ['DASHBOARD',     '/dashboard',     'layout-dashboard'],
            ['PRODUCTOS',     '/productos',     'package'],
            ['CATEGORIAS',    '/categorias',    'folder'],
            ['MOVIMIENTOS',   '/movimientos',   'arrow-left-right'],
            ['PROVEEDORES',   '/proveedores',   'truck'],
            ['VENTAS',        '/ventas',        'shopping-cart'],
            ['CLIENTES',      '/clientes',      'users'],
            ['CONFIGURACION', '/configuracion', 'settings'],
        ];
        for (const [desc, url, icono] of modulos) {
            await sequelize.query(`
                INSERT INTO general.gener_nivel
                    (descripcion, id_nivel_padre, icono, estado, id_tipo_nivel, url, id_tipo_negocio)
                SELECT :desc, :padre, :icono, 'A', 1, :url, :tipo
                WHERE NOT EXISTS (
                    SELECT 1 FROM general.gener_nivel
                    WHERE id_tipo_negocio = :tipo AND id_tipo_nivel = 1 AND url = :url
                );
            `, { replacements: { desc, url, icono, padre: idNivelRoot, tipo: idTipoTienda }, transaction: t });
        }
        console.log('   OK\n');

        // 13. Permisos por rol
        console.log('13. Asignando permisos por rol...');

        // ADMINISTRADOR: acceso total a todos los 8 módulos hijo
        await sequelize.query(`
            INSERT INTO general.gener_rol_nivel
                (id_rol, id_nivel, puede_ver, puede_crear, puede_editar, puede_eliminar, estado)
            SELECT :rol, n.id_nivel, true, true, true, true, 'A'
            FROM general.gener_nivel n
            WHERE n.id_tipo_negocio = :tipo
              AND n.id_tipo_nivel = 1
              AND n.url IS NOT NULL
              AND n.url <> '/tienda'
            ON CONFLICT (id_rol, id_nivel) DO NOTHING;
        `, { replacements: { rol: rolAdmin, tipo: idTipoTienda }, transaction: t });

        // VENDEDOR: /dashboard (ver), /productos (ver), /ventas (ver+crear+editar), /clientes (ver+crear+editar)
        await sequelize.query(`
            INSERT INTO general.gener_rol_nivel
                (id_rol, id_nivel, puede_ver, puede_crear, puede_editar, puede_eliminar, estado)
            SELECT :rol, n.id_nivel,
                   true,
                   CASE WHEN n.url IN ('/ventas', '/clientes') THEN true ELSE false END,
                   CASE WHEN n.url IN ('/ventas', '/clientes') THEN true ELSE false END,
                   false, 'A'
            FROM general.gener_nivel n
            WHERE n.id_tipo_negocio = :tipo
              AND n.id_tipo_nivel = 1
              AND n.url IN ('/dashboard', '/productos', '/ventas', '/clientes')
            ON CONFLICT (id_rol, id_nivel) DO NOTHING;
        `, { replacements: { rol: rolVendedor, tipo: idTipoTienda }, transaction: t });

        // BODEGUERO: /dashboard (ver), /productos (ver+crear+editar), /categorias (ver+crear),
        //            /movimientos (ver+crear), /proveedores (ver+crear+editar)
        await sequelize.query(`
            INSERT INTO general.gener_rol_nivel
                (id_rol, id_nivel, puede_ver, puede_crear, puede_editar, puede_eliminar, estado)
            SELECT :rol, n.id_nivel,
                   true,
                   CASE WHEN n.url IN ('/productos', '/categorias', '/movimientos', '/proveedores') THEN true ELSE false END,
                   CASE WHEN n.url IN ('/productos', '/proveedores') THEN true ELSE false END,
                   false, 'A'
            FROM general.gener_nivel n
            WHERE n.id_tipo_negocio = :tipo
              AND n.id_tipo_nivel = 1
              AND n.url IN ('/dashboard', '/productos', '/categorias', '/movimientos', '/proveedores')
            ON CONFLICT (id_rol, id_nivel) DO NOTHING;
        `, { replacements: { rol: rolBodeguero, tipo: idTipoTienda }, transaction: t });
        console.log('   OK\n');

        // 14. Backfill por-negocio (si ya existen negocios tipo TIENDA)
        console.log('14. Backfill gener_nivel_negocio para negocios TIENDA existentes...');
        await sequelize.query(`
            INSERT INTO general.gener_nivel_negocio
                (id_negocio, id_rol, id_nivel, puede_ver, estado, fecha_creacion, fecha_actualizacion)
            SELECT neg.id_negocio, rn.id_rol, rn.id_nivel, rn.puede_ver, 'A',
                   CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
            FROM general.gener_negocio neg
            JOIN general.gener_rol_nivel rn ON rn.id_rol IN (
                SELECT id_rol FROM general.gener_rol WHERE id_tipo_negocio = :tipo AND estado = 'A'
            )
            JOIN general.gener_nivel niv ON niv.id_nivel = rn.id_nivel
                                         AND niv.id_tipo_negocio = :tipo
                                         AND niv.id_tipo_nivel = 1
            WHERE neg.id_tipo_negocio = :tipo AND neg.estado = 'A'
            ON CONFLICT (id_negocio, id_rol, id_nivel) DO NOTHING;
        `, { replacements: { tipo: idTipoTienda }, transaction: t });
        console.log('   OK\n');

        // 15. Crear negocio demo Tienda
        console.log('15. Creando negocio demo Tienda...');
        await sequelize.query(`
            INSERT INTO general.gener_negocio (nombre, nit, email_contacto, id_tipo_negocio, estado)
            VALUES ('Tienda Demo EscalApp', '900-TIENDA-001', 'tienda@escalapp.cloud', :tipo, 'A')
            ON CONFLICT DO NOTHING;
        `, { replacements: { tipo: idTipoTienda }, transaction: t });

        const [[negocioTienda]] = await sequelize.query(`
            SELECT id_negocio FROM general.gener_negocio
            WHERE nit = '900-TIENDA-001' AND id_tipo_negocio = :tipo;
        `, { replacements: { tipo: idTipoTienda }, transaction: t });

        if (negocioTienda) {
            const idNegocioTienda = negocioTienda.id_negocio;
            console.log(`   id_negocio = ${idNegocioTienda}`);

            // Buscar usuario por num_identificacion
            const [[usuarioPrincipal]] = await sequelize.query(`
                SELECT id_usuario FROM general.gener_usuario
                WHERE num_identificacion = '1193035399' AND estado = 'A';
            `, { transaction: t });

            if (usuarioPrincipal) {
                const idUsuario = usuarioPrincipal.id_usuario;
                console.log(`   id_usuario = ${idUsuario}`);

                // Vincular usuario al negocio
                await sequelize.query(`
                    INSERT INTO general.gener_negocio_usuario (id_negocio, id_usuario, estado)
                    VALUES (:neg, :usr, 'A')
                    ON CONFLICT DO NOTHING;
                `, { replacements: { neg: idNegocioTienda, usr: idUsuario }, transaction: t });

                // Asignar rol ADMINISTRADOR
                await sequelize.query(`
                    INSERT INTO general.gener_usuario_rol (id_usuario, id_rol, id_negocio, estado)
                    VALUES (:usr, :rol, :neg, 'A')
                    ON CONFLICT DO NOTHING;
                `, { replacements: { usr: idUsuario, rol: rolAdmin, neg: idNegocioTienda }, transaction: t });

                // Backfill nivel_negocio para este negocio+usuario (via rol admin)
                await sequelize.query(`
                    INSERT INTO general.gener_nivel_negocio
                        (id_negocio, id_rol, id_nivel, puede_ver, estado, fecha_creacion, fecha_actualizacion)
                    SELECT :neg, rn.id_rol, rn.id_nivel, rn.puede_ver, 'A',
                           CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
                    FROM general.gener_rol_nivel rn
                    JOIN general.gener_nivel niv ON niv.id_nivel = rn.id_nivel
                                                 AND niv.id_tipo_negocio = :tipo
                                                 AND niv.id_tipo_nivel = 1
                    WHERE rn.id_rol = :rol
                    ON CONFLICT (id_negocio, id_rol, id_nivel) DO NOTHING;
                `, { replacements: { neg: idNegocioTienda, tipo: idTipoTienda, rol: rolAdmin }, transaction: t });

                console.log('   Usuario vinculado y permisos asignados.\n');
            } else {
                console.log('   Usuario 1193035399 no encontrado, saltando asignación.\n');
            }
        } else {
            console.log('   Negocio demo no creado (posiblemente ya existe con otro NIT).\n');
        }

        await t.commit();
        console.log('✓ Migración Tienda completada');
        console.log(`  tipo_negocio = ${idTipoTienda}, roles = ${rolesTienda.map(r => r.descripcion).join(', ')}`);
    } catch (error) {
        await t.rollback();
        console.error('✗ Error:', error.message);
        console.error(error);
        process.exitCode = 1;
    } finally {
        await sequelize.close();
    }
}

migrate();
