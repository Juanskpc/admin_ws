/**
 * Migración: el rol DOMICILIARIO deja de ver todos los pedidos de Despacho.
 *
 * `despacho_ver_todos` es el permiso que separa a quien atiende el local (ve todos los pedidos
 * para llevar y a domicilio) de quien solo reparte (ve únicamente los domicilios que le asignaron).
 * `migrate_restaurante_domicilio.js` lo sembró SOLO para ADMINISTRADOR, MESERO y CAJERO: el
 * repartidor recibía el módulo `/despacho` y nada más. Aun así, en las bases ya existentes el rol
 * DOMICILIARIO tenía `despacho_ver_todos` con `puede_ver = true` —alguien lo encendió desde la
 * pantalla de permisos— y, con él, un repartidor veía los pedidos «para llevar» de todo el
 * negocio y los cancelados que no eran suyos.
 *
 * Esta migración lo devuelve a lo diseñado, en las dos tablas que lo deciden:
 *   - general.gener_rol_nivel      (catálogo global por rol)
 *   - general.gener_nivel_negocio  (ajuste de un negocio; si dice «sí», gana sobre el global)
 *
 * No borra ni crea filas: solo apaga `puede_ver`, así que un negocio que de verdad quiera que su
 * repartidor lo vea todo puede volver a encenderlo desde Usuarios → Roles. Idempotente: si ya
 * está apagado no toca nada.
 *
 *   npm run migrate:restaurante-domiciliario-solo-suyos
 */
require('dotenv').config();
const db = require('../app_core/models/conection');
const sequelize = db.sequelize;

async function migrate() {
    const t = await sequelize.transaction();
    try {
        console.log('→ Migración Restaurante - DOMICILIARIO solo ve lo suyo en Despacho\n');

        console.log('1. Catálogo global (gener_rol_nivel)...');
        const [, global] = await sequelize.query(`
            UPDATE general.gener_rol_nivel rn
               SET puede_ver = false
              FROM general.gener_nivel n, general.gener_rol r
             WHERE rn.id_nivel = n.id_nivel
               AND rn.id_rol = r.id_rol
               AND n.id_tipo_nivel = 4
               AND n.url = 'despacho_ver_todos'
               AND r.descripcion = 'DOMICILIARIO'
               AND rn.puede_ver = true;
        `, { transaction: t });
        console.log(`   ✓ ${global.rowCount ?? 0} fila(s) apagadas`);

        console.log('2. Ajustes por negocio (gener_nivel_negocio)...');
        const [, porNegocio] = await sequelize.query(`
            UPDATE general.gener_nivel_negocio nn
               SET puede_ver = false, fecha_actualizacion = CURRENT_TIMESTAMP
              FROM general.gener_nivel n, general.gener_rol r
             WHERE nn.id_nivel = n.id_nivel
               AND nn.id_rol = r.id_rol
               AND n.id_tipo_nivel = 4
               AND n.url = 'despacho_ver_todos'
               AND r.descripcion = 'DOMICILIARIO'
               AND nn.puede_ver = true;
        `, { transaction: t });
        console.log(`   ✓ ${porNegocio.rowCount ?? 0} fila(s) apagadas`);

        await t.commit();
        console.log('\n✓ Migración completada');
    } catch (error) {
        await t.rollback();
        console.error('✗ Error:', error.message);
        process.exitCode = 1;
    } finally {
        await sequelize.close();
    }
}

migrate();
