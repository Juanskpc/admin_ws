/**
 * F2 — el envío: la plantilla, la compuerta y el ritmo.
 *
 * ## Qué se prueba aquí, y por qué cada caso cuesta caro si falla
 *
 * Esta fase es la primera que **manda mensajes de verdad a clientes de verdad** y la primera en la
 * que un error no se corrige: un mensaje enviado no se desenvía. Los fallos que esta suite
 * persigue son los que no dan excepción:
 *
 *   1. **Que el botón de la plantilla no case con las palabras de la baja.** El cliente pulsaría
 *      «No quiero promociones», llegaría como un texto normal, no casaría con nada y **no pasaría
 *      nada**. La salida que le prometimos no existiría, y lo siguiente que hace esa persona es
 *      bloquear el número. No hay error, no hay log: solo un cliente perdido.
 *   2. **Que una promoción salga como `UTILITY`.** Costaría 15 veces menos y es exactamente lo que
 *      hace que Meta rechace la plantilla o degrade la cuenta.
 *   3. **Que se mande fuera de la franja horaria.** Una promoción a las 11 de la noche es una
 *      denuncia, y el despachador es lo único que lo impide.
 *   4. **Que el tier de Meta se lea mal.** Con un tier mal interpretado se intenta mandar a 400
 *      cuando caben 250, Meta rechaza el resto y el dueño cree que salió.
 *   5. **Que la plantilla con imagen se mande sin imagen** (o se cree sin el ejemplo que Meta
 *      exige): los dos casos fallan en Meta, tarde y con un mensaje que no ayuda.
 *
 * Corre **sin Postgres y sin red**: lo que habla con Meta recibe un `fetch` de mentira. La base de
 * desarrollo es compartida y las suites que escriben van contra la local
 * (`docs/desarrollo-local.md`).
 *
 *   npx jest __tests__/promociones/envio.test.js
 */
'use strict';

const catalogo = require('../../intelligence/core/plantillas');
const bajaPromociones = require('../../intelligence/engine/bajaPromociones');
const plantillasMeta = require('../../app_core/promociones/plantillasMeta');
const elegibilidad = require('../../app_core/promociones/elegibilidad');
const despachador = require('../../app_core/promociones/despachador');
const campanas = require('../../app_core/promociones/campanas');
const adaptador = require('../../intelligence/channels/whatsapp/adaptador');

// ── El catálogo de marketing ────────────────────────────────────────────────────────────

describe('las plantillas de promoción', () => {
    const deMarketing = catalogo.deMarketing();

    test('hay al menos una sin imagen: un negocio sin foto tiene que poder enviar', () => {
        expect(deMarketing.some((p) => !p.encabezado)).toBe(true);
    });

    test('todas son MARKETING, no UTILITY', () => {
        // Colarlas como UTILITY costaría 15 veces menos y es como se pierde la cuenta.
        for (const p of deMarketing) expect(p.categoria).toBe('MARKETING');
    });

    test('⚠️ el botón de baja casa con las palabras que el motor entiende', () => {
        // El fallo silencioso que esto caza: el cliente pulsa el botón, llega como texto normal,
        // no casa con nada y la salida que le prometimos no existe.
        for (const p of deMarketing) {
            for (const boton of p.botones ?? []) {
                if (boton.tipo !== 'QUICK_REPLY') continue;
                expect(bajaPromociones.bajaPedida(boton.texto)).toBe(true);
            }
        }
    });

    test('todas llevan la salida escrita en el pie, y cabe en los 60 caracteres de Meta', () => {
        for (const p of deMarketing) {
            expect(p.pie).toBeTruthy();
            expect(p.pie.length).toBeLessThanOrEqual(60);
            expect(bajaPromociones.bajaPedida(p.pie.split(':').pop().trim())).toBe(true);
        }
    });

    test('el cuerpo dice de dónde salió el mensaje y no termina en variable', () => {
        for (const p of deMarketing) {
            // La política de Meta pide que quede claro quién escribe y por qué; y un cliente que
            // no reconoce al negocio reporta el número.
            expect(p.texto).toMatch(/porque has pedido/i);
            expect(p.texto.trim()).not.toMatch(/\}\}$/);
        }
    });
});

// ── Lo que se le manda a Meta para crear la plantilla ───────────────────────────────────

describe('el cuerpo que se somete a Meta', () => {
    const texto = catalogo.obtener('promocion_texto');
    const imagen = catalogo.obtener('promocion_imagen');

    test('lleva ejemplos de los huecos: sin ellos Meta la rechaza', () => {
        const cuerpo = plantillasMeta.cuerpoParaMeta(texto);
        const body = cuerpo.components.find((c) => c.type === 'BODY');

        expect(body.example.body_text[0]).toHaveLength(texto.parametros.length);
        // Plausibles, no «texto de prueba»: lo lee una persona que decide si la aprueba.
        expect(body.example.body_text[0].join(' ')).toMatch(/\$/);
    });

    test('el pie y los botones viajan como componentes propios', () => {
        const cuerpo = plantillasMeta.cuerpoParaMeta(texto);
        expect(cuerpo.components.find((c) => c.type === 'FOOTER').text).toBe(texto.pie);
        expect(cuerpo.components.find((c) => c.type === 'BUTTONS').buttons[0]).toEqual({
            type: 'QUICK_REPLY',
            text: 'No quiero promociones',
        });
    });

    test('la de imagen exige el handle del ejemplo, y lo dice con su código', () => {
        expect(() => plantillasMeta.cuerpoParaMeta(imagen)).toThrow(
            /exige una de ejemplo|imagen/i,
        );
        try {
            plantillasMeta.cuerpoParaMeta(imagen);
        } catch (e) {
            expect(e.code).toBe('PROMOS_PLANTILLA_SIN_EJEMPLO');
        }
    });

    test('con el handle, el encabezado va como IMAGE', () => {
        const cuerpo = plantillasMeta.cuerpoParaMeta(imagen, { ejemploHandle: 'h:abc' });
        const header = cuerpo.components.find((c) => c.type === 'HEADER');
        expect(header.format).toBe('IMAGE');
        expect(header.example.header_handle).toEqual(['h:abc']);
    });

    test('el nombre y el idioma salen del catálogo, no de quien llama', () => {
        // Es la lección del `#132001`: Meta busca por nombre MÁS idioma, exactos. Si esto se
        // pudiera pasar por parámetro, un día se crearía `es` y se enviaría `es_CO`.
        const cuerpo = plantillasMeta.cuerpoParaMeta(texto);
        expect(cuerpo.name).toBe('promocion_texto');
        expect(cuerpo.language).toBe('es_CO');
    });
});

// ── El envío: cómo se traduce al payload de la Cloud API ────────────────────────────────

describe('el mensaje que sale', () => {
    test('la plantilla con imagen manda un LINK, no el handle', () => {
        const payload = adaptador.renderizar({
            plantilla: {
                nombre: 'promocion_imagen',
                idioma: 'es_CO',
                parametros: { cliente: 'Ana', negocio: 'Zona Burger', oferta: '2x1 hoy' },
                encabezado_url: 'https://ejemplo.com/promo.jpg',
            },
            contenido: 'lo que sea',
        });

        const header = payload.template.components.find((c) => c.type === 'header');
        expect(header.parameters[0].image.link).toBe('https://ejemplo.com/promo.jpg');
        const body = payload.template.components.find((c) => c.type === 'body');
        expect(body.parameters.map((p) => p.text)).toEqual(['Ana', 'Zona Burger', '2x1 hoy']);
    });

    test('el pie y los botones NO se repiten en el envío', () => {
        // No tienen variables: viajan en la plantilla aprobada. Mandarlos otra vez es un 400.
        const payload = adaptador.renderizar({
            plantilla: {
                nombre: 'promocion_texto',
                idioma: 'es_CO',
                parametros: { cliente: 'Ana', negocio: 'Zona Burger', oferta: '2x1' },
            },
            contenido: 'x',
        });
        const tipos = payload.template.components.map((c) => c.type);
        expect(tipos).toEqual(['body']);
    });

    test('sin imagen, la plantilla de imagen se niega y NO es reintentable', () => {
        // Reintentarlo cinco veces es tirar cinco llamadas: la URL la puso (o no) quien armó la
        // campaña, y no va a aparecer por insistir.
        try {
            adaptador.renderizar({
                plantilla: { nombre: 'promocion_imagen', idioma: 'es_CO', parametros: {} },
                contenido: 'x',
            });
            throw new Error('tenía que haber fallado');
        } catch (e) {
            expect(e.code).toBe('WHATSAPP_PLANTILLA_SIN_IMAGEN');
            expect(e.reintentable).toBe(false);
        }
    });
});

// ── La oferta que escribe el dueño ──────────────────────────────────────────────────────

describe('el texto de la oferta', () => {
    test('se le quitan los saltos de línea: Meta rechaza una variable con ellos', () => {
        expect(campanas.limpiarParametro('2 hamburguesas\npor $20.000\t¡hoy!')).toBe(
            '2 hamburguesas por $20.000 ¡hoy!',
        );
    });

    test('no deja dobles espacios ni bordes sucios', () => {
        expect(campanas.limpiarParametro('  hola   mundo  ')).toBe('hola mundo');
    });
});

// ── El estado del número en Meta ────────────────────────────────────────────────────────

describe('la lectura del número en Meta', () => {
    const numeros = require('../../intelligence/channels/whatsapp/numeros');
    const original = { numeroDe: numeros.numeroDe, tokenDeNegocio: numeros.tokenDeNegocio };

    beforeEach(() => {
        numeros.numeroDe = () => '123456789';
        numeros.tokenDeNegocio = () => 'token-del-inquilino';
    });
    afterEach(() => {
        numeros.numeroDe = original.numeroDe;
        numeros.tokenDeNegocio = original.tokenDeNegocio;
    });

    const fetchQueDevuelve = (datos, ok = true) => async () => ({
        ok,
        status: ok ? 200 : 400,
        json: async () => datos,
    });

    test('traduce el tier de Meta a un número', async () => {
        const r = await elegibilidad.estadoDelNumero({
            idNegocio: 6,
            fetchImpl: fetchQueDevuelve({ quality_rating: 'GREEN', messaging_limit_tier: 'TIER_1K' }),
        });
        expect(r.leido).toBe(true);
        expect(r.tier).toBe(1000);
        expect(r.calidad).toBe('GREEN');
    });

    test('TIER_UNLIMITED no es cero: es sin límite', async () => {
        const r = await elegibilidad.estadoDelNumero({
            idNegocio: 6,
            fetchImpl: fetchQueDevuelve({ messaging_limit_tier: 'TIER_UNLIMITED' }),
        });
        expect(r.tier).toBe(Infinity);
    });

    test('si Meta no contesta, se dice que no se leyó — no se inventa un tier', async () => {
        const r = await elegibilidad.estadoDelNumero({
            idNegocio: 6,
            fetchImpl: fetchQueDevuelve({ error: { message: 'nope' } }, false),
        });
        expect(r.leido).toBe(false);
        expect(r.tier).toBeUndefined();
    });

    test('el rojo es lo único que bloquea; el amarillo avisa', () => {
        expect(elegibilidad.CALIDAD_QUE_BLOQUEA.has('RED')).toBe(true);
        expect(elegibilidad.CALIDAD_QUE_BLOQUEA.has('YELLOW')).toBe(false);
        expect(elegibilidad.CALIDAD_QUE_BLOQUEA.has('GREEN')).toBe(false);
    });
});

// ── El ritmo ────────────────────────────────────────────────────────────────────────────

describe('la franja horaria', () => {
    const aLas = (hora) => new Date(2026, 9, 12, hora, 0, 0);

    test.each([8, 12, 20])('a las %i sí se manda', (hora) => {
        expect(despachador.dentroDeHorario(aLas(hora))).toBe(true);
    });

    test.each([0, 6, 7, 21, 23])('a las %i NO se manda', (hora) => {
        expect(despachador.dentroDeHorario(aLas(hora))).toBe(false);
    });

    test('la franja es la misma que anuncia la compuerta', () => {
        // Dos franjas distintas —una que avisa y otra que manda— es un dueño que no entiende por
        // qué su promoción no salió.
        expect(despachador.dentroDeHorario(aLas(elegibilidad.HORA_MIN))).toBe(true);
        expect(despachador.dentroDeHorario(aLas(elegibilidad.HORA_MAX))).toBe(false);
    });
});

describe('el canal del inquilino', () => {
    const numeros = require('../../intelligence/channels/whatsapp/numeros');
    const original = {
        origenDeNegocio: numeros.origenDeNegocio,
        tokenDeNegocio: numeros.tokenDeNegocio,
        wabaDeNegocio: numeros.wabaDeNegocio,
    };
    // El entorno también se devuelve como estaba: estas pruebas tocan WHATSAPP_NEGOCIO_ID, y una
    // variable que se queda puesta convierte la suite en un orden de ejecución con suerte.
    const entorno = {
        WHATSAPP_NEGOCIO_ID: process.env.WHATSAPP_NEGOCIO_ID,
        WHATSAPP_TOKEN: process.env.WHATSAPP_TOKEN,
        WHATSAPP_WABA_ID: process.env.WHATSAPP_WABA_ID,
    };
    afterEach(() => {
        Object.assign(numeros, original);
        for (const [clave, valor] of Object.entries(entorno)) {
            if (valor === undefined) delete process.env[clave];
            else process.env[clave] = valor;
        }
    });

    test('⚠️ un número de alta manual NO puede crear plantillas de marketing', () => {
        // Sale por NUESTRA WABA: Meta nos facturaría a nosotros sus envíos y su mala calificación
        // sería la nuestra — y la nuestra la comparten todos los inquilinos.
        numeros.origenDeNegocio = () => 'manual';
        try {
            plantillasMeta.canalDe(6);
            throw new Error('tenía que haber fallado');
        } catch (e) {
            expect(e.code).toBe('PROMOS_CANAL_NO_PROPIO');
        }
    });

    test('sin canal, lo dice con su propio código', () => {
        numeros.origenDeNegocio = () => null;
        try {
            plantillasMeta.canalDe(6);
            throw new Error('tenía que haber fallado');
        } catch (e) {
            expect(e.code).toBe('PROMOS_SIN_CANAL');
        }
    });

    test('con token y WABA propios, pasa', () => {
        numeros.origenDeNegocio = () => 'embedded_signup';
        numeros.tokenDeNegocio = () => 'tok';
        numeros.wabaDeNegocio = () => '123';
        expect(plantillasMeta.canalDe(6)).toEqual({
            token: 'tok',
            wabaId: '123',
            deLaPlataforma: false,
        });
    });

    test('el negocio de EscalApp SÍ puede, por nuestra WABA y con nuestras credenciales', () => {
        // La excepción deliberada: el argumento para negar un canal manual es «la factura y la
        // calificación serían de EscalApp», y para el negocio con el que EscalApp se prueba a sí
        // misma eso es exactamente lo que se quiere. Sin esto el piloto no se puede mandar.
        numeros.origenDeNegocio = () => 'manual';
        numeros.tokenDeNegocio = () => null;
        numeros.wabaDeNegocio = () => null;
        process.env.WHATSAPP_NEGOCIO_ID = '12';
        process.env.WHATSAPP_TOKEN = 'token-global';
        process.env.WHATSAPP_WABA_ID = 'waba-escalapp';

        expect(plantillasMeta.canalDe(12)).toEqual({
            token: 'token-global',
            wabaId: 'waba-escalapp',
            deLaPlataforma: true,
        });

        // Y sigue negándoselo a cualquier OTRO negocio de alta manual, que es el punto.
        try {
            plantillasMeta.canalDe(13);
            throw new Error('tenía que haber fallado');
        } catch (e) {
            expect(e.code).toBe('PROMOS_CANAL_NO_PROPIO');
        }
    });

    test('el negocio de EscalApp sin las variables del servidor: se niega con su motivo', () => {
        numeros.origenDeNegocio = () => 'manual';
        process.env.WHATSAPP_NEGOCIO_ID = '12';
        delete process.env.WHATSAPP_WABA_ID;
        process.env.WHATSAPP_TOKEN = 'token-global';
        try {
            plantillasMeta.canalDe(12);
            throw new Error('tenía que haber fallado');
        } catch (e) {
            expect(e.code).toBe('PROMOS_CANAL_INCOMPLETO');
        }
    });

    test('conectado pero sin token guardado: se niega en vez de usar el global', () => {
        numeros.origenDeNegocio = () => 'embedded_signup';
        numeros.tokenDeNegocio = () => null;
        numeros.wabaDeNegocio = () => '123';
        try {
            plantillasMeta.canalDe(6);
            throw new Error('tenía que haber fallado');
        } catch (e) {
            expect(e.code).toBe('PROMOS_CANAL_INCOMPLETO');
        }
    });
});
