/**
 * Prueba de punta a punta del registro de prueba, sin pasar por el correo.
 *
 * Pide el código, lo lee de la base, crea la cuenta y comprueba con qué tipo de negocio nació y
 * si el usuario ve módulos. Borra todo al terminar.
 *
 *   node scripts/probar_registro_trial.js BARBERIA
 */
require('dotenv').config();
const bcrypt = require('bcrypt');
const Models = require('../app_core/models/conection');
const { sendRegistroCode } = require('../app_admin_api/services/registroVerificacionService');
const { verificarYCrearCuentaTrial } = require('../app_admin_api/services/registroTrialService');

const Q = Models.sequelize.QueryTypes.SELECT;
const TIPO = (process.argv[2] || 'BARBERIA').toUpperCase();
const sufijo = Date.now().toString().slice(-6);
const EMAIL = `prueba.${TIPO.toLowerCase()}.${sufijo}@ejemplo.test`;
const CEDULA = `9${sufijo}`;

async function limpiar() {
    // El orden importa: primero lo que cuelga del usuario y del negocio.
    await Models.sequelize.query(
        `DELETE FROM general.gener_codigo_verificacion WHERE lower(email) = lower(:email);`,
        { replacements: { email: EMAIL } }
    );
    const u = await Models.sequelize.query(
        `SELECT id_usuario FROM general.gener_usuario WHERE lower(email) = lower(:email);`,
        { replacements: { email: EMAIL }, type: Q }
    );
    if (u.length === 0) return;
    const idUsuario = u[0].id_usuario;
    const negocios = await Models.sequelize.query(
        `SELECT id_negocio FROM general.gener_negocio_usuario WHERE id_usuario = :id;`,
        { replacements: { id: idUsuario }, type: Q }
    );
    for (const n of negocios) {
        // El orden importa: el plan y la ficha fiscal cuelgan del negocio con FK, y el plan NO
        // tiene ON DELETE CASCADE.
        for (const tabla of [
            'general.gener_negocio_plan',
            'general.gener_negocio_fiscal',
            'general.gener_nivel_negocio',
            'general.gener_usuario_rol',
            'general.gener_negocio_usuario',
        ]) {
            await Models.sequelize.query(`DELETE FROM ${tabla} WHERE id_negocio = :id;`, {
                replacements: { id: n.id_negocio },
            });
        }
        await Models.sequelize.query(`DELETE FROM general.gener_negocio WHERE id_negocio = :id;`, {
            replacements: { id: n.id_negocio },
        });
    }
    await Models.sequelize.query(`DELETE FROM general.gener_nivel_usuario WHERE id_usuario = :id;`, {
        replacements: { id: idUsuario },
    });
    await Models.sequelize.query(`DELETE FROM general.gener_usuario_rol WHERE id_usuario = :id;`, {
        replacements: { id: idUsuario },
    });
    await Models.sequelize.query(`DELETE FROM general.gener_usuario WHERE id_usuario = :id;`, {
        replacements: { id: idUsuario },
    });
}

async function main() {
    console.log(`\n=== Registro de prueba con tipo «${TIPO}» ===`);
    console.log(`    correo: ${EMAIL}`);

    const envio = await sendRegistroCode(EMAIL, {
        nombre: 'Prueba Automatica Chip',
        numIdentificacion: CEDULA,
        tipoNegocio: TIPO,
        idPlan: null,
    });
    if (envio && envio.ok === false) throw new Error(envio.error);

    // El código se guarda hasheado con bcrypt, así que no se puede leer de la base — que es lo
    // correcto. Para la prueba se sustituye el hash por el de un código conocido: se ejercita el
    // mismo camino de verificación, sin abrir ninguna puerta en el código de producción.
    const CODIGO = '123456';
    const hash = await bcrypt.hash(CODIGO, 10);
    const [, meta] = await Models.sequelize.query(
        `UPDATE general.gener_codigo_verificacion
            SET token_hash = :hash
          WHERE lower(email) = lower(:email) AND tipo = 'REGISTRO' AND used = false;`,
        { replacements: { hash, email: EMAIL } }
    );
    console.log(`    código de verificación sustituido por uno conocido`);

    await verificarYCrearCuentaTrial(EMAIL, CODIGO);

    const res = await Models.sequelize.query(
        `SELECT n.id_negocio, n.nombre, n.id_tipo_negocio, tn.nombre AS tipo,
                r.descripcion AS rol, u.id_usuario
           FROM general.gener_usuario u
           JOIN general.gener_negocio_usuario nu ON nu.id_usuario = u.id_usuario
           JOIN general.gener_negocio n         ON n.id_negocio = nu.id_negocio
      LEFT JOIN general.gener_tipo_negocio tn    ON tn.id_tipo_negocio = n.id_tipo_negocio
      LEFT JOIN general.gener_usuario_rol ur     ON ur.id_usuario = u.id_usuario AND ur.id_negocio = n.id_negocio
      LEFT JOIN general.gener_rol r              ON r.id_rol = ur.id_rol
          WHERE lower(u.email) = lower(:email);`,
        { replacements: { email: EMAIL }, type: Q }
    );

    if (res.length === 0) throw new Error('No se creó el negocio.');
    const r = res[0];
    console.log(`\n    negocio creado : ${r.id_negocio} · «${r.nombre}»`);
    console.log(`    tipo de negocio: ${r.id_tipo_negocio} · ${r.tipo}`);
    console.log(`    rol asignado   : ${r.rol || 'NINGUNO ⚠️'}`);

    // ¿Ve módulos? Se pregunta al servicio de la vertical que le toca.
    const esReserva = String(r.tipo).toUpperCase() === 'RESERVA';
    const servicio = esReserva
        ? require('../app_reserva_api/services/dashboardService')
        : require('../app_restaurante_api/services/dashboardService');
    const fn = servicio.verificarAccesoReserva || servicio.verificarAccesoRestaurante;

    const acceso = JSON.parse(JSON.stringify(await fn(r.id_usuario)));
    const negocio = (acceso.negocios || []).find((x) => x.id_negocio === r.id_negocio);
    const vistas = negocio?.permisos_vista || [];
    console.log(`    vertical       : ${esReserva ? '/reserva' : '/restaurante'}`);
    console.log(`    módulos visibles: ${vistas.length}`);
    if (vistas.length > 0) console.log(`    ${vistas.map((v) => v.url).join(' ')}`);

    console.log(vistas.length > 0 ? '\n    ✓ El usuario entra y ve menús.' : '\n    ✗ SIN MÓDULOS.');
}

main()
    .then(async () => {
        await limpiar();
        console.log('    (datos de prueba borrados)\n');
        await Models.sequelize.close();
    })
    .catch(async (e) => {
        console.error('FALLÓ:', e.message);
        await limpiar().catch(() => {});
        await Models.sequelize.close();
        process.exit(1);
    });
