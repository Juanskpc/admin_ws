/**
 * Principal — quién está ejecutando una operación (ADR-010, ADR-002).
 *
 * Hoy resuelve un solo tipo, `usuario` (personal del negocio, con roles). El modelo deja
 * sitio para un segundo tipo, **`contacto`** — el cliente final en una conversación
 * pública, con permisos mínimos y acotados a sus propias entidades — que es el que
 * necesitará el Policy Gate en F4. Se **reserva la frontera sin implementarla** (P13):
 * hoy no existe ninguna conversación pública que produzca un `contacto`.
 *
 * El Principal es lo que permite que el `id_negocio` lo imponga la plataforma y no quien
 * hace la petición. Esa regla es innegociable en ADR-010 y es la que evita que un prompt
 * —o un `curl`— pida los datos de otro inquilino.
 */
const Models = require('../models/conection');

const SUPER_ADMIN_ROL = 'SUPER ADMINISTRADOR';

const TIPO = {
    USUARIO: 'usuario',
    /** Reservado para F4: el cliente final en un canal público. Todavía sin productor. */
    CONTACTO: 'contacto',
};

/**
 * Carga los negocios a los que pertenece un usuario y si es super administrador.
 *
 * La pertenencia sale de `general.gener_negocio_usuario` (la membresía), no de
 * `gener_usuario_rol`: el rol dice qué hace dentro del negocio, la membresía dice si
 * está dentro. Es la misma distinción que usa el login.
 */
async function resolverPrincipalUsuario(idUsuario) {
    const [filas] = await Models.sequelize.query(
        `
        SELECT
            nu.id_negocio,
            COALESCE(
                ARRAY_AGG(DISTINCT UPPER(TRIM(r.descripcion)))
                    FILTER (WHERE r.descripcion IS NOT NULL),
                '{}'
            ) AS roles
          FROM general.gener_negocio_usuario nu
          JOIN general.gener_negocio n
            ON n.id_negocio = nu.id_negocio AND n.estado = 'A'
          LEFT JOIN general.gener_usuario_rol ur
            ON ur.id_usuario = nu.id_usuario
           AND ur.id_negocio = nu.id_negocio
           AND ur.estado = 'A'
          LEFT JOIN general.gener_rol r
            ON r.id_rol = ur.id_rol AND r.estado = 'A'
         WHERE nu.id_usuario = :idUsuario
           AND nu.estado = 'A'
         GROUP BY nu.id_negocio;
        `,
        // Sin `type: SELECT` a propósito: con él Sequelize devuelve las filas directamente
        // y la desestructuración `const [filas]` cogería la primera fila, no el array.
        { replacements: { idUsuario } }
    );

    const [[superAdmin]] = await Models.sequelize.query(
        `
        SELECT 1 AS es
          FROM general.gener_usuario_rol ur
          JOIN general.gener_rol r ON r.id_rol = ur.id_rol AND r.estado = 'A'
         WHERE ur.id_usuario = :idUsuario
           AND ur.estado = 'A'
           AND UPPER(TRIM(r.descripcion)) = :rol
         LIMIT 1;
        `,
        { replacements: { idUsuario, rol: SUPER_ADMIN_ROL } }
    );

    const negocios = new Map((filas || []).map((f) => [Number(f.id_negocio), f.roles || []]));

    return crearPrincipal({
        tipo: TIPO.USUARIO,
        idUsuario,
        esSuperAdmin: Boolean(superAdmin),
        negocios,
    });
}

function crearPrincipal({ tipo, idUsuario = null, esSuperAdmin = false, negocios = new Map() }) {
    return {
        tipo,
        id_usuario: idUsuario,
        es_super_admin: esSuperAdmin,
        negocios,

        /** Ids de negocio a los que pertenece. Útil para logs y para acotar consultas. */
        idsNegocio() {
            return [...negocios.keys()];
        },

        /**
         * ¿Puede operar sobre este negocio?
         *
         * El super administrador sí: opera la plataforma (métricas, soporte, impersonación)
         * y su acceso transversal es intencional, no un agujero.
         */
        puedeOperarEn(idNegocio) {
            if (esSuperAdmin) return true;
            return negocios.has(Number(idNegocio));
        },

        rolesEn(idNegocio) {
            return negocios.get(Number(idNegocio)) || [];
        },
    };
}

module.exports = { resolverPrincipalUsuario, crearPrincipal, TIPO };
