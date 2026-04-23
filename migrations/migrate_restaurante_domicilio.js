/**
 * Migración: tipo de pedido + datos de domicilio + módulo Despacho.
 *  - Agrega columnas a pedid_orden: tipo_pedido, contacto_*, direccion_domicilio,
 *    nota_domicilio, id_domiciliario.
 *  - Migra datos existentes: id_mesa NULL → 'LLEVAR', else 'MESA'.
 *  - Inserta nivel /despacho + subnivel despacho_ver_todos.
 *  - Backfill permisos por-negocio.
 *
 * Idempotente. npm run migrate:restaurante-domicilio
 */
require('dotenv').config();
const db = require('../app_core/models/conection');
const sequelize = db.sequelize;

const TIPO_RESTAURANTE = 1;

async function migrate() {
    const t = await sequelize.transaction();
    try {
        console.log('→ Migración Restaurante - Domicilio + Despacho\n');

        // 1. Columnas en pedid_orden
        console.log('1. Agregando columnas a pedid_orden...');
        const colsToAdd = [
            ['tipo_pedido',          "VARCHAR(20) NOT NULL DEFAULT 'MESA' CHECK (tipo_pedido IN ('MESA','LLEVAR','DOMICILIO'))"],
            ['contacto_nombre',      'VARCHAR(160)'],
            ['contacto_telefono',    'VARCHAR(40)'],
            ['direccion_domicilio',  'VARCHAR(500)'],
            ['nota_domicilio',       'TEXT'],
            ['id_domiciliario',      'INTEGER REFERENCES general.gener_usuario(id_usuario) ON DELETE SET NULL'],
        ];
        for (const [name, def] of colsToAdd) {
            const [cols] = await sequelize.query(`
                SELECT 1 FROM information_schema.columns
                WHERE table_schema='restaurante' AND table_name='pedid_orden'
                  AND column_name=:col;
            `, { replacements: { col: name }, transaction: t });
            if (cols.length === 0) {
                await sequelize.query(
                    `ALTER TABLE restaurante.pedid_orden ADD COLUMN ${name} ${def};`,
                    { transaction: t }
                );
            }
        }
        console.log('   OK\n');

        // 2. Backfill tipo_pedido en datos existentes
        console.log('2. Backfill tipo_pedido en datos históricos...');
        await sequelize.query(`
            UPDATE restaurante.pedid_orden
               SET tipo_pedido = CASE WHEN id_mesa IS NULL THEN 'LLEVAR' ELSE 'MESA' END
             WHERE tipo_pedido = 'MESA' OR tipo_pedido IS NULL;
        `, { transaction: t });

        // 3. Nivel /despacho
        console.log('3. Creando nivel /despacho...');
        const [[modPedidos]] = await sequelize.query(`
            SELECT id_nivel FROM general.gener_nivel
            WHERE id_tipo_negocio = :tipo AND id_tipo_nivel = 1 AND url = '/pedidos';
        `, { replacements: { tipo: TIPO_RESTAURANTE }, transaction: t });
        const padreModulo = modPedidos?.id_nivel ?? null;

        await sequelize.query(`
            INSERT INTO general.gener_nivel
                (descripcion, id_nivel_padre, icono, estado, id_tipo_nivel, url, id_tipo_negocio)
            SELECT 'DESPACHO', :padre, 'bike', 'A', 1, '/despacho', :tipo
            WHERE NOT EXISTS (
                SELECT 1 FROM general.gener_nivel
                WHERE id_tipo_negocio = :tipo AND id_tipo_nivel = 1 AND url = '/despacho'
            );
        `, { replacements: { padre: padreModulo, tipo: TIPO_RESTAURANTE }, transaction: t });

        const [[nivelDespacho]] = await sequelize.query(`
            SELECT id_nivel FROM general.gener_nivel
            WHERE id_tipo_negocio = :tipo AND id_tipo_nivel = 1 AND url = '/despacho';
        `, { replacements: { tipo: TIPO_RESTAURANTE }, transaction: t });

        // 4. Subnivel despacho_ver_todos
        console.log('4. Creando subnivel despacho_ver_todos...');
        await sequelize.query(`
            INSERT INTO general.gener_nivel
                (descripcion, id_nivel_padre, icono, estado, id_tipo_nivel, url, id_tipo_negocio)
            SELECT 'DESPACHO - VER TODOS', :padre, NULL, 'A', 4, 'despacho_ver_todos', :tipo
            WHERE NOT EXISTS (
                SELECT 1 FROM general.gener_nivel
                WHERE id_tipo_negocio = :tipo AND id_tipo_nivel = 4 AND url = 'despacho_ver_todos'
            );
        `, { replacements: { padre: nivelDespacho.id_nivel, tipo: TIPO_RESTAURANTE }, transaction: t });

        // 5. Permisos por rol (matriz global)
        console.log('5. Asignando permisos a roles del restaurante...');
        const rolesRest = await sequelize.query(`
            SELECT id_rol, descripcion FROM general.gener_rol
            WHERE id_tipo_negocio = :tipo AND estado = 'A';
        `, { replacements: { tipo: TIPO_RESTAURANTE }, transaction: t, type: sequelize.QueryTypes.SELECT });
        const rolAdmin = rolesRest.find(r => r.descripcion === 'ADMINISTRADOR')?.id_rol;
        const rolDom   = rolesRest.find(r => r.descripcion === 'DOMICILIARIO')?.id_rol;
        const rolMesero = rolesRest.find(r => r.descripcion === 'MESERO')?.id_rol;
        const rolCajero = rolesRest.find(r => r.descripcion === 'CAJERO')?.id_rol;

        // ADMIN: módulo + ver todos
        await sequelize.query(`
            INSERT INTO general.gener_rol_nivel
                (id_rol, id_nivel, puede_ver, puede_crear, puede_editar, puede_eliminar, estado)
            SELECT :rol, n.id_nivel, true, true, true, true, 'A'
            FROM general.gener_nivel n
            WHERE n.id_tipo_negocio = :tipo
              AND ((n.id_tipo_nivel = 1 AND n.url = '/despacho')
                OR (n.id_tipo_nivel = 4 AND n.url = 'despacho_ver_todos'))
            ON CONFLICT (id_rol, id_nivel) DO NOTHING;
        `, { replacements: { rol: rolAdmin, tipo: TIPO_RESTAURANTE }, transaction: t });

        // DOMICILIARIO: módulo (solo sus pedidos)
        if (rolDom) {
            await sequelize.query(`
                INSERT INTO general.gener_rol_nivel
                    (id_rol, id_nivel, puede_ver, puede_crear, puede_editar, puede_eliminar, estado)
                SELECT :rol, n.id_nivel, true, false, true, false, 'A'
                FROM general.gener_nivel n
                WHERE n.id_tipo_negocio = :tipo
                  AND n.id_tipo_nivel = 1 AND n.url = '/despacho'
                ON CONFLICT (id_rol, id_nivel) DO NOTHING;
            `, { replacements: { rol: rolDom, tipo: TIPO_RESTAURANTE }, transaction: t });
        }

        // MESERO + CAJERO: ver módulo + ver todos (necesitan asignar)
        for (const rol of [rolMesero, rolCajero].filter(Boolean)) {
            await sequelize.query(`
                INSERT INTO general.gener_rol_nivel
                    (id_rol, id_nivel, puede_ver, puede_crear, puede_editar, puede_eliminar, estado)
                SELECT :rol, n.id_nivel, true, true, true, false, 'A'
                FROM general.gener_nivel n
                WHERE n.id_tipo_negocio = :tipo
                  AND ((n.id_tipo_nivel = 1 AND n.url = '/despacho')
                    OR (n.id_tipo_nivel = 4 AND n.url = 'despacho_ver_todos'))
                ON CONFLICT (id_rol, id_nivel) DO NOTHING;
            `, { replacements: { rol, tipo: TIPO_RESTAURANTE }, transaction: t });
        }

        // 6. Backfill por-negocio
        console.log('6. Backfill gener_nivel_negocio para restaurantes...');
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
                                         AND ((niv.id_tipo_nivel = 1 AND niv.url = '/despacho')
                                           OR (niv.id_tipo_nivel = 4 AND niv.url = 'despacho_ver_todos'))
            WHERE neg.id_tipo_negocio = :tipo AND neg.estado = 'A'
            ON CONFLICT (id_negocio, id_rol, id_nivel) DO NOTHING;
        `, { replacements: { tipo: TIPO_RESTAURANTE }, transaction: t });

        await t.commit();
        console.log('\n✓ Migración Domicilio + Despacho completada');
    } catch (error) {
        await t.rollback();
        console.error('✗ Error:', error.message);
        process.exitCode = 1;
    } finally {
        await sequelize.close();
    }
}

migrate();
