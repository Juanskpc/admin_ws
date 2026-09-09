/**
 * Crea (o desactiva) el usuario que se le entrega al revisor del App Review de Meta.
 *
 * ## Por qué existe, en vez de crearlo a mano por la Consola
 *
 * Se puede crear por la Consola, y está bien. Esto existe por tres cosas que a mano se olvidan:
 *
 * 1. **Se apoya en `usuarioAdminDao.createUsuario`**, que es exactamente lo que usa la Consola:
 *    da de alta el usuario, lo ata al negocio, le pone el rol y **reconstruye sus niveles**. Un
 *    `INSERT` a mano en `gener_usuario` deja un usuario que entra y no puede hacer nada, y el
 *    guardia cancela la navegación sin error — el fallo mudo que ya documenta `desarrollo-local.md`.
 * 2. **Por defecto no escribe.** Sin `--aplicar` solo dice lo que haría. Esto corre contra
 *    producción, donde están los datos de un cliente real.
 * 3. **Sabe deshacerse.** `--desactivar` deja el usuario en estado `I` cuando la revisión termine,
 *    que es la mitad que siempre se queda sin hacer. No borra: un borrado se lleva por delante el
 *    rastro de auditoría de lo que ese usuario tocó.
 *
 * El rol y el negocio no se piden por argumento: se resuelven. El rol es el `ADMINISTRADOR` del
 * **tipo** del negocio indicado, porque un id de rol copiado a mano de otra instalación es la
 * forma más fácil de crear un administrador de otra vertical.
 *
 * ## Uso
 *
 *   node scripts/crear_usuario_revisor.js --negocio=12                      # ensayo, no escribe
 *   node scripts/crear_usuario_revisor.js --negocio=12 --aplicar
 *   node scripts/crear_usuario_revisor.js --negocio=12 --documento=90000001 \
 *        --email=review@escalapp.cloud --password='...' --aplicar
 *
 *   node scripts/crear_usuario_revisor.js --desactivar=90000001 --aplicar   # al terminar Meta
 *
 * Estilo: el del backend (comillas simples, 4 espacios), no el de Prettier por defecto.
 */
'use strict';
require('dotenv').config();

const crypto = require('crypto');
const Models = require('../app_core/models/conection');
const UsuarioAdminDao = require('../app_core/dao/usuarioAdminDao');

const arg = (nombre, defecto = null) => {
    const encontrado = process.argv.find((a) => a.startsWith(`--${nombre}=`));
    return encontrado ? encontrado.split('=').slice(1).join('=') : defecto;
};
const bandera = (nombre) => process.argv.includes(`--${nombre}`);

const APLICAR = bandera('aplicar');
const DESACTIVAR = arg('desactivar');

/**
 * Una clave que se pueda dictar por teléfono y pegar en un formulario de Meta: sin caracteres
 * que dependan de la distribución del teclado ni parejas que se confundan al leerlas.
 */
function claveLegible() {
    const abc = 'ABCDEFGHJKMNPQRSTUVWXYZ';
    const min = 'abcdefghijkmnpqrstuvwxyz';
    const num = '23456789';
    const saca = (juego, n) =>
        Array.from({ length: n }, () => juego[crypto.randomInt(juego.length)]).join('');
    return `${saca(abc, 1)}${saca(min, 7)}${saca(num, 3)}*`;
}

function aviso(t) {
    console.log(`  \x1b[33m!\x1b[0m ${t}`);
}
function bien(t) {
    console.log(`  \x1b[32m✓\x1b[0m ${t}`);
}

async function desactivar(documento) {
    const usuario = await Models.GenerUsuario.findOne({
        where: { num_identificacion: String(documento) },
    });
    if (!usuario) throw new Error(`No hay ningún usuario con documento ${documento}.`);
    if (usuario.es_admin_principal) {
        throw new Error('Ese usuario es el administrador principal. No se desactiva desde aquí.');
    }

    console.log(`\n  ${usuario.primer_nombre} ${usuario.primer_apellido} · estado actual: ${usuario.estado}`);
    if (!APLICAR) return aviso('ensayo: añade --aplicar para desactivarlo de verdad');

    // `update` y no `save`: el hook de bcrypt del modelo solo toca `password` si cambia, así que
    // esto no rehashea nada. Se cambia el estado y nada más.
    await usuario.update({ estado: 'I' });
    bien('desactivado (estado I). Sus permisos y su rastro de auditoría siguen donde estaban.');
}

async function crear() {
    const idNegocio = Number(arg('negocio'));
    if (!idNegocio) throw new Error('Falta --negocio=<id>.');

    const negocio = await Models.GenerNegocio.findByPk(idNegocio);
    if (!negocio) throw new Error(`No existe el negocio ${idNegocio}.`);

    // El rol se resuelve por el TIPO del negocio: cada vertical tiene su propio ADMINISTRADOR.
    const rol = await Models.GenerRol.findOne({
        where: { descripcion: 'ADMINISTRADOR', id_tipo_negocio: negocio.id_tipo_negocio },
    });
    if (!rol) {
        throw new Error(
            `El tipo de negocio ${negocio.id_tipo_negocio} no tiene rol ADMINISTRADOR. ` +
                'Sin catálogo de permisos el usuario entraría y no vería nada (npm run migrate:niveles).'
        );
    }

    const payload = {
        primer_nombre: arg('nombre', 'Meta'),
        segundo_nombre: null,
        primer_apellido: arg('apellido', 'App Review'),
        segundo_apellido: null,
        num_identificacion: arg('documento', '90000001'),
        telefono: null,
        email: arg('email', 'app-review@escalapp.cloud').toLowerCase().trim(),
        password: arg('password') || claveLegible(),
        estado: 'A',
        es_admin_principal: false,
        id_negocio: idNegocio,
        id_rol: rol.id_rol,
    };

    const duplicado = await UsuarioAdminDao.findUsuarioDuplicado({
        email: payload.email,
        num_identificacion: payload.num_identificacion,
    });
    if (duplicado) {
        throw new Error(
            `Ya existe un usuario con ese ${duplicado.email === payload.email ? 'email' : 'documento'} ` +
                `(id ${duplicado.id_usuario}). Elige otro, o desactiva aquél.`
        );
    }

    console.log('\nSe va a crear:');
    console.log(`  negocio   ${negocio.id_negocio} · ${negocio.nombre} (tipo ${negocio.id_tipo_negocio})`);
    console.log(`  rol       ${rol.id_rol} · ADMINISTRADOR`);
    console.log(`  usuario   ${payload.primer_nombre} ${payload.primer_apellido}`);
    console.log(`  documento ${payload.num_identificacion}   ← con esto inicia sesión`);
    console.log(`  email     ${payload.email}`);
    console.log(`  clave     ${payload.password}`);

    if (!APLICAR) return aviso('ensayo: no se ha escrito nada. Añade --aplicar.');

    const t = await Models.sequelize.transaction();
    try {
        const idUsuario = await UsuarioAdminDao.createUsuario(payload, t);
        await t.commit();
        bien(`creado con id_usuario ${idUsuario}, y sus niveles reconstruidos`);
        console.log(
            '\n  Entra en https://escalapp.cloud/admin con el DOCUMENTO y la clave de arriba.' +
                '\n  Cuando Meta termine:  node scripts/crear_usuario_revisor.js ' +
                `--desactivar=${payload.num_identificacion} --aplicar\n`
        );
    } catch (e) {
        await t.rollback();
        throw e;
    }
}

(async () => {
    try {
        await Models.sequelize.authenticate();
        console.log(`\nBase: ${process.env.DB_NAME} en ${process.env.DB_HOST}:${process.env.DB_PORT}`);
        if (DESACTIVAR) await desactivar(DESACTIVAR);
        else await crear();
    } catch (e) {
        console.error(`\n  \x1b[31m✗\x1b[0m ${e.message}\n`);
        process.exitCode = 1;
    } finally {
        await Models.sequelize.close();
    }
})();
