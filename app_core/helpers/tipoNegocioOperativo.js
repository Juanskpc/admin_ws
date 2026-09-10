'use strict';

const Models = require('../models/conection');
const { Op } = Models.Sequelize;

/**
 * ¿Qué tipos de negocio se pueden **usar**, y no solo elegir?
 *
 * ## El problema que resuelve
 *
 * `gener_tipo_negocio` es un catálogo de intenciones: tiene ocho filas activas, pero solo dos
 * verticales existen de verdad (RESTAURANTE y RESERVA). Las otras seis —BARBERIA, SUPERMERCADO,
 * TALLER, FONDO, FINANCIERA…— tienen nombre y hasta roles, pero **ninguna fila en
 * `gener_rol_nivel`**: nadie sembró su catálogo de permisos porque nunca se construyó su app.
 *
 * Crear un cliente sobre uno de esos tipos produce un negocio que no se puede abrir, y lo hace
 * **en silencio**: el registro se guarda, el usuario se crea, el correo sale, y solo al intentar
 * entrar a la vertical aparece el problema —sin mensaje de error, porque el guardia del frontend
 * cancela la navegación cuando la sesión llega con cero vistas. Pasó con el primer cliente de
 * reserva: se creó como BARBERIA (2026-09-09).
 *
 * Cambiarle el tipo después tampoco basta, y por eso este archivo existe además de la validación
 * obvia: **los roles son por tipo de negocio**. `gener_rol` tiene un ADMINISTRADOR distinto por
 * cada tipo (10 para BARBERIA, 33 para RESERVA), y el usuario se queda con el del tipo viejo. La
 * consulta de permisos exige que el nivel pertenezca al tipo *actual* del negocio, así que el
 * rol antiguo no casa con nada y la sesión sigue llegando vacía. Ver `remapearRolesDeNegocio`.
 *
 * ## Por qué se deriva y no se codifica en una lista
 *
 * La condición se calcula del propio catálogo en vez de mantener una lista de tipos permitidos:
 * el día que alguien siembre los permisos de una vertical nueva, esa vertical se vuelve
 * seleccionable sola. Una lista escrita a mano sería una segunda fuente de verdad que hay que
 * acordarse de tocar, y este es justo el tipo de olvido que causó el fallo.
 *
 * La condición es exactamente la que necesita la vertical para pintar una sola pantalla: que
 * exista al menos un permiso de rol sobre un nivel de menú (`id_tipo_nivel = 1`) con `url`.
 */
async function getTiposOperativos({ transaction } = {}) {
    const filas = await Models.GenerRolNivel.findAll({
        where: { estado: 'A', puede_ver: true },
        attributes: ['id_nivel'],
        include: [{
            model: Models.GenerNivel,
            as: 'nivel',
            required: true,
            where: {
                estado: 'A',
                id_tipo_nivel: 1,
                url: { [Op.ne]: null },
                id_tipo_negocio: { [Op.ne]: null },
            },
            attributes: ['id_tipo_negocio'],
        }],
        transaction,
    });

    return new Set(filas.map((f) => Number(f.nivel.id_tipo_negocio)));
}

/**
 * Falla si el tipo de negocio no tiene catálogo de permisos sembrado.
 *
 * El error lleva `code` y `statusCode` para que el controlador lo reenvíe tal cual, y el mensaje
 * nombra el arreglo (`npm run migrate:niveles`) porque quien lo lee suele ser quien puede
 * ejecutarlo.
 */
async function assertTipoOperativo(idTipoNegocio, { transaction } = {}) {
    const operativos = await getTiposOperativos({ transaction });
    if (operativos.has(Number(idTipoNegocio))) return;

    const tipo = await Models.GenerTipoNegocio.findByPk(Number(idTipoNegocio), {
        attributes: ['nombre'],
        transaction,
    });
    const nombre = tipo?.nombre ? `«${tipo.nombre}»` : `#${idTipoNegocio}`;

    const err = new Error(
        `El tipo de negocio ${nombre} todavía no tiene módulo: no hay permisos sembrados para él, `
        + 'así que el negocio se crearía sin ninguna pantalla y nadie podría entrar. '
        + 'Elige un tipo con módulo disponible, o siembra su catálogo (npm run migrate:niveles).',
    );
    err.code = 'TIPO_NEGOCIO_SIN_MODULO';
    err.statusCode = 409;
    throw err;
}

/**
 * Traduce los roles de los usuarios de un negocio cuando cambia su tipo.
 *
 * Se hace **por nombre de rol**, que es la única correspondencia que existe: `gener_rol` repite
 * ADMINISTRADOR, RECEPCIONISTA, CAJERO… una vez por tipo. Si algún rol en uso no tiene homónimo
 * en el tipo nuevo (BARBERO no existe en RESERVA), se aborta el cambio entero en vez de dejar a
 * ese empleado sin permisos: perder el acceso de alguien en silencio es el fallo que se está
 * corrigiendo, y repetirlo aquí sería peor que negarse.
 *
 * Los ajustes por negocio (`gener_nivel_negocio`) apuntan a niveles del tipo viejo, así que
 * quedan inservibles: se desactivan. No se traducen porque son decisiones del dueño sobre un
 * menú que ya no existe.
 *
 * @returns {Promise<{remapeados:number, ajustesDesactivados:number}>}
 */
async function remapearRolesDeNegocio(idNegocio, idTipoNegocioNuevo, { transaction } = {}) {
    const asignaciones = await Models.GenerUsuarioRol.findAll({
        where: { id_negocio: idNegocio, estado: 'A' },
        include: [{ model: Models.GenerRol, as: 'rol', required: true, attributes: ['id_rol', 'descripcion', 'id_tipo_negocio'] }],
        transaction,
    });

    // Los roles globales (id_tipo_negocio null, como SUPER ADMINISTRADOR) no pertenecen a ningún
    // tipo y siguen siendo válidos: no se tocan.
    const aTraducir = asignaciones.filter(
        (a) => a.rol.id_tipo_negocio !== null
            && Number(a.rol.id_tipo_negocio) !== Number(idTipoNegocioNuevo),
    );
    if (aTraducir.length === 0) return { remapeados: 0, ajustesDesactivados: 0 };

    const rolesDestino = await Models.GenerRol.findAll({
        where: { id_tipo_negocio: Number(idTipoNegocioNuevo), estado: 'A' },
        attributes: ['id_rol', 'descripcion'],
        transaction,
    });
    const porNombre = new Map(rolesDestino.map((r) => [r.descripcion.trim().toUpperCase(), r.id_rol]));

    const sinEquivalente = [...new Set(
        aTraducir
            .filter((a) => !porNombre.has(a.rol.descripcion.trim().toUpperCase()))
            .map((a) => a.rol.descripcion),
    )];
    if (sinEquivalente.length > 0) {
        const err = new Error(
            `No se puede cambiar el tipo de negocio: los roles ${sinEquivalente.join(', ')} no existen `
            + 'en el tipo nuevo, y los usuarios que los tienen se quedarían sin acceso. '
            + 'Reasigna esos usuarios a un rol del tipo nuevo y vuelve a intentarlo.',
        );
        err.code = 'ROLES_SIN_EQUIVALENTE';
        err.statusCode = 409;
        throw err;
    }

    for (const a of aTraducir) {
        await a.update(
            { id_rol: porNombre.get(a.rol.descripcion.trim().toUpperCase()) },
            { transaction },
        );
    }

    const [ajustesDesactivados] = await Models.GenerNivelNegocio.update(
        { estado: 'I' },
        { where: { id_negocio: idNegocio, estado: 'A' }, transaction },
    );

    return { remapeados: aTraducir.length, ajustesDesactivados: ajustesDesactivados || 0 };
}

module.exports = { getTiposOperativos, assertTipoOperativo, remapearRolesDeNegocio };
