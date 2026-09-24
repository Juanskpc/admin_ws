/**
 * Lo que el cliente ya eligió en la carta virtual (2026-09-24): cómo lo recibe, el barrio y la mesa.
 *
 * Contrato: `carrito.service.ts` (restaurante_app) escribe `#P12-4x2,9x1~m=D~z=7~t=3` y
 * `codigoPedido.js` lo lee. Aquí se prueban las dos mitades del lado del bot:
 *   1. el LECTOR: los códigos viejos siguen leyéndose EXACTAMENTE igual, y lo desconocido o
 *      basura se ignora sin rechazar el pedido;
 *   2. el FLUJO: con lo elegido sembrado no vuelve a preguntar domicilio/recoger; con barrio o
 *      mesa inválidos vuelve a preguntar sin perder el carrito.
 *
 * El catálogo (barrios y mesas) se inyecta: nada de esto necesita Postgres.
 *
 * Correr con:  npx jest __tests__/intelligence/pedido_del_menu_modalidad.test.js
 */
'use strict';

const codigoPedido = require('../../intelligence/adapters/restaurante/codigoPedido');
const flujo = require('../../intelligence/adapters/restaurante/flujo');

const { crearFlujoRestaurante, TAREA_PEDIDO, PASO_PEDIDO, ENTREGA, elegirBarrio, elegirMesa, OTRO_BARRIO } = flujo;

// ── 1. El lector ────────────────────────────────────────────────────────────────────────────

describe('codigoPedido.leer con modificadores', () => {
    it('un código SIN modificadores devuelve exactamente lo de siempre (sin claves nuevas)', () => {
        expect(codigoPedido.leer('#P12-4x2,9x1')).toEqual({
            idNegocio: 12,
            items: [
                { id_producto: 4, cantidad: 2 },
                { id_producto: 9, cantidad: 1 },
            ],
        });
        expect(Object.keys(codigoPedido.leer('#P12-4x2'))).toEqual(['idNegocio', 'items']);
    });

    it('lee la modalidad, el barrio y la mesa', () => {
        expect(codigoPedido.leer('#P12-4x2~m=D~z=7')).toMatchObject({
            modalidad: 'DOMICILIO',
            idBarrio: 7,
        });
        expect(codigoPedido.leer('#P12-4x2~m=R').modalidad).toBe('LLEVAR');
        expect(codigoPedido.leer('#P12-4x2~m=L~t=3')).toMatchObject({ modalidad: 'MESA', idMesa: 3 });
    });

    it('`z=0` es «otro barrio»', () => {
        expect(codigoPedido.leer('#P12-4x2~m=D~z=0').idBarrio).toBe(0);
    });

    it('un modificador desconocido o con valor basura se ignora: el pedido NO se rechaza', () => {
        const r = codigoPedido.leer('#P12-4x2~m=X~q=9~z=abc~t=0');
        expect(r).toEqual({ idNegocio: 12, items: [{ id_producto: 4, cantidad: 2 }] });
    });

    it('sigue encontrando el código en la última línea aunque haya texto antes', () => {
        const msg = 'Hola, quiero pedir:\n\n• 2 × Bandeja\n\nTotal aproximado: $78.000\n\n#P12-4x2~m=D~z=7';
        expect(codigoPedido.leer(msg)).toMatchObject({ idNegocio: 12, modalidad: 'DOMICILIO', idBarrio: 7 });
        expect(codigoPedido.loTrae(msg)).toBe(true);
    });
});

// ── 2. Leer lo que dice el cliente ─────────────────────────────────────────────────────────

describe('elegirBarrio y elegirMesa', () => {
    const barrios = [
        { id_barrio: 1, nombre: 'El Poblado', valor: 6000 },
        { id_barrio: 2, nombre: 'Laureles', valor: 4000 },
        { id_barrio: 3, nombre: 'Laureles Norte', valor: 5000 },
    ];

    it('nombre exacto, sin tildes ni mayúsculas', () => {
        expect(elegirBarrio('EL POBLADO', barrios).id_barrio).toBe(1);
        expect(elegirBarrio('laureles', barrios).id_barrio).toBe(2); // exacto gana a parcial
    });

    it('una parte del nombre vale solo si es UNA coincidencia', () => {
        expect(elegirBarrio('poblado', barrios).id_barrio).toBe(1);
        expect(elegirBarrio('norte', barrios).id_barrio).toBe(3);
        // «Laur» coincide con dos: no se elige por el cliente.
        expect(elegirBarrio('laur', barrios)).toBeNull();
    });

    it('«otro» y sus variantes', () => {
        expect(elegirBarrio('otro', barrios)).toBe(OTRO_BARRIO);
        expect(elegirBarrio('no aparece', barrios)).toBe(OTRO_BARRIO);
    });

    it('lo que no se entiende es null', () => {
        expect(elegirBarrio('en mi casa', barrios)).toBeNull();
        expect(elegirBarrio('', barrios)).toBeNull();
    });

    it('la mesa, por número o por nombre', () => {
        const mesas = [
            { id_mesa: 10, nombre: 'Mesa 5', numero: 5 },
            { id_mesa: 11, nombre: 'Terraza', numero: 6 },
        ];
        expect(elegirMesa('5', mesas).id_mesa).toBe(10);
        expect(elegirMesa('estoy en la mesa 6', mesas).id_mesa).toBe(11);
        expect(elegirMesa('terraza', mesas).id_mesa).toBe(11);
        expect(elegirMesa('la 99', mesas)).toBeNull();
    });
});

// ── 3. El flujo ────────────────────────────────────────────────────────────────────────────

const BARRIOS = {
    habilitado: true,
    barrios: [
        { id_barrio: 7, nombre: 'Centro', valor: 4500 },
        { id_barrio: 8, nombre: 'Norte', valor: 6000 },
    ],
};
const MESAS = [
    { id_mesa: 3, nombre: 'Mesa 3', numero: 3 },
    { id_mesa: 4, nombre: 'Mesa 4', numero: 4 },
];

function crear({ barrios = BARRIOS, mesas = MESAS, telefonoProbado = '573000000000' } = {}) {
    const catalogo = {
        barrios: async () => barrios,
        mesas: async () => mesas,
        resolverBarrio: async ({ idBarrio }) => {
            const b = barrios.barrios.find((x) => x.id_barrio === idBarrio);
            if (!b) throw Object.assign(new Error('barrio'), { code: 'ZONA_INVALIDA', statusCode: 400 });
            return b;
        },
        resolverMesa: async ({ idMesa }) => {
            const m = mesas.find((x) => x.id_mesa === idMesa);
            if (!m) throw Object.assign(new Error('mesa'), { code: 'MESA_INVALIDA', statusCode: 400 });
            return m;
        },
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
        ahora: () => new Date('2026-09-24T18:00:00-05:00'),
    });
}

const conversacion = (extra = {}) => ({
    id_conversacion: 'conv-1',
    id_negocio: 12,
    canal: 'whatsapp',
    id_externo: '573000000000',
    variables: { turnos: 1, nombre: 'Nicolás' },
    tarea_actual: null,
    tarea_datos: null,
    ...extra,
});

const decir = (manejar, conv, texto) =>
    manejar({ conversacion: conv, mensajes: [{ contenido: texto }], texto, turno: { id_turno: 't1' } });

const codigo = (sufijo = '') => `Hola, quiero pedir:\n\n• 1 × Bandeja\n\n#P12-4x1${sufijo}`;
const textos = (d) => (d.respuestas || []).map((r) => (typeof r === 'string' ? r : r.texto));
const args = (d) => d.tarea?.datos?.args;

describe('pedido del menú con la modalidad ya elegida', () => {
    it('SIN modalidad (código viejo) pregunta domicilio o recoger, como siempre', async () => {
        const d = await decir(crear(), conversacion(), codigo());
        expect(d.tarea.datos.paso).toBe(PASO_PEDIDO.ENTREGA);
    });

    it('recoger (m=R) NO pregunta la entrega y no pide dirección', async () => {
        const d = await decir(crear(), conversacion(), codigo('~m=R'));
        // Ya sabe todo: nombre (memoria) + entrega + teléfono probado → pide confirmar.
        expect(d.tarea.nombre).toBe('confirmar_mutacion');
        expect(args(d).tipo_entrega).toBe(ENTREGA.RECOGER);
        expect(args(d).direccion).toBeUndefined();
    });

    it('domicilio con barrio (m=D z=7) NO pregunta entrega ni barrio: pide la dirección', async () => {
        const d = await decir(crear(), conversacion(), codigo('~m=D~z=7'));
        expect(d.tarea.datos.paso).toBe(PASO_PEDIDO.DIRECCION);
        expect(d.tarea.datos.entrega).toBe(ENTREGA.DOMICILIO);
        expect(d.tarea.datos.id_barrio).toBe(7);
    });

    it('con el barrio elegido y la dirección dada, confirma con id_barrio en los argumentos', async () => {
        const conv = conversacion();
        const d1 = await decir(crear(), conv, codigo('~m=D~z=7'));
        const d2 = await decir(
            crear(),
            conversacion({ tarea_actual: d1.tarea.nombre, tarea_datos: d1.tarea.datos }),
            'Calle 10 # 5-30'
        );
        expect(d2.tarea.nombre).toBe('confirmar_mutacion');
        expect(args(d2)).toMatchObject({ tipo_entrega: 'DOMICILIO', id_barrio: 7, direccion: 'Calle 10 # 5-30' });
    });

    it('«Otro barrio» (m=D z=0): no hay valor, pide la dirección y avisa que el restaurante lo confirma', async () => {
        const d = await decir(crear(), conversacion(), codigo('~m=D~z=0'));
        expect(d.tarea.datos.paso).toBe(PASO_PEDIDO.DIRECCION);
        expect(d.tarea.datos.id_barrio).toBeUndefined();
        expect(d.tarea.datos.barrio_otro).toBe(true);
        expect(textos(d)[0]).toMatch(/valor del domicilio te lo confirma el restaurante/i);
    });

    it('domicilio sin z: se trata como «otro barrio» y NO se pregunta el barrio', async () => {
        const d = await decir(crear(), conversacion(), codigo('~m=D'));
        expect(d.tarea.datos.paso).toBe(PASO_PEDIDO.DIRECCION);
        expect(d.tarea.datos.barrio_otro).toBe(true);
    });

    it('barrio INVÁLIDO (z de otro negocio o borrado): vuelve a preguntar el barrio SIN perder el carrito', async () => {
        const d = await decir(crear(), conversacion(), codigo('~m=D~z=999'));
        expect(d.tarea.nombre).toBe(TAREA_PEDIDO);
        expect(d.tarea.datos.items).toEqual([{ id_producto: 4, cantidad: 1 }]);
        expect(d.tarea.datos.paso).toBe(PASO_PEDIDO.BARRIO);
        expect(textos(d)[0]).toMatch(/no aparece en mi lista/i);
        expect(textos(d)[0]).toContain('Centro');
    });

    it('el cliente contesta el barrio y sigue a la dirección', async () => {
        const d1 = await decir(crear(), conversacion(), codigo('~m=D~z=999'));
        const d2 = await decir(
            crear(),
            conversacion({ tarea_actual: d1.tarea.nombre, tarea_datos: d1.tarea.datos }),
            'Norte'
        );
        expect(d2.tarea.datos.id_barrio).toBe(8);
        expect(d2.tarea.datos.paso).toBe(PASO_PEDIDO.DIRECCION);
    });

    it('con el barrio deshabilitado en el negocio, domicilio no pregunta barrio', async () => {
        const d = await decir(crear({ barrios: { habilitado: false, barrios: [] } }), conversacion(), codigo('~m=D~z=7'));
        expect(d.tarea.datos.paso).toBe(PASO_PEDIDO.DIRECCION);
        expect(d.tarea.datos.id_barrio).toBeUndefined();
    });

    it('en el local con mesa (m=L t=3): confirma directo, sin dirección ni teléfono, con id_mesa', async () => {
        const d = await decir(crear({ telefonoProbado: null }), conversacion(), codigo('~m=L~t=3'));
        expect(d.tarea.nombre).toBe('confirmar_mutacion');
        expect(args(d)).toMatchObject({ tipo_entrega: 'MESA', id_mesa: 3 });
        expect(args(d).direccion).toBeUndefined();
        expect(args(d).cliente_telefono).toBeUndefined();
    });

    it('mesa INVÁLIDA: vuelve a preguntar la mesa sin perder el carrito', async () => {
        const d = await decir(crear(), conversacion(), codigo('~m=L~t=999'));
        expect(d.tarea.datos.paso).toBe(PASO_PEDIDO.MESA);
        expect(d.tarea.datos.items).toHaveLength(1);
        expect(textos(d)[0]).toMatch(/no encontré esa mesa/i);
    });

    it('«en el local» sin mesas activas en el negocio se ignora y se pregunta como siempre', async () => {
        const d = await decir(crear({ mesas: [] }), conversacion(), codigo('~m=L~t=3'));
        expect(d.tarea.datos.paso).toBe(PASO_PEDIDO.ENTREGA);
    });

    it('si falla leer el catálogo, el pedido sigue: se pregunta como siempre', async () => {
        const roto = crearFlujoRestaurante({
            contextoNegocio: {
                obtener: async () => ({ id: 12, nombre: 'P', tratamiento: 'P', atencion: null, tipoNegocio: 'RESTAURANTE' }),
            },
            identidad: { resolver: async () => ({ principal: { telefono_verificado: '573000000000' } }) },
            gate: {},
            catalogo: {
                barrios: async () => { throw new Error('caído'); },
                mesas: async () => { throw new Error('caído'); },
                resolverBarrio: async () => { throw new Error('caído'); },
                resolverMesa: async () => { throw new Error('caído'); },
            },
        });
        const d = await decir(roto, conversacion(), codigo('~m=D~z=7'));
        expect(d.tarea.datos.entrega).toBe(ENTREGA.DOMICILIO);
        expect(d.tarea.datos.paso).toBe(PASO_PEDIDO.DIRECCION);
    });
});

describe('domicilio elegido por chat, con barrios cargados', () => {
    it('pregunta el barrio DESPUÉS de saber que es domicilio y ANTES de la dirección', async () => {
        const d1 = await decir(crear(), conversacion(), codigo());
        expect(d1.tarea.datos.paso).toBe(PASO_PEDIDO.ENTREGA);

        const d2 = await decir(
            crear(),
            conversacion({ tarea_actual: d1.tarea.nombre, tarea_datos: d1.tarea.datos }),
            'domicilio'
        );
        expect(d2.tarea.datos.paso).toBe(PASO_PEDIDO.BARRIO);
        expect(textos(d2)[0]).toContain('Centro');
        expect(textos(d2)[0]).toMatch(/\$\s?4\.500/);
    });

    it('un barrio que no entiende lo vuelve a preguntar', async () => {
        const d = await decir(
            crear(),
            conversacion({
                tarea_actual: TAREA_PEDIDO,
                tarea_datos: {
                    items: [{ id_producto: 4, cantidad: 1 }], nombre: 'N', entrega: 'DOMICILIO', paso: PASO_PEDIDO.BARRIO,
                },
            }),
            'en mi casa'
        );
        expect(d.tarea.datos.paso).toBe(PASO_PEDIDO.BARRIO);
        expect(textos(d)[0]).toMatch(/no encontré ese barrio/i);
    });
});
