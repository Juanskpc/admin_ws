const Models = require('../models/conection');

/**
 * Registra en auditoría un evento de impersonación de super administrador.
 * No lanza: la auditoría no debe bloquear el flujo, pero sí queda logueada si falla.
 * @param {Object} data
 * @param {number} data.id_admin            Super admin que impersona.
 * @param {number} data.id_usuario_objetivo Usuario al que se accede.
 * @param {string|null} [data.ip]
 * @param {string|null} [data.user_agent]
 */
async function registrarImpersonacion({ id_admin, id_usuario_objetivo, ip = null, user_agent = null }) {
    await Models.sequelize.query(
        `INSERT INTO general.gener_impersonacion
             (id_admin, id_usuario_objetivo, ip, user_agent)
         VALUES (:id_admin, :id_usuario_objetivo, :ip, :user_agent)`,
        { replacements: { id_admin, id_usuario_objetivo, ip, user_agent } }
    );
}

module.exports = { registrarImpersonacion };
