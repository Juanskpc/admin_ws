/**
 * F1 — el simulador y las tarifas: lo que una promoción va a costar antes de mandarla.
 *
 * ## Qué se prueba aquí, y por qué cada caso duele si falla
 *
 * Esta pantalla es la primera del producto en la que el dueño **decide gastar dinero**, y decide
 * sobre lo que diga esta cuenta. Los fallos no son excepciones, son cifras creíbles y equivocadas:
 *
 *   1. **Que el punto de equilibrio se calcule con la venta y no con el margen.** Es la trampa de
 *      todo el módulo: con venta sale «con un pedido ya ganaste», y es mentira. La primera campaña
 *      lo descubre y entonces el dueño no vuelve a creerle a ninguna cifra nuestra.
 *   2. **Que se cobre por un mensaje que Meta no entrega.** Las plantillas de marketing no llegan a
 *      números de EE. UU.: contarlos infla el costo y el crédito.
 *   3. **Que se invente la tarifa de un país que no tenemos.** Chile no está publicado y ahí ya hay
 *      un inquilino. Estimar «algo parecido» es prometerle un costo que la factura va a desmentir.
 *   4. **Que se olvide el costo que no se ve**: las respuestas que la promoción provoca gastan del
 *      techo del asistente, y si no alcanza el freno degrada justo cuando llegan los pedidos.
 *
 * Y una estructural: que `SEGMENTOS` y el `CASE` de SQL no se desincronicen. Añadir un segmento a
 * la lista y olvidarlo en el `CASE` no da ningún error — simplemente ese segmento sale siempre en
 * cero y nadie se entera.
 *
 * Corre **sin Postgres**, a propósito: la base de desarrollo es compartida y las suites que
 * escriben van contra la local (`docs/desarrollo-local.md`). Lo que necesita base —la consulta de
 * segmentación— se comprobó a mano contra los dos verticales el 2026-10-12 y queda sostenido por
 * esta suite solo en su parte estructural.
 *
 *   npx jest __tests__/promociones/simulador.test.js
 */
'use strict';

const tarifas = require('../../app_core/promociones/tarifas');
const simulador = require('../../app_core/promociones/simulador');
const segmentos = require('../../app_core/promociones/segmentos');

/** Un lote de destinatarios colombianos con el ticket real medido de Zona Burger. */
const colombianos = (n, valor = 27321) =>
    Array.from({ length: n }, (_, i) => ({
        id_persona_negocio: `p${i}`,
        telefono: `+5730011${String(i).padStart(5, '0')}`,
        valor_total: valor,
    }));

// ── Las tarifas ─────────────────────────────────────────────────────────────────────────

describe('la tarifa de Meta', () => {
    test('Colombia está confirmada: marketing a US$0,0125', () => {
        const t = tarifas.tarifaDe('+573001112233');
        expect(t.pais).toBe('Colombia');
        expect(t.marketing).toBe(0.0125);
        expect(t.confirmada).toBe(true);
    });

    test('el marketing cuesta ~15 veces el mensaje de servicio', () => {
        // La relación que justifica que exista un simulador: una promoción de 400 envíos cuesta
        // lo mismo que 6.250 mensajes del asistente.
        const marketing = tarifas.POR_PAIS[57].marketing;
        const servicio = tarifas.POR_PAIS[57].servicio;
        expect(Math.round(marketing / servicio)).toBe(16);
    });

    test('Chile NO tiene tarifa inventada: devuelve null y lo dice', () => {
        const t = tarifas.tarifaDe('+56912345678');
        expect(t.pais).toBe('Chile');
        expect(t.marketing).toBeNull();
        expect(t.confirmada).toBe(false);
    });

    test('a los números de EE. UU. Meta no entrega marketing', () => {
        const t = tarifas.tarifaDe('+14155550123');
        expect(t.sin_entrega).toBe(true);
        expect(t.marketing).toBeNull();
    });

    test('un indicativo desconocido no se confunde con uno conocido', () => {
        const t = tarifas.tarifaDe('+34600111222');
        expect(t.indicativo).toBe('34');
        expect(t.marketing).toBeNull();
        expect(t.confirmada).toBe(false);
    });

    test('la vigencia viaja con el precio: una tarifa sin fecha es una tarifa que miente', () => {
        expect(tarifas.VIGENCIA).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(tarifas.FX_REFERENCIA.fecha).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
});

// ── El costo ────────────────────────────────────────────────────────────────────────────

describe('el costo de una campaña', () => {
    test('400 colombianos: US$5 y el desglose dice quién lo cobra', () => {
        const r = simulador.calcular(colombianos(400));

        expect(r.enviables).toBe(400);
        expect(r.meta.costo_usd).toBeCloseTo(5, 2);
        expect(r.meta.lo_cobra).toMatch(/Meta/);
        expect(r.meta.vigencia_tarifa).toBe(tarifas.VIGENCIA);
        // 1 crédito = 1 mensaje entregable, a precio fijo. Todavía solo se muestra.
        expect(r.escalapp.creditos).toBe(400);
        expect(r.escalapp.precio_local).toBe(400 * simulador.PRECIO_ENVIO_COP);
        expect(r.escalapp.se_cobra).toBe(false);
    });

    test('fuera de Colombia no se inventa un precio de EscalApp', () => {
        const r = simulador.calcular(colombianos(10), { moneda: 'CLP' });
        expect(r.escalapp.precio_local).toBeNull();
        expect(r.retorno.base).toMatch(/solo el costo de Meta/);
    });

    test('un número de EE. UU. no se cuenta ni se cobra', () => {
        const r = simulador.calcular([...colombianos(10), { telefono: '+14155550123', valor_total: 0 }]);

        expect(r.destinatarios).toBe(11);
        expect(r.enviables).toBe(10);
        expect(r.sin_entrega).toBe(1);
        expect(r.meta.costo_usd).toBeCloseTo(0.125, 4);
    });

    test('un chileno se cuenta como enviable pero NO se le pone precio', () => {
        const r = simulador.calcular([...colombianos(10), { telefono: '+56912345678', valor_total: 0 }]);

        expect(r.enviables).toBe(11);
        expect(r.sin_tarifa_confirmada).toBe(1);
        // El costo sigue siendo solo el de los 10 colombianos: no se estima lo que no se sabe.
        expect(r.meta.costo_usd).toBeCloseTo(0.125, 4);
        const chile = r.meta.por_pais.find((p) => p.indicativo === '56');
        expect(chile.confirmada).toBe(false);
        expect(chile.precio_unitario_usd).toBeNull();
    });

    test('el desglose va por país, porque Meta cobra por el país del destinatario', () => {
        const r = simulador.calcular([
            ...colombianos(5),
            { telefono: '+56912345678', valor_total: 0 },
            { telefono: '+56987654321', valor_total: 0 },
        ]);

        const porPais = r.meta.por_pais;
        expect(porPais).toHaveLength(2);
        expect(porPais[0].destinatarios).toBe(5);
        expect(porPais[1].destinatarios).toBe(2);
    });
});

// ── El punto de equilibrio: la regresión que importa ────────────────────────────────────

describe('el punto de equilibrio', () => {
    test('se calcula con el MARGEN, no con la venta', () => {
        // 400 envíos a US$0,0125 = US$5 ≈ $19.500 COP con la tasa de referencia.
        // Con VENTA (ticket $27.321) saldría 1 pedido — la cifra inflada que esto evita.
        // Con MARGEN (30 % = $8.196) salen 3.
        const r = simulador.calcular(colombianos(400), { margen: 0.3 });

        expect(r.retorno.margen_por_pedido).toBe(Math.round(27321 * 0.3));
        expect(r.retorno.pedidos_para_empatar).toBeGreaterThan(1);
        // Cuenta lo que paga en total: lo de Meta y lo de EscalApp.
        expect(r.retorno.pedidos_para_empatar).toBe(
            Math.ceil(
                (r.meta.costo_estimado_local + r.escalapp.precio_local) / r.retorno.margen_por_pedido,
            ),
        );
    });

    test('un margen más flaco exige más pedidos', () => {
        const generoso = simulador.calcular(colombianos(400), { margen: 0.5 });
        const flaco = simulador.calcular(colombianos(400), { margen: 0.15 });

        expect(flaco.retorno.pedidos_para_empatar).toBeGreaterThan(
            generoso.retorno.pedidos_para_empatar,
        );
    });

    test('un margen absurdo cae al valor por defecto en vez de inventar', () => {
        const r = simulador.calcular(colombianos(10), { margen: 12 });
        expect(r.retorno.margen_usado).toBe(simulador.MARGEN_POR_DEFECTO);
    });

    test('el ticket medio es el de ESTOS destinatarios, no el del negocio', () => {
        // Si la campaña va a los dormidos, lo que importa es lo que gastaban ellos.
        const r = simulador.calcular([
            { telefono: '+573001112233', valor_total: 10000 },
            { telefono: '+573001112234', valor_total: 20000 },
            // Quien nunca gastó no arrastra la media hacia abajo: no hay dato, no cuenta.
            { telefono: '+573001112235', valor_total: 0 },
        ]);
        expect(r.retorno.ticket_medio).toBe(15000);
    });

    test('sin historial de gasto no se inventa un retorno', () => {
        const r = simulador.calcular(colombianos(50, 0));
        expect(r.retorno.ticket_medio).toBe(0);
        expect(r.retorno.pedidos_para_empatar).toBeNull();
    });
});

// ── El costo que no se ve ───────────────────────────────────────────────────────────────

describe('el consumo del asistente', () => {
    test('estima las respuestas y las dice como lo que son: no medidas', () => {
        const r = simulador.calcular(colombianos(400));

        expect(r.asistente.conversaciones_esperadas).toBe(40);
        expect(r.asistente.mensajes_estimados).toBe(Math.round(40 * simulador.MENSAJES_POR_CONVERSACION));
        // Que no esté medido tiene que viajar en la respuesta, no quedarse en un comentario.
        expect(r.asistente.medida).toBe(false);
    });

    test('con el cupo del negocio dice si alcanza', () => {
        const apretado = simulador.calcular(colombianos(400), {
            cupo: { servicio: 5900, asignacion: 6000, restantes: 100 },
        });
        expect(apretado.asistente.cupo.alcanza).toBe(false);

        const holgado = simulador.calcular(colombianos(400), {
            cupo: { servicio: 1000, asignacion: 6000, restantes: 5000 },
        });
        expect(holgado.asistente.cupo.alcanza).toBe(true);
    });

    test('sin cupo conocido no se adivina', () => {
        const r = simulador.calcular(colombianos(10));
        expect(r.asistente.cupo).toBeNull();
    });
});

// ── Los segmentos, en lo que se puede comprobar sin base ────────────────────────────────

describe('los segmentos', () => {
    test('cada segmento de la lista existe en el CASE de SQL, y al revés', () => {
        // El fallo que esto caza: añadir un segmento a `SEGMENTOS` y olvidarlo en el `CASE`. No da
        // ningún error — ese segmento sale siempre en cero y nadie se entera.
        const sql = require('fs')
            .readFileSync(require.resolve('../../app_core/promociones/segmentos.js'), 'utf8')
            .split('const CASE_SEGMENTO')[1]
            .split('`;')[0];

        for (const s of segmentos.SEGMENTOS) {
            expect(sql).toContain(`'${s.codigo}'`);
        }
        const enElCase = [...sql.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
        for (const codigo of enElCase) {
            expect(segmentos.CODIGOS.has(codigo)).toBe(true);
        }
    });

    test('los umbrales NO están escritos a mano dentro del SQL', () => {
        // Lo que se comprueba es que el `CASE` interpole `UMBRALES` en vez de llevar el número
        // pegado: con un 120 literal, mover el corte desde `UMBRALES` no cambiaría nada y la
        // pantalla diría un umbral distinto del que de verdad se aplica.
        const sql = require('fs')
            .readFileSync(require.resolve('../../app_core/promociones/segmentos.js'), 'utf8')
            .split('const CASE_SEGMENTO')[1]
            .split('`;')[0];

        expect(sql).toContain('${UMBRALES.DIAS_DORMIDO}');
        expect(sql).toContain('${UMBRALES.DIAS_ACTIVO}');
        expect(sql).toContain('${UMBRALES.VISITAS_FRECUENTE}');
        // Y que los valores sigan siendo coherentes entre sí: dormido va DESPUÉS de activo.
        expect(segmentos.UMBRALES.DIAS_DORMIDO).toBeGreaterThan(segmentos.UMBRALES.DIAS_ACTIVO);
    });

    test('«frecuentes» se presenta como lo que NO hay que mandar', () => {
        // Es el caso de uso que pidió el dueño: lo valioso es poder no escribirle al que ya viene.
        const frecuente = segmentos.SEGMENTOS.find((s) => s.codigo === 'frecuente');
        expect(frecuente.recomendado).toBe(false);
        expect(frecuente.recomendado_para).toMatch(/NO hace falta/i);

        const enRiesgo = segmentos.SEGMENTOS.find((s) => s.codigo === 'en_riesgo');
        expect(enRiesgo.recomendado).toBe(true);
    });

    test('sin segmentos ni personas NO se asume «todos»', () => {
        // Una campaña a toda la base por omisión es el error más caro que puede cometer esta
        // pantalla. Se para antes de tocar la base.
        const hechos = require('../../app_core/promociones/hechos');
        const original = hechos.paraNegocio;
        hechos.paraNegocio = async () => ({
            vertical: 'restaurante',
            adaptador: require('../../app_core/promociones/hechos/restaurante'),
        });

        return segmentos
            .destinatariosParaEnvio({ idNegocio: 6 })
            .then(
                () => {
                    throw new Error('tenía que haber fallado');
                },
                (error) => {
                    expect(error.code).toBe('PROMOS_SIN_DESTINATARIOS');
                    expect(error.statusCode).toBe(422);
                },
            )
            .finally(() => {
                hechos.paraNegocio = original;
            });
    });
});
