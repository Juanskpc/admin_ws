/**
 * Atender citas es una capacidad, no un rol (2026-09-10).
 *
 * Hasta ahora la ficha de agenda solo nacía si el rol era PROFESIONAL. En un salón pequeño eso
 * obligaba a la dueña a elegir entre administrar el negocio o cortar el pelo, porque el rol es
 * uno solo por negocio. Estos tests fijan la regla nueva y, sobre todo, **lo que no debe pasar
 * al quitarla**: nada de fichas duplicadas y nada de borrar historial.
 *
 * Se ataca el servicio, no el formulario: la API es alcanzable con `curl` y es ahí donde la
 * regla tiene que sostenerse.
 *
 * Requiere la BD local con los datos de desarrollo (`scripts/seed_dev_local.js`).
 * Correr con:  DB_PORT=5432 npx jest __tests__/reserva/usuarios_profesional.test.js --forceExit
 */
require('dotenv').config();
const Models = require('../../app_core/models/conection');
const Usuarios = require('../../app_reserva_api/services/usuarioService');

const sequelize = Models.sequelize;

/** Marca de todo lo que crea esta suite, para poder borrarlo sin tocar nada más. */
const MARCA = 'TEST-CAPACIDAD';

let idNegocio;
let rolAdministrador;
let rolProfesional;

async function unaFila(sql, replacements = {}) {
    const [[fila]] = await sequelize.query(sql, { replacements });
    return fila ?? null;
}

/** La ficha de agenda de un usuario, exista o no y esté como esté. */
function fichaDe(idUsuario) {
    return Models.ReservaProfesional.findOne({
        where: { id_negocio: idNegocio, id_usuario: idUsuario },
    });
}

let cedula = 0;
function datosDe(idRol, extra = {}) {
    cedula += 1;
    return {
        primer_nombre: MARCA,
        primer_apellido: `PERSONA${cedula}`,
        num_identificacion: `9900000${String(cedula).padStart(3, '0')}`,
        email: null,
        id_rol: idRol,
        ...extra,
    };
}

async function limpiar() {
    await sequelize.query(
        `DELETE FROM reserva.reserva_profesional
          WHERE id_negocio = :n AND id_usuario IN (
              SELECT id_usuario FROM general.gener_usuario WHERE primer_nombre = :m);`,
        { replacements: { n: idNegocio, m: MARCA } },
    );
    await sequelize.query(
        `DELETE FROM general.gener_usuario_rol WHERE id_usuario IN (
              SELECT id_usuario FROM general.gener_usuario WHERE primer_nombre = :m);`,
        { replacements: { m: MARCA } },
    );
    await sequelize.query(
        `DELETE FROM general.gener_negocio_usuario WHERE id_usuario IN (
              SELECT id_usuario FROM general.gener_usuario WHERE primer_nombre = :m);`,
        { replacements: { m: MARCA } },
    );
    await sequelize.query(`DELETE FROM general.gener_usuario WHERE primer_nombre = :m;`, {
        replacements: { m: MARCA },
    });
}

beforeAll(async () => {
    const negocio = await unaFila(`
        SELECT n.id_negocio FROM general.gener_negocio n
          JOIN general.gener_tipo_negocio t ON t.id_tipo_negocio = n.id_tipo_negocio
         WHERE t.nombre = 'RESERVA' AND n.estado = 'A'
         ORDER BY n.id_negocio LIMIT 1;`);
    if (!negocio) throw new Error('No hay ningún negocio de tipo RESERVA en la BD local.');
    idNegocio = negocio.id_negocio;

    const roles = await Usuarios.listarRoles();
    rolAdministrador = roles.find(r => r.descripcion === 'ADMINISTRADOR')?.id_rol;
    rolProfesional = roles.find(r => r.descripcion === 'PROFESIONAL')?.id_rol;
    if (!rolAdministrador || !rolProfesional) {
        throw new Error('Falta el catálogo de roles de RESERVA. Ejecuta npm run migrate:niveles.');
    }

    await limpiar();
});

afterEach(limpiar);
afterAll(async () => { await sequelize.close(); });

// ────────────────────────────────────────────────────────────────────────────────────────

describe('el rol ya no decide quién atiende', () => {
    it('un administrador que además atiende recibe su ficha en la agenda', async () => {
        const { usuario } = await Usuarios.crear({
            idNegocio,
            datos: datosDe(rolAdministrador, { es_profesional: true, especialidad: 'colorimetría' }),
        });

        const ficha = await fichaDe(usuario.id_usuario);
        expect(ficha).not.toBeNull();
        expect(ficha.estado).toBe('A');
        // Se guarda tal cual se escribió: desde el 2026-09-10 solo el documento se pone en
        // mayúsculas (ver `CAMPOS_MAYUSCULA`).
        expect(ficha.especialidad).toBe('colorimetría');
    });

    it('un administrador que NO atiende sigue sin ficha, como hasta ahora', async () => {
        const { usuario } = await Usuarios.crear({ idNegocio, datos: datosDe(rolAdministrador) });
        expect(await fichaDe(usuario.id_usuario)).toBeNull();
    });

    it('el rol PROFESIONAL sigue implicando la ficha aunque no se pida', async () => {
        const { usuario } = await Usuarios.crear({ idNegocio, datos: datosDe(rolProfesional) });
        expect(await fichaDe(usuario.id_usuario)).not.toBeNull();
    });

    it('y no se le puede quitar: sin ficha, su acceso no serviría para nada', async () => {
        const { usuario } = await Usuarios.crear({
            idNegocio,
            datos: datosDe(rolProfesional, { es_profesional: false }),
        });
        const ficha = await fichaDe(usuario.id_usuario);
        expect(ficha).not.toBeNull();
        expect(ficha.estado).toBe('A');
    });
});

describe('poner y quitar la capacidad al editar', () => {
    it('un cajero pasa a atender sin cambiar de rol', async () => {
        const { usuario } = await Usuarios.crear({ idNegocio, datos: datosDe(rolAdministrador) });
        expect(await fichaDe(usuario.id_usuario)).toBeNull();

        await Usuarios.actualizar({
            idNegocio,
            idUsuario: usuario.id_usuario,
            datos: { es_profesional: true, especialidad: 'barbería' },
        });

        const ficha = await fichaDe(usuario.id_usuario);
        expect(ficha.estado).toBe('A');
        expect(ficha.especialidad).toBe('barbería');
    });

    it('retirarla desactiva la ficha, NO la borra: el historial de citas cuelga de ella', async () => {
        const { usuario } = await Usuarios.crear({
            idNegocio, datos: datosDe(rolAdministrador, { es_profesional: true }),
        });
        const antes = await fichaDe(usuario.id_usuario);

        await Usuarios.actualizar({
            idNegocio, idUsuario: usuario.id_usuario, datos: { es_profesional: false },
        });

        const despues = await fichaDe(usuario.id_usuario);
        expect(despues).not.toBeNull();
        expect(despues.id_profesional).toBe(antes.id_profesional);
        expect(despues.estado).toBe('I');
    });

    it('volver a ponerla reutiliza la MISMA ficha, no crea una segunda', async () => {
        const { usuario } = await Usuarios.crear({
            idNegocio, datos: datosDe(rolAdministrador, { es_profesional: true }),
        });
        const original = await fichaDe(usuario.id_usuario);

        await Usuarios.actualizar({
            idNegocio, idUsuario: usuario.id_usuario, datos: { es_profesional: false },
        });
        await Usuarios.actualizar({
            idNegocio, idUsuario: usuario.id_usuario, datos: { es_profesional: true },
        });

        const fichas = await Models.ReservaProfesional.findAll({
            where: { id_negocio: idNegocio, id_usuario: usuario.id_usuario },
        });
        expect(fichas).toHaveLength(1);
        expect(fichas[0].id_profesional).toBe(original.id_profesional);
        expect(fichas[0].estado).toBe('A');
    });

    it('editar otra cosa sin mencionar la capacidad no toca la agenda', async () => {
        const { usuario } = await Usuarios.crear({
            idNegocio, datos: datosDe(rolAdministrador, { es_profesional: true }),
        });

        // Es el caso que rompería sin querer: cambiar un teléfono no puede retirar a nadie de
        // la agenda sólo porque el formulario que llamó no conociera el campo.
        await Usuarios.actualizar({
            idNegocio, idUsuario: usuario.id_usuario, datos: { telefono: '3001112233' },
        });

        expect((await fichaDe(usuario.id_usuario)).estado).toBe('A');
    });

    it('quitarle el acceso lo saca de la agenda; devolvérselo no lo devuelve solo', async () => {
        const { usuario } = await Usuarios.crear({
            idNegocio, datos: datosDe(rolAdministrador, { es_profesional: true }),
        });

        await Usuarios.cambiarEstado({
            idNegocio, idUsuario: usuario.id_usuario, estado: 'I', idUsuarioSolicitante: 0,
        });
        expect((await fichaDe(usuario.id_usuario)).estado).toBe('I');

        await Usuarios.cambiarEstado({
            idNegocio, idUsuario: usuario.id_usuario, estado: 'A', idUsuarioSolicitante: 0,
        });
        // Una ficha desactivada puede serlo por dos razones y la tabla no distingue cuál:
        // reactivar a ciegas devolvería a la agenda a quien se retiró a propósito. Con rol
        // PROFESIONAL sí vuelve, porque ahí atender no es opcional (siguiente test).
        expect((await fichaDe(usuario.id_usuario)).estado).toBe('I');
    });

    it('a un PROFESIONAL, recuperar el acceso sí lo devuelve a la agenda', async () => {
        const { usuario } = await Usuarios.crear({ idNegocio, datos: datosDe(rolProfesional) });

        await Usuarios.cambiarEstado({
            idNegocio, idUsuario: usuario.id_usuario, estado: 'I', idUsuarioSolicitante: 0,
        });
        await Usuarios.cambiarEstado({
            idNegocio, idUsuario: usuario.id_usuario, estado: 'A', idUsuarioSolicitante: 0,
        });

        expect((await fichaDe(usuario.id_usuario)).estado).toBe('A');
    });
});
