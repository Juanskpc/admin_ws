/**
 * ¿Qué le falta a un negocio para que su asistente de WhatsApp atienda bien?
 *
 * ## Por qué existe (2026-10-02)
 *
 * La primera noche de Zona Burger el asistente funcionó, pero a medias: sin tiempo de entrega,
 * sin número de Nequi ni valor del domicilio, sin vuelta automática tras una respuesta humana…
 * Cada hueco salió como un cliente esperando o como «confírmalo con el restaurante». Nada de eso
 * era código: eran DATOS que nadie le había pedido al negocio. Esto convierte esa lista en algo
 * que el sistema revisa solo y le enseña al dueño en la Bandeja, apenas conecta su número.
 *
 * Cada punto dice qué falta, POR QUÉ importa (lo que pasa con el cliente si falta) y DÓNDE se
 * arregla. Tres niveles:
 *   - `falta`       — sin esto el asistente falla con el cliente (no sabe si está abierto, no
 *                     tiene qué vender…).
 *   - `recomendado` — funciona, pero contesta «no tengo esa información» y alguien tiene que
 *                     entrar a mano.
 *   - `ok`
 *
 * Cada comprobación va en su propio try: una tabla que no exista en un entorno (o una vertical
 * sin migrar) no tumba el resto de la lista; ese punto simplemente no sale.
 */
'use strict';

const Models = require('../../app_core/models/conection');
const features = require('../../intelligence/core/features');
const contextoNegocio = require('../../intelligence/core/contextoNegocio');

const sequelize = Models.sequelize;
const SELECT = { type: sequelize.QueryTypes.SELECT };

async function uno(sql, replacements) {
    const [fila] = await sequelize.query(sql, { replacements, ...SELECT });
    return fila || null;
}

const APP_RESTAURANTE = 'App del restaurante';
const APP_RESERVA = 'App de reservas';
const BANDEJA = 'Aquí, en WhatsApp';

/** Comprobaciones comunes a cualquier vertical. */
function comunes() {
    return [
        {
            clave: 'whatsapp_conectado',
            titulo: 'Número de WhatsApp conectado',
            donde: `${BANDEJA} → Gestionar número`,
            async revisar({ idNegocio }) {
                const f = await uno(
                    `SELECT count(*)::int AS n FROM platform.numero_canal
                      WHERE id_negocio = :idNegocio AND canal = 'whatsapp' AND estado = 'A';`,
                    { idNegocio }
                );
                return f.n > 0
                    ? { estado: 'ok' }
                    : { estado: 'falta', por_que: 'Sin número conectado nadie le puede escribir al asistente.' };
            },
        },
        {
            clave: 'plan_con_asistente',
            titulo: 'Plan con asistente de WhatsApp',
            donde: 'Mis pagos → Planes',
            async revisar({ idNegocio }) {
                return (await features.estaHabilitado(idNegocio, features.FEATURE.ASISTENTE_IA))
                    ? { estado: 'ok' }
                    : {
                          estado: 'falta',
                          por_que:
                              'Sin el asistente en el plan, el bot no puede consultar la carta ni tomar ' +
                              'pedidos: solo contesta «confírmalo con el negocio».',
                      };
            },
        },
        {
            clave: 'info_asistente',
            titulo: 'Información para el asistente (pagos, Nequi…)',
            donde: `${BANDEJA} → «Info para el asistente»`,
            async revisar({ negocio }) {
                return String(negocio.info_asistente || '').trim()
                    ? { estado: 'ok' }
                    : {
                          estado: 'recomendado',
                          por_que:
                              'Los clientes preguntan el número de Nequi o si reciben efectivo o transferencia. ' +
                              'Sin esto el asistente contesta «no tengo esa información».',
                      };
            },
        },
        {
            clave: 'reactivacion',
            titulo: 'Que el asistente vuelva solo después de que alguien conteste',
            donde: `${BANDEJA} → «Asistente vuelve tras … min»`,
            async revisar({ negocio }) {
                return Number(negocio.reactivar_asistente_min) > 0
                    ? { estado: 'ok' }
                    : {
                          estado: 'recomendado',
                          por_que:
                              'Cuando alguien del negocio contesta desde su celular, el asistente se calla en ' +
                              'ese chat. Sin esto no vuelve nunca, y los siguientes mensajes de ese cliente ' +
                              'quedan sin respuesta si nadie los mira.',
                      };
            },
        },
    ];
}

function deRestaurante() {
    return [
        {
            clave: 'horario',
            titulo: 'Horario de atención',
            donde: `${APP_RESTAURANTE} → Horarios`,
            async revisar({ idNegocio }) {
                const f = await uno(
                    `SELECT count(*)::int AS n FROM restaurante.rest_horario
                      WHERE id_negocio = :idNegocio AND id_usuario IS NULL;`,
                    { idNegocio }
                );
                return f.n > 0
                    ? { estado: 'ok' }
                    : {
                          estado: 'falta',
                          por_que:
                              'Sin horario el asistente no sabe si están abiertos: a la noche le dice al ' +
                              'cliente «cerrado» o le toma un pedido a deshoras.',
                      };
            },
        },
        {
            clave: 'carta',
            titulo: 'Carta con productos visibles',
            donde: `${APP_RESTAURANTE} → Menú`,
            async revisar({ idNegocio }) {
                const f = await uno(
                    `SELECT count(*)::int AS n FROM restaurante.carta_producto
                      WHERE id_negocio = :idNegocio AND estado = 'A'
                        AND COALESCE(visible, true) AND COALESCE(disponible, true);`,
                    { idNegocio }
                );
                return f.n > 0
                    ? { estado: 'ok' }
                    : { estado: 'falta', por_que: 'Sin productos visibles el asistente no tiene nada que vender.' };
            },
        },
        {
            clave: 'tiempo_entrega',
            titulo: 'Tiempo de entrega',
            donde: `${BANDEJA} → «Entrega en … a … min»`,
            async revisar({ negocio }) {
                return Number(negocio.tiempo_estimado_min) > 0
                    ? { estado: 'ok' }
                    : {
                          estado: 'recomendado',
                          por_que:
                              '«¿Cuánto se demora?» es de las preguntas más repetidas. Sin un tiempo, el ' +
                              'asistente contesta que no lo sabe.',
                      };
            },
        },
        {
            clave: 'metodos_pago',
            titulo: 'Métodos de pago',
            donde: `${APP_RESTAURANTE} → Configuración`,
            async revisar({ idNegocio }) {
                const f = await uno(
                    `SELECT count(*)::int AS n FROM restaurante.rest_metodo_pago
                      WHERE id_negocio = :idNegocio AND estado = 'A' AND NOT es_cuenta;`,
                    { idNegocio }
                );
                return f.n > 0
                    ? { estado: 'ok' }
                    : {
                          estado: 'recomendado',
                          por_que: 'Para contestar «¿puedo pagar con…?» el asistente necesita saber qué reciben.',
                      };
            },
        },
        {
            clave: 'domicilio',
            titulo: 'Valor del domicilio',
            donde: `${BANDEJA} → «Domicilio entre $ … y $ …»`,
            async revisar({ idNegocio, negocio }) {
                // Desde 2026-10-02 lo normal es un RANGO («entre $7.000 y $9.000»): cargar el
                // precio barrio por barrio era tedioso. Los barrios siguen contando para quien
                // los tenga, y la nota sola («fuera de la ciudad, desde $10.000») también.
                const conRango =
                    negocio.domicilio_valor_min !== null && negocio.domicilio_valor_min !== undefined;
                const conNota = Boolean(String(negocio.domicilio_nota || '').trim());
                if (conRango || conNota) return { estado: 'ok' };
                const f = await uno(
                    `SELECT count(*)::int AS n FROM restaurante.rest_barrio_domicilio
                      WHERE id_negocio = :idNegocio AND estado = 'A';`,
                    { idNegocio }
                );
                const enInfo = /domicil/i.test(String(negocio.info_asistente || ''));
                return f.n > 0 || enInfo
                    ? { estado: 'ok' }
                    : {
                          estado: 'recomendado',
                          por_que:
                              'Los clientes preguntan cuánto vale el domicilio. Basta un rango (por ' +
                              'ejemplo, entre $7.000 y $9.000): sin él, el asistente contesta que no lo sabe.',
                      };
            },
        },
    ];
}

function deReserva() {
    return [
        {
            clave: 'servicios',
            titulo: 'Servicios con duración y precio',
            donde: `${APP_RESERVA} → Servicios`,
            async revisar({ idNegocio }) {
                const f = await uno(
                    `SELECT count(*)::int AS n FROM reserva.reserva_servicio
                      WHERE id_negocio = :idNegocio AND COALESCE(estado, 'A') = 'A';`,
                    { idNegocio }
                );
                return f.n > 0
                    ? { estado: 'ok' }
                    : { estado: 'falta', por_que: 'Sin servicios no hay nada que el asistente pueda agendar.' };
            },
        },
        {
            clave: 'profesionales',
            titulo: 'Profesionales que atienden',
            donde: `${APP_RESERVA} → Equipo`,
            async revisar({ idNegocio }) {
                const f = await uno(
                    `SELECT count(*)::int AS n FROM reserva.reserva_profesional
                      WHERE id_negocio = :idNegocio AND estado = 'A';`,
                    { idNegocio }
                );
                return f.n > 0
                    ? { estado: 'ok' }
                    : { estado: 'falta', por_que: 'Sin profesionales no hay con quién agendar la cita.' };
            },
        },
        {
            clave: 'horario',
            titulo: 'Horario de atención',
            donde: `${APP_RESERVA} → Horarios`,
            async revisar({ idNegocio }) {
                const f = await uno(
                    `SELECT count(*)::int AS n FROM reserva.reserva_horario WHERE id_negocio = :idNegocio;`,
                    { idNegocio }
                );
                return f.n > 0
                    ? { estado: 'ok' }
                    : { estado: 'falta', por_que: 'Sin horario el asistente no puede ofrecer horas libres.' };
            },
        },
    ];
}

/**
 * @returns {Promise<{tipo: string|null, pendientes: number, criticos: number, puntos: Array}>}
 */
async function revisar(idNegocio) {
    const negocio =
        (await uno(
            `SELECT id_negocio, reactivar_asistente_min, tiempo_estimado_min, info_asistente,
                    domicilio_valor_min, domicilio_nota
               FROM general.gener_negocio WHERE id_negocio = :idNegocio;`,
            { idNegocio }
        ).catch(() =>
            // Sin la migración del rango de domicilio (2026-10-02), la consulta de antes.
            uno(
                `SELECT id_negocio, reactivar_asistente_min, tiempo_estimado_min, info_asistente
                   FROM general.gener_negocio WHERE id_negocio = :idNegocio;`,
                { idNegocio }
            )
        ).catch(() =>
            uno(
                `SELECT id_negocio, reactivar_asistente_min FROM general.gener_negocio
                  WHERE id_negocio = :idNegocio;`,
                { idNegocio }
            )
        )) || null;
    if (!negocio) return null;

    const tipo = (await contextoNegocio.obtener(idNegocio))?.tipoNegocio || null;
    const lista = [
        ...comunes(),
        ...(tipo === 'RESTAURANTE' ? deRestaurante() : []),
        ...(tipo === 'RESERVA' || tipo === 'ALOJAMIENTO' ? deReserva() : []),
    ];

    const puntos = [];
    for (const p of lista) {
        try {
            const r = await p.revisar({ idNegocio, negocio });
            puntos.push({ clave: p.clave, titulo: p.titulo, donde: p.donde, estado: r.estado, por_que: r.por_que ?? null });
        } catch (error) {
            console.warn(`[preparacion] «${p.clave}» no se pudo revisar en el negocio ${idNegocio}: ${error.message}`);
        }
    }

    // Primero lo que falta, después lo recomendado, al final lo que ya está.
    const orden = { falta: 0, recomendado: 1, ok: 2 };
    puntos.sort((a, b) => orden[a.estado] - orden[b.estado]);

    return {
        tipo,
        criticos: puntos.filter((p) => p.estado === 'falta').length,
        pendientes: puntos.filter((p) => p.estado !== 'ok').length,
        puntos,
    };
}

module.exports = { revisar };
