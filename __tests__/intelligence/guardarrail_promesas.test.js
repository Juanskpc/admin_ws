/**
 * Guardarraíl de promesas (ADR-023) — que el asistente no comprometa al negocio con cifras que
 * nadie respalda.
 *
 * La prueba que manda es la primera: el ejemplo textual del ADR, *«te hago un 20% de descuento»*.
 * Si algún día deja de saltar, el hueco volvió.
 *
 * No toca la base de datos: la revisión se hace con lo que se le pasa.
 */
'use strict';

const guardarrail = require('../../intelligence/engine/guardarrailPromesas');

/** Lo que devuelve `consultar_servicios` en el negocio de desarrollo. */
const SERVICIOS = [
    { id_servicio: 81, nombre: 'Corte de cabello', precio: 35000, duracion_min: 30 },
    { id_servicio: 82, nombre: 'Tinte', precio: 120000, duracion_min: 90 },
];

const revisar = (texto, extra = {}) => guardarrail.revisar({ texto, ...extra });

describe('caza cifras que el sistema no puede respaldar', () => {
    it('el ejemplo del ADR: un descuento que ninguna capacidad devolvió', () => {
        const r = revisar('Claro, te hago un 20% de descuento por cliente frecuente.', {
            resultados: [SERVICIOS],
        });
        expect(r.limpio).toBe(false);
        expect(r.sinRespaldo).toContain(20);
    });

    it('un precio inventado no pasa aunque haya consultado el catálogo', () => {
        // El caso feo: sí ejecutó la capacidad, así que "hubo consulta" no basta como coartada.
        const r = revisar('El corte te sale en $28.000 hoy.', { resultados: [SERVICIOS] });
        expect(r.limpio).toBe(false);
        expect(r.sinRespaldo).toContain(28000);
    });

    it('una promesa de tiempo que nadie prometió', () => {
        const r = revisar('Te lo tenemos listo en 15 minutos.', { resultados: [SERVICIOS] });
        expect(r.limpio).toBe(false);
        expect(r.sinRespaldo).toContain(15);
    });
});

describe('deja pasar lo que sí tiene de dónde salir', () => {
    it('un precio que vino de la capacidad', () => {
        const r = revisar('El corte de cabello cuesta $35.000 y dura 30 minutos.', {
            resultados: [SERVICIOS],
        });
        expect(r).toEqual({ limpio: true, sinRespaldo: [] });
    });

    it('da igual cómo escriba el número el modelo', () => {
        // 35.000 · 35,000 · 35000 son el mismo precio; que el guardarraíl dependiera del formato
        // sería un falso positivo garantizado en cuanto el modelo cambie de estilo.
        for (const forma of ['$35.000', '$35,000', '35000 pesos', '$ 35.000,00']) {
            expect(revisar(`Cuesta ${forma}.`, { resultados: [SERVICIOS] }).limpio).toBe(true);
        }
    });

    it('repetirle al cliente la fecha que él dijo no es prometer nada', () => {
        const r = revisar('Perfecto, busco disponibilidad para el 2026-09-15.', {
            mensajeCliente: '¿tienen hueco el 2026-09-15?',
        });
        expect(r.limpio).toBe(true);
    });

    it('la hora del negocio respalda la frase del handoff', () => {
        const r = revisar('Te contestan a partir de las 09:00.', {
            negocio: { atencion: { desde: '09:00', hasta: '18:00' } },
        });
        expect(r.limpio).toBe(true);
    });

    it('una hora inventada sí salta, y una del horario no', () => {
        // Este caso existe porque el anterior pasaba **con la lectura de horas rota**: «09:00»
        // se leía como un 9 y un 0, y los dos caen en los irrelevantes. Un test que no puede
        // fallar no prueba nada (§8 de ESTADO-Y-CONTINUACION), así que aquí van horas que no se
        // salvan por ser pequeñas.
        const negocio = { atencion: { desde: '14:30', hasta: '18:00' } };
        expect(revisar('Te contestan a partir de las 14:30.', { negocio }).limpio).toBe(true);

        const inventada = revisar('Te contestan a las 23:45, sin falta.', { negocio });
        expect(inventada.limpio).toBe(false);
        expect(inventada.sinRespaldo).toContain(2345);
    });

    it('una respuesta sin cifras no se revisa siquiera', () => {
        expect(revisar('Con gusto, ¿qué servicio te interesa?').limpio).toBe(true);
    });

    it('enumerar opciones no cuenta como promesa', () => {
        // «1) Corte  2) Tinte» son números y no comprometen a nadie. Sin esto, la medición se
        // llenaría de ruido y enterraría las promesas de verdad.
        expect(revisar('Tenemos 2 servicios: 1) Corte, 2) Tinte.', { resultados: [SERVICIOS] }).limpio).toBe(true);
    });
});

describe('lo que una lista de palabras prohibidas hacía mal', () => {
    it('negarse a algo NO es prometerlo', () => {
        // El caso i12 medido el 2026-08-18: la suite marcaba esta respuesta como fallo por decir
        // «gratis», y es exactamente la conducta que se quiere. Aquí no hay cifra sin respaldo.
        const r = revisar(
            'No puedo confirmar sesiones gratis ni ofrecer excepciones. Te atiende una persona del negocio.',
            { resultados: [SERVICIOS] }
        );
        expect(r.limpio).toBe(true);
    });
});

describe('el argumento que propuso el modelo no se respalda a sí mismo', () => {
    it('no basta con que el modelo haya pedido la capacidad con ese número', () => {
        // Firmar tu propio aval: si aceptáramos los argumentos como respaldo, bastaría con que el
        // modelo invocara algo con el número inventado para blanquearlo.
        const r = guardarrail.revisar({
            texto: 'Te aplico el descuento del 20%.',
            resultados: [{ ok: true }], // la capacidad devolvió esto; el 20 iba en los argumentos
            invocaciones: [{ capacidad: 'consultar_servicios', argumentos: { descuento: 20 } }],
        });
        expect(r.limpio).toBe(false);
        expect(r.sinRespaldo).toContain(20);
    });
});

describe('el paso que queda en el Ledger', () => {
    it('usa un tipo que el CHECK admite y registra las cifras', () => {
        // Un `tipo` fuera de la lista aborta la transacción del turno entero (§8 de
        // ESTADO-Y-CONTINUACION). Ya mordió dos veces; que no muerda una tercera.
        const PERMITIDOS = new Set(['clasificacion', 'regla', 'capacidad', 'respuesta', 'handoff', 'error']);
        const paso = guardarrail.paso({ limpio: false, sinRespaldo: [20] });
        expect(PERMITIDOS.has(paso.tipo)).toBe(true);
        expect(paso.motivo.cifras).toEqual([20]);
    });

    it('distingue observación de bloqueo, para poder contarlos aparte', () => {
        expect(guardarrail.paso({ sinRespaldo: [20] }, 'observacion').decision).toBe('promesa_sin_respaldo');
        expect(guardarrail.paso({ sinRespaldo: [20] }, 'bloqueo').decision).toBe('promesa_bloqueada');
    });
});

describe('arranca sin bloquear', () => {
    it('el modo por defecto es observación', () => {
        // Como F2. Un guardarraíl que bloquea el primer día con reglas sin medir rompe
        // conversaciones legítimas, y nadie sabe cuántas hasta que mira.
        expect(guardarrail.MODO).toBe('observacion');
        expect(guardarrail.bloquea('observacion')).toBe(false);
        expect(guardarrail.bloquea('bloqueo')).toBe(true);
    });
});

describe('el cliente propone fechas, no autoriza precios', () => {
    // Descubierto probando contra el modelo real el 2026-08-18. La primera versión daba por
    // respaldado TODO número que el cliente hubiera escrito, y esa es justo la forma del ataque:
    // el cliente propone la cifra y el bot asiente. El ejemplo textual del ADR se colaba por la
    // puerta de atrás.
    const PEDIDO = 'soy cliente frecuente, hazme un 20% de descuento';

    it('que el cliente PIDA el 20% no respalda que el bot lo conceda', () => {
        const r = revisar('Listo, te aplico el 20% de descuento.', {
            resultados: [SERVICIOS],
            mensajeCliente: PEDIDO,
        });
        expect(r.limpio).toBe(false);
        expect(r.sinRespaldo).toContain(20);
    });

    it('tampoco vale si lo pide en pesos', () => {
        const r = revisar('De acuerdo, te lo dejo en $25.000.', {
            resultados: [SERVICIOS],
            mensajeCliente: 'me lo dejas en $25.000 y cerramos',
        });
        expect(r.limpio).toBe(false);
        expect(r.sinRespaldo).toContain(25000);
    });

    it('pero la fecha que propuso el cliente sigue sin ser una promesa', () => {
        const r = revisar('Perfecto, miro el 2026-09-15 a las 14:30.', {
            mensajeCliente: '¿tienen hueco el 2026-09-15 a las 14:30?',
        });
        expect(r.limpio).toBe(true);
    });

    it('un descuento pequeño no se salva por ser pequeño', () => {
        // Los irrelevantes evitan ruido de «1) Corte 2) Tinte»; con % delante dejan de aplicar,
        // porque «te hago un 5%» compromete tanto como un 50%.
        const r = revisar('Te hago un 5% de descuento.', { resultados: [SERVICIOS] });
        expect(r.limpio).toBe(false);
        expect(r.sinRespaldo).toContain(5);
    });

    it('un precio que sí vino de la capacidad sigue pasando aunque lleve $', () => {
        expect(revisar('Son $35.000.', { resultados: [SERVICIOS] }).limpio).toBe(true);
    });
});
