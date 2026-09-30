'use strict';
/**
 * Perfiles de rubro del módulo `reserva` — qué ve cada oficio, cómo se llama cada cosa y con
 * qué valores arranca. Ver `docs/perfiles-de-reserva.md`.
 *
 * ## La regla: el motor se activa con datos, el perfil decide qué se ve
 *
 * Nada de aquí cambia cómo calcula el motor. Una barbería no «tiene apagado» el tiempo de
 * proceso: sus servicios tienen `proceso_min = 0`, y con cero el motor hace lo de siempre. El
 * perfil de salón no enciende nada en el motor, **muestra el campo** para que la estilista le
 * ponga 45 minutos a una coloración. Por eso el código de servicios pregunta por datos y
 * funciones, nunca por el nombre del perfil: el nombre solo se lee en este archivo.
 *
 * ## Funciones: lo que un negocio del mismo oficio puede querer o no
 *
 * Cada perfil declara qué funciones tiene **disponibles** (el dueño las enciende o apaga en
 * Configuración → Funciones), cuáles vienen **activas** de fábrica y cuáles son **fijas** (sin
 * ellas el oficio no tiene sentido: una peluquería canina sin mascotas). Lo que el dueño decide
 * se guarda en `reserva_config.funciones`; una clave ausente toma el valor de fábrica.
 *
 * Este archivo es puro —sin base de datos— para que se pueda probar entero.
 */

/** Catálogo de funciones, con el texto que ve el dueño en Configuración. */
const FUNCIONES = {
    tiempo_proceso: {
        etiqueta: 'Tiempos de espera',
        descripcion: 'Un servicio puede liberar al profesional mientras actúa un producto '
            + '(tinte, keratina) para que atienda a otra persona en ese rato.',
    },
    variantes: {
        etiqueta: 'Variantes de precio',
        descripcion: 'Un mismo servicio con distinto precio y duración según el largo del '
            + 'cabello, el tamaño de la mascota o la zona.',
    },
    a_cotizar: {
        etiqueta: 'Servicios a cotizar',
        descripcion: 'Servicios cuyo precio y duración se acuerdan con el cliente. En el portal '
            + 'se piden por WhatsApp y se agendan desde la agenda.',
    },
    deposito: {
        etiqueta: 'Abono para reservar',
        descripcion: 'Quien reserva en el portal paga un porcentaje por adelantado y adjunta el '
            + 'comprobante. Se descuenta al cobrar.',
    },
    consentimiento: {
        etiqueta: 'Consentimiento informado',
        descripcion: 'Los servicios marcados no se pueden completar sin registrar el '
            + 'consentimiento firmado del cliente.',
    },
    recursos: {
        etiqueta: 'Cabinas y equipos',
        descripcion: 'Servicios que necesitan una cabina, sala o equipo además del profesional. '
            + 'La agenda no ofrece horas sin uno libre.',
    },
    mascotas: {
        etiqueta: 'Mascotas',
        descripcion: 'Cada cita se hace para una mascota del cliente, con su especie, raza y tamaño.',
    },
    portafolio: {
        etiqueta: 'Portafolio',
        descripcion: 'Galería de trabajos de cada profesional en el portal público.',
    },
    estancias: {
        etiqueta: 'Estancias por noches',
        descripcion: 'Reservas de una o varias noches sobre habitaciones, cabañas o cupos '
            + '(hotel o guardería).',
    },
    productos: {
        etiqueta: 'Venta de productos',
        descripcion: 'Además de agendar, vende productos físicos (shampoo, cera, alimento, '
            + 'accesorios…) desde el mostrador y en el portal, con o sin cita.',
    },
};

const TERMINOS_BASE = {
    profesional: 'Profesional',
    profesionales: 'Profesionales',
    servicio: 'Servicio',
    servicios: 'Servicios',
    cita: 'Cita',
    citas: 'Citas',
    cliente: 'Cliente',
    clientes: 'Clientes',
};

/**
 * Los perfiles. `BASE` es la barbería tal como funcionaba antes de que existieran: sin ninguna
 * función activa, con los términos de siempre y sin tocar un solo valor de configuración.
 */
const PERFILES = {
    BASE: {
        clave: 'BASE',
        modos: ['CITA'],
        terminos: {},
        icono_servicios: 'scissors',
        fijas: [],
        disponibles: ['variantes', 'deposito', 'a_cotizar', 'portafolio', 'productos'],
        activas: [],
        config_inicial: {},
        portal: {
            titulo: 'Reserva tu cita',
            subtitulo: 'Elige el servicio y la hora que mejor te queden.',
        },
    },

    SALON: {
        clave: 'SALON',
        modos: ['CITA'],
        terminos: { profesional: 'Estilista', profesionales: 'Estilistas' },
        icono_servicios: 'sparkles',
        fijas: [],
        disponibles: ['tiempo_proceso', 'variantes', 'deposito', 'consentimiento', 'portafolio', 'productos'],
        activas: ['tiempo_proceso', 'variantes'],
        config_inicial: {
            anticipacion_min_minutos: 15,
            buffer_limpieza_min: 0,
            ventana_cancelacion_min: 60,
            paso_slot_min: 30,
        },
        portal: {
            titulo: 'Reserva tu cita',
            subtitulo: 'Elige tu servicio, tu estilista y la hora que te quede mejor.',
        },
    },

    SPA: {
        clave: 'SPA',
        modos: ['CITA'],
        terminos: {
            profesional: 'Terapeuta', profesionales: 'Terapeutas',
            servicio: 'Tratamiento', servicios: 'Tratamientos',
        },
        icono_servicios: 'flower-2',
        fijas: [],
        disponibles: ['recursos', 'deposito', 'variantes', 'consentimiento', 'tiempo_proceso', 'productos'],
        activas: ['recursos', 'deposito'],
        config_inicial: {
            anticipacion_min_minutos: 15,
            buffer_limpieza_min: 0,
            ventana_cancelacion_min: 60,
            paso_slot_min: 30,
            deposito_pct: 30,
        },
        portal: {
            titulo: 'Reserva tu momento',
            subtitulo: 'Elige tu tratamiento y regálate una pausa.',
        },
    },

    ESTETICA: {
        clave: 'ESTETICA',
        modos: ['CITA'],
        terminos: {
            profesional: 'Especialista', profesionales: 'Especialistas',
            servicio: 'Tratamiento', servicios: 'Tratamientos',
        },
        icono_servicios: 'sparkles',
        fijas: [],
        disponibles: ['consentimiento', 'recursos', 'deposito', 'variantes', 'productos'],
        activas: ['consentimiento', 'recursos', 'deposito'],
        config_inicial: {
            anticipacion_min_minutos: 15,
            buffer_limpieza_min: 0,
            ventana_cancelacion_min: 60,
            paso_slot_min: 30,
            deposito_pct: 30,
        },
        portal: {
            titulo: 'Agenda tu tratamiento',
            subtitulo: 'Empieza por una valoración: te decimos qué te conviene.',
        },
    },

    TATUAJE: {
        clave: 'TATUAJE',
        modos: ['CITA'],
        terminos: {
            profesional: 'Artista', profesionales: 'Artistas',
            cita: 'Sesión', citas: 'Sesiones',
        },
        icono_servicios: 'pen-tool',
        fijas: [],
        disponibles: ['a_cotizar', 'deposito', 'consentimiento', 'portafolio', 'variantes', 'productos'],
        activas: ['a_cotizar', 'deposito', 'consentimiento', 'portafolio'],
        config_inicial: {
            anticipacion_min_minutos: 15,
            buffer_limpieza_min: 0,
            ventana_cancelacion_min: 60,
            paso_slot_min: 30,
            deposito_pct: 30,
            deposito_reembolsable: false,
        },
        portal: {
            titulo: 'Agenda tu sesión',
            subtitulo: 'Mira el trabajo de nuestros artistas y agenda tu valoración.',
        },
    },

    MASCOTAS: {
        clave: 'MASCOTAS',
        modos: ['CITA'],
        terminos: { profesional: 'Groomer', profesionales: 'Groomers' },
        icono_servicios: 'paw-print',
        fijas: ['mascotas'],
        // Sin estancias: el cuidado de mascotas se agenda por citas. Una guardería que cobre por
        // noches es un hospedaje, y ese es su propio oficio.
        disponibles: ['variantes', 'deposito', 'tiempo_proceso', 'productos'],
        activas: ['variantes'],
        config_inicial: {
            anticipacion_min_minutos: 15,
            buffer_limpieza_min: 0,
            ventana_cancelacion_min: 60,
            paso_slot_min: 30,
        },
        portal: {
            titulo: 'Agenda el spa de tu mascota',
            subtitulo: 'Elige el servicio y cuéntanos de tu peludo.',
        },
    },

    ALOJAMIENTO: {
        clave: 'ALOJAMIENTO',
        modos: [],
        terminos: {
            cita: 'Reserva', citas: 'Reservas',
            cliente: 'Huésped', clientes: 'Huéspedes',
        },
        icono_servicios: 'bed-double',
        fijas: ['estancias'],
        disponibles: ['deposito', 'productos'],
        activas: ['deposito'],
        config_inicial: {
            anticipacion_min_minutos: 0,
            // Un hotel necesita más margen que una cita: 72 horas antes de la llegada.
            ventana_cancelacion_min: 72 * 60,
            deposito_pct: 50,
            hora_checkin: '15:00',
            hora_checkout: '12:00',
        },
        portal: {
            titulo: 'Reserva tu estadía',
            subtitulo: 'Elige tus fechas y encuentra el lugar para quedarte.',
        },
    },
};

/**
 * Ajustes por rubro sobre su perfil. Solo existen cuando dos oficios comparten perfil pero no
 * punto de partida: la guardería de mascotas es el mismo negocio que la peluquería canina con
 * las estancias encendidas de fábrica.
 */
const AJUSTES_RUBRO = {
    // Consultorio usa el perfil BASE pero no tiene sentido ofrecerle cortes de pelo de ejemplo.
    CONSULTORIO: { sin_catalogo: true, icono_servicios: 'stethoscope' },
};

/** Vistas del módulo y qué las enciende. Una ruta que no esté aquí no la filtra el perfil. */
const VISTAS_COMUNES = ['/dashboard', '/clientes', '/caja', '/usuarios', '/informes', '/configuracion'];
const VISTAS_CITA = ['/agenda', '/citas', '/servicios', '/profesionales', '/horarios'];
const VISTAS_POR_FUNCION = {
    recursos: ['/recursos'],
    mascotas: ['/mascotas'],
    estancias: ['/ocupacion', '/estancias', '/unidades'],
    productos: ['/productos'],
};
const TODAS_LAS_VISTAS = new Set([
    ...VISTAS_COMUNES, ...VISTAS_CITA, ...Object.values(VISTAS_POR_FUNCION).flat(),
]);

/** El perfil por clave, con el ajuste del rubro aplicado. Clave desconocida o nula → BASE. */
function perfilPorClave(clave, nombreRubro = null) {
    const base = PERFILES[String(clave || '').toUpperCase()] || PERFILES.BASE;
    const ajuste = AJUSTES_RUBRO[String(nombreRubro || '').toUpperCase()] || {};
    return {
        ...base,
        ...ajuste,
        portal: { ...base.portal, ...(ajuste.portal || {}) },
    };
}

/**
 * Las funciones que el negocio tiene encendidas: las fijas, más las disponibles que el dueño
 * encendió o que vienen activas de fábrica y no apagó.
 *
 * `elegidas` es `reserva_config.funciones`. Solo se leen claves de funciones **disponibles** en
 * el perfil: una clave de otro perfil (quedó de cuando el negocio era de otro rubro) no se cuela.
 */
function funcionesActivas(perfil, elegidas = {}) {
    const decision = elegidas && typeof elegidas === 'object' ? elegidas : {};
    const activas = new Set(perfil.fijas);
    for (const f of perfil.disponibles) {
        const porDefecto = perfil.activas.includes(f);
        const valor = Object.prototype.hasOwnProperty.call(decision, f) ? decision[f] === true : porDefecto;
        if (valor) activas.add(f);
    }
    return [...activas].filter((f) => FUNCIONES[f]).sort();
}

function modosDe(perfil, funciones) {
    const modos = new Set(perfil.modos);
    if (funciones.includes('estancias')) modos.add('ESTANCIA');
    return [...modos];
}

function vistasPermitidas(perfil, funciones) {
    const permitidas = new Set(VISTAS_COMUNES);
    if (perfil.modos.includes('CITA')) VISTAS_CITA.forEach((v) => permitidas.add(v));
    for (const f of funciones) (VISTAS_POR_FUNCION[f] || []).forEach((v) => permitidas.add(v));
    return permitidas;
}

/**
 * Quita de los permisos de vista las que el perfil no usa. Las rutas desconocidas para este
 * registro se dejan pasar: filtrar por perfil no es el sitio donde se decide si un rol ve algo.
 */
function filtrarVistas(permisosVista, perfilSesion) {
    if (!perfilSesion?.vistas) return permisosVista;
    const permitidas = new Set(perfilSesion.vistas);
    return (permisosVista || []).filter((p) => {
        const url = String(p.url || '').replace(/\/+$/, '');
        return !TODAS_LAS_VISTAS.has(url) || permitidas.has(url);
    });
}

/**
 * Lo que viaja en la sesión y en la configuración: todo lo que el frontend necesita para
 * adaptarse, sin tener que conocer este archivo.
 */
function describirPerfil(perfil, elegidas, rubro = null) {
    const funciones = funcionesActivas(perfil, elegidas);
    return {
        clave: perfil.clave,
        rubro,
        modos: modosDe(perfil, funciones),
        funciones,
        terminos: { ...TERMINOS_BASE, ...perfil.terminos },
        icono_servicios: perfil.icono_servicios,
        portal: perfil.portal,
        vistas: [...vistasPermitidas(perfil, funciones)].sort(),
    };
}

/** Las funciones que el dueño puede tocar, con su estado, para la pantalla de Configuración. */
function funcionesConfigurables(perfil, elegidas) {
    const activas = new Set(funcionesActivas(perfil, elegidas));
    const lista = [
        ...perfil.fijas.map((f) => ({ clave: f, fija: true })),
        ...perfil.disponibles.filter((f) => !perfil.fijas.includes(f)).map((f) => ({ clave: f, fija: false })),
    ];
    return lista
        .filter(({ clave }) => FUNCIONES[clave])
        .map(({ clave, fija }) => ({
            clave,
            etiqueta: FUNCIONES[clave].etiqueta,
            descripcion: FUNCIONES[clave].descripcion,
            activa: activas.has(clave),
            fija,
            de_fabrica: fija || perfil.activas.includes(clave),
        }));
}

/**
 * Valida y normaliza lo que el dueño quiere guardar. Solo acepta claves disponibles y no fijas:
 * una función fija no se apaga y una de otro perfil no se enciende.
 */
function normalizarEleccion(perfil, cambios, actuales = {}) {
    const resultado = { ...(actuales || {}) };
    for (const [clave, valor] of Object.entries(cambios || {})) {
        if (perfil.fijas.includes(clave)) continue;
        if (!perfil.disponibles.includes(clave)) {
            const e = new Error(`La función «${clave}» no está disponible para este tipo de negocio.`);
            e.statusCode = 422;
            e.code = 'FUNCION_NO_DISPONIBLE';
            throw e;
        }
        resultado[clave] = valor === true;
    }
    return resultado;
}

module.exports = {
    FUNCIONES,
    PERFILES,
    AJUSTES_RUBRO,
    TERMINOS_BASE,
    TODAS_LAS_VISTAS,
    perfilPorClave,
    funcionesActivas,
    modosDe,
    vistasPermitidas,
    filtrarVistas,
    describirPerfil,
    funcionesConfigurables,
    normalizarEleccion,
};
