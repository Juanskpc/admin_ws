'use strict';
const Models = require('../../app_core/models/conection');
const ImagenService = require('./imagenService');
const { normalizarE164 } = require('../../app_core/helpers/telefono');
const { PAIS_POR_DEFECTO } = require('../../app_core/helpers/paises');
const { Op } = Models.Sequelize;

/**
 * Lista profesionales del negocio **con los servicios que cada uno ofrece**.
 *
 * Antes los `servicios` solo se incluían cuando se pasaba `idServicio`, y entonces el include
 * hacía dos trabajos a la vez: filtrar la lista de profesionales y, de paso, ser la única vía
 * por la que ese campo llegaba al cliente. Sin filtro, la respuesta no traía `servicios`.
 *
 * Eso rompía el formulario de cita, que decide qué servicios ofrecer con esta regla —la misma
 * que aplica `citaService` al crear—: *sin asignaciones, el profesional puede hacer todo; con
 * asignaciones, solo ésas*. Como el campo llegaba `undefined`, el formulario leía «sin
 * asignaciones» para todo el mundo y ofrecía el catálogo entero; al guardar, el backend sí
 * miraba la tabla real y respondía «El profesional no ofrece alguno de los servicios
 * solicitados». El usuario elegía algo que la interfaz le había ofrecido.
 *
 * Ahora el include siempre trae la lista completa, y el filtro por servicio se resuelve antes,
 * acotando los ids de profesional. Así una cosa no depende de la otra.
 */
async function listar({ idNegocio, idServicio = null, soloActivos = true }) {
    const where = { id_negocio: idNegocio };
    if (soloActivos) where.estado = 'A';

    if (idServicio) {
        const asignaciones = await Models.ReservaProfesionalServicio.findAll({
            where: { id_servicio: idServicio },
            attributes: ['id_profesional'],
        });
        where.id_profesional = { [Op.in]: asignaciones.map(a => a.id_profesional) };
    }

    return Models.ReservaProfesional.findAll({
        where,
        include: [{
            model: Models.ReservaServicio, as: 'servicios',
            attributes: ['id_servicio', 'nombre', 'duracion_min', 'precio'],
            through: { attributes: [] },
            required: false,   // un profesional sin asignaciones debe seguir apareciendo
        }],
        order: [['nombre', 'ASC']],
    });
}

async function getById(idProfesional, idNegocio) {
    return Models.ReservaProfesional.findOne({
        where: { id_profesional: idProfesional, id_negocio: idNegocio },
        include: [{
            model: Models.ReservaServicio, as: 'servicios',
            attributes: ['id_servicio', 'nombre'],
            through: { attributes: [] },
        }],
    });
}

/**
 * Nombre y especialidad se guardan en mayúsculas, igual que en el alta desde Usuarios.
 *
 * El nombre de un profesional puede llegar por dos caminos —creado con su usuario, o editado
 * aquí— y si solo uno normalizara, la misma persona acabaría escrita de dos formas según por
 * dónde se tocara por última vez. El email no se toca: se guarda tal cual para poder escribirle.
 */
function normalizarTexto(data) {
    const salida = { ...data };
    for (const campo of ['nombre', 'especialidad']) {
        if (typeof salida[campo] === 'string') salida[campo] = salida[campo].trim().toUpperCase();
    }
    return salida;
}

/**
 * El teléfono se guarda en E.164, igual que el del usuario. Ver `usuarioService`.
 *
 * `telefono_pais` es el selector de indicativo del formulario; si no llega, se asume el país
 * del negocio. Un número que no se reconoce se rechaza en vez de guardarse a medias: el destino
 * del dato es un enlace `wa.me` del portal público, y ahí un número inservible es un botón que
 * lleva a un chat vacío.
 */
async function normalizarContacto(data, idNegocio) {
    if (data.telefono === undefined) return data;

    const crudo = String(data.telefono ?? '').trim();
    const salida = { ...data };
    delete salida.telefono_pais;

    if (!crudo) { salida.telefono = null; return salida; }

    let pais = data.telefono_pais;
    if (!pais) {
        const negocio = await Models.GenerNegocio.findByPk(idNegocio, { attributes: ['pais'] });
        pais = negocio?.pais || PAIS_POR_DEFECTO;
    }
    const e164 = normalizarE164(crudo, pais);
    if (!e164) {
        const e = new Error('El teléfono no parece un móvil válido del país seleccionado.');
        e.statusCode = 422; e.code = 'TELEFONO_INVALIDO';
        throw e;
    }
    salida.telefono = e164;
    return salida;
}

/**
 * El contacto vuelve al usuario si la ficha tiene uno detrás.
 *
 * Es la otra mitad de lo que hace `usuarioService`: allí el usuario escribe en su ficha, aquí
 * la ficha escribe en su usuario. Sin esta dirección, editar el teléfono desde Profesionales
 * dejaría la pantalla de Usuarios mostrando el viejo, y volveríamos a tener el mismo dato con
 * dos valores según por dónde se mirara.
 *
 * El nombre **no** se propaga: en `gener_usuario` está partido en cuatro columnas y adivinar
 * cuál es el segundo apellido de «MARÍA JOSÉ PÉREZ GÓMEZ» es justo el tipo de heurística que
 * acaba renombrando a alguien por su cuenta.
 */
async function propagarAUsuario(profesional, data, transaction) {
    if (!profesional.id_usuario) return;
    const cambios = {};
    if (data.telefono !== undefined) cambios.telefono = data.telefono;
    if (data.email !== undefined) cambios.email = String(data.email || '').trim().toLowerCase() || null;
    if (!Object.keys(cambios).length) return;

    // El email es único en `gener_usuario`: si otro ya lo tiene, se deja el del usuario como
    // está en vez de tumbar el guardado de la ficha, que es lo que el usuario vino a hacer.
    if (cambios.email) {
        const choque = await Models.GenerUsuario.findOne({
            where: { email: cambios.email, id_usuario: { [Op.ne]: profesional.id_usuario } },
            attributes: ['id_usuario'], transaction,
        });
        if (choque) delete cambios.email;
        if (!Object.keys(cambios).length) return;
    }

    await Models.GenerUsuario.update(cambios, {
        where: { id_usuario: profesional.id_usuario }, transaction,
    });
}

async function crear(data) {
    return Models.ReservaProfesional.create(
        normalizarTexto(await normalizarContacto(data, data.id_negocio)),
    );
}

async function actualizar(idProfesional, idNegocio, data) {
    const p = await Models.ReservaProfesional.findOne({ where: { id_profesional: idProfesional, id_negocio: idNegocio } });
    if (!p) return null;
    const limpio = normalizarTexto(await normalizarContacto(data, idNegocio));
    delete limpio.id_profesional; delete limpio.id_negocio; delete limpio.fecha_creacion;
    delete limpio.id_usuario;   // a quién pertenece la ficha se decide en Usuarios, no aquí
    delete limpio.telefono_pais;
    limpio.fecha_actualizacion = new Date();

    return Models.sequelize.transaction(async (t) => {
        await p.update(limpio, { transaction: t });
        await propagarAUsuario(p, limpio, t);
        return p;
    });
}

async function inactivar(idProfesional, idNegocio) {
    const p = await Models.ReservaProfesional.findOne({ where: { id_profesional: idProfesional, id_negocio: idNegocio } });
    if (!p) return null;
    // La foto se borra del disco al inactivar, igual que la imagen de un servicio: un registro
    // que ya no se muestra en ningún sitio no debe dejar su archivo suelto en `uploads`.
    if (p.foto_url) {
        ImagenService.eliminar({ tipo: 'profesional', idNegocio, idEntidad: idProfesional });
    }
    return p.update({ estado: 'I', foto_url: null, fecha_actualizacion: new Date() });
}

async function setServicios(idProfesional, idNegocio, idServicios = []) {
    const p = await Models.ReservaProfesional.findOne({ where: { id_profesional: idProfesional, id_negocio: idNegocio } });
    if (!p) return null;
    const t = await Models.sequelize.transaction();
    try {
        await Models.ReservaProfesionalServicio.destroy({ where: { id_profesional: idProfesional }, transaction: t });
        if (idServicios.length) {
            // Validar que los servicios pertenezcan al mismo negocio
            const servicios = await Models.ReservaServicio.findAll({
                where: { id_servicio: idServicios, id_negocio: idNegocio },
                attributes: ['id_servicio'],
                transaction: t,
            });
            if (servicios.length !== idServicios.length) {
                const e = new Error('Algún servicio no pertenece al negocio'); e.statusCode = 400; throw e;
            }
            await Models.ReservaProfesionalServicio.bulkCreate(
                idServicios.map(id_servicio => ({ id_profesional: idProfesional, id_servicio })),
                { transaction: t },
            );
        }
        await t.commit();
    } catch (err) {
        await t.rollback(); throw err;
    }
    return getById(idProfesional, idNegocio);
}

module.exports = { listar, getById, crear, actualizar, inactivar, setServicios };
