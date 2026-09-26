'use strict';
/**
 * Un `Models` de mentira, en memoria, para probar el motor de agenda sin base de datos.
 *
 * ## Por qué existe
 *
 * La prueba dorada del motor (`motor_dorado.test.js`) tiene que poder correrse en cualquier
 * máquina y en cualquier momento, incluida la base de desarrollo **compartida**, donde las
 * suites que escriben filas están prohibidas (ver `docs/desarrollo-local.md`). El motor solo
 * lee: horarios, bloqueos, citas, holds, servicios, profesionales y configuración. Eso cabe en
 * unas tablas en memoria y un evaluador de `where` que entiende los operadores que el motor usa.
 *
 * El evaluador es deliberadamente pequeño: igualdad, `null`, listas (`IN`), `Op.in`, `Op.ne`,
 * `Op.lt/lte/gt/gte` y `Op.or`. Si el motor empieza a usar otro operador, la prueba falla con un
 * error explícito en vez de devolver un resultado inventado.
 */
const { Op } = require('sequelize');

function valor(v) {
    return v instanceof Date ? v.getTime() : v;
}

function cumpleOperador(v, op, x) {
    switch (op) {
        case Op.in: return x.map(valor).includes(valor(v));
        case Op.notIn: return !x.map(valor).includes(valor(v));
        case Op.ne: return valor(v) !== valor(x);
        case Op.eq: return valor(v) === valor(x);
        case Op.lt: return valor(v) < valor(x);
        case Op.lte: return valor(v) <= valor(x);
        case Op.gt: return valor(v) > valor(x);
        case Op.gte: return valor(v) >= valor(x);
        default: throw new Error(`Operador no soportado por el modelo falso: ${String(op)}`);
    }
}

function cumple(fila, where = {}) {
    for (const clave of Reflect.ownKeys(where)) {
        const cond = where[clave];
        if (clave === Op.or) {
            if (!cond.some((w) => cumple(fila, w))) return false;
            continue;
        }
        if (clave === Op.and) {
            if (!cond.every((w) => cumple(fila, w))) return false;
            continue;
        }
        if (typeof clave === 'symbol') throw new Error(`Operador no soportado: ${String(clave)}`);

        const v = fila[clave] ?? null;
        if (Array.isArray(cond)) {
            if (!cond.map(valor).includes(valor(v))) return false;
        } else if (cond !== null && typeof cond === 'object' && !(cond instanceof Date)) {
            for (const op of Reflect.ownKeys(cond)) {
                if (!cumpleOperador(v, op, cond[op])) return false;
            }
        } else if (cond === null) {
            if (v !== null) return false;
        } else if (valor(v) !== valor(cond)) {
            return false;
        }
    }
    return true;
}

function ordenar(filas, order) {
    if (!order) return filas;
    return [...filas].sort((a, b) => {
        for (const [campo, dir = 'ASC'] of order) {
            const va = valor(a[campo]);
            const vb = valor(b[campo]);
            if (va === vb) continue;
            const r = va < vb ? -1 : 1;
            return dir.toUpperCase() === 'DESC' ? -r : r;
        }
        return 0;
    });
}

/** Una fila con la forma mínima de una instancia de Sequelize. */
function instancia(fila) {
    return { ...fila, toJSON() { const { toJSON, ...resto } = this; return { ...resto }; } };
}

function tabla(nombre, datos) {
    return {
        _nombre: nombre,
        _filas: () => datos[nombre] || [],
        async findAll({ where, order, raw } = {}) {
            const filas = ordenar((datos[nombre] || []).filter((f) => cumple(f, where)), order);
            return raw ? filas.map((f) => ({ ...f })) : filas.map(instancia);
        },
        async findOne({ where, order } = {}) {
            const f = ordenar((datos[nombre] || []).filter((x) => cumple(x, where)), order)[0];
            return f ? instancia(f) : null;
        },
        async findByPk(id) {
            const pk = Object.keys((datos[nombre] || [])[0] || {})[0];
            const f = (datos[nombre] || []).find((x) => x[pk] === id);
            return f ? instancia(f) : null;
        },
        async count({ where } = {}) {
            return (datos[nombre] || []).filter((f) => cumple(f, where)).length;
        },
        async create(fila) {
            datos[nombre] = [...(datos[nombre] || []), fila];
            return instancia(fila);
        },
    };
}

/**
 * Construye el módulo falso sobre un objeto `datos` mutable: la prueba puede cambiar la
 * configuración o las citas entre casos y el motor lo ve en la siguiente consulta.
 */
function crearModelos(datos) {
    const nombres = [
        'ReservaHorario', 'ReservaBloqueo', 'ReservaCita', 'ReservaHold', 'ReservaServicio',
        'ReservaProfesional', 'ReservaProfesionalServicio', 'ReservaConfig', 'ReservaRecurso',
        'ReservaCitaServicio', 'ReservaServicioVariante', 'GenerNegocio', 'GenerTipoNegocio',
    ];
    const modelos = Object.fromEntries(nombres.map((n) => [n, tabla(n, datos)]));
    return {
        ...modelos,
        Sequelize: { Op },
        sequelize: {
            async query() { throw new Error('El modelo falso no ejecuta SQL crudo.'); },
            async transaction() { throw new Error('El modelo falso no abre transacciones.'); },
        },
    };
}

module.exports = { crearModelos, cumple };
