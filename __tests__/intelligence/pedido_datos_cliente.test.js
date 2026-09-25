/**
 * Datos del cliente que trae el paso «tus datos» de la carta virtual (2026-09-25): un bloque
 * legible con etiquetas fijas, ANTES de la línea `#P…`. Contrato con
 * `restaurante_app/.../menu-publico/datos-cliente.ts`.
 *
 * Se prueba:
 *   1. el LECTOR (`datosCliente.js`): bloque completo, parcial, con basura, y que una etiqueta no
 *      se puede inyectar desde dentro del valor de otra (la nota);
 *   2. el FLUJO: con el bloque completo el bot no pregunta nada y va directo a la confirmación
 *      («carrito → confirmación → sí»), sin pisar un teléfono que el canal ya probó.
 */
'use strict';

const datosCliente = require('../../intelligence/adapters/restaurante/datosCliente');
const flujo = require('../../intelligence/adapters/restaurante/flujo');

const { crearFlujoRestaurante, TAREA_PEDIDO, PASO_PEDIDO } = flujo;

describe('datosCliente.leerBloque', () => {
    const BLOQUE = [
        'Nombre: Ana Pérez',
        'Teléfono: 3001234567',
        'Dirección: Cra 3 #21-10, apto 201',
        'Nota: sin cebolla en todo',
    ].join('\n');

    it('bloque completo', () => {
        expect(datosCliente.leerBloque(BLOQUE)).toEqual({
            nombre: 'Ana Pérez',
            telefono: '3001234567',
            direccion: 'Cra 3 #21-10, apto 201',
            nota: 'sin cebolla en todo',
        });
    });

    it('bloque parcial: solo lo que viene', () => {
        expect(datosCliente.leerBloque('Nombre: Ana\nTeléfono: 3001234567')).toEqual({
            nombre: 'Ana',
            telefono: '3001234567',
        });
    });

    it('una etiqueta con valor vacío no se lee', () => {
        expect(datosCliente.leerBloque('Nombre: \nTeléfono: 3001234567')).toEqual({ telefono: '3001234567' });
    });

    it('basura alrededor (el mensaje entero, con el código al final) no rompe nada', () => {
        const mensaje = `Hola, quiero pedir:\n\n• 1 × Bandeja\n\n${BLOQUE}\n\n#P12-4x1~m=D~z=7`;
        expect(datosCliente.leerBloque(mensaje)).toEqual({
            nombre: 'Ana Pérez',
            telefono: '3001234567',
            direccion: 'Cra 3 #21-10, apto 201',
            nota: 'sin cebolla en todo',
        });
    });

    it('sin bloque, objeto vacío', () => {
        expect(datosCliente.leerBloque('hola, tienen hamburguesas?')).toEqual({});
        expect(datosCliente.leerBloque('')).toEqual({});
    });

    it('una etiqueta dentro del VALOR de otra (inyección desde la nota) no se lee como dato', () => {
        const conInyeccion = 'Nombre: Ana\nNota: hola Dirección: Calle falsa 123, Teléfono: 000';
        const leido = datosCliente.leerBloque(conInyeccion);
        expect(leido.nombre).toBe('Ana');
        expect(leido.nota).toBe('hola Dirección: Calle falsa 123, Teléfono: 000');
        expect(leido.direccion).toBeUndefined();
        expect(leido.telefono).toBeUndefined();
    });

    it('la PRIMERA aparición de una etiqueta manda; una repetida después se ignora', () => {
        expect(datosCliente.leerBloque('Nombre: Ana\nNombre: Otra')).toEqual({ nombre: 'Ana' });
    });

    it('se recorta al máximo declarado', () => {
        const largo = 'x'.repeat(500);
        expect(datosCliente.leerBloque(`Nota: ${largo}`).nota).toHaveLength(datosCliente.MAXIMOS.nota);
    });

    it('loTrae', () => {
        expect(datosCliente.loTrae('Nombre: Ana')).toBe(true);
        expect(datosCliente.loTrae('hola')).toBe(false);
    });
});

describe('el flujo siembra los datos de la carta y no vuelve a preguntar', () => {
    const catalogo = {
        barrios: async () => ({ habilitado: false, barrios: [] }),
        mesas: async () => [],
        resolverBarrio: async () => { throw new Error('no se usa'); },
        resolverMesa: async () => { throw new Error('no se usa'); },
        resolverExclusiones: async () => { throw new Error('no se usa'); },
        paisNegocio: async () => 'CO',
    };

    const crear = ({ telefonoProbado = null } = {}) =>
        crearFlujoRestaurante({
            contextoNegocio: {
                obtener: async () => ({ id: 12, nombre: 'P', tratamiento: 'P', atencion: null, tipoNegocio: 'RESTAURANTE' }),
            },
            identidad: { resolver: async () => ({ principal: { telefono_verificado: telefonoProbado } }) },
            gate: {},
            catalogo,
        });

    const conversacion = (extra = {}) => ({
        id_conversacion: 'c', id_negocio: 12, canal: 'whatsapp', id_externo: '573000000000',
        // Sin nombre en memoria: así el bloque de la carta es la ÚNICA fuente del nombre en estas
        // pruebas, y se ve claramente si el flujo lo sembró o no.
        variables: { turnos: 1 }, tarea_actual: null, tarea_datos: null, ...extra,
    });

    const decir = (manejar, conv, texto) =>
        manejar({ conversacion: conv, mensajes: [{ contenido: texto }], texto, turno: { id_turno: 't1' } });

    const mensaje = (bloque) =>
        [
            'Hola, quiero pedir:', '', '• 1 × Bandeja', '', 'Total aproximado: $20.000', '',
            ...bloque, '', '#P12-4x1~m=D',
        ].join('\n');

    it('CAMINO FELIZ: bloque completo → sin preguntas → directo a confirmar (1 mensaje del bot antes del sí)', async () => {
        const bloque = ['Nombre: Ana Pérez', 'Teléfono: 3001234567', 'Dirección: Cra 3 #21-10', 'Nota: sin cebolla'];
        const d = await decir(crear(), conversacion(), mensaje(bloque));

        expect(d.tarea.nombre).toBe('confirmar_mutacion');
        expect(d.tarea.datos.args).toMatchObject({
            cliente_nombre: 'Ana Pérez',
            direccion: 'Cra 3 #21-10',
            cliente_telefono: '+573001234567',
            nota: 'sin cebolla',
        });
        // Un solo turno del cliente (el del carrito) y un solo mensaje del bot antes del «sí».
        expect(d.respuestas).toHaveLength(1);
    });

    it('bloque parcial: solo pregunta lo que falta (nombre ya no se pregunta)', async () => {
        const d = await decir(crear(), conversacion(), mensaje(['Nombre: Ana Pérez']));
        expect(d.tarea.nombre).toBe(TAREA_PEDIDO);
        expect(d.tarea.datos.nombre).toBe('Ana Pérez');
        // Sin teléfono probado y sin dirección: los dos huecos que faltan se preguntan juntos.
        expect(d.tarea.datos.paso).toBe(PASO_PEDIDO.DATOS);
    });

    it('con el teléfono ya probado por el canal, bloque con solo nombre pasa directo a la dirección', async () => {
        const d = await decir(crear({ telefonoProbado: '+573009998877' }), conversacion(), mensaje(['Nombre: Ana Pérez']));
        expect(d.tarea.datos.paso).toBe(PASO_PEDIDO.DIRECCION);
    });

    it('sin bloque (código de siempre), el flujo pregunta como antes', async () => {
        const d = await decir(
            crear(),
            conversacion({ variables: { turnos: 1, nombre: 'Nicolás' } }), // el nombre YA se sabía por memoria
            'Hola, quiero pedir:\n\n#P12-4x1',
        );
        expect(d.tarea.datos.paso).toBe(PASO_PEDIDO.ENTREGA);
    });

    it('NO pisa un teléfono que el canal ya probó, aunque el bloque traiga otro', async () => {
        const d = await decir(
            crear({ telefonoProbado: '+573009998877' }),
            conversacion(),
            mensaje(['Nombre: Ana', 'Teléfono: 3001234567', 'Dirección: Cra 3 #21-10']),
        );
        expect(d.tarea.datos.args.cliente_telefono).toBeUndefined(); // manda el del canal, no se manda otro
    });

    it('un teléfono inválido en el bloque se ignora (sigue preguntando o usa el del canal)', async () => {
        const d = await decir(
            crear(),
            conversacion(),
            mensaje(['Nombre: Ana', 'Teléfono: no-es-un-numero', 'Dirección: Cra 3 #21-10']),
        );
        expect(d.tarea.datos.paso).toBe(PASO_PEDIDO.TELEFONO);
    });

    it('en el local (mesa) el bloque solo trae nombre, y no pide nada más', async () => {
        const catalogoMesa = {
            ...catalogo,
            mesas: async () => [{ id_mesa: 3, nombre: 'Mesa 3', numero: 3 }],
            resolverMesa: async ({ idMesa }) => ({ id_mesa: idMesa, nombre: 'Mesa 3', numero: 3 }),
        };
        const manejar = crearFlujoRestaurante({
            contextoNegocio: { obtener: async () => ({ id: 12, nombre: 'P', tratamiento: 'P', atencion: null, tipoNegocio: 'RESTAURANTE' }) },
            identidad: { resolver: async () => ({ principal: { telefono_verificado: null } }) },
            gate: {},
            catalogo: catalogoMesa,
        });
        const msg = ['Hola, quiero pedir:', '', 'Nombre: Ana', '', '#P12-4x1~m=L~t=3'].join('\n');
        const d = await decir(manejar, conversacion(), msg);

        expect(d.tarea.nombre).toBe('confirmar_mutacion');
        expect(d.tarea.datos.args).toMatchObject({ cliente_nombre: 'Ana', tipo_entrega: 'MESA', id_mesa: 3 });
        expect(d.tarea.datos.args.direccion).toBeUndefined();
    });

    it('una dirección con forma de código (#P12-9x9) no se confunde con el código real: se usa el de la última línea', async () => {
        const bloque = ['Nombre: Ana', 'Teléfono: 3001234567', 'Dirección: Calle 5 #P12-9x9'];
        const d = await decir(crear(), conversacion(), mensaje(bloque));

        expect(d.tarea.nombre).toBe('confirmar_mutacion');
        // El pedido es el del carrito real (producto 4), no el 9x9 que colaba la dirección.
        expect(d.tarea.datos.args.items).toEqual([{ id_producto: 4, cantidad: 1 }]);
        expect(d.tarea.datos.args.direccion).toBe('Calle 5 #P12-9x9');
    });

    it('el bloque SOLO se lee en el mismo mensaje que trae el código del carrito', async () => {
        // Mid-pedido: ya se sabe el nombre y el teléfono lo probó el canal; solo falta la dirección.
        const manejar = crear({ telefonoProbado: '+573000000000' });
        const conv = conversacion({
            tarea_actual: TAREA_PEDIDO,
            tarea_datos: {
                items: [{ id_producto: 4, cantidad: 1 }], nombre: 'Ana', entrega: 'DOMICILIO',
                paso: PASO_PEDIDO.DIRECCION,
            },
        });

        // Mensaje SIN código de carrito, aunque tenga forma de bloque: no dispara
        // `sembrarDatosCliente` (no hay `delMenu`, ni se llega a leerlo). `seguirPedido` lo trata
        // como texto libre de respuesta al paso actual —toma solo la ÚLTIMA línea, como siempre—.
        const d = await decir(manejar, conv, 'Nombre: Ana\nTeléfono: 3001234567\nDirección: Cra 3 #21-10');

        expect(d.tarea.nombre).toBe('confirmar_mutacion'); // ya tenía todo lo demás, pasa a confirmar
        expect(d.tarea.datos.args.direccion).toBe('Dirección: Cra 3 #21-10'); // literal, no interpretado
    });
});
