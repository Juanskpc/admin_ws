'use strict';
const Models = require('../../app_core/models/conection');
const { Op } = Models.Sequelize;

/**
 * Usuarios y permisos **del negocio de reserva**, no de la plataforma.
 *
 * ## Por qué no se reutiliza `/admin/usuarios/admin`
 *
 * `negocio_app` llama a los endpoints del admin API para esto, y funciona, pero ahí
 * `id_negocio` es un parámetro libre de la query: `listUsuarios` no acota por los negocios del
 * llamante, y `exigirPertenenciaNegocio` arranca en **modo observación** (audita, no bloquea).
 * Traer ese contrato aquí significaría que el administrador de una barbería puede listar —y
 * crear— usuarios de cualquier otro negocio de la plataforma escribiendo otro número en la URL.
 *
 * Aquí el `id_negocio` no se acepta: **se deriva de lo que el llamante puede administrar**, y
 * cada operación lo comprueba. Ése es el motivo de que este módulo exista en vez de un import.
 *
 * ## Cómo se conceden los permisos
 *
 * Hay dos tablas y responden preguntas distintas (ver `dashboardService.getPermisosVistaNegocio`):
 *
 * - `gener_rol_nivel` — la **plantilla del rol**: qué puede hacer un RECEPCIONISTA en general.
 *   Es catálogo de plataforma y desde aquí **no se toca**: cambiarla afectaría a todos los
 *   negocios del tipo RESERVA a la vez.
 * - `gener_nivel_negocio` — el **ajuste de este negocio**: qué vistas ve cada rol aquí dentro.
 *   Es la tabla que escribe esta pantalla, y por eso conceder o quitar una vista a un rol solo
 *   afecta a quien lo hace.
 */

const TIPO_NEGOCIO = 'RESERVA';
const ROL_PROFESIONAL = 'PROFESIONAL';
/** `gener_tipo_nivel` 4 = «Operación específica dentro de una vista». */
const TIPO_NIVEL_ACCION = 4;

function error(mensaje, statusCode = 422, code) {
    const e = new Error(mensaje);
    e.statusCode = statusCode;
    if (code) e.code = code;
    return e;
}

/** Nombre completo sin dobles espacios cuando faltan los segundos nombres. */
function nombreCompleto(u) {
    return [u.primer_nombre, u.segundo_nombre, u.primer_apellido, u.segundo_apellido]
        .filter(Boolean).join(' ');
}

/**
 * Normaliza a mayúsculas los campos de nombre e identificación.
 *
 * La directiva del formulario ya lo hace mientras se escribe, pero la validación de verdad va
 * aquí: la API es alcanzable sin pasar por la pantalla, y basta un `curl` o un cliente futuro
 * para meter «Ana Pérez» junto a «ANA PÉREZ» y romper la uniformidad que se buscaba. Que el
 * formulario lo muestre y el servidor lo garantice no es duplicar: es que una cosa es comodidad
 * y la otra es la regla.
 *
 * Se deja fuera el **email** (se guarda en minúscula; en mayúscula despistaría al iniciar
 * sesión) y la **contraseña**, que en mayúsculas simplemente sería otra contraseña.
 */
const CAMPOS_MAYUSCULA = [
    'primer_nombre', 'segundo_nombre', 'primer_apellido', 'segundo_apellido',
    'num_identificacion', 'especialidad',
];

function aMayusculas(valor) {
    return typeof valor === 'string' ? valor.trim().toUpperCase() : valor;
}

/** Devuelve una copia de `datos` con los campos de nombre ya en mayúscula. */
function normalizarNombres(datos) {
    const salida = { ...datos };
    for (const campo of CAMPOS_MAYUSCULA) {
        if (salida[campo] !== undefined && salida[campo] !== null) {
            salida[campo] = aMayusculas(salida[campo]);
        }
    }
    return salida;
}

// ─────────────────────────── Autorización ───────────────────────────

/**
 * ¿Puede este usuario administrar el negocio que dice?
 *
 * Se comprueba contra la BD en cada operación, nunca contra lo que venga en el cuerpo de la
 * petición. Un super administrador entra a cualquiera; el resto, solo a los negocios de tipo
 * RESERVA donde está asignado y con rol ADMINISTRADOR.
 */
async function exigirPuedeAdministrar({ idUsuario, idNegocio }) {
    const negocio = await Models.GenerNegocio.findOne({
        where: { id_negocio: idNegocio, estado: 'A' },
        include: [{
            model: Models.GenerTipoNegocio, as: 'tipoNegocio',
            where: { nombre: TIPO_NEGOCIO }, required: true,
            attributes: ['id_tipo_negocio', 'nombre'],
        }],
        attributes: ['id_negocio', 'nombre', 'id_tipo_negocio'],
    });
    if (!negocio) throw error('Negocio no encontrado o no es de tipo reserva.', 404);

    const globales = await Models.GenerUsuarioRol.findAll({
        where: { id_usuario: idUsuario, id_negocio: null, estado: 'A' },
        include: [{ model: Models.GenerRol, as: 'rol', attributes: ['descripcion'] }],
    });
    const esSuperAdmin = globales.some(r => /SUPER/i.test(r.rol?.descripcion || ''));
    if (esSuperAdmin) return negocio;

    const enNegocio = await Models.GenerUsuarioRol.findOne({
        where: { id_usuario: idUsuario, id_negocio: idNegocio, estado: 'A' },
        include: [{
            model: Models.GenerRol, as: 'rol',
            where: { descripcion: 'ADMINISTRADOR' }, required: true,
            attributes: ['descripcion'],
        }],
    });
    if (!enNegocio) {
        throw error('No tienes permiso para administrar los usuarios de este negocio.', 403);
    }
    return negocio;
}

// ─────────────────────────── Consultas ───────────────────────────

/** Usuarios del negocio, con su rol aquí dentro y el profesional al que estén ligados. */
async function listar({ idNegocio, search = '', incluirInactivos = false }) {
    const whereUsuario = {};
    if (!incluirInactivos) whereUsuario.estado = 'A';
    if (search.trim()) {
        const like = `%${search.trim()}%`;
        whereUsuario[Op.or] = [
            { primer_nombre: { [Op.iLike]: like } },
            { primer_apellido: { [Op.iLike]: like } },
            { email: { [Op.iLike]: like } },
            { num_identificacion: { [Op.iLike]: like } },
        ];
    }

    const vinculos = await Models.GenerNegocioUsuario.findAll({
        where: { id_negocio: idNegocio, estado: 'A' },
        include: [{
            model: Models.GenerUsuario, as: 'usuario', required: true,
            where: whereUsuario,
            attributes: [
                'id_usuario', 'primer_nombre', 'segundo_nombre', 'primer_apellido',
                'segundo_apellido', 'num_identificacion', 'email', 'telefono',
                'estado', 'fecha_creacion', 'es_admin_principal', 'debe_cambiar_password',
            ],
        }],
    });

    const ids = vinculos.map(v => v.usuario.id_usuario);
    if (ids.length === 0) return [];

    const roles = await Models.GenerUsuarioRol.findAll({
        where: { id_usuario: ids, id_negocio: idNegocio, estado: 'A' },
        include: [{ model: Models.GenerRol, as: 'rol', attributes: ['id_rol', 'descripcion'] }],
    });
    const rolPorUsuario = new Map();
    roles.forEach(r => rolPorUsuario.set(r.id_usuario, {
        id_usuario_rol: r.id_usuario_rol,
        id_rol: r.rol?.id_rol ?? r.id_rol,
        descripcion: r.rol?.descripcion ?? null,
    }));

    // Un usuario con rol PROFESIONAL suele tener ficha en la agenda; se muestra el vínculo para
    // que quede claro que borrarle el acceso no borra su historial de citas.
    const profesionales = await Models.ReservaProfesional.findAll({
        where: { id_negocio: idNegocio, id_usuario: { [Op.in]: ids } },
        attributes: ['id_profesional', 'id_usuario', 'nombre', 'estado'],
    });
    const proPorUsuario = new Map(profesionales.map(p => [p.id_usuario, p]));

    return vinculos
        .map(v => {
            const u = v.usuario;
            const pro = proPorUsuario.get(u.id_usuario);
            return {
                id_usuario: u.id_usuario,
                nombre_completo: nombreCompleto(u),
                primer_nombre: u.primer_nombre,
                segundo_nombre: u.segundo_nombre,
                primer_apellido: u.primer_apellido,
                segundo_apellido: u.segundo_apellido,
                num_identificacion: u.num_identificacion,
                email: u.email,
                telefono: u.telefono,
                estado: u.estado,
                fecha_creacion: u.fecha_creacion,
                es_admin_principal: u.es_admin_principal,
                debe_cambiar_password: u.debe_cambiar_password,
                rol: rolPorUsuario.get(u.id_usuario) ?? null,
                profesional: pro
                    ? { id_profesional: pro.id_profesional, nombre: pro.nombre, estado: pro.estado }
                    : null,
            };
        })
        .sort((a, b) => a.nombre_completo.localeCompare(b.nombre_completo));
}

/** Roles del vertical reserva. Son los únicos que esta pantalla puede asignar. */
async function listarRoles() {
    const tipo = await Models.GenerTipoNegocio.findOne({
        where: { nombre: TIPO_NEGOCIO }, attributes: ['id_tipo_negocio'],
    });
    if (!tipo) return [];
    return Models.GenerRol.findAll({
        where: { id_tipo_negocio: tipo.id_tipo_negocio, estado: 'A' },
        attributes: ['id_rol', 'descripcion', 'id_tipo_negocio'],
        order: [['id_rol', 'ASC']],
    });
}

/**
 * Matriz de permisos de un rol **en este negocio**.
 *
 * Devuelve todas las vistas del vertical con dos datos por cada una: lo que la plantilla del rol
 * permite (`plantilla`, informativo y de solo lectura) y si este negocio la tiene habilitada
 * (`puede_ver`, editable). Mostrar las dos evita la confusión de conceder una vista aquí y que
 * el usuario siga sin acciones porque su rol nunca las tuvo.
 */
async function getPermisosRol({ idRol, idNegocio }) {
    const tipo = await Models.GenerTipoNegocio.findOne({
        where: { nombre: TIPO_NEGOCIO }, attributes: ['id_tipo_negocio'],
    });
    if (!tipo) throw error('No existe el tipo de negocio RESERVA.', 404);

    const rol = await Models.GenerRol.findOne({
        where: { id_rol: idRol, id_tipo_negocio: tipo.id_tipo_negocio, estado: 'A' },
        attributes: ['id_rol', 'descripcion'],
    });
    if (!rol) throw error('Rol no encontrado para este vertical.', 404);

    const niveles = await Models.GenerNivel.findAll({
        where: {
            id_tipo_negocio: tipo.id_tipo_negocio,
            id_tipo_nivel: 1,
            estado: 'A',
            url: { [Op.ne]: null, [Op.notIn]: ['/reserva'] },
        },
        attributes: ['id_nivel', 'descripcion', 'url', 'icono'],
        order: [['id_nivel', 'ASC']],
    });

    // Acciones dentro de cada vista (`id_tipo_nivel = 4`), colgadas de su vista por
    // `id_nivel_padre`. Es lo que permite decir «puede agendar pero no cancelar».
    const acciones = await Models.GenerNivel.findAll({
        where: {
            id_tipo_negocio: tipo.id_tipo_negocio,
            id_tipo_nivel: TIPO_NIVEL_ACCION,
            estado: 'A',
            url: { [Op.ne]: null },
        },
        attributes: ['id_nivel', 'descripcion', 'url', 'id_nivel_padre'],
        order: [['id_nivel', 'ASC']],
    });
    const accionesPorVista = new Map();
    for (const a of acciones) {
        const lista = accionesPorVista.get(a.id_nivel_padre) ?? [];
        lista.push(a);
        accionesPorVista.set(a.id_nivel_padre, lista);
    }

    const plantilla = await Models.GenerRolNivel.findAll({
        where: { id_rol: idRol, estado: 'A' },
        attributes: ['id_nivel', 'puede_ver', 'puede_crear', 'puede_editar', 'puede_eliminar'],
    });
    const plantillaPorNivel = new Map(plantilla.map(p => [p.id_nivel, p]));

    const ajustes = await Models.GenerNivelNegocio.findAll({
        where: { id_negocio: idNegocio, id_rol: idRol, estado: 'A' },
        attributes: ['id_nivel', 'puede_ver'],
    });
    const ajustePorNivel = new Map(ajustes.map(a => [a.id_nivel, a.puede_ver]));
    const hayAjustes = ajustes.length > 0;

    /** Concedido = lo que dice el negocio; si aún no ha dicho nada, la plantilla del rol. */
    const concedido = (idNivel) => hayAjustes
        ? (ajustePorNivel.get(idNivel) ?? false)
        : !!plantillaPorNivel.get(idNivel)?.puede_ver;

    return {
        id_rol: rol.id_rol,
        descripcion: rol.descripcion,
        // Sin ajustes propios, el negocio hereda la plantilla entera: el frontend lo dice para
        // que se entienda por qué todo aparece marcado antes de tocar nada.
        hereda_plantilla: !hayAjustes,
        modulos: niveles.map(n => {
            const p = plantillaPorNivel.get(n.id_nivel);
            return {
                id_nivel: n.id_nivel,
                modulo: n.descripcion,
                url: n.url,
                icono: n.icono,
                plantilla: {
                    puede_ver: !!p?.puede_ver,
                    puede_crear: !!p?.puede_crear,
                    puede_editar: !!p?.puede_editar,
                    puede_eliminar: !!p?.puede_eliminar,
                },
                puede_ver: concedido(n.id_nivel),
                acciones: (accionesPorVista.get(n.id_nivel) ?? []).map(a => ({
                    id_nivel: a.id_nivel,
                    codigo: normalizarCodigoAccion(a.url),
                    accion: a.descripcion,
                    url: a.url,
                    // La plantilla del rol es el techo: una acción que el rol no tiene no se
                    // puede conceder desde aquí. Se envía para poder explicarlo en la interfaz.
                    en_plantilla: !!plantillaPorNivel.get(a.id_nivel)?.puede_ver,
                    puede_ver: concedido(a.id_nivel),
                })),
            };
        }),
    };
}

/** `/citas/no-show` → `citas_no_show`. El guion también se normaliza (ver `dashboardService`). */
function normalizarCodigoAccion(url) {
    if (!url) return '';
    return String(url).trim().toLowerCase().replace(/^\/+/, '').replace(/[/-]/g, '_');
}

/** Guarda qué vistas ve este rol en este negocio. Reemplaza el conjunto completo. */
async function savePermisosRol({ idRol, idNegocio, modulos }) {
    const tipo = await Models.GenerTipoNegocio.findOne({
        where: { nombre: TIPO_NEGOCIO }, attributes: ['id_tipo_negocio'],
    });
    const rol = await Models.GenerRol.findOne({
        where: { id_rol: idRol, id_tipo_negocio: tipo?.id_tipo_negocio, estado: 'A' },
    });
    if (!rol) throw error('Rol no encontrado para este vertical.', 404);

    const nivelesValidos = await Models.GenerNivel.findAll({
        where: {
            id_tipo_negocio: tipo.id_tipo_negocio,
            id_tipo_nivel: { [Op.in]: [1, TIPO_NIVEL_ACCION] },
            estado: 'A',
        },
        attributes: ['id_nivel', 'id_tipo_nivel', 'id_nivel_padre'],
    });
    const porId = new Map(nivelesValidos.map(n => [n.id_nivel, n]));

    const vistas = (modulos || [])
        .filter(m => porId.get(Number(m.id_nivel))?.id_tipo_nivel === 1)
        .map(m => ({ id_nivel: Number(m.id_nivel), puede_ver: !!m.puede_ver, acciones: m.acciones || [] }));

    // Al menos una vista visible, o el usuario entra y la app lo rebota a /sin-acceso sin
    // explicación. Es un error que se comete fácil y se diagnostica mal.
    if (!vistas.some(v => v.puede_ver)) {
        throw error('El rol debe poder ver al menos una vista.', 422, 'SIN_VISTAS');
    }

    const entradas = vistas.map(v => ({ id_nivel: v.id_nivel, puede_ver: v.puede_ver }));

    for (const vista of vistas) {
        for (const a of vista.acciones) {
            const idNivel = Number(a.id_nivel);
            const nivel = porId.get(idNivel);
            // Solo acciones reales, del catálogo, y colgadas de **esta** vista: sin esto se
            // podría conceder «cerrar caja» mandándola dentro del módulo de Servicios.
            if (!nivel || nivel.id_tipo_nivel !== TIPO_NIVEL_ACCION) continue;
            if (Number(nivel.id_nivel_padre) !== vista.id_nivel) continue;

            // El único techo es la **vista que la contiene**: una acción dentro de una vista
            // oculta sería un botón que nadie puede pulsar y un permiso imposible de auditar.
            //
            // La plantilla del rol NO limita. Es deliberado y sigue lo que ya hace la plataforma
            // con las vistas (ver `getPermisosVistaNegocio`): el ajuste por negocio **añade**,
            // no solo recorta. Un salón puede necesitar que su recepcionista cancele citas y
            // otro no; obligarles a compartir la plantilla del vertical convertiría esta
            // pantalla en un interruptor de solo apagar. `en_plantilla` viaja igualmente para
            // que la interfaz pueda avisar de que la acción no viene por defecto en ese rol.
            const permitida = !!a.puede_ver && vista.puede_ver;
            entradas.push({ id_nivel: idNivel, puede_ver: permitida });
        }
    }

    await Models.sequelize.transaction(async (t) => {
        await Models.GenerNivelNegocio.destroy({
            where: { id_negocio: idNegocio, id_rol: idRol }, transaction: t,
        });
        await Models.GenerNivelNegocio.bulkCreate(
            entradas.map(e => ({
                id_negocio: idNegocio, id_rol: idRol, id_nivel: e.id_nivel,
                puede_ver: e.puede_ver, estado: 'A',
                fecha_creacion: new Date(), fecha_actualizacion: new Date(),
            })),
            { transaction: t },
        );
    });

    // La relectura va DESPUÉS del commit, no dentro de la transacción.
    //
    // `getPermisosRol` abre sus propias consultas sin recibir la transacción, así que dentro de
    // ella leía el estado anterior: la respuesta devolvía los permisos viejos aunque el guardado
    // hubiera funcionado, y en la pantalla el cambio parecía no haberse aplicado. Se detectó
    // concediendo `/caja` a un rol y viendo volver la lista sin ella.
    return getPermisosRol({ idRol, idNegocio });
}

// ─────────────────────────── Escritura de usuarios ───────────────────────────

async function validarRolDelVertical(idRol) {
    const roles = await listarRoles();
    const rol = roles.find(r => r.id_rol === Number(idRol));
    if (!rol) throw error('El rol no pertenece al vertical de reservas.', 400);
    return rol;
}

/**
 * Crea un usuario del negocio.
 *
 * La contraseña inicial es la cédula y se marca `debe_cambiar_password`, igual que hace el
 * registro por invitación del admin: nadie tiene que inventarse una contraseña por otro, y el
 * dueño puede decirle al empleado cómo entrar sin enviarle nada por escrito.
 *
 * Si el rol es PROFESIONAL, se crea además su ficha en la agenda —o se enlaza la que ya
 * exista—, porque un profesional sin ficha no puede recibir citas y sería un acceso inútil.
 */
async function crear({ idNegocio, datos: datosCrudos, idProfesionalExistente = null }) {
    const datos = normalizarNombres(datosCrudos);
    const rol = await validarRolDelVertical(datos.id_rol);
    const email = String(datos.email || '').trim().toLowerCase();
    const cedula = String(datos.num_identificacion || '').trim();

    if (!email || !cedula) throw error('El email y la identificación son obligatorios.');

    const choque = await Models.GenerUsuario.findOne({
        where: { [Op.or]: [{ email }, { num_identificacion: cedula }] },
        attributes: ['id_usuario', 'email', 'num_identificacion'],
    });
    if (choque) {
        throw error(
            choque.email === email
                ? 'Ya existe un usuario con ese email.'
                : 'Ya existe un usuario con esa identificación.',
            409, 'USUARIO_DUPLICADO',
        );
    }

    return Models.sequelize.transaction(async (t) => {
        const usuario = await Models.GenerUsuario.create({
            primer_nombre: String(datos.primer_nombre || '').trim(),
            segundo_nombre: datos.segundo_nombre?.trim() || null,
            primer_apellido: String(datos.primer_apellido || '').trim(),
            segundo_apellido: datos.segundo_apellido?.trim() || null,
            num_identificacion: cedula,
            email,
            telefono: datos.telefono?.trim() || null,
            password: datos.password?.trim() || cedula,   // el hook del modelo aplica bcrypt
            debe_cambiar_password: !datos.password?.trim(),
            estado: 'A',
            es_admin_principal: false,
        }, { transaction: t });

        await Models.GenerNegocioUsuario.create({
            id_usuario: usuario.id_usuario, id_negocio: idNegocio, estado: 'A',
        }, { transaction: t });

        await Models.GenerUsuarioRol.create({
            id_usuario: usuario.id_usuario, id_rol: rol.id_rol, id_negocio: idNegocio, estado: 'A',
        }, { transaction: t });

        let profesional = null;
        if (rol.descripcion === ROL_PROFESIONAL) {
            profesional = await vincularProfesional({
                idNegocio, usuario, datos, idProfesionalExistente, transaction: t,
            });
        }

        return { usuario, rol, profesional };
    });
}

/** Enlaza (o crea) la ficha de agenda del profesional recién dado de alta. */
async function vincularProfesional({ idNegocio, usuario, datos, idProfesionalExistente, transaction }) {
    if (idProfesionalExistente) {
        const pro = await Models.ReservaProfesional.findOne({
            where: { id_profesional: idProfesionalExistente, id_negocio: idNegocio },
            transaction,
        });
        if (!pro) throw error('El profesional indicado no pertenece a este negocio.', 400);
        if (pro.id_usuario && pro.id_usuario !== usuario.id_usuario) {
            throw error('Ese profesional ya tiene un usuario asignado.', 409);
        }
        return pro.update({ id_usuario: usuario.id_usuario }, { transaction });
    }

    return Models.ReservaProfesional.create({
        id_negocio: idNegocio,
        id_usuario: usuario.id_usuario,
        nombre: nombreCompleto(usuario),
        especialidad: datos.especialidad?.trim() || null,
        telefono: datos.telefono?.trim() || null,
        email: usuario.email,
        color_hex: datos.color_hex || null,
        estado: 'A',
    }, { transaction });
}

/**
 * Actualiza los datos y el rol de un usuario del negocio.
 *
 * **No usa `updateUsuario` del admin API**: aquel sincroniza roles y negocios y, con un usuario
 * que pertenece a varios, se los borra. Aquí solo se toca el vínculo de *este* negocio y se
 * dejan intactos los demás.
 */
async function actualizar({ idNegocio, idUsuario, datos: datosCrudos }) {
    const datos = normalizarNombres(datosCrudos);
    const vinculo = await Models.GenerNegocioUsuario.findOne({
        where: { id_usuario: idUsuario, id_negocio: idNegocio, estado: 'A' },
    });
    if (!vinculo) throw error('Ese usuario no pertenece a este negocio.', 404);

    const usuario = await Models.GenerUsuario.findByPk(idUsuario);
    if (!usuario) throw error('Usuario no encontrado.', 404);

    if (datos.email) {
        const email = String(datos.email).trim().toLowerCase();
        const choque = await Models.GenerUsuario.findOne({
            where: { email, id_usuario: { [Op.ne]: idUsuario } }, attributes: ['id_usuario'],
        });
        if (choque) throw error('Ya existe otro usuario con ese email.', 409);
    }

    return Models.sequelize.transaction(async (t) => {
        const cambios = {};
        for (const campo of ['primer_nombre', 'segundo_nombre', 'primer_apellido', 'segundo_apellido', 'telefono']) {
            if (datos[campo] !== undefined) cambios[campo] = datos[campo]?.trim() || null;
        }
        if (datos.email) cambios.email = String(datos.email).trim().toLowerCase();
        // Cambiar la contraseña obliga al usuario a ponerse una propia en el siguiente acceso.
        if (datos.password?.trim()) {
            cambios.password = datos.password.trim();
            cambios.debe_cambiar_password = true;
        }
        await usuario.update(cambios, { transaction: t });

        if (datos.id_rol) {
            const rol = await validarRolDelVertical(datos.id_rol);
            await Models.GenerUsuarioRol.destroy({
                where: { id_usuario: idUsuario, id_negocio: idNegocio }, transaction: t,
            });
            await Models.GenerUsuarioRol.create({
                id_usuario: idUsuario, id_rol: rol.id_rol, id_negocio: idNegocio, estado: 'A',
            }, { transaction: t });
        }

        // Si tiene ficha de profesional, el nombre se mantiene sincronizado: dos nombres para la
        // misma persona en la agenda y en usuarios es una fuente de confusión garantizada.
        const pro = await Models.ReservaProfesional.findOne({
            where: { id_negocio: idNegocio, id_usuario: idUsuario }, transaction: t,
        });
        if (pro) {
            await pro.update({
                nombre: nombreCompleto({ ...usuario.toJSON(), ...cambios }),
                fecha_actualizacion: new Date(),
            }, { transaction: t });
        }

        return usuario;
    });
}

/**
 * Activa o desactiva el acceso.
 *
 * Se cambia el **vínculo con el negocio**, no el usuario global: alguien que trabaja en dos
 * sitios no debe perder el acceso al otro porque aquí lo den de baja. La ficha de profesional
 * se desactiva a la vez para que deje de ofrecerse en la agenda.
 */
async function cambiarEstado({ idNegocio, idUsuario, estado, idUsuarioSolicitante }) {
    if (!['A', 'I'].includes(estado)) throw error('Estado inválido.');
    if (Number(idUsuario) === Number(idUsuarioSolicitante)) {
        throw error('No puedes desactivar tu propio acceso.', 409, 'AUTO_BLOQUEO');
    }

    const vinculo = await Models.GenerNegocioUsuario.findOne({
        where: { id_usuario: idUsuario, id_negocio: idNegocio },
    });
    if (!vinculo) throw error('Ese usuario no pertenece a este negocio.', 404);

    return Models.sequelize.transaction(async (t) => {
        await vinculo.update({ estado }, { transaction: t });
        await Models.GenerUsuarioRol.update(
            { estado },
            { where: { id_usuario: idUsuario, id_negocio: idNegocio }, transaction: t },
        );
        const pro = await Models.ReservaProfesional.findOne({
            where: { id_negocio: idNegocio, id_usuario: idUsuario }, transaction: t,
        });
        if (pro) await pro.update({ estado, fecha_actualizacion: new Date() }, { transaction: t });
        return vinculo;
    });
}

/** Devuelve la contraseña a la cédula y fuerza el cambio en el siguiente acceso. */
async function resetPassword({ idNegocio, idUsuario }) {
    const vinculo = await Models.GenerNegocioUsuario.findOne({
        where: { id_usuario: idUsuario, id_negocio: idNegocio, estado: 'A' },
    });
    if (!vinculo) throw error('Ese usuario no pertenece a este negocio.', 404);

    const usuario = await Models.GenerUsuario.findByPk(idUsuario);
    if (!usuario) throw error('Usuario no encontrado.', 404);

    await usuario.update({
        password: usuario.num_identificacion,   // el hook la cifra
        debe_cambiar_password: true,
    });
    return { id_usuario: usuario.id_usuario, password_temporal: usuario.num_identificacion };
}

/** Profesionales del negocio sin usuario: los candidatos a los que darles acceso. */
async function profesionalesSinUsuario(idNegocio) {
    return Models.ReservaProfesional.findAll({
        where: { id_negocio: idNegocio, estado: 'A', id_usuario: null },
        attributes: ['id_profesional', 'nombre', 'especialidad'],
        order: [['nombre', 'ASC']],
    });
}

module.exports = {
    normalizarNombres,
    aMayusculas,
    exigirPuedeAdministrar,
    listar,
    listarRoles,
    getPermisosRol,
    savePermisosRol,
    crear,
    actualizar,
    cambiarEstado,
    resetPassword,
    profesionalesSinUsuario,
    ROL_PROFESIONAL,
};
