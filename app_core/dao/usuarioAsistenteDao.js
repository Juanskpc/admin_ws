/**
 * El usuario a cuyo nombre quedan las órdenes que toma el asistente.
 *
 * ## Por qué hace falta un usuario, y por qué uno POR NEGOCIO
 *
 * `restaurante.pedid_orden.id_usuario` es **NOT NULL**: una orden siempre la toma alguien. Es
 * una regla del esquema, no una convención que se pueda rodear — un pedido sin autor no existe
 * en este dominio, y está bien que así sea, porque alguien responde de él en la caja.
 *
 * Un pedido que llega por WhatsApp no tiene empleado detrás. La pregunta «¿a nombre de quién?»
 * parece de fontanería y no lo es: **hay un informe de ventas por usuario**
 * (`reporteService`, «ventas por usuario») que agrupa por `o.id_usuario`. Quien figure aquí
 * aparece en el reporte que el dueño del restaurante mira para saber quién vende.
 *
 * De ahí la decisión (2026-08-24): **un usuario propio por negocio**, no el administrador.
 *
 *   · Con el administrador, sus ventas quedarían infladas con cada pedido del bot y ese informe
 *     dejaría de ser cierto. Un reporte que miente es peor que uno que falta.
 *   · Con un usuario propio, el dueño ve una fila «Asistente — 34 pedidos — $1.2M», que es
 *     exactamente lo que quiere saber: cuánto le está vendiendo el bot.
 *   · Y por negocio, no global: `pedid_orden` distingue inquilino en todo lo demás, y un usuario
 *     compartido haría que un dueño viera en su informe a alguien que no es suyo.
 *
 * ## No puede iniciar sesión, y eso es parte del diseño
 *
 * Se crea **sin ningún rol**. En esta plataforma los permisos vienen de `gener_usuario_rol`, así
 * que sin filas ahí no puede hacer nada aunque alguien lograse autenticarse. Y la contraseña es
 * el hash de un valor aleatorio que no se guarda en ninguna parte: no hay texto plano que
 * alguien pueda descubrir, ni siquiera quien lo creó.
 *
 * No se le pone `estado = 'I'` a propósito: el informe de ventas hace `INNER JOIN` con
 * `gener_usuario` sin filtrar estado, y un usuario inactivo saldría igual en el reporte pero
 * daría la impresión equivocada al mirarlo en la lista de usuarios.
 */
'use strict';

const crypto = require('crypto');
const bcrypt = require('bcrypt');
const db = require('../models/conection');

const sequelize = db.sequelize;

/** Lo que se ve en el informe de ventas. Corto: es una celda de una tabla. */
const NOMBRE = 'Asistente';
const APELLIDO = 'EscalApp';

/** Identificadores sintéticos. Las dos columnas son UNIQUE, así que llevan el id del negocio. */
const identificacionDe = (idNegocio) => `ASISTENTE-${idNegocio}`;
const emailDe = (idNegocio) => `asistente+${idNegocio}@escalapp.local`;

/**
 * El `id_usuario` del asistente de este negocio, creándolo si aún no existe.
 *
 * Idempotente por `num_identificacion`, que es único: dos llamadas simultáneas no crean dos
 * usuarios. Se ejecuta **dentro de la transacción de quien llama** para que un pedido y el autor
 * de ese pedido nazcan o fallen juntos; si la orden se deshace, el usuario no queda huérfano.
 *
 * @param {number} idNegocio
 * @param {Object} [opciones]
 * @param {Object} [opciones.transaction]
 * @returns {Promise<number>} id_usuario
 */
async function resolverOCrear(idNegocio, { transaction = null } = {}) {
    const id = Number(idNegocio);
    if (!Number.isInteger(id) || id <= 0) {
        throw new Error('usuarioAsistenteDao.resolverOCrear requiere un id_negocio válido.');
    }

    const identificacion = identificacionDe(id);

    const [existente] = await sequelize.query(
        `SELECT id_usuario FROM general.gener_usuario WHERE num_identificacion = :identificacion LIMIT 1;`,
        { replacements: { identificacion }, type: sequelize.QueryTypes.SELECT, transaction }
    );
    if (existente) {
        await asegurarMembresia(existente.id_usuario, id, transaction);
        return existente.id_usuario;
    }

    // Un secreto aleatorio que no se guarda ni se devuelve: nadie conoce el texto plano, ni
    // siquiera este proceso después de esta línea.
    const passwordImposible = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10);

    const [creado] = await sequelize.query(
        `
        INSERT INTO general.gener_usuario
            (primer_nombre, primer_apellido, num_identificacion, email, password, estado, es_admin_principal)
        VALUES (:nombre, :apellido, :identificacion, :email, :password, 'A', false)
        ON CONFLICT (num_identificacion) DO UPDATE SET num_identificacion = EXCLUDED.num_identificacion
        RETURNING id_usuario;
        `,
        {
            replacements: {
                nombre: NOMBRE,
                apellido: APELLIDO,
                identificacion,
                email: emailDe(id),
                password: passwordImposible,
            },
            type: sequelize.QueryTypes.SELECT,
            transaction,
        }
    );

    await asegurarMembresia(creado.id_usuario, id, transaction);
    return creado.id_usuario;
}

/**
 * La membresía usuario ↔ negocio.
 *
 * No es decorativa: `app_core/authz/principal.js` saca de `gener_negocio_usuario` a qué negocios
 * pertenece alguien, y la autorización multi-inquilino de F2 se apoya en eso. Un autor de
 * órdenes que no pertenece al negocio sería una fila incoherente esperando a confundir a quien
 * la mire.
 */
async function asegurarMembresia(idUsuario, idNegocio, transaction) {
    await sequelize.query(
        `
        INSERT INTO general.gener_negocio_usuario (id_usuario, id_negocio, estado)
        SELECT :idUsuario, :idNegocio, 'A'
         WHERE NOT EXISTS (
            SELECT 1 FROM general.gener_negocio_usuario
             WHERE id_usuario = :idUsuario AND id_negocio = :idNegocio
         );
        `,
        { replacements: { idUsuario, idNegocio }, transaction }
    );
}

module.exports = { resolverOCrear, NOMBRE, APELLIDO, identificacionDe, emailDe };
