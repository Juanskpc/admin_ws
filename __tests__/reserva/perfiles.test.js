/**
 * Registro de perfiles de rubro (`app_reserva_api/perfiles/definiciones.js`).
 *
 * Lo primero que se prueba es la promesa que hace posible todo lo demás: **la barbería (perfil
 * BASE) queda exactamente como estaba** —mismos términos, mismas once vistas, ninguna función
 * encendida—. Después, que cada oficio arranca con lo suyo y que el dueño solo puede tocar lo
 * que su perfil ofrece.
 *
 * Puro: no usa base de datos.
 */
'use strict';

const Def = require('../../app_reserva_api/perfiles/definiciones');
const { CATALOGOS, catalogoDe, unidadesDe } = require('../../app_reserva_api/perfiles/catalogos');
const { RUBROS } = require('../../migrations/catalogo_rubros');

const VISTAS_DE_SIEMPRE = [
    '/agenda', '/caja', '/citas', '/clientes', '/configuracion', '/dashboard',
    '/horarios', '/informes', '/profesionales', '/servicios', '/usuarios',
];

describe('perfil BASE: la barbería no cambia', () => {
    const base = Def.perfilPorClave(null, 'BARBERIA');
    const descrito = Def.describirPerfil(base, {}, { nombre: 'BARBERIA', etiqueta: 'Barbería' });

    test('sin ninguna función encendida', () => {
        expect(descrito.funciones).toEqual([]);
        expect(descrito.modos).toEqual(['CITA']);
    });

    test('los términos de siempre', () => {
        expect(descrito.terminos).toEqual(Def.TERMINOS_BASE);
        expect(descrito.terminos.profesional).toBe('Profesional');
    });

    test('exactamente las once vistas que ya tenía', () => {
        expect(descrito.vistas).toEqual(VISTAS_DE_SIEMPRE);
    });

    test('filtrar sus permisos no quita nada de lo que ya veía', () => {
        const permisos = VISTAS_DE_SIEMPRE.map((url) => ({ url, puede_ver: true }));
        expect(Def.filtrarVistas(permisos, descrito)).toEqual(permisos);
    });

    test('sin valores de arranque: nace con los defaults de la tabla', () => {
        expect(base.config_inicial).toEqual({});
    });

    test('una clave de perfil desconocida o nula cae en BASE', () => {
        expect(Def.perfilPorClave('NO-EXISTE').clave).toBe('BASE');
        expect(Def.perfilPorClave(undefined).clave).toBe('BASE');
    });
});

describe('cada oficio arranca con lo suyo', () => {
    test('salón: tiempo de proceso y variantes; estilistas', () => {
        const p = Def.describirPerfil(Def.perfilPorClave('SALON'), {});
        expect(p.funciones).toEqual(['tiempo_proceso', 'variantes']);
        expect(p.terminos.profesional).toBe('Estilista');
        expect(p.vistas).toEqual(VISTAS_DE_SIEMPRE);
    });

    test('spa: cabinas y abono; ve Recursos', () => {
        const p = Def.describirPerfil(Def.perfilPorClave('SPA'), {});
        expect(p.funciones).toEqual(['deposito', 'recursos']);
        expect(p.vistas).toContain('/recursos');
        expect(p.terminos.servicios).toBe('Tratamientos');
    });

    test('tatuaje: a cotizar, abono, consentimiento, portafolio; sesiones', () => {
        const p = Def.describirPerfil(Def.perfilPorClave('TATUAJE'), {});
        expect(p.funciones).toEqual(expect.arrayContaining(['a_cotizar', 'deposito', 'consentimiento', 'portafolio']));
        expect(p.terminos.cita).toBe('Sesión');
    });

    test('mascotas: la mascota es fija y el oficio se agenda por citas, nunca por noches', () => {
        const mascotas = Def.describirPerfil(Def.perfilPorClave('MASCOTAS', 'PELUQUERIA CANINA'), {});
        expect(mascotas.funciones).toContain('mascotas');
        expect(mascotas.modos).toEqual(['CITA']);
        expect(mascotas.vistas).toContain('/mascotas');
        expect(mascotas.vistas).not.toContain('/ocupacion');

        // Ni siquiera pidiéndolas por configuración: las estancias no están entre sus funciones
        // disponibles, y `funcionesActivas` ignora las claves que el perfil no ofrece.
        const forzado = Def.describirPerfil(Def.perfilPorClave('MASCOTAS'), { estancias: true });
        expect(forzado.funciones).not.toContain('estancias');
        expect(forzado.modos).toEqual(['CITA']);
    });

    test('alojamiento: solo estancias, sin agenda ni profesionales', () => {
        const p = Def.describirPerfil(Def.perfilPorClave('ALOJAMIENTO'), {});
        expect(p.modos).toEqual(['ESTANCIA']);
        expect(p.vistas).toEqual(expect.arrayContaining(['/ocupacion', '/estancias', '/unidades', '/caja']));
        for (const v of ['/agenda', '/citas', '/servicios', '/profesionales', '/horarios']) {
            expect(p.vistas).not.toContain(v);
        }
        expect(p.terminos.cliente).toBe('Huésped');
    });

    test('el filtro quita las vistas que el perfil no usa y respeta las desconocidas', () => {
        const alojamiento = Def.describirPerfil(Def.perfilPorClave('ALOJAMIENTO'), {});
        const permisos = ['/agenda', '/ocupacion', '/caja', '/algo-nuevo'].map((url) => ({ url }));
        expect(Def.filtrarVistas(permisos, alojamiento).map((p) => p.url))
            .toEqual(['/ocupacion', '/caja', '/algo-nuevo']);
    });
});

describe('lo que el dueño puede tocar', () => {
    test('apagar una función de fábrica y encender una disponible', () => {
        const salon = Def.perfilPorClave('SALON');
        const eleccion = Def.normalizarEleccion(salon, { tiempo_proceso: false, deposito: true }, {});
        expect(Def.funcionesActivas(salon, eleccion)).toEqual(['deposito', 'variantes']);
    });

    test('una función de otro perfil se rechaza', () => {
        const base = Def.perfilPorClave('BASE');
        expect(() => Def.normalizarEleccion(base, { estancias: true })).toThrow(/no está disponible/);
    });

    test('una función fija no se apaga, ni aunque se pida', () => {
        const mascotas = Def.perfilPorClave('MASCOTAS');
        const eleccion = Def.normalizarEleccion(mascotas, { mascotas: false });
        expect(Def.funcionesActivas(mascotas, eleccion)).toContain('mascotas');
    });

    test('una clave guardada que ya no es del perfil no se cuela', () => {
        const base = Def.perfilPorClave('BASE');
        expect(Def.funcionesActivas(base, { recursos: true })).toEqual([]);
    });

    test('la lista de Configuración marca las fijas y las de fábrica', () => {
        const lista = Def.funcionesConfigurables(Def.perfilPorClave('MASCOTAS'), {});
        const mascotas = lista.find((f) => f.clave === 'mascotas');
        expect(mascotas).toMatchObject({ fija: true, activa: true });
        expect(lista.every((f) => f.etiqueta && f.descripcion)).toBe(true);
    });
});

describe('coherencia de los datos', () => {
    test('todo rubro del catálogo apunta a un perfil que existe', () => {
        for (const r of RUBROS.filter((x) => x.perfil)) {
            expect(Def.PERFILES[r.perfil]).toBeDefined();
        }
    });

    test('toda función declarada en un perfil existe en el catálogo de funciones', () => {
        for (const p of Object.values(Def.PERFILES)) {
            for (const f of [...p.fijas, ...p.disponibles, ...p.activas]) {
                expect(Def.FUNCIONES[f]).toBeDefined();
            }
            for (const f of p.activas) expect(p.disponibles.concat(p.fijas)).toContain(f);
        }
    });

    test('los catálogos de arranque son válidos', () => {
        for (const [clave, categorias] of Object.entries(CATALOGOS)) {
            for (const c of categorias) {
                for (const s of c.servicios) {
                    expect(s.duracion_min).toBeGreaterThan(0);
                    expect(s.precio).toBeGreaterThanOrEqual(0);
                    if (s.proceso) {
                        const [desde, min] = s.proceso;
                        const duraciones = [s.duracion_min, ...(s.variantes || []).map((v) => v.duracion_min)];
                        for (const d of duraciones) expect(desde + min).toBeLessThan(d);
                    }
                    for (const v of s.variantes || []) {
                        expect(v.duracion_min).toBeGreaterThan(0);
                    }
                }
            }
            expect(Def.PERFILES[clave]).toBeDefined();
        }
    });

    test('consultorio no recibe cortes de pelo de ejemplo', () => {
        expect(catalogoDe(Def.perfilPorClave(null, 'CONSULTORIO'))).toEqual([]);
        expect(catalogoDe(Def.perfilPorClave(null, 'BARBERIA')).length).toBeGreaterThan(0);
    });

    test('solo el hospedaje trae unidades de ejemplo', () => {
        expect(unidadesDe(Def.perfilPorClave('ALOJAMIENTO')).length).toBeGreaterThan(0);
        expect(unidadesDe(Def.perfilPorClave('MASCOTAS'))).toEqual([]);
        expect(unidadesDe(Def.perfilPorClave('SALON'))).toEqual([]);
    });
});
