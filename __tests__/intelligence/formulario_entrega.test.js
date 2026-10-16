/**
 * El formulario de entrega por WhatsApp (WhatsApp Flows, 2026-10-16).
 *
 *  - el canal convierte la respuesta del formulario en texto legible (antes llegaba vacía y se
 *    rechazaba con TEXTO_VACIO: los datos se perdían);
 *  - una opción con `formulario` sale como mensaje `flow`, y el núcleo no se la come al normalizar;
 *  - el pedido: con el formulario encendido el paso de entrega ofrece el botón, y la respuesta
 *    llena entrega, dirección, pago y barrio —con la búsqueda de barrio de siempre—;
 *  - apagado (o fuera de WhatsApp) todo sigue con los botones de antes.
 */
'use strict';

const adaptador = require('../../intelligence/channels/whatsapp/adaptador');
const mensajeCanonico = require('../../intelligence/core/mensajeCanonico');
const formularioEntrega = require('../../intelligence/adapters/restaurante/formularioEntrega');
const flujo = require('../../intelligence/adapters/restaurante/flujo');

const respuestaDeMeta = (campos) => ({
    type: 'interactive',
    interactive: {
        type: 'nfm_reply',
        nfm_reply: { name: 'flow', response_json: JSON.stringify({ flow_token: 'entrega:c', ...campos }) },
    },
});

describe('el canal y el formulario', () => {
    it('la respuesta llega como texto legible, sin los campos vacíos ni el token', () => {
        const texto = adaptador.textoDeMensaje(
            respuestaDeMeta({ entrega: 'domicilio', barrio: 'Las Cuadras', direccion: 'Cra 24 # 18-35', indicaciones: '', pago: 'Nequi' })
        );
        expect(texto).toBe(
            '📋 Formulario enviado\nEntrega: domicilio\nBarrio: Las Cuadras\nDireccion: Cra 24 # 18-35\nPago: Nequi'
        );
        expect(texto).not.toContain('entrega:c');
    });

    it('lo que el canal escribe es lo que el restaurante lee', () => {
        const texto = adaptador.textoDeMensaje(respuestaDeMeta({ entrega: 'recoger', pago: 'Efectivo' }));
        expect(formularioEntrega.leer(texto)).toEqual({ entrega: 'recoger', pago: 'Efectivo' });
        expect(formularioEntrega.leer('hola, a domicilio')).toBeNull();
    });

    it('una opción con formulario sale como mensaje flow, con sus datos', () => {
        const salida = mensajeCanonico.normalizarSalida({
            texto: '¿Cómo lo recibes?',
            opciones: [formularioEntrega.opcion({ flowId: 'F1', idConversacion: 'c', conMesas: false })],
        });
        expect(salida.opciones[0].formulario.flow_id).toBe('F1');

        const payload = adaptador.renderizar(salida);
        expect(payload.type).toBe('interactive');
        expect(payload.interactive.type).toBe('flow');
        const p = payload.interactive.action.parameters;
        expect(p).toMatchObject({ flow_id: 'F1', flow_cta: 'Completar datos', flow_action: 'navigate', flow_token: 'entrega:c' });
        expect(p.mode).toBeUndefined();
        expect(p.flow_action_payload.screen).toBe('DATOS_ENTREGA');
        expect(p.flow_action_payload.data.entregas.map((e) => e.id)).toEqual(['domicilio', 'recoger']);
    });

    it('con mesas el formulario ofrece también «Para servir»', () => {
        const o = formularioEntrega.opcion({ flowId: 'F1', idConversacion: 'c', conMesas: true });
        expect(o.formulario.datos.entregas.map((e) => e.id)).toContain('servir');
    });

    it('el JSON del formulario respeta los 20 caracteres por título de campo', () => {
        const campos = [];
        const recorrer = (nodos) =>
            (nodos || []).forEach((n) => {
                if (n.label && n.type !== 'Footer') campos.push(n.label);
                recorrer(n.then);
                recorrer(n.else);
            });
        recorrer(formularioEntrega.FLOW_JSON.screens[0].layout.children);
        expect(campos.length).toBeGreaterThan(3);
        for (const c of campos) expect(c.length).toBeLessThanOrEqual(20);
        expect(campos.join(' ')).not.toMatch(/opcional/i);
    });
});

// ── El pedido ───────────────────────────────────────────────────────────────────────────

const BARRIOS = [
    { id_barrio: 1, nombre: 'San José', zona: 'Comuna 1', valor: 5000 },
    { id_barrio: 2, nombre: 'San José', zona: 'Buesaquillo', valor: 9000 },
    { id_barrio: 3, nombre: 'Las Cuadras', zona: 'Comuna 1', valor: 4000 },
];

function crear({ flowId = 'FLOW1' } = {}) {
    return flujo.crearFlujoRestaurante({
        contextoNegocio: {
            obtener: async () => ({ id: 12, nombre: 'P', tratamiento: 'P', atencion: null, tipoNegocio: 'RESTAURANTE' }),
        },
        identidad: { resolver: async () => ({ principal: { telefono_verificado: '573000000000' } }) },
        gate: {},
        catalogo: {
            barrios: async () => ({ habilitado: true, barrios: BARRIOS }),
            mesas: async () => [],
            resolverBarrio: async () => { throw new Error('no se usa'); },
            resolverMesa: async () => { throw new Error('no se usa'); },
            resolverExclusiones: async ({ lineas }) => lineas.map(() => ({ validas: [], descartadas: [] })),
            formularioEntrega: async () => flowId,
        },
    });
}

const turno = (manejar, texto, tarea = null, canal = 'whatsapp') =>
    manejar({
        conversacion: {
            id_conversacion: 'c', id_negocio: 12, canal, id_externo: '573000000000',
            variables: { turnos: 1, nombre: 'Ana' },
            tarea_actual: tarea?.nombre ?? null,
            tarea_datos: tarea?.datos ?? null,
        },
        mensajes: [{ contenido: texto }], texto, turno: { id_turno: 't' },
    });

const formulario = (campos) => adaptador.textoDeMensaje(respuestaDeMeta(campos));
const opcionesDe = (d) => d.respuestas.flatMap((r) => (typeof r === 'string' ? [] : r.opciones || []));

describe('el pedido con el formulario encendido', () => {
    it('el paso de entrega ofrece el botón del formulario y deja las palabras en el texto', async () => {
        const d = await turno(crear(), '#P12-4x1');
        const op = opcionesDe(d);
        expect(op).toHaveLength(1);
        expect(op[0].formulario.flow_id).toBe('FLOW1');
        expect(d.respuestas.map((r) => r.texto ?? r).join('\n')).toContain('*domicilio* o *recoger*');
    });

    it('apagado, o fuera de WhatsApp, siguen los dos botones de siempre', async () => {
        const apagado = await turno(crear({ flowId: null }), '#P12-4x1');
        expect(opcionesDe(apagado).map((o) => o.id)).toEqual(['entrega_domicilio', 'entrega_recoger']);
        const webchat = await turno(crear(), '#P12-4x1', null, 'webchat');
        expect(opcionesDe(webchat).some((o) => o.formulario)).toBe(false);
    });

    it('a domicilio con un barrio repetido: pregunta cuál, con la dirección y el pago ya guardados', async () => {
        const manejar = crear();
        const d0 = await turno(manejar, '#P12-4x1');
        const d1 = await turno(
            manejar,
            formulario({ entrega: 'domicilio', barrio: 'san jose', direccion: 'Cra 24 # 18-35', indicaciones: 'reja negra', pago: 'Nequi' }),
            d0.tarea
        );
        const texto = d1.respuestas.map((r) => r.texto ?? r).join('\n');
        expect(texto).toContain('1. San José (Comuna 1) — $5.000');
        expect(d1.tarea.datos).toMatchObject({
            entrega: 'DOMICILIO',
            direccion: 'Cra 24 # 18-35 — reja negra',
            nota: 'Pago: Nequi',
            barrio_opciones: [1, 2],
        });
        expect(d1.pasos.map((p) => p.decision ?? p.tipo)).toContain('pedido_formulario_recibido');
    });

    it('a domicilio con un barrio que existe una vez: queda elegido sin preguntar', async () => {
        const manejar = crear();
        const d0 = await turno(manejar, '#P12-4x1');
        const d1 = await turno(
            manejar,
            formulario({ entrega: 'domicilio', barrio: 'las cuadras', direccion: 'Calle 10 # 5-20', pago: 'Efectivo' }),
            d0.tarea
        );
        // Con todo lo necesario, va directo a pedir el «sí».
        expect(d1.tarea.nombre).toBe('confirmar_mutacion');
        expect(d1.tarea.datos.args).toMatchObject({
            tipo_entrega: 'DOMICILIO',
            direccion: 'Calle 10 # 5-20',
            id_barrio: 3,
            nota: 'Pago: Efectivo',
        });
    });

    it('para recoger no guarda dirección ni pide barrio', async () => {
        const manejar = crear();
        const d0 = await turno(manejar, '#P12-4x1');
        const d1 = await turno(manejar, formulario({ entrega: 'recoger', pago: 'Efectivo' }), d0.tarea);
        const texto = JSON.stringify(d1);
        expect(texto).not.toContain('¿En qué barrio');
        expect(texto).not.toContain('¿A qué dirección');
    });
});
