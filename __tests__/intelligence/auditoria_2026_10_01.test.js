/**
 * Lo que salió de la auditoría de la primera noche de Zona Burger con WhatsApp (2026-10-01).
 *
 * Cada caso usa un mensaje REAL de esa noche (o su forma exacta). Las primeras secciones no tocan
 * la base; la última sí (DB_PORT=5432) y prueba la regla de fondo: lo que llega con una persona
 * atendiendo, o con horas de retraso, nunca queda «pendiente» para el asistente.
 */
'use strict';
require('dotenv').config();

const cortesia = require('../../intelligence/engine/cortesia');
const { esAfirmacion } = require('../../intelligence/engine/texto');
const { lineasParaAnotar } = require('../../intelligence/engine/confirmacion');
const { esPreguntaDeTiempo } = require('../../intelligence/adapters/restaurante/flujo');
const { esAntiguo } = require('../../intelligence/channels/whatsapp/adaptador');
const openai = require('../../intelligence/model/adaptadores/openai');
const anthropic = require('../../intelligence/model/adaptadores/anthropic');
const { estadoParaElCliente } = require('../../intelligence/adapters/restaurante/index');

describe('cortesías de cierre (pedido del dueño)', () => {
    const conv = (variables = { turnos: 4 }) => ({ conversacion: { variables: { ...variables } } });
    const dijo = (texto) => async () => texto;

    test('«Gracias» tras un cierre: una respuesta fija, sin modelo', async () => {
        const d = await cortesia.decidir(
            { ...conv(), texto: 'Gracias' },
            { hayTarea: false, ultimoDelAsistente: dijo('¡Listo! Tu pedido quedó tomado. El número es ORD-7550.') }
        );
        expect(d.respuestas).toEqual([cortesia.RESPUESTA]);
        expect(d.nivel).toBe('determinista');
        expect(d.variables[cortesia.MARCA]).toBe(true);
    });

    test('el segundo «Gracias» ya no se contesta', async () => {
        const d = await cortesia.decidir(
            { ...conv({ turnos: 5, [cortesia.MARCA]: true }), texto: 'Gracias' },
            { hayTarea: false, ultimoDelAsistente: dijo(cortesia.RESPUESTA) }
        );
        expect(d.respuestas).toEqual([]);
        expect(d.resultado).toBe('sin_respuesta');
    });

    test('un «ok», un sticker o un emoji tras un cierre: silencio directo', async () => {
        for (const texto of ['ok', '[sticker]', '😊', 'Ya paso', 'Estoy pendiente']) {
            const d = await cortesia.decidir(
                { ...conv(), texto },
                { hayTarea: false, ultimoDelAsistente: dijo('Perfecto, veci. Te esperamos.') }
            );
            expect(d.respuestas).toEqual([]);
        }
    });

    test('si el asistente acaba de PREGUNTAR, «ok» es una respuesta y sigue su camino', async () => {
        const d = await cortesia.decidir(
            { ...conv(), texto: 'ok' },
            { hayTarea: false, ultimoDelAsistente: dijo('La *the house GRANDE* vale $39.000. ¿Quieres pedirla para recoger?') }
        );
        expect(d).toBeNull();
    });

    test('pedir algo después de agradecer sí se atiende, y borra la marca', async () => {
        const ctx = { ...conv({ turnos: 6, [cortesia.MARCA]: true }), texto: 'Y de tomar?' };
        const d = await cortesia.decidir(ctx, { hayTarea: false, ultimoDelAsistente: dijo('¡Con gusto!') });
        expect(d).toBeNull();
        expect(ctx.conversacion.variables[cortesia.MARCA]).toBeUndefined();
    });

    test('con una tarea a medias, o en el primer mensaje, no se toca nada', async () => {
        const ultimo = dijo('Perfecto.');
        expect(await cortesia.decidir({ ...conv(), texto: 'listo' }, { hayTarea: true, ultimoDelAsistente: ultimo })).toBeNull();
        expect(await cortesia.decidir({ ...conv({ turnos: 0 }), texto: '[sticker]' }, { hayTarea: false, ultimoDelAsistente: ultimo })).toBeNull();
    });

    test('un «sí» suelto o una imagen NO son cortesía', () => {
        expect(cortesia.leer('sí').cortesia).toBe(false);
        expect(cortesia.leer('[image]').cortesia).toBe(false);
        expect(cortesia.leer('Vale pagaré en efectivo').cortesia).toBe(false);
    });
});

describe('«sí» a la colombiana', () => {
    test.each(['Si Veci', 'si', 'Sí porfa', 'siii', 'dale de una', 'Listo veci', 'si señor gracias'])(
        '«%s» confirma',
        (t) => expect(esAfirmacion(t)).toBe(true)
    );
    test.each(['si pero sin cebolla', 'Hit le Lulo si tiene', 'de nada', 'no'])('«%s» no es un sí limpio', (t) =>
        expect(esAfirmacion(t)).toBe(false)
    );
});

describe('lo que el cliente añade al confirmar', () => {
    test('la dirección extra se anota; la pregunta no', () => {
        expect(lineasParaAnotar('Alameda 2 entrada al barrio común', { afirma: false })).toEqual([
            'Alameda 2 entrada al barrio común',
        ]);
        expect(lineasParaAnotar('¿Cuánto vale el domicilio?', { afirma: false })).toEqual([]);
        expect(lineasParaAnotar('espera', { afirma: false })).toEqual([]);
    });

    test('en la ráfaga «Hit le Lulo si tiene» + «si», se anota lo de antes del sí', () => {
        expect(lineasParaAnotar('Hit le Lulo si tiene\nsi', { afirma: true })).toEqual(['Hit le Lulo si tiene']);
    });
});

describe('«¿cuánto se demora?» dicho por quien recoge', () => {
    test.each([
        'En cuanto puedo pasar',
        'En cuanto tiempo puede recoger',
        'Ok  gracias en cuanto tiempo recojo el pedido',
        'A qué hora llega',
        'Cuánto se demora aproximadamente',
    ])('«%s»', (t) => expect(esPreguntaDeTiempo(t)).toBe(true));
});

describe('mensajes viejos que Meta entrega al conectar', () => {
    const ahora = Date.parse('2026-10-01T19:37:41-05:00');
    test('más de 30 minutos de retraso: antiguo', () => {
        expect(esAntiguo(String(ahora / 1000 - 2 * 3600), ahora)).toBe(true);
    });
    test('un mensaje recién enviado no lo es, ni uno sin fecha', () => {
        expect(esAntiguo(String(ahora / 1000 - 5), ahora)).toBe(false);
        expect(esAntiguo(undefined, ahora)).toBe(false);
    });
});

describe('items de tomar_pedido llegan al modelo como lista, no como texto', () => {
    const parametros = {
        items: {
            tipo: 'lista',
            requerido: true,
            min_items: 1,
            elemento: {
                id_producto: { tipo: 'entero', requerido: true, min: 1 },
                cantidad: { tipo: 'entero', requerido: true, min: 1 },
            },
        },
    };
    test.each([['openai', openai], ['anthropic', anthropic]])('%s', (_n, adaptador) => {
        const esquema = adaptador.renderizarEsquema(parametros);
        expect(esquema.properties.items.type).toBe('array');
        expect(esquema.properties.items.items.properties.id_producto.type).toBe('integer');
        expect(esquema.properties.items.items.required).toEqual(['id_producto', 'cantidad']);
    });
});

describe('estado del pedido en palabras del cliente', () => {
    test('«pendiente de pago» ya no se le dice a nadie', () => {
        const base = { estado: 'ABIERTA', estado_pago: 'pendiente_pago', tipo_pedido: 'DOMICILIO' };
        expect(estadoParaElCliente({ ...base, estado_cocina: null })).toMatch(/recibido/);
        expect(estadoParaElCliente({ ...base, estado_cocina: 'EN_PREPARACION' })).toMatch(/preparación/);
        expect(estadoParaElCliente({ ...base, aviso_listo_en: new Date() })).toMatch(/en camino/);
        expect(estadoParaElCliente({ ...base, tipo_pedido: 'LLEVAR', estado_cocina: 'LISTO' })).toMatch(/recoger/);
    });
});

describe('lo que llega con una persona atendiendo no se le contesta después (base local)', () => {
    const Models = require('../../app_core/models/conection');
    const repositorio = require('../../intelligence/engine/repositorio');
    const motor = require('../../intelligence/engine/motor');
    const sequelize = Models.sequelize;
    const CORRIDA = String(Date.now()).slice(-7);
    let idNegocio;
    let n = 0;

    beforeAll(async () => {
        const [fila] = await sequelize.query(
            `SELECT id_negocio FROM general.gener_negocio WHERE estado = 'A' ORDER BY id_negocio LIMIT 1;`,
            { type: sequelize.QueryTypes.SELECT, logging: false }
        );
        idNegocio = fila.id_negocio;
    });

    afterAll(async () => {
        await sequelize.query(
            `DELETE FROM intelligence.conversacion WHERE id_externo LIKE :p;`,
            { replacements: { p: `577${CORRIDA}%` }, logging: false }
        );
        await sequelize.close();
    });

    const pendientes = (id) =>
        sequelize.transaction((t) => repositorio.mensajesPendientes(id, { ventanaDias: 7, transaction: t }));

    const llega = (idExterno, texto, extra = {}) =>
        motor.recibir({
            canal: 'whatsapp',
            idNegocio,
            idExterno,
            texto,
            idExternoMensaje: `wamid.test.${CORRIDA}.${n++}`,
            despertar: false,
            ...extra,
        });

    test('en handoff: se guarda marcado y no es pendiente, ni al volver al asistente', async () => {
        const idExterno = `577${CORRIDA}01`;
        const primero = await llega(idExterno, 'hola');
        await repositorio.cambiarEstadoConversacion(primero.id_conversacion, 'handoff_humano');
        // El primero lo vio la persona que tomó la conversación.
        await repositorio.marcarIntervencionHumana(primero.id_conversacion);

        const r = await llega(idExterno, 'Listo y van por el');
        expect(r.sin_turno_motivo).toBe('handoff_humano');

        await repositorio.cambiarEstadoConversacion(primero.id_conversacion, 'activa');
        expect(await pendientes(primero.id_conversacion)).toHaveLength(0);

        // Lo que escribe después de volver al asistente sí se atiende.
        await llega(idExterno, 'Y de tomar?');
        const ahora = await pendientes(primero.id_conversacion);
        expect(ahora.map((m) => m.contenido)).toEqual(['Y de tomar?']);
    });

    test('la revisión de preparación dice qué falta, por qué y dónde, lo crítico primero', async () => {
        const Preparacion = require('../../app_admin_api/services/preparacionAsistenteService');
        const [rest] = await sequelize.query(
            `SELECT n.id_negocio FROM general.gener_negocio n
               JOIN general.gener_tipo_negocio t ON t.id_tipo_negocio = n.id_tipo_negocio
              WHERE n.estado = 'A' AND UPPER(t.nombre) = 'RESTAURANTE' ORDER BY n.id_negocio LIMIT 1;`,
            { type: sequelize.QueryTypes.SELECT, logging: false }
        );
        const r = await Preparacion.revisar(rest.id_negocio);
        const claves = r.puntos.map((p) => p.clave);
        for (const c of ['whatsapp_conectado', 'plan_con_asistente', 'horario', 'carta', 'tiempo_entrega', 'info_asistente']) {
            expect(claves).toContain(c);
        }
        const orden = { falta: 0, recomendado: 1, ok: 2 };
        const niveles = r.puntos.map((p) => orden[p.estado]);
        expect(niveles).toEqual([...niveles].sort((a, b) => a - b));
        expect(r.pendientes).toBe(r.puntos.filter((p) => p.estado !== 'ok').length);
        for (const p of r.puntos.filter((x) => x.estado !== 'ok')) {
            expect(p.por_que).toBeTruthy();
            expect(p.donde).toBeTruthy();
        }
    });

    test('un mensaje con horas de retraso se guarda pero no se contesta', async () => {
        const r = await llega(`577${CORRIDA}02`, '[sticker]', { antiguo: true });
        expect(r.sin_turno_motivo).toBe('antiguo');
        expect(await pendientes(r.id_conversacion)).toHaveLength(0);
    });
});
