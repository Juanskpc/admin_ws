'use strict';
/**
 * La cartera de clientes del negocio.
 *
 * No hay tabla propia: los clientes **son** `platform.persona_negocio`, la entidad que ADR-006
 * y ADR-025 fijaron con `UNIQUE (id_negocio, telefono_e164)` y que `restaurante` ya usa. Aquí
 * solo se lee y se cruza con las citas para saber cuántas veces ha venido cada quien.
 *
 * Todo va acotado por `id_negocio` en el WHERE, sin excepción: la unicidad del teléfono es por
 * negocio y **jamás cruza inquilinos** (ADR-025). Dos salones distintos pueden tener el mismo
 * número y son dos clientes distintos.
 */
const Models = require('../../app_core/models/conection');
const { normalizarE164 } = require('../../app_core/helpers/telefono');
const { paisDeNegocio } = require('../../app_core/helpers/paisNegocio');

const sequelize = Models.sequelize;

/**
 * El email no vive en `persona_negocio` a propósito: los identificadores globales son
 * frontera reservada hasta el Portal del Cliente (ADR-025), y añadir una columna aquí sería
 * abrir esa puerta por la ventana. Se muestra el de la cita más reciente que traiga uno, que
 * es la misma regla con la que el backfill eligió el nombre.
 */
const SQL_AGREGADOS = `
    LEFT JOIN LATERAL (
        SELECT
            count(*)::int                                                    AS total_citas,
            count(*) FILTER (WHERE c.estado = 'completada')::int             AS citas_completadas,
            count(*) FILTER (WHERE c.estado = 'cancelada')::int              AS citas_canceladas,
            count(*) FILTER (WHERE c.estado = 'no_show')::int                AS inasistencias,
            min(c.fecha_hora_inicio)                                         AS primera_cita,
            max(c.fecha_hora_inicio)                                         AS ultima_cita,
            COALESCE(SUM(c.monto_total) FILTER (WHERE c.estado = 'completada'), 0) AS total_gastado
        FROM reserva.reserva_cita c
        WHERE c.id_persona_negocio = pn.id_persona_negocio
          AND c.id_negocio = pn.id_negocio
    ) agg ON true
    LEFT JOIN LATERAL (
        SELECT NULLIF(BTRIM(c2.cliente_email), '') AS email
        FROM reserva.reserva_cita c2
        WHERE c2.id_persona_negocio = pn.id_persona_negocio
          AND c2.id_negocio = pn.id_negocio
          AND NULLIF(BTRIM(COALESCE(c2.cliente_email, '')), '') IS NOT NULL
        ORDER BY c2.fecha_creacion DESC
        LIMIT 1
    ) mail ON true
`;

function aCliente(fila) {
    return {
        id_persona_negocio: fila.id_persona_negocio,
        nombre:             fila.nombre_mostrado,
        telefono:           fila.telefono_e164,
        email:              fila.email ?? null,
        notas:              fila.notas ?? null,
        etiquetas:          fila.etiquetas ?? [],
        total_citas:        Number(fila.total_citas ?? 0),
        citas_completadas:  Number(fila.citas_completadas ?? 0),
        citas_canceladas:   Number(fila.citas_canceladas ?? 0),
        inasistencias:      Number(fila.inasistencias ?? 0),
        total_gastado:      Number(fila.total_gastado ?? 0),
        primera_cita:       fila.primera_cita ?? null,
        ultima_cita:        fila.ultima_cita ?? null,
        creado_en:          fila.creado_en,
    };
}

/**
 * Listado paginado de la cartera.
 *
 * @param {Object} params
 * @param {number} params.idNegocio
 * @param {string} [params.buscar]   — nombre o teléfono, parcial.
 * @param {number} [params.limite]
 * @param {number} [params.offset]
 */
/**
 * El WHERE de la búsqueda, compartido por el listado y la exportación: el archivo tiene que
 * traer exactamente lo que la pantalla muestra con el mismo término.
 *
 * Un término puede ser un nombre o un trozo de teléfono. Si son dígitos se compara contra el
 * número **ya normalizado**, porque en la base está en E.164: buscar "300 111" a pelo no
 * encontraría "+573001112233".
 */
function filtroBusqueda(buscar) {
    const termino = buscar ? String(buscar).trim() : '';
    const digitos = termino.replace(/\D/g, '');
    const filtro = termino
        ? `AND (pn.nombre_mostrado ILIKE :like
                OR (:digitos <> '' AND pn.telefono_e164 LIKE '%' || :digitos))`
        : '';
    return { filtro, like: `%${termino}%`, digitos };
}

async function listar({ idNegocio, buscar = null, limite = 50, offset = 0 }) {
    const { filtro, like, digitos } = filtroBusqueda(buscar);

    const replacements = {
        idNegocio,
        limite: Math.min(Math.max(Number(limite) || 50, 1), 200),
        offset: Math.max(Number(offset) || 0, 0),
        like,
        digitos,
    };

    const filas = await sequelize.query(
        `
        SELECT pn.id_persona_negocio, pn.nombre_mostrado, pn.telefono_e164,
               pn.notas, pn.etiquetas, pn.creado_en,
               agg.total_citas, agg.citas_completadas, agg.citas_canceladas,
               agg.inasistencias, agg.primera_cita, agg.ultima_cita, agg.total_gastado,
               mail.email
          FROM platform.persona_negocio pn
          ${SQL_AGREGADOS}
         WHERE pn.id_negocio = :idNegocio
           ${filtro}
         ORDER BY agg.ultima_cita DESC NULLS LAST, pn.creado_en DESC
         LIMIT :limite OFFSET :offset;
        `,
        { replacements, type: sequelize.QueryTypes.SELECT }
    );

    const [{ total }] = await sequelize.query(
        `
        SELECT count(*)::int AS total
          FROM platform.persona_negocio pn
         WHERE pn.id_negocio = :idNegocio
           ${filtro};
        `,
        { replacements, type: sequelize.QueryTypes.SELECT }
    );

    return { total, clientes: filas.map(aCliente) };
}

/** Tope de la exportación: de sobra para un salón, y evita que un archivo tumbe el proceso. */
const MAX_EXPORTAR = 10000;

/**
 * La cartera completa —sin paginar— para el Excel/PDF, con el mismo filtro y el mismo orden
 * que el listado en pantalla.
 */
async function listarParaExportar({ idNegocio, buscar = null }) {
    const { filtro, like, digitos } = filtroBusqueda(buscar);
    const filas = await sequelize.query(
        `
        SELECT pn.id_persona_negocio, pn.nombre_mostrado, pn.telefono_e164,
               pn.notas, pn.etiquetas, pn.creado_en,
               agg.total_citas, agg.citas_completadas, agg.citas_canceladas,
               agg.inasistencias, agg.primera_cita, agg.ultima_cita, agg.total_gastado,
               mail.email
          FROM platform.persona_negocio pn
          ${SQL_AGREGADOS}
         WHERE pn.id_negocio = :idNegocio
           ${filtro}
         ORDER BY agg.ultima_cita DESC NULLS LAST, pn.creado_en DESC
         LIMIT :max;
        `,
        {
            replacements: { idNegocio, like, digitos, max: MAX_EXPORTAR },
            type: sequelize.QueryTypes.SELECT,
        }
    );
    return filas.map(aCliente);
}

/**
 * Un cliente por teléfono — lo que alimenta el autocompletado del formulario de cita.
 *
 * Devuelve `null` cuando no se conoce, y también cuando el teléfono no es un móvil
 * utilizable **en el país del negocio**: no es un error, es que no hay a quién reconocer.
 *
 * El país tiene que ser el mismo con el que se guardó el cliente, o el buscador no encontraría
 * a quien sí está en la cartera. Por eso ambos lados lo sacan de `gener_negocio.pais`.
 */
async function buscarPorTelefono({ idNegocio, telefono }) {
    const telefonoE164 = normalizarE164(telefono, await paisDeNegocio(idNegocio));
    if (!telefonoE164) return null;

    const [fila] = await sequelize.query(
        `
        SELECT pn.id_persona_negocio, pn.nombre_mostrado, pn.telefono_e164,
               pn.notas, pn.etiquetas, pn.creado_en,
               agg.total_citas, agg.citas_completadas, agg.citas_canceladas,
               agg.inasistencias, agg.primera_cita, agg.ultima_cita, agg.total_gastado,
               mail.email
          FROM platform.persona_negocio pn
          ${SQL_AGREGADOS}
         WHERE pn.id_negocio = :idNegocio
           AND pn.telefono_e164 = :telefonoE164
         LIMIT 1;
        `,
        { replacements: { idNegocio, telefonoE164 }, type: sequelize.QueryTypes.SELECT }
    );

    return fila ? aCliente(fila) : null;
}

/**
 * Edita lo que el negocio puede cambiar de un cliente: el nombre con el que lo conoce y sus
 * notas. El teléfono NO se toca: es la llave, y cambiarlo sería crear otro cliente — se hace
 * agendando con el número nuevo.
 */
async function actualizar({ idNegocio, idPersonaNegocio, nombre, notas }) {
    const [fila] = await sequelize.query(
        `
        UPDATE platform.persona_negocio
           SET nombre_mostrado = COALESCE(:nombre, nombre_mostrado),
               notas           = CASE WHEN :notas::text IS NULL THEN notas ELSE NULLIF(BTRIM(:notas), '') END,
               actualizado_en  = now()
         WHERE id_persona_negocio = :id
           AND id_negocio = :idNegocio
        RETURNING id_persona_negocio;
        `,
        {
            replacements: {
                id: idPersonaNegocio,
                idNegocio,
                nombre: nombre ? String(nombre).trim() : null,
                notas: notas === undefined ? null : notas,
            },
            type: sequelize.QueryTypes.SELECT,
        }
    );
    if (!fila) {
        const e = new Error('Cliente no encontrado en este negocio.');
        e.statusCode = 404;
        e.code = 'CLIENTE_NO_ENCONTRADO';
        throw e;
    }
    return buscarPorId({ idNegocio, idPersonaNegocio });
}

async function buscarPorId({ idNegocio, idPersonaNegocio }) {
    const [fila] = await sequelize.query(
        `
        SELECT pn.id_persona_negocio, pn.nombre_mostrado, pn.telefono_e164,
               pn.notas, pn.etiquetas, pn.creado_en,
               agg.total_citas, agg.citas_completadas, agg.citas_canceladas,
               agg.inasistencias, agg.primera_cita, agg.ultima_cita, agg.total_gastado,
               mail.email
          FROM platform.persona_negocio pn
          ${SQL_AGREGADOS}
         WHERE pn.id_negocio = :idNegocio
           AND pn.id_persona_negocio = :id
         LIMIT 1;
        `,
        {
            replacements: { idNegocio, id: idPersonaNegocio },
            type: sequelize.QueryTypes.SELECT,
        }
    );
    return fila ? aCliente(fila) : null;
}

/** Las citas de un cliente, de la más reciente a la más antigua. */
async function citasDe({ idNegocio, idPersonaNegocio, limite = 20 }) {
    return sequelize.query(
        `
        SELECT c.id_cita, c.fecha_hora_inicio, c.fecha_hora_fin, c.estado,
               c.monto_total, c.notas,
               p.nombre AS profesional,
               COALESCE(
                   (SELECT string_agg(s.nombre, ', ' ORDER BY s.nombre)
                      FROM reserva.reserva_cita_servicio cs
                      JOIN reserva.reserva_servicio s ON s.id_servicio = cs.id_servicio
                     WHERE cs.id_cita = c.id_cita),
                   ''
               ) AS servicios
          FROM reserva.reserva_cita c
          LEFT JOIN reserva.reserva_profesional p ON p.id_profesional = c.id_profesional
         WHERE c.id_negocio = :idNegocio
           AND c.id_persona_negocio = :id
         ORDER BY c.fecha_hora_inicio DESC
         LIMIT :limite;
        `,
        {
            replacements: { idNegocio, id: idPersonaNegocio, limite: Math.min(Number(limite) || 20, 100) },
            type: sequelize.QueryTypes.SELECT,
        }
    );
}

module.exports = { listar, listarParaExportar, buscarPorTelefono, buscarPorId, actualizar, citasDe };
