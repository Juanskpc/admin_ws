/**
 * Las campañas: armarlas, probarlas, mandarlas y mirar qué dejaron (F2).
 *
 * ## La decisión que da forma a todo el módulo
 *
 * **Aquí no se llama a la Cloud API.** Una promoción se convierte en filas de
 * `intelligence.mensaje` con su plantilla, y a partir de ahí la manda **el entregador que ya
 * existe** desde F5-C. Eso regala cuatro cosas que habría que haber escrito otra vez:
 *
 *   · el número y el token **del inquilino** (el fallo que peor duele, ya resuelto en F8-C),
 *   · reintentos con backoff y *dead letter*,
 *   · el `estado_entrega` corregido por el acuse del webhook (`marcarAcuseDelCanal`), con el
 *     código de error de Meta dentro,
 *   · y el Ledger, donde ya se mira todo lo demás.
 *
 * Por eso `campana_destinatario` guarda `id_mensaje` y **no** el estado de la entrega: un contador
 * paralelo sería una segunda verdad sobre lo mismo, y la primera vez que divergieran no habría
 * forma de saber cuál miente.
 *
 * ## La lista se congela al armar la campaña
 *
 * `campana_destinatario` se llena de una vez, con el teléfono copiado. Dos razones: hay que poder
 * explicar **a dónde se mandó** (no a dónde se mandaría hoy), y una campaña que recalculara su
 * audiencia a mitad de envío le escribiría a gente que no estaba cuando el dueño aprobó el costo.
 *
 * Lo que **sí** se vuelve a comprobar en el momento de cada envío es la baja: entre aprobar y
 * mandar el mensaje 400 pueden pasar horas. Eso lo hace el despachador con
 * `audiencia.esContactable`.
 */
'use strict';

const Models = require('../models/conection');
const auditHelper = require('../helpers/auditHelper');
const catalogo = require('../../intelligence/core/plantillas');
const repositorio = require('../../intelligence/engine/repositorio');
const segmentos = require('./segmentos');
const simulador = require('./simulador');
const elegibilidad = require('./elegibilidad');
const plantillasMeta = require('./plantillasMeta');
const hechos = require('./hechos');
const identidad = require('../../intelligence/engine/identidad');
const numeros = require('../../intelligence/channels/whatsapp/numeros');

const sequelize = Models.sequelize;
const SELECT = { type: sequelize.QueryTypes.SELECT };
const CANAL = 'whatsapp';
const MODULO_AUDITORIA = 'promociones';

/** Tope de destinatarios por campaña. Más que la clientela entera del negocio más grande. */
const MAX_DESTINATARIOS = 2000;

/**
 * Cuántos días hay que esperar entre campañas del mismo negocio.
 *
 * Es el freno que protege al cliente de sí mismo (§6.7) y vive en el servidor, no en la interfaz.
 * Una semana no sale de ninguna norma: sale de que dos promociones en cuatro días es cuando la
 * gente empieza a bloquear, y lo que se pierde al bloquear no es la promoción — es el canal por el
 * que el negocio recibe sus pedidos.
 */
const DIAS_ENTRE_CAMPANAS = 7;

function fallo(mensaje, { code, statusCode = 422, detalle = null }) {
    const e = new Error(mensaje);
    e.code = code;
    e.statusCode = statusCode;
    e.detalle = detalle;
    return e;
}

/**
 * Congela la lista de una campaña, de una sola vez.
 *
 * `UNNEST` y no 400 INSERTs: un servidor de un núcleo nota la diferencia, y además así es una sola
 * sentencia que no puede quedar a medias.
 *
 * ⚠️ `ARRAY[:ids]` y no `:ids::text[]`: Sequelize expande un array de `replacements` como valores
 * sueltos separados por comas ('a', 'b'), no como un array de Postgres. Con `:ids::text[]` salía
 * `UNNEST('a', 'b'::text[], …)` y Postgres contestaba «unnest(unknown) is not unique»: ninguna
 * promoción se podía preparar, y se descubrió con la primera en producción (2026-10-13). Las pruebas
 * no la vieron porque ninguna llegaba a la base; `__tests__/promociones/destinatarios_db.test.js` sí.
 */
async function insertarDestinatarios(idCampana, destinatarios, { transaction = null } = {}) {
    if (!destinatarios.length) return;
    await sequelize.query(
        `INSERT INTO platform.campana_destinatario
             (id_campana, id_persona_negocio, telefono_e164, segmento)
         SELECT :idCampana, p.id::uuid, p.tel, p.seg
           FROM UNNEST(ARRAY[:ids]::text[], ARRAY[:tels]::text[], ARRAY[:segs]::text[])
                AS p(id, tel, seg)
         ON CONFLICT (id_campana, id_persona_negocio) DO NOTHING;`,
        {
            replacements: {
                idCampana,
                ids: destinatarios.map((d) => d.id_persona_negocio),
                tels: destinatarios.map((d) => d.telefono),
                segs: destinatarios.map((d) => d.segmento ?? null),
            },
            transaction,
        }
    );
}

/**
 * Lo que dice el saludo cuando el cliente no tiene nombre guardado: «Hola de nuevo, te escribimos
 * de…». Se lee natural y no inventa un nombre.
 */
const CLIENTE_SIN_NOMBRE = 'de nuevo';

/** El primer nombre, para el saludo: «Hola Ana», no «Hola ANA MARÍA GÓMEZ RUIZ». */
function primerNombre(nombre) {
    const limpio = limpiarParametro(nombre);
    if (!limpio || /^sin nombre$/i.test(limpio)) return '';
    const primero = limpio.split(' ')[0];
    return primero.charAt(0).toLocaleUpperCase('es') + primero.slice(1).toLocaleLowerCase('es');
}

/**
 * Rellena los huecos que el dueño no escribe: el nombre del cliente y el del negocio.
 *
 * ⚠️ Meta rechaza una plantilla con un parámetro VACÍO (#131008, «Required parameter is
 * missing»), y la pantalla solo manda la oferta. Hasta el 2026-10-13 nadie rellenaba `cliente` ni
 * `negocio`: la prueba salía con el negocio en blanco y fallaba, y el envío a los clientes habría
 * fallado entero. Se hace aquí, al materializar cada mensaje, y no al crear la campaña, para que
 * cada destinatario lleve SU nombre y para que las campañas ya creadas también salgan bien.
 *
 * Lo que ya venga escrito se respeta (la prueba manda su propio `cliente`).
 */
async function completarParametros({ idNegocio, idPersonaNegocio = null, parametros = {} }, { transaction } = {}) {
    const completos = { ...parametros };

    if (!limpiarParametro(completos.negocio)) {
        const [negocio] = await sequelize.query(
            'SELECT nombre FROM general.gener_negocio WHERE id_negocio = :idNegocio LIMIT 1;',
            { replacements: { idNegocio: Number(idNegocio) }, ...SELECT, transaction }
        );
        completos.negocio = limpiarParametro(negocio?.nombre) || 'tu restaurante de confianza';
    }

    if (!limpiarParametro(completos.cliente)) {
        let nombre = '';
        if (idPersonaNegocio) {
            const [persona] = await sequelize.query(
                `SELECT nombre_mostrado FROM platform.persona_negocio
                  WHERE id_persona_negocio = :id AND id_negocio = :idNegocio LIMIT 1;`,
                { replacements: { id: idPersonaNegocio, idNegocio: Number(idNegocio) }, ...SELECT, transaction }
            );
            nombre = primerNombre(persona?.nombre_mostrado);
        }
        completos.cliente = nombre || CLIENTE_SIN_NOMBRE;
    }

    return completos;
}

/** El texto de la oferta no puede traer saltos de línea: Meta rechaza una variable con ellos. */
function limpiarParametro(valor) {
    return String(valor ?? '')
        .replace(/[\r\n\t]+/g, ' ')
        .replace(/\s{2,}/g, ' ')
        .trim();
}

/**
 * Convierte un destinatario en un saliente de verdad.
 *
 * Es el mismo camino que recorre un recordatorio desde F8-B —`intelligence.mensaje` pendiente →
 * entregador → adaptador → canal—, con una diferencia: lleva `encabezado_url`, que es la imagen de
 * la campaña.
 *
 * Devuelve `{bloqueada: true}` sin crear nada cuando la conversación está bloqueada. Hace falta
 * aquí aunque el entregador también lo filtre: para entonces el mensaje ya existiría y se quedaría
 * pendiente hasta caducar, ensuciando la cola y el Ledger con algo que no va a salir.
 */
async function materializar(
    { idNegocio, idPersonaNegocio = null, telefono, plantilla, parametros: crudos, imagenUrl },
    { transaction }
) {
    const definicion = catalogo.obtener(plantilla);
    if (!definicion) {
        throw fallo(`No existe la plantilla "${plantilla}".`, { code: 'PROMOS_PLANTILLA_DESCONOCIDA' });
    }

    const parametros = await completarParametros(
        { idNegocio, idPersonaNegocio, parametros: crudos },
        { transaction }
    );

    const conversacion = await repositorio.asegurarConversacion(
        {
            idNegocio,
            canal: CANAL,
            // El `id_externo` de WhatsApp son los dígitos sin el «+», como el `from` del webhook.
            idExterno: String(telefono).replace(/\D/g, ''),
        },
        { transaction }
    );

    if (conversacion.estado === 'bloqueada') return { bloqueada: true, idMensaje: null };

    const contenido = catalogo.renderizarTexto(plantilla, parametros);

    const fila = await repositorio.insertarMensajeSaliente(
        {
            idConversacion: conversacion.id_conversacion,
            idNegocio,
            // Sin turno: no lo decidió una conversación, lo decidió el dueño con un botón.
            idTurno: null,
            canal: CANAL,
            contenido,
            plantilla: {
                nombre: definicion.nombre,
                idioma: definicion.idioma,
                parametros,
                ...(definicion.encabezado === 'IMAGE' ? { encabezado_url: imagenUrl } : {}),
            },
        },
        { transaction }
    );

    return { bloqueada: false, idMensaje: fila.id_mensaje };
}

/** La campaña, acotada al negocio. Falla cerrado: una campaña de otro negocio no existe. */
async function obtener({ idNegocio, idCampana, transaction = null } = {}) {
    const [fila] = await sequelize.query(
        `SELECT * FROM platform.campana
          WHERE id_campana = :idCampana AND id_negocio = :idNegocio LIMIT 1;`,
        { replacements: { idCampana, idNegocio: Number(idNegocio) }, ...SELECT, transaction }
    );
    if (!fila) {
        throw fallo('Esa promoción no existe.', { code: 'PROMOS_CAMPANA_NO_EXISTE', statusCode: 404 });
    }
    return fila;
}

/**
 * Arma una campaña: congela la lista y deja el costo estimado guardado.
 *
 * No envía nada y no exige todavía la prueba ni la plantilla aprobada: un borrador se puede
 * preparar mientras Meta revisa. Lo que sí comprueba es el freno de frecuencia, porque de nada
 * sirve dejar armar lo que no se va a poder mandar.
 */
async function crear({
    idNegocio,
    nombre,
    plantilla,
    parametros = {},
    imagenUrl = null,
    segmentos: codigos = null,
    personas = null,
    margen = undefined,
    idUsuario = null,
} = {}) {
    const definicion = catalogo.obtener(plantilla);
    if (!definicion || definicion.categoria !== 'MARKETING') {
        throw fallo('Esa plantilla no sirve para promociones.', {
            code: 'PROMOS_PLANTILLA_INVALIDA',
        });
    }
    if (definicion.encabezado === 'IMAGE' && !imagenUrl) {
        throw fallo('Esa plantilla lleva imagen y no se envió ninguna.', {
            code: 'PROMOS_FALTA_IMAGEN',
        });
    }

    const par = await hechos.paraNegocio(idNegocio);
    if (!par) {
        throw fallo('Las promociones no están disponibles para este tipo de negocio.', {
            code: 'PROMOS_VERTICAL_NO_SOPORTADO',
        });
    }

    // El freno de frecuencia, antes de dejar trabajar al dueño para nada.
    const [ultima] = await sequelize.query(
        `SELECT creado_en FROM platform.campana
          WHERE id_negocio = :idNegocio
            AND estado IN ('ENVIANDO', 'ENVIADA', 'PAUSADA')
            AND creado_en > now() - (:dias || ' days')::interval
          ORDER BY creado_en DESC LIMIT 1;`,
        { replacements: { idNegocio: Number(idNegocio), dias: DIAS_ENTRE_CAMPANAS }, ...SELECT }
    );
    if (ultima) {
        throw fallo(
            `Ya se mandó una promoción esta semana. Se puede volver a mandar a partir del `
            + `${new Date(new Date(ultima.creado_en).getTime() + DIAS_ENTRE_CAMPANAS * 86400000)
                .toLocaleDateString('es-CO')}. `
            + 'Es para que los clientes no empiecen a bloquear el número.',
            { code: 'PROMOS_DEMASIADO_PRONTO' },
        );
    }

    const destinatarios = await segmentos.destinatariosParaEnvio({
        idNegocio,
        segmentos: codigos,
        personas,
    });
    if (destinatarios.length === 0) {
        throw fallo('No quedó ningún cliente al que mandarle.', { code: 'PROMOS_SIN_DESTINATARIOS' });
    }
    if (destinatarios.length > MAX_DESTINATARIOS) {
        throw fallo(
            `Son ${destinatarios.length} destinatarios y el tope por promoción es ${MAX_DESTINATARIOS}.`,
            { code: 'PROMOS_DEMASIADOS' },
        );
    }

    const limpios = {};
    for (const clave of definicion.parametros) limpios[clave] = limpiarParametro(parametros[clave]);

    const costo = await simulador.calcularConCupo(destinatarios, { idNegocio, margen });
    const aprobadas = await plantillasMeta.estadoDe({ idNegocio }).catch(() => []);
    const usable = aprobadas.find((p) => p.nombre === plantilla)?.usable === true;

    return sequelize.transaction(async (transaction) => {
        const [[campana]] = await sequelize.query(
            `INSERT INTO platform.campana
                 (id_negocio, vertical, nombre, estado, plantilla, parametros, imagen_url,
                  segmento, destinatarios, costo_estimado, id_usuario_creo)
             VALUES (:idNegocio, :vertical, :nombre, :estado, :plantilla, :parametros::jsonb,
                     :imagenUrl, :segmento::jsonb, :destinatarios, :costo::jsonb, :idUsuario)
             RETURNING *;`,
            {
                replacements: {
                    idNegocio: Number(idNegocio),
                    vertical: par.vertical,
                    nombre: String(nombre || 'Promoción').slice(0, 120),
                    estado: usable ? 'LISTA' : 'PENDIENTE_PLANTILLA',
                    plantilla,
                    parametros: JSON.stringify(limpios),
                    imagenUrl,
                    segmento: JSON.stringify({ segmentos: codigos ?? null, personas: personas ? personas.length : null }),
                    destinatarios: destinatarios.length,
                    costo: JSON.stringify(costo),
                    idUsuario,
                },
                transaction,
            }
        );

        await insertarDestinatarios(campana.id_campana, destinatarios, { transaction });

        await auditHelper.registrarEvento({
            modulo: MODULO_AUDITORIA,
            accion: 'campana_creada',
            idNegocio: Number(idNegocio),
            idUsuario,
            detalle: {
                id_campana: campana.id_campana,
                plantilla,
                destinatarios: destinatarios.length,
                segmentos: codigos ?? null,
                costo_meta_usd: costo.meta.costo_usd,
            },
            transaction,
        });

        return campana;
    });
}

/**
 * Manda la prueba a un WhatsApp de carne y hueso.
 *
 * Es un mensaje **real**, con la plantilla real y la imagen real. Cuesta lo que cuesta uno (~$50) y
 * es lo único que comprueba de verdad que hay método de pago en Meta, que la plantilla existe en su
 * WABA y que el número puede mandar marketing. Sin esto entregado, no se envía (ver
 * `elegibilidad`).
 *
 * ## ⚠️ Por qué el destino se pide y no se deduce
 *
 * La primera versión la mandaba al número del canal del negocio, que parecía lo obvio: «el
 * WhatsApp del dueño». Pero **ese es el número que ENVÍA**, y la Cloud API no se manda mensajes a
 * sí misma: el destino tiene que ser otro teléfono. Deducirlo era una prueba que fallaba siempre,
 * y encima en el único sitio donde un fallo se lee como «tu cuenta de Meta tiene un problema».
 *
 * Así que se pide el teléfono de quien va a revisarla —el móvil del dueño, el del encargado— y se
 * niega en el acto si coincide con el número que envía, diciendo por qué.
 *
 * @param {string} [opciones.telefono] — a quién llega. Sin él se intenta el del canal, que sirve
 *        para el negocio cuyo canal NO es el que envía (ninguno hoy) y falla con un motivo claro
 *        en el resto.
 */
async function mandarPrueba({ idNegocio, idCampana, idUsuario = null, telefono: destinoPedido = null } = {}) {
    const campana = await obtener({ idNegocio, idCampana });
    if (!['BORRADOR', 'PENDIENTE_PLANTILLA', 'LISTA', 'PROGRAMADA'].includes(campana.estado)) {
        throw fallo('Esta promoción ya está en marcha: la prueba se manda antes.', {
            code: 'PROMOS_ESTADO_INVALIDO',
        });
    }

    if (destinoPedido && !identidad.normalizarTelefono(destinoPedido)) {
        throw fallo(
            `"${destinoPedido}" no parece un número de WhatsApp. Escríbelo con indicativo o como `
            + 'los 10 dígitos de un móvil colombiano.',
            { code: 'PROMOS_TELEFONO_INVALIDO' },
        );
    }

    const telefono = destinoPedido
        ? identidad.normalizarTelefono(destinoPedido)
        : elegibilidad.numeroDelDueno(idNegocio);
    if (!telefono) {
        throw fallo(
            'Falta el número al que mandar la prueba: escribe el WhatsApp de quien la va a '
            + 'revisar.',
            { code: 'PROMOS_SIN_NUMERO_DUENO' },
        );
    }

    // El que envía no puede ser el que recibe. Se compara por dígitos porque el canal guarda el
    // número con espacios ('+57 323 6388196') y lo que teclea una persona viene como venga.
    await numeros.asegurarCargado();
    const digitos = (valor) => String(valor || '').replace(/D/g, '');
    const propio = digitos(elegibilidad.numeroDelDueno(idNegocio));
    if (propio && digitos(telefono) === propio) {
        throw fallo(
            'Ese es el mismo número que envía la promoción, y WhatsApp no se manda mensajes a sí '
            + 'mismo. Pon el móvil de quien va a revisar la prueba.',
            { code: 'PROMOS_PRUEBA_A_SI_MISMO' },
        );
    }

    const parametros = { ...campana.parametros, cliente: 'Prueba' };

    return sequelize.transaction(async (transaction) => {
        const { bloqueada, idMensaje } = await materializar(
            {
                idNegocio: Number(idNegocio),
                telefono,
                plantilla: campana.plantilla,
                parametros,
                imagenUrl: campana.imagen_url,
            },
            { transaction }
        );
        if (bloqueada) {
            throw fallo(
                'Ese número tiene la conversación bloqueada con el negocio, así que no se le '
                + 'puede ni mandar la prueba.',
                { code: 'PROMOS_DUENO_BLOQUEADO' },
            );
        }

        await sequelize.query(
            `UPDATE platform.campana
                SET id_mensaje_prueba = :idMensaje, prueba_en = now(), actualizado_en = now()
              WHERE id_campana = :idCampana;`,
            { replacements: { idMensaje, idCampana }, transaction }
        );

        await auditHelper.registrarEvento({
            modulo: MODULO_AUDITORIA,
            accion: 'campana_prueba',
            idNegocio: Number(idNegocio),
            idUsuario,
            detalle: { id_campana: idCampana, telefono, id_mensaje: idMensaje },
            transaction,
        });

        return { id_mensaje: idMensaje, telefono };
    });
}

/**
 * Da la orden de enviar.
 *
 * No manda nada: pone la campaña en `ENVIANDO` (o `PROGRAMADA`) y el despachador la va drenando
 * con ritmo. Es deliberado — un POST que se quedara abierto mandando 400 mensajes se cortaría a
 * mitad por cualquier timeout, y nadie sabría por dónde iba.
 */
async function enviar({ idNegocio, idCampana, programadaPara = null, idUsuario = null } = {}) {
    const campana = await obtener({ idNegocio, idCampana });
    if (!['LISTA', 'PROGRAMADA', 'PAUSADA'].includes(campana.estado)) {
        throw fallo(
            campana.estado === 'PENDIENTE_PLANTILLA'
                ? 'Meta todavía no ha aprobado la plantilla de este negocio.'
                : `No se puede enviar una promoción en estado ${campana.estado}.`,
            { code: 'PROMOS_ESTADO_INVALIDO' },
        );
    }

    const gate = await elegibilidad.verificar({
        idNegocio,
        idCampana,
        destinatarios: campana.destinatarios,
    });
    if (!gate.puede) {
        throw fallo(gate.motivos[0].mensaje, {
            code: gate.motivos[0].code,
            detalle: gate.motivos,
        });
    }

    const [[actualizada]] = await sequelize.query(
        `UPDATE platform.campana
            SET estado = CASE WHEN :programada::timestamp IS NULL THEN 'ENVIANDO' ELSE 'PROGRAMADA' END,
                programada_para = :programada::timestamp,
                enviando_desde = COALESCE(enviando_desde, CASE WHEN :programada::timestamp IS NULL THEN now() END),
                motivo_corte = NULL,
                actualizado_en = now()
          WHERE id_campana = :idCampana
        RETURNING *;`,
        { replacements: { idCampana, programada: programadaPara } }
    );

    await auditHelper.registrarEvento({
        modulo: MODULO_AUDITORIA,
        accion: 'campana_enviada',
        idNegocio: Number(idNegocio),
        idUsuario,
        detalle: {
            id_campana: idCampana,
            destinatarios: campana.destinatarios,
            programada_para: programadaPara,
            avisos: gate.avisos.map((a) => a.code),
        },
    });

    return actualizada;
}

/** Para la campaña donde esté. Lo ya enviado no se puede deshacer, y la pantalla lo dice. */
async function pausar({ idNegocio, idCampana, motivo: razon = null, idUsuario = null } = {}) {
    const campana = await obtener({ idNegocio, idCampana });
    if (!['ENVIANDO', 'PROGRAMADA'].includes(campana.estado)) {
        throw fallo(`No hay nada que pausar: la promoción está ${campana.estado}.`, {
            code: 'PROMOS_ESTADO_INVALIDO',
        });
    }

    await sequelize.query(
        `UPDATE platform.campana
            SET estado = 'PAUSADA', motivo_corte = :razon, actualizado_en = now()
          WHERE id_campana = :idCampana;`,
        { replacements: { idCampana, razon } }
    );

    await auditHelper.registrarEvento({
        modulo: MODULO_AUDITORIA,
        accion: 'campana_pausada',
        idNegocio: Number(idNegocio),
        idUsuario,
        detalle: { id_campana: idCampana, motivo: razon },
    });

    return { pausada: true };
}

/** Cancela: lo pendiente no sale nunca. */
async function cancelar({ idNegocio, idCampana, idUsuario = null } = {}) {
    const campana = await obtener({ idNegocio, idCampana });
    if (['ENVIADA', 'CANCELADA'].includes(campana.estado)) {
        throw fallo(`La promoción ya está ${campana.estado}.`, { code: 'PROMOS_ESTADO_INVALIDO' });
    }

    return sequelize.transaction(async (transaction) => {
        await sequelize.query(
            `UPDATE platform.campana_destinatario
                SET estado = 'OMITIDO', motivo_omision = 'campana_cancelada'
              WHERE id_campana = :idCampana AND estado = 'PENDIENTE';`,
            { replacements: { idCampana }, transaction }
        );
        await sequelize.query(
            `UPDATE platform.campana
                SET estado = 'CANCELADA', terminada_en = now(), actualizado_en = now()
              WHERE id_campana = :idCampana;`,
            { replacements: { idCampana }, transaction }
        );
        await auditHelper.registrarEvento({
            modulo: MODULO_AUDITORIA,
            accion: 'campana_cancelada',
            idNegocio: Number(idNegocio),
            idUsuario,
            detalle: { id_campana: idCampana },
            transaction,
        });
        return { cancelada: true };
    });
}

/**
 * El informe de una campaña, que es el producto.
 *
 * La entrega se lee de `intelligence.mensaje` y **no** de una columna nuestra (ver la cabecera).
 * La atribución es el primer evento del destinatario en los 7 días siguientes al envío, y cuenta
 * como *recuperado* solo si no tenía ninguno en los 30 días previos: defendible, explicable al
 * dueño, y calculable con `id_persona_negocio`, que ya está en las órdenes y en las citas.
 */
async function informe({ idNegocio, idCampana } = {}) {
    const campana = await obtener({ idNegocio, idCampana });
    const par = await hechos.paraNegocio(idNegocio);

    const [envio] = await sequelize.query(
        `SELECT COUNT(*)::int AS destinatarios,
                COUNT(*) FILTER (WHERE cd.estado = 'ENCOLADO')::int AS encolados,
                COUNT(*) FILTER (WHERE cd.estado = 'OMITIDO')::int AS omitidos,
                COUNT(*) FILTER (WHERE cd.estado = 'PENDIENTE')::int AS pendientes,
                COUNT(*) FILTER (WHERE m.estado_entrega IN ('entregado','sent','delivered','read'))::int AS salieron,
                COUNT(*) FILTER (WHERE m.estado_entrega = 'read')::int AS leidos,
                COUNT(*) FILTER (WHERE m.estado_entrega = 'fallido')::int AS fallidos,
                COUNT(*) FILTER (WHERE cd.credito_cobrado)::int AS creditos_cobrados,
                COUNT(*) FILTER (WHERE cd.credito_devuelto_en IS NOT NULL)::int AS creditos_devueltos
           FROM platform.campana_destinatario cd
           LEFT JOIN intelligence.mensaje m ON m.id_mensaje = cd.id_mensaje
          WHERE cd.id_campana = :idCampana;`,
        { replacements: { idCampana }, ...SELECT }
    );

    // Por qué no se le mandó a alguien, agrupado: es la mitad del informe que de verdad enseña algo.
    const omisiones = await sequelize.query(
        `SELECT motivo_omision AS motivo, COUNT(*)::int AS n
           FROM platform.campana_destinatario
          WHERE id_campana = :idCampana AND estado = 'OMITIDO'
          GROUP BY 1 ORDER BY 2 DESC;`,
        { replacements: { idCampana }, ...SELECT }
    );

    // Los códigos de error de Meta, que es lo que dice si hay que arreglar algo o no. El 131049
    // (tope de marketing por usuario) no es culpa de nadie; el 131042 sí hay que arreglarlo.
    const errores = await sequelize.query(
        `SELECT m.crudo->'acuse'->>'code' AS codigo, COUNT(*)::int AS n
           FROM platform.campana_destinatario cd
           JOIN intelligence.mensaje m ON m.id_mensaje = cd.id_mensaje
          WHERE cd.id_campana = :idCampana AND m.estado_entrega = 'fallido'
          GROUP BY 1 ORDER BY 2 DESC;`,
        { replacements: { idCampana }, ...SELECT }
    );

    let retorno = null;
    if (par && campana.enviando_desde) {
        const [fila] = await sequelize.query(
            `WITH h AS (${par.adaptador.sql})
             SELECT COUNT(*) FILTER (WHERE respondio)::int   AS respondieron,
                    COUNT(*) FILTER (WHERE pidio)::int       AS pidieron,
                    COUNT(*) FILTER (WHERE pidio AND recuperado)::int AS recuperados,
                    COALESCE(SUM(valor) FILTER (WHERE pidio), 0)::numeric AS venta
               FROM (
                 SELECT cd.id_persona_negocio,
                        EXISTS (
                            SELECT 1 FROM intelligence.mensaje mm
                             WHERE mm.id_conversacion = (
                                 SELECT m2.id_conversacion FROM intelligence.mensaje m2
                                  WHERE m2.id_mensaje = cd.id_mensaje)
                               AND mm.direccion = 'entrante'
                               AND mm.creado_en BETWEEN cd.encolado_en AND cd.encolado_en + interval '7 days'
                        ) AS respondio,
                        -- Un evento nuevo después del envío.
                        (h.ultimo_evento IS NOT NULL
                         AND h.ultimo_evento >= cd.encolado_en
                         AND h.ultimo_evento <= cd.encolado_en + interval '7 days') AS pidio,
                        -- «Recuperado» solo si no venía ya: si pidió en los 30 días previos, su
                        -- pedido no se le puede atribuir a la promoción.
                        (cd.segmento IN ('en_riesgo', 'dormido')) AS recuperado,
                        h.valor_total AS valor
                   FROM platform.campana_destinatario cd
                   LEFT JOIN h ON h.id_persona_negocio = cd.id_persona_negocio
                  WHERE cd.id_campana = :idCampana AND cd.estado = 'ENCOLADO'
               ) x;`,
            { replacements: { idCampana, idNegocio: Number(idNegocio) }, ...SELECT }
        );
        retorno = {
            respondieron: Number(fila?.respondieron || 0),
            pidieron: Number(fila?.pidieron || 0),
            recuperados: Number(fila?.recuperados || 0),
            venta_atribuida: Number(fila?.venta || 0),
            ventana_dias: 7,
        };
    }

    return {
        campana,
        envio: Object.fromEntries(Object.entries(envio || {}).map(([k, v]) => [k, Number(v)])),
        omisiones,
        errores,
        retorno,
    };
}

/** El historial. Lo que el dueño mira para decidir si la próxima vale la pena. */
async function listar({ idNegocio, limite = 50 } = {}) {
    return sequelize.query(
        `SELECT c.id_campana, c.nombre, c.estado, c.plantilla, c.destinatarios,
                c.programada_para, c.enviando_desde, c.terminada_en, c.creado_en,
                c.costo_estimado->'meta'->>'costo_usd' AS costo_usd,
                COUNT(cd.*) FILTER (WHERE cd.estado = 'ENCOLADO')::int AS encolados,
                COUNT(m.*) FILTER (WHERE m.estado_entrega = 'read')::int AS leidos
           FROM platform.campana c
           LEFT JOIN platform.campana_destinatario cd ON cd.id_campana = c.id_campana
           LEFT JOIN intelligence.mensaje m ON m.id_mensaje = cd.id_mensaje
          WHERE c.id_negocio = :idNegocio
          GROUP BY c.id_campana
          ORDER BY c.creado_en DESC
          LIMIT :limite;`,
        { replacements: { idNegocio: Number(idNegocio), limite: Math.min(Number(limite) || 50, 200) }, ...SELECT }
    );
}

module.exports = {
    MAX_DESTINATARIOS,
    DIAS_ENTRE_CAMPANAS,
    limpiarParametro,
    insertarDestinatarios,
    completarParametros,
    materializar,
    obtener,
    crear,
    mandarPrueba,
    enviar,
    pausar,
    cancelar,
    informe,
    listar,
};
