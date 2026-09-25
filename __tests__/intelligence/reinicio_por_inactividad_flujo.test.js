/**
 * Lo que el cliente ve DESPUÉS de un reinicio por inactividad (ver `reinicio_por_inactividad.
 * test.js` para el mecanismo que lo produce: `repositorio.reiniciarSiInactivaMucho` deja
 * `tarea_actual: null`, `tarea_datos: {}` y `variables: {}`).
 *
 * Este archivo no toca Postgres: solo comprueba que el flujo de restaurante, con ESE estado
 * exacto, hace lo que el dueño pidió —saludo con el enlace de la carta, salvo que el mensaje ya
 * sea un código de carrito, que se procesa como pedido nuevo—. Es la misma garantía que ya
 * cubren `pedido_del_menu_modalidad.test.js` y el resto de la suite de `flujo.js` para «primera
 * conversación»; aquí se nombra explícitamente para que quede claro que un reinicio por
 * inactividad cae en el mismo camino, sin ninguna rama especial para él.
 *
 * Correr con:  npx jest __tests__/intelligence/reinicio_por_inactividad_flujo.test.js
 */
'use strict';

const flujo = require('../../intelligence/adapters/restaurante/flujo');
const { crearFlujoRestaurante, enlaceDelMenu } = flujo;

function crear({ telefonoProbado = '573000000000' } = {}) {
    const catalogo = {
        barrios: async () => ({ habilitado: false, barrios: [] }),
        mesas: async () => [],
        resolverBarrio: async () => null,
        resolverMesa: async () => null,
        resolverExclusiones: async () => null,
    };
    return crearFlujoRestaurante({
        contextoNegocio: {
            obtener: async () => ({
                id: 12, nombre: 'Pregonchos', tratamiento: 'Pregonchos', atencion: null, tipoNegocio: 'RESTAURANTE',
            }),
        },
        identidad: { resolver: async () => ({ principal: { telefono_verificado: telefonoProbado } }) },
        gate: {},
        catalogo,
        estadoAtencion: async () => ({ estado: 'abierto' }),
        ahora: () => new Date('2026-09-24T18:00:00-05:00'),
    });
}

/** Exactamente lo que deja `reiniciarSiInactivaMucho` en la fila: tarea y memoria en blanco. */
const conversacionReiniciada = (extra = {}) => ({
    id_conversacion: 'conv-1',
    id_negocio: 12,
    canal: 'whatsapp',
    id_externo: '573000000000',
    variables: {},
    tarea_actual: null,
    tarea_datos: {},
    ...extra,
});

const decir = (manejar, conv, texto) =>
    manejar({ conversacion: conv, mensajes: [{ contenido: texto }], texto, turno: { id_turno: 't1' } });

const textos = (d) => (d.respuestas || []).map((r) => (typeof r === 'string' ? r : r.texto)).join('\n');

describe('tras el reinicio por inactividad, restaurante', () => {
    test('un mensaje cualquiera recibe el saludo normal, con el enlace de la carta', async () => {
        const d = await decir(crear(), conversacionReiniciada(), 'hola, sigues ahí?');

        expect(textos(d)).toContain(enlaceDelMenu(12));
        expect(textos(d)).toMatch(/Te saluda \*Pregonchos\*/);
        // Sin tarea abierta: el saludo no deja ningún pedido ni agendamiento a medias.
        expect(d.tarea).toBeNull();
    });

    test('respeta el estado de atención, igual que en la primera conversación de siempre', async () => {
        const cerrado = crearFlujoRestaurante({
            contextoNegocio: { obtener: async () => ({ id: 12, tratamiento: 'Pregonchos' }) },
            identidad: { resolver: async () => ({ principal: { telefono_verificado: '573000000000' } }) },
            gate: {},
            catalogo: { barrios: async () => ({ habilitado: false, barrios: [] }), mesas: async () => [] },
            estadoAtencion: async () => ({ estado: 'fuera_de_horario' }),
            ahora: () => new Date('2026-09-24T02:00:00-05:00'),
        });

        const d = await decir(cerrado, conversacionReiniciada(), 'hola');
        expect(textos(d)).toMatch(/fuera de nuestro horario/);
    });

    test('un código de carrito (#P…) se procesa como pedido nuevo, NO como saludo', async () => {
        const d = await decir(crear(), conversacionReiniciada(), '#P12-4x2');

        // Nada de saludo: hay una tarea de pedido abierta pidiendo lo que falte del pedido.
        expect(textos(d)).not.toMatch(/Te saluda/);
        expect(d.tarea?.nombre).toBe(flujo.TAREA_PEDIDO);
    });
});
