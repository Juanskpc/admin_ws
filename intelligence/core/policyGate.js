/**
 * Policy Gate — el único camino por el que se ejecuta una capacidad (ADR-010, ADR-021).
 *
 * ## La regla innegociable
 *
 * **El `id_negocio` lo inyecta la plataforma desde el Principal, nunca quien invoca.**
 * No hay excepción y hay un test que lo prueba. Si un argumento trae `id_negocio`, ni se
 * usa ni se ignora en silencio: se rechaza la invocación entera. Un `id_negocio` en los
 * argumentos solo puede significar dos cosas —el catálogo se desincronizó, o alguien está
 * probando la puerta— y las dos merecen ruido.
 *
 * ## Las tres capas, en orden (ADR-021)
 *
 *   1. COMERCIAL  → `estaHabilitado(id_negocio, feature)`. ¿El plan incluye esto?
 *   2. DOMINIO    → `platform.capacidad_habilitada`. ¿Puede este negocio ejecutar esta
 *                   capacidad? Más el permiso del Principal sobre el negocio.
 *   3. ECONÓMICA  → los límites de Business Policy que la capacidad aplica (ADR-011).
 *
 * El orden importa: lo comercial primero porque es lo más barato de comprobar y lo que
 * separa antes al que no debería estar aquí. Y porque mantenerlas separadas es lo que
 * evita que la lógica de facturación se filtre al dominio.
 *
 * ### La capa 3 no tiene tabla propia, y es a conciencia (F4-B)
 *
 * ADR-011 fija **dónde se aplica** un límite económico —«un valor que la capacidad lee y
 * hace cumplir dentro de su transacción»— y deliberadamente no dice dónde se guarda.
 * `bounded-contexts.md` tampoco lista Business Policy entre lo que posee `platform`.
 *
 * El primer límite real del proyecto es `ventana_cancelacion_horas`, y **ya existe** en
 * `reserva.reserva_config`, donde la vertical ya lo aplica. Copiarlo a una tabla de
 * `platform` crearía dos fuentes de verdad para el mismo número: el día que un negocio lo
 * cambie desde su panel, el asistente seguiría usando el viejo. Un límite económico
 * desincronizado es peor que no tenerlo, porque parece que está.
 *
 * Así que la capa 3 hace lo único que le toca al Gate: **declarar y auditar** qué límites
 * gobiernan cada invocación, y pasárselos a la capacidad. El enforcement vive donde ADR-011
 * dice que viva. Si algún día aparece un límite que no tiene casa en ninguna vertical
 * (`descuento_maximo` es el candidato), ése sí necesitará almacén propio y llegará con su
 * capacidad, no antes.
 *
 * ## Dry-run
 *
 * Toda capacidad se puede ejecutar en seco. Se implementa donde es genérico —el Gate abre
 * la transacción y hace rollback pase lo que pase— y no capacidad por capacidad, porque una
 * implementación por capacidad es una implementación que alguien olvidará. Es el cimiento
 * del arnés de evaluación de F6 y de la depuración para siempre.
 *
 * ## Idempotencia (F4-B)
 *
 * Una invocación puede traer `claveIdempotencia` en el sobre —nunca en los parámetros que
 * el modelo rellena—. Si esa clave ya se usó para esa capacidad y ese negocio, se devuelve
 * el resultado guardado **sin volver a ejecutar**. El registro se escribe en la misma
 * transacción que la mutación: o existen los dos o ninguno.
 */
'use strict';
const Models = require('../../app_core/models/conection');
const Audit = require('../../app_core/helpers/auditHelper');
const registry = require('./registry');
const argumentos = require('./argumentos');
const features = require('./features');

const MODULO_AUDITORIA = 'capacidades';

/** Motivos de denegación. Son enum-like porque se auditan y se miden. */
const DENEGADO = {
    NO_EXISTE: 'CAPACIDAD_NO_EXISTE',
    ID_NEGOCIO_EN_ARGUMENTOS: 'ID_NEGOCIO_EN_ARGUMENTOS',
    PRINCIPAL_AJENO: 'PRINCIPAL_NO_PERTENECE_AL_NEGOCIO',
    FEATURE_APAGADA: 'FEATURE_NO_HABILITADA',
    CAPACIDAD_NO_HABILITADA: 'CAPACIDAD_NO_HABILITADA',
    ARGUMENTOS: 'ARGUMENTOS_INVALIDOS',
};

function denegar(codigo, mensaje) {
    const e = new Error(mensaje);
    e.code = codigo;
    e.statusCode = codigo === DENEGADO.ARGUMENTOS ? 400 : 403;
    return e;
}

/** Capa 2, mitad de dominio: ¿está la capacidad encendida para este negocio? */
async function capacidadHabilitada(idNegocio, nombre) {
    const [fila] = await Models.sequelize.query(
        `
        SELECT habilitada
          FROM platform.capacidad_habilitada
         WHERE id_negocio = :idNegocio AND capacidad = :nombre;
        `,
        { replacements: { idNegocio, nombre }, type: Models.sequelize.QueryTypes.SELECT }
    );
    // Sin fila = denegado. La ausencia de una decisión no autoriza nada.
    return Boolean(fila && fila.habilitada);
}

/**
 * Capa 3: los límites económicos que gobiernan esta invocación.
 *
 * El Gate **no** los hace cumplir: los declara y los audita. Quien los aplica es la
 * capacidad, dentro de su transacción, que es lo que ADR-011 exige para que el límite sea
 * imposible de violar diga lo que diga el modelo.
 *
 * Un límite que la capacidad declara pero no aplica es peor que ninguno, porque aparece en
 * la auditoría como si estuviera protegiendo algo. Eso no se puede comprobar desde aquí
 * —requiere leer la capacidad—, así que es materia de revisión de código, y por eso el
 * campo `politica` del manifiesto es corto y explícito.
 */
function declararPolitica(capacidad) {
    return capacidad.politica && capacidad.politica.length > 0 ? [...capacidad.politica] : [];
}

/**
 * ¿Ya se ejecutó esta invocación? Devuelve el resultado guardado, o `null`.
 *
 * Se consulta **antes** de tocar nada: un reintento no debe volver a abrir transacciones ni
 * volver a auditar como si fuera trabajo nuevo.
 */
async function resultadoIdempotente(idNegocio, capacidad, clave) {
    if (!clave) return null;
    const [fila] = await Models.sequelize.query(
        `
        SELECT resultado
          FROM platform.capacidad_idempotencia
         WHERE id_negocio = :idNegocio AND capacidad = :capacidad AND clave = :clave;
        `,
        {
            replacements: { idNegocio, capacidad, clave },
            type: Models.sequelize.QueryTypes.SELECT,
        }
    );
    return fila ? fila.resultado : null;
}

async function auditar({ nombre, idNegocio, principal, args, resultado, detalle, dryRun }) {
    try {
        await Audit.registrarEvento({
            modulo: MODULO_AUDITORIA,
            accion: nombre,
            resultado,
            idUsuario: principal?.id_usuario ?? null,
            idNegocio,
            // Los argumentos van completos: sin ellos la auditoría no responde a la única
            // pregunta que importa después de un incidente, que es qué se pidió exactamente.
            detalle: { argumentos: args, dry_run: Boolean(dryRun), ...detalle },
        });
    } catch (error) {
        // Perder la auditoría no debe tumbar la operación, pero tampoco puede pasar callando.
        console.error('[capacidades] No se pudo auditar la invocación:', error.message);
    }
}

/**
 * Ejecuta una capacidad. Es el único camino: nadie llama a `capacidad.ejecutar` directamente.
 *
 * @param {Object}  invocacion
 * @param {string}  invocacion.capacidad — nombre registrado.
 * @param {Object}  invocacion.principal — quién ejecuta (`app_core/authz/principal.js`).
 * @param {number}  invocacion.idNegocio — sobre qué negocio. Lo impone la plataforma.
 * @param {Object}  [invocacion.args]    — argumentos. NUNCA contienen `id_negocio`.
 * @param {boolean} [invocacion.dryRun]  — ejecuta y deshace: no deja rastro en el dominio.
 * @param {string}  [invocacion.claveIdempotencia] — reintentar con la misma clave devuelve
 *                  el resultado guardado sin volver a ejecutar. Va en el sobre, no en `args`.
 */
async function ejecutar({
    capacidad: nombre,
    principal,
    idNegocio,
    args = {},
    dryRun = false,
    claveIdempotencia = null,
}) {
    const capacidad = registry.obtener(nombre);

    if (!capacidad) {
        const error = denegar(DENEGADO.NO_EXISTE, `La capacidad "${nombre}" no existe en el catálogo.`);
        await auditar({ nombre, idNegocio, principal, args, resultado: 'denegado', dryRun, detalle: { motivo: error.code } });
        throw error;
    }

    // ── El `id_negocio` nunca llega de fuera ────────────────────────────────────────────
    for (const prohibido of registry.PARAMETROS_PROHIBIDOS) {
        if (Object.prototype.hasOwnProperty.call(args, prohibido)) {
            const error = denegar(
                DENEGADO.ID_NEGOCIO_EN_ARGUMENTOS,
                `Los argumentos traen "${prohibido}". El id_negocio lo impone la plataforma ` +
                    'desde el Principal y nunca viaja en los argumentos (ADR-010).'
            );
            await auditar({
                nombre,
                idNegocio,
                principal,
                args,
                resultado: 'denegado',
                dryRun,
                detalle: { motivo: error.code, parametro: prohibido, valor_intentado: args[prohibido] },
            });
            throw error;
        }
    }

    if (!Number.isInteger(idNegocio) || idNegocio <= 0) {
        throw denegar(DENEGADO.PRINCIPAL_AJENO, 'La invocación no trae un id_negocio válido de la plataforma.');
    }

    // ── Capa 2a: el Principal debe poder operar sobre este negocio ──────────────────────
    // Va antes que la comercial aunque el orden canónico empiece por lo comercial: preguntar
    // qué plan tiene un negocio al que quien invoca no pertenece ya es filtrar información.
    if (!principal || typeof principal.puedeOperarEn !== 'function' || !principal.puedeOperarEn(idNegocio)) {
        const error = denegar(
            DENEGADO.PRINCIPAL_AJENO,
            'Quien invoca no pertenece a este negocio.'
        );
        await auditar({ nombre, idNegocio, principal, args, resultado: 'denegado', dryRun, detalle: { motivo: error.code } });
        throw error;
    }

    // ── Capa 1: comercial ──────────────────────────────────────────────────────────────
    if (!(await features.estaHabilitado(idNegocio, capacidad.feature))) {
        const { motivo } = await features.explicar(idNegocio, capacidad.feature);
        const error = denegar(
            DENEGADO.FEATURE_APAGADA,
            `El negocio no tiene la feature "${capacidad.feature}": ${motivo}.`
        );
        await auditar({
            nombre,
            idNegocio,
            principal,
            args,
            resultado: 'denegado',
            dryRun,
            detalle: { motivo: error.code, feature: capacidad.feature, explicacion: motivo },
        });
        throw error;
    }

    // ── Capa 2b: dominio ───────────────────────────────────────────────────────────────
    if (!(await capacidadHabilitada(idNegocio, nombre))) {
        const error = denegar(
            DENEGADO.CAPACIDAD_NO_HABILITADA,
            `La capacidad "${nombre}" no está habilitada para este negocio.`
        );
        await auditar({ nombre, idNegocio, principal, args, resultado: 'denegado', dryRun, detalle: { motivo: error.code } });
        throw error;
    }

    // ── Esquema de entrada ─────────────────────────────────────────────────────────────
    let limpios;
    try {
        limpios = argumentos.validar(capacidad, args);
    } catch (error) {
        await auditar({
            nombre,
            idNegocio,
            principal,
            args,
            resultado: 'denegado',
            dryRun,
            detalle: { motivo: DENEGADO.ARGUMENTOS, error: error.message },
        });
        throw error;
    }

    // ── Capa 3: económica ──────────────────────────────────────────────────────────────
    const politica = declararPolitica(capacidad);

    // ── Idempotencia: ¿esto ya se hizo? ────────────────────────────────────────────────
    // En seco nunca se consulta ni se guarda: un dry-run no debe poder «gastar» una clave y
    // hacer que la ejecución de verdad devuelva un resultado que nunca ocurrió.
    const usaClave = Boolean(claveIdempotencia) && !dryRun;

    if (usaClave) {
        const guardado = await resultadoIdempotente(idNegocio, nombre, claveIdempotencia);
        if (guardado !== null) {
            await auditar({
                nombre,
                idNegocio,
                principal,
                args: limpios,
                resultado: 'ok',
                dryRun,
                detalle: { reintento_idempotente: true, clave: claveIdempotencia },
            });
            return { capacidad: nombre, dry_run: false, reintento: true, resultado: guardado };
        }
    }

    // ── Ejecución ──────────────────────────────────────────────────────────────────────
    // Siempre dentro de una transacción, también las consultas: es lo que hace que el
    // dry-run sea genérico y no algo que cada capacidad deba implementar (y olvidar).
    const transaction = await Models.sequelize.transaction();
    const iniciado = Date.now();

    try {
        const resultado = await capacidad.ejecutar({
            idNegocio,
            args: limpios,
            contexto: { principal, politica, dryRun, transaction },
        });

        if (usaClave) {
            // Dentro de la MISMA transacción que la mutación: si se guardara después, un
            // fallo entre medias dejaría la cita creada y la clave sin registrar, y el
            // reintento crearía una segunda.
            await Models.sequelize.query(
                `
                INSERT INTO platform.capacidad_idempotencia (id_negocio, capacidad, clave, resultado)
                VALUES (:idNegocio, :nombre, :clave, CAST(:resultado AS jsonb));
                `,
                {
                    replacements: {
                        idNegocio,
                        nombre,
                        clave: claveIdempotencia,
                        resultado: JSON.stringify(resultado ?? null),
                    },
                    transaction,
                }
            );
        }

        if (dryRun) {
            // Se deshace SIEMPRE, incluso si la capacidad no escribió nada. El criterio de
            // aceptación es "no deja rastro", y eso no puede depender de que la capacidad
            // se haya portado bien.
            await transaction.rollback();
        } else {
            await transaction.commit();
        }

        await auditar({
            nombre,
            idNegocio,
            principal,
            args: limpios,
            resultado: 'ok',
            dryRun,
            detalle: {
                ms: Date.now() - iniciado,
                tipo: capacidad.tipo,
                ...(politica.length ? { politica } : {}),
                ...(usaClave ? { clave: claveIdempotencia } : {}),
            },
        });

        return { capacidad: nombre, dry_run: Boolean(dryRun), resultado };
    } catch (error) {
        await transaction.rollback();

        // Dos invocaciones simultáneas con la misma clave. La perdedora ya deshizo su
        // trabajo con el rollback, así que no hay dos citas; si la ganadora dejó resultado,
        // se lo devuelve.
        //
        // Se comprueba ante **cualquier** error, no solo ante la violación de unicidad: la
        // perdedora rara vez llega a chocar contra la clave primaria, porque antes se topa
        // con el efecto de la ganadora. En la carrera real de `reservar_turno`, la segunda
        // falla con `SLOT_NO_DISPONIBLE` — la primera ya ocupó el hueco. Filtrar por el
        // código de error concreto dejaría fuera justo el caso que ocurre.
        if (usaClave) {
            const guardado = await resultadoIdempotente(idNegocio, nombre, claveIdempotencia);
            if (guardado !== null) {
                await auditar({
                    nombre,
                    idNegocio,
                    principal,
                    args: limpios,
                    resultado: 'ok',
                    dryRun,
                    detalle: { reintento_idempotente: true, carrera: true, clave: claveIdempotencia },
                });
                return { capacidad: nombre, dry_run: false, reintento: true, resultado: guardado };
            }
        }

        await auditar({
            nombre,
            idNegocio,
            principal,
            args: limpios,
            resultado: 'error',
            dryRun,
            detalle: { ms: Date.now() - iniciado, error: error.message, code: error.code || null },
        });
        throw error;
    }
}

/** Qué puede hacer el asistente de este negocio, hoy. Las tres capas, ya resueltas. */
async function capacidadesDisponibles(idNegocio) {
    const disponibles = [];
    for (const capacidad of registry.listar()) {
        const comercial = await features.estaHabilitado(idNegocio, capacidad.feature);
        const dominio = comercial && (await capacidadHabilitada(idNegocio, capacidad.nombre));
        if (dominio) disponibles.push(registry.describir(capacidad.nombre));
    }
    return disponibles;
}

module.exports = { ejecutar, capacidadesDisponibles, capacidadHabilitada, DENEGADO, MODULO_AUDITORIA };
