const {
    normalizarE164,
    normalizarE164Colombia,
    paisesSoportados,
} = require('../../app_core/helpers/telefono');

describe('normalizarE164Colombia', () => {
    describe('formatos que aparecen en producción', () => {
        // Los cinco resuelven al mismo humano. Es lo que hace posible la Ficha 360:
        // sin esta convergencia, un mismo cliente sería cinco personas distintas.
        it.each([
            ['3001112233', 'crudo'],
            ['300 111 2233', 'con espacios'],
            ['300-111-2233', 'con guiones'],
            ['+57 300 111 2233', 'con prefijo país'],
            ['573001112233', 'con 57 pegado'],
            ['03001112233', 'con troncal 0'],
            ['(300) 111 2233', 'con paréntesis'],
        ])('normaliza %s (%s) a +573001112233', (entrada) => {
            expect(normalizarE164Colombia(entrada)).toBe('+573001112233');
        });
    });

    describe('rechaza lo que no es un móvil utilizable', () => {
        it.each([
            [null, 'null'],
            [undefined, 'undefined'],
            ['', 'cadena vacía'],
            ['   ', 'solo espacios'],
            ['abc', 'sin dígitos'],
            ['12345', 'demasiado corto'],
            ['6012345678', 'fijo (empieza en 6)'],
            ['1234567', 'fijo legacy de 7 dígitos'],
            ['0000000000', 'dígito repetido'],
            ['3333333333', 'dígito repetido que parece móvil'],
            ['30011122334455', 'demasiado largo'],
            ['2001112233', 'diez dígitos pero no empieza en 3'],
        ])('rechaza %s (%s)', (entrada) => {
            expect(normalizarE164Colombia(entrada)).toBeNull();
        });
    });

    it('es idempotente sobre un valor ya normalizado', () => {
        const unaVez = normalizarE164Colombia('3001112233');
        expect(normalizarE164Colombia(unaVez)).toBe(unaVez);
    });

    it('acepta valores numéricos, no solo cadenas', () => {
        expect(normalizarE164Colombia(3001112233)).toBe('+573001112233');
    });
});

describe('normalizarE164 con país', () => {
    // Chile llegó con el primer cliente de reserva (2026-09-09). El móvil chileno es 9 + 8
    // dígitos, y hasta entonces la plataforma lo tiraba a la basura sin decir nada: `null`
    // significa «este teléfono no sirve», así que no había error que ver — solo citas sin
    // ficha de cliente y recordatorios que no salían.
    describe('Chile', () => {
        it.each([
            ['912345678', 'crudo'],
            ['9 1234 5678', 'con espacios'],
            ['+56 9 1234 5678', 'con prefijo país'],
            ['56912345678', 'con 56 pegado'],
            ['+56912345678', 'ya en E.164'],
        ])('normaliza %s (%s) a +56912345678', (entrada) => {
            expect(normalizarE164(entrada, 'CL')).toBe('+56912345678');
        });

        it.each([
            ['221234567', 'fijo de Santiago (empieza en 2)'],
            ['999999999', 'dígito repetido'],
            ['91234567', 'un dígito corto'],
            ['9123456789', 'un dígito largo'],
            ['+541139458615', 'móvil argentino'],
        ])('rechaza %s (%s)', (entrada) => {
            expect(normalizarE164(entrada, 'CL')).toBeNull();
        });
    });

    // Que los dos países no se contaminen es el punto: el mismo texto tiene que dar resultados
    // distintos según de quién sea el cliente, y nunca colarse de un país al otro.
    it('el mismo número da resultados distintos según el país', () => {
        expect(normalizarE164('3001112233', 'CO')).toBe('+573001112233');
        expect(normalizarE164('3001112233', 'CL')).toBeNull();
        expect(normalizarE164('912345678', 'CL')).toBe('+56912345678');
        expect(normalizarE164('912345678', 'CO')).toBeNull();
    });

    it('sin país indicado se comporta como Colombia, que es lo que había', () => {
        expect(normalizarE164('3001112233')).toBe(normalizarE164Colombia('3001112233'));
        expect(normalizarE164('3001112233', null)).toBe('+573001112233');
    });

    it('un país que no sabemos normalizar devuelve null, no un número inventado', () => {
        expect(normalizarE164('912345678', 'AR')).toBeNull();
        expect(normalizarE164('3001112233', 'XX')).toBeNull();
    });

    it('paisesSoportados enumera exactamente lo que el normalizador acepta', () => {
        const paises = paisesSoportados();
        expect(paises).toEqual(expect.arrayContaining(['CO', 'CL']));
        // Es la lista que valida el endpoint de negocios: si divergen, el formulario ofrecería
        // un país que el normalizador no sabe tratar.
        paises.forEach((p) => expect(normalizarE164('0', p)).toBeNull());
    });
});

/**
 * Los países que se añadieron con la moneda (2026-09-10).
 *
 * Se prueban aquí y no solo en el catálogo porque el fallo que importa es silencioso: un móvil
 * válido que devuelve `null` no da error, simplemente deja al cliente sin ficha y sin
 * recordatorio. Ofrecer un país en el selector de moneda sin que el normalizador lo entienda
 * sería repetir exactamente lo que costó el primer cliente chileno.
 */
describe('países añadidos con el catálogo de monedas', () => {
    it('Perú: móviles de 9 dígitos que empiezan por 9', () => {
        ['987654321', '+51 987 654 321', '51987654321'].forEach((entrada) => {
            expect(normalizarE164(entrada, 'PE')).toBe('+51987654321');
        });
        expect(normalizarE164('12345678', 'PE')).toBeNull();   // fijo de Lima
    });

    it('Ecuador: el 0 nacional se quita y el prefijo son tres dígitos', () => {
        ['987654321', '0987654321', '+593 98 765 4321', '593987654321'].forEach((entrada) => {
            expect(normalizarE164(entrada, 'EC')).toBe('+593987654321');
        });
        expect(normalizarE164('22345678', 'EC')).toBeNull();
    });

    it('México: acepta el 1 que arrastra WhatsApp, pero guarda sin él', () => {
        ['5512345678', '+52 55 1234 5678', '525512345678', '5215512345678'].forEach((entrada) => {
            expect(normalizarE164(entrada, 'MX')).toBe('+525512345678');
        });
        // Sin distinción de móvil, lo único que descalifica es el largo o la basura.
        expect(normalizarE164('12345', 'MX')).toBeNull();
        expect(normalizarE164('5555555555', 'MX')).toBeNull();
    });

    it('el mismo número cambia de país según quién lo captura', () => {
        // Chile y Perú comparten forma —9 dígitos empezando por 9— y no hay forma de
        // distinguirlos mirando el número. Los distingue el negocio que lo apunta, que es
        // justo para lo que existe `gener_negocio.pais`.
        expect(normalizarE164('987654321', 'CL')).toBe('+56987654321');
        expect(normalizarE164('987654321', 'PE')).toBe('+51987654321');
        expect(normalizarE164('5512345678', 'CO')).toBeNull();
        expect(normalizarE164('3001112233', 'PE')).toBeNull();
    });
});
