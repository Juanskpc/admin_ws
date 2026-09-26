/**
 * Verificación de extremo a extremo de los perfiles de rubro de `reserva`, contra la base real,
 * **sin dejar rastro**.
 *
 *   node scripts/verificar_perfiles_reserva.js
 *
 * ## Cómo no deja rastro
 *
 * Todo corre dentro de UNA transacción externa que se revierte al final, pase lo que pase. Las
 * transacciones que abren los servicios (crear cita, cobrar, aprobar pago…) se convierten en
 * savepoints de esa transacción, y las consultas que los servicios hacen sin transacción la
 * heredan por CLS (AsyncLocalStorage). Así se ven entre sí los datos de prueba sin confirmarse
 * nunca: ni filas, ni registros de auditoría (los triggers escriben en la misma transacción).
 *
 * Por eso es seguro correrlo en la base de desarrollo compartida (ver
 * `docs/desarrollo-local.md`), a diferencia de las suites de Jest que escriben y confirman.
 *
 * ## Qué comprueba
 *
 * 1. Barbería (perfil BASE): una cita se crea y se cobra exactamente como antes.
 * 2. Salón: tiempo de proceso (otra clienta en la espera del tinte), variantes.
 * 3. Abono: portal con 30 %, aprobación que lo asienta, cobro del saldo; caja cuadra.
 * 4. Tatuaje: servicio «a cotizar» rechazado en el portal y agendado con precio acordado.
 * 5. Spa: una sola cabina entre dos terapeutas.
 * 6. Estética: consentimiento exigido antes de completar.
 * 7. Mascotas: la cita exige mascota; el portal la crea y la reconoce la segunda vez.
 */
'use strict';
require('dotenv').config();
const { AsyncLocalStorage } = require('async_hooks');
const Sequelize = require('sequelize');
const Models = require('../app_core/models/conection');

const sequelize = Models.sequelize;

// ── CLS mínimo sobre AsyncLocalStorage (Sequelize solo necesita get/set/run/bind) ──
const als = new AsyncLocalStorage();
Sequelize.useCLS({
    get: (k) => als.getStore()?.get(k),
    set: (k, v) => { const s = als.getStore(); if (s) s.set(k, v); },
    run: (fn) => { const ctx = new Map(als.getStore() || []); return als.run(ctx, () => fn(ctx)); },
    bind: (fn) => fn,
});

// Varios servicios pasan `transaction: null` a propósito («fuera de transacción»). Sequelize solo
// hereda por CLS cuando vale `undefined`, así que aquí `null` se trata igual: en producción esa
// consulta lee lo confirmado; aquí, lo que la verificación escribió dentro de la externa.
const queryReal = sequelize.query.bind(sequelize);
sequelize.query = function (sql, opciones) {
    if (opciones && opciones.transaction === null) opciones = { ...opciones, transaction: undefined };
    return queryReal(sql, opciones);
};

// ── Toda transacción de los servicios pasa a ser un savepoint de la externa ──
let externa = null;
const transaccionReal = sequelize.transaction.bind(sequelize);
sequelize.transaction = function (opciones, cb) {
    if (typeof opciones === 'function') { cb = opciones; opciones = undefined; }
    const o = { ...(opciones || {}) };
    if (externa && !o.transaction) o.transaction = externa;
    return cb ? transaccionReal(o, cb) : transaccionReal(o);
};

const Citas = require('../app_reserva_api/services/citaService');
const Cobro = require('../app_reserva_api/services/cobroService');
const Caja = require('../app_reserva_api/services/cajaService');
const Config = require('../app_reserva_api/services/configService');
const Disponibilidad = require('../app_reserva_api/services/disponibilidadService');
const Ficha = require('../app_reserva_api/services/fichaService');
const Perfiles = require('../app_reserva_api/perfiles');
const Servicios = require('../app_reserva_api/services/servicioService');
const Recursos = require('../app_reserva_api/services/recursoService');
const Catalogo = require('../app_reserva_api/services/catalogoService');
const Estancias = require('../app_reserva_api/services/estancia/estanciaService');
const Ical = require('../app_reserva_api/services/estancia/icalService');
const Tarifas = require('../app_reserva_api/services/estancia/tarifas');
const Reglas = require('../app_reserva_api/services/reglasAgenda');

const USUARIO = Number(process.env.VERIFICAR_ID_USUARIO || 1);
const MARCA = 'VERIF-PERFIL';

let fallos = 0;
let pasos = 0;
function ok(condicion, mensaje, detalle = '') {
    pasos += 1;
    if (condicion) console.log(`   ✓ ${mensaje}`);
    else { fallos += 1; console.log(`   ✗ ${mensaje}${detalle ? `  → ${detalle}` : ''}`); }
}
async function falla(promesa, codigo, mensaje) {
    try {
        await promesa;
        ok(false, mensaje, 'no falló');
    } catch (err) {
        ok(err.code === codigo, mensaje, `${err.code || ''} ${err.message}`);
    }
}

/** Primer lunes a más de tres semanas: lejos de la anticipación mínima y de datos reales. */
function lunesLejano() {
    const d = new Date();
    d.setDate(d.getDate() + 21);
    while (d.getDay() !== 1) d.setDate(d.getDate() + 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const FECHA = lunesLejano();
const a = (hhmm) => `${FECHA}T${hhmm}:00`;

/** Deja un negocio con el rubro, las funciones y la configuración pedidos, y dos profesionales. */
let ronda = 0;
async function preparar(idNegocio, rubro, { funciones = {}, config = {} } = {}) {
    ronda += 1;
    const tipo = await Models.GenerTipoNegocio.findOne({ where: { nombre: rubro } });
    if (!tipo) throw new Error(`No existe el rubro ${rubro}: corre migrate:rubros-negocio`);
    await Models.GenerNegocio.update({ id_rubro: tipo.id_tipo_negocio }, { where: { id_negocio: idNegocio } });

    const cfg = await Config.get(idNegocio);
    await cfg.update({
        funciones, anticipacion_min_horas: 1, buffer_limpieza_min: 10, paso_slot_min: 15,
        cobro_adelantado: false, deposito_pct: 0, instrucciones_pago: null, ...config,
    });

    const profesionales = [];
    for (const nombre of ['Ana', 'Beto']) {
        const p = await Models.ReservaProfesional.create({ id_negocio: idNegocio, nombre: `${MARCA} ${nombre} ${ronda}`, estado: 'A' });
        for (let dia = 0; dia <= 6; dia++) {
            await Models.ReservaHorario.create({
                id_negocio: idNegocio, id_profesional: p.id_profesional, dia_semana: dia,
                hora_inicio: '08:00:00', hora_fin: '20:00:00',
            });
        }
        profesionales.push(p.id_profesional);
    }
    const metodo = await Models.ReservaMetodoPago.create({
        id_negocio: idNegocio, nombre: `${MARCA} efectivo ${ronda}`, estado: 'A',
    });
    let caja = await Caja.getCajaAbiertaRaw(idNegocio);
    if (!caja) caja = await Caja.abrirCaja({ idNegocio, idUsuario: USUARIO, montoApertura: 0 });
    return { profesionales, idMetodo: metodo.id_metodo_pago, idCaja: caja.id_caja };
}

function servicio(idNegocio, datos) {
    return Servicios.crear({ id_negocio: idNegocio, estado: 'A', ...datos });
}

async function escenarios(idNegocio) {
    // ── 1. Barbería ──
    console.log('\n1. Barbería (perfil BASE): todo como antes');
    {
        const { profesionales: [ana], idMetodo } = await preparar(idNegocio, 'BARBERIA');
        const perfil = await Perfiles.perfilDeNegocio(idNegocio);
        ok(perfil.clave === 'BASE' && perfil.funciones.length === 0, 'perfil BASE sin funciones');
        const corte = await servicio(idNegocio, { nombre: `${MARCA} Corte`, duracion_min: 30, precio: 28000 });
        const barba = await servicio(idNegocio, { nombre: `${MARCA} Barba`, duracion_min: 20, precio: 18000 });
        const cita = await Citas.crearCita({
            idNegocio, idProfesional: ana, idServicios: [corte.id_servicio, barba.id_servicio],
            fechaHoraInicioISO: a('10:00'), clienteNombre: `${MARCA} Cliente`, creadoPorIdUsuario: USUARIO,
        });
        const dur = (new Date(cita.fecha_hora_fin) - new Date(cita.fecha_hora_inicio)) / 60000;
        ok(dur === 50 && Number(cita.monto_total) === 46000, 'duración y monto = suma de lista', `${dur} min, ${cita.monto_total}`);
        ok(cita.proceso_tramos == null && cita.monto_abono == null && cita.id_recurso == null && cita.id_mascota == null,
            'ningún campo de perfil se llena');
        const cobrada = await Cobro.completarYCobrar({ idCita: cita.id_cita, idNegocio, idUsuario: USUARIO, idMetodoPago: idMetodo });
        const movs = await Models.ReservaMovimientoCaja.findAll({ where: { id_cita: cita.id_cita } });
        ok(cobrada.estado === 'completada' && movs.length === 1 && Number(movs[0].monto) === 46000,
            'se cobra el total en un movimiento, como siempre');
        await falla(
            Config.actualizar(idNegocio, { funciones: { estancias: true } }),
            'FUNCION_NO_DISPONIBLE', 'no puede encender una función de otro rubro',
        );
    }

    // ── 2. Salón ──
    console.log('\n2. Salón: tiempo de proceso y variantes');
    {
        const { profesionales: [ana] } = await preparar(idNegocio, 'SALON DE BELLEZA',
            { funciones: {} });
        const perfil = await Perfiles.perfilDeNegocio(idNegocio);
        ok(perfil.clave === 'SALON' && perfil.funciones.includes('tiempo_proceso'), 'perfil SALON con espera de fábrica');
        const tinte = await servicio(idNegocio, {
            nombre: `${MARCA} Tinte`, duracion_min: 120, precio: 120000, proceso_desde_min: 30, proceso_min: 45,
            variantes: [
                { nombre: 'Corto', duracion_min: 105, precio: 100000 },
                { nombre: 'Largo', duracion_min: 150, precio: 150000 },
            ],
        });
        const corte = await servicio(idNegocio, { nombre: `${MARCA} Corte dama`, duracion_min: 30, precio: 35000 });
        const largo = tinte.variantes.find((v) => v.nombre === 'Largo');

        const citaTinte = await Citas.crearCita({
            idNegocio, idProfesional: ana, idServicios: [tinte.id_servicio],
            variantes: { [tinte.id_servicio]: largo.id_variante },
            fechaHoraInicioISO: a('10:00'), clienteNombre: `${MARCA} Clienta tinte`, creadoPorIdUsuario: USUARIO,
        });
        const dur = (new Date(citaTinte.fecha_hora_fin) - new Date(citaTinte.fecha_hora_inicio)) / 60000;
        ok(dur === 150 && Number(citaTinte.monto_total) === 150000, 'la variante «Largo» fija 150 min y su precio');
        ok(JSON.stringify(citaTinte.proceso_tramos) === '[[30,75]]', 'guarda el tramo de espera', JSON.stringify(citaTinte.proceso_tramos));
        ok(citaTinte.servicios[0].variante_snapshot === 'Largo', 'congela el nombre de la variante');

        const slots = await Disponibilidad.calcularSlots({
            idNegocio, idServicios: [corte.id_servicio], idProfesional: ana, fechaISO: FECHA,
        });
        const horas = slots.slots.filter((s) => s.disponible).map((s) => s.hora);
        ok(horas.includes('10:30') && !horas.includes('10:15'), 'ofrece el corte dentro de la espera del tinte', horas.slice(0, 12).join(' '));

        const enEspera = await Citas.crearCita({
            idNegocio, idProfesional: ana, idServicios: [corte.id_servicio],
            fechaHoraInicioISO: a('10:30'), clienteNombre: `${MARCA} Clienta corte`, creadoPorIdUsuario: USUARIO,
        });
        ok(!!enEspera.id_cita, 'y la agenda sí la acepta');
        await falla(Citas.crearCita({
            idNegocio, idProfesional: ana, idServicios: [corte.id_servicio],
            fechaHoraInicioISO: a('10:15'), clienteNombre: `${MARCA} Choque`, creadoPorIdUsuario: USUARIO,
        }), 'SLOT_NO_DISPONIBLE', 'pero no mientras aplica el tinte');

        await Config.actualizar(idNegocio, { funciones: { tiempo_proceso: false } });
        const sinEspera = await Disponibilidad.calcularSlots({
            idNegocio, idServicios: [tinte.id_servicio], idProfesional: ana, fechaISO: FECHA,
        });
        ok(sinEspera.duracion_servicio_min === 120, 'apagada la función de variantes/espera no cambia la lista');
    }

    // ── 3. Abono ──
    console.log('\n3. Abono del 30 % desde el portal');
    {
        const { profesionales: [ana], idMetodo, idCaja } = await preparar(idNegocio, 'SPA Y ESTETICA', {
            funciones: { recursos: false },
            config: { deposito_pct: 30, instrucciones_pago: 'Nequi 300 000 0000' },
        });
        const masaje = await servicio(idNegocio, { nombre: `${MARCA} Masaje`, duracion_min: 60, precio: 120000 });
        await falla(Citas.crearCita({
            idNegocio, idProfesional: ana, idServicios: [masaje.id_servicio],
            fechaHoraInicioISO: a('09:00'), clienteNombre: `${MARCA} Sin comprobante`, clienteTelefono: '3001112233',
        }), 'COMPROBANTE_REQUERIDO', 'el portal exige comprobante del abono');

        const cita = await Citas.crearCita({
            idNegocio, idProfesional: ana, idServicios: [masaje.id_servicio],
            fechaHoraInicioISO: a('09:00'), clienteNombre: `${MARCA} Con abono`, clienteTelefono: '3001112233',
            comprobantePath: '/uploads/reserva/comprobantes/verif.png',
        });
        ok(Number(cita.monto_abono) === 36000 && cita.pago_estado === 'pendiente_validacion', 'abono = 30 % de 120.000', cita.monto_abono);

        await Citas.aprobarPago(cita.id_cita, idNegocio, USUARIO, { idMetodoPago: idMetodo });
        const aprobada = await Models.ReservaCita.findByPk(cita.id_cita);
        ok(aprobada.id_caja_abono === idCaja, 'al aprobar, el abono entra a la caja abierta');

        await Cobro.completarYCobrar({ idCita: cita.id_cita, idNegocio, idUsuario: USUARIO, idMetodoPago: idMetodo });
        const movs = await Models.ReservaMovimientoCaja.findAll({ where: { id_cita: cita.id_cita } });
        const suma = movs.reduce((s, m) => s + Number(m.monto), 0);
        ok(movs.length === 2 && suma === 120000, 'al completar se cobra el saldo; abono + saldo = total', `${movs.length} movs, ${suma}`);

        const gratis = await servicio(idNegocio, { nombre: `${MARCA} Valoración`, duracion_min: 20, precio: 0 });
        const sinPago = await Citas.crearCita({
            idNegocio, idProfesional: ana, idServicios: [gratis.id_servicio],
            fechaHoraInicioISO: a('15:00'), clienteNombre: `${MARCA} Gratis`, clienteTelefono: '3001112244',
        });
        ok(sinPago.requiere_pago === false, 'un servicio gratis no pide comprobante');
    }

    // ── 4. Tatuaje ──
    console.log('\n4. Tatuaje: servicio a cotizar');
    {
        const { profesionales: [ana] } = await preparar(idNegocio, 'TATUAJES Y PERFORACIONES',
            { config: { deposito_pct: 30, instrucciones_pago: 'Cuenta 123' } });
        const sesion = await servicio(idNegocio, { nombre: `${MARCA} Sesión`, duracion_min: 180, precio: 450000, a_cotizar: true });
        await falla(Citas.crearCita({
            idNegocio, idProfesional: ana, idServicios: [sesion.id_servicio],
            fechaHoraInicioISO: a('09:00'), clienteNombre: `${MARCA} Portal`, clienteTelefono: '3001112255',
            comprobantePath: '/x.png',
        }), 'SERVICIO_A_COTIZAR', 'el portal no agenda un servicio a cotizar');
        const cita = await Citas.crearCita({
            idNegocio, idProfesional: ana, idServicios: [sesion.id_servicio],
            ajustes: [{ id_servicio: sesion.id_servicio, precio: 380000, duracion_min: 240 }],
            fechaHoraInicioISO: a('09:00'), clienteNombre: `${MARCA} Acordado`, creadoPorIdUsuario: USUARIO,
        });
        const dur = (new Date(cita.fecha_hora_fin) - new Date(cita.fecha_hora_inicio)) / 60000;
        ok(Number(cita.monto_total) === 380000 && dur === 240, 'el artista fija precio y duración acordados');
        const movida = await Citas.reagendarCita({ idCita: cita.id_cita, idNegocio, nuevaFechaHoraInicioISO: a('14:00') });
        const dur2 = (new Date(movida.fecha_hora_fin) - new Date(movida.fecha_hora_inicio)) / 60000;
        ok(dur2 === 240, 'reagendar conserva la duración acordada', dur2);
    }

    // ── 5. Spa: cabina ──
    console.log('\n5. Spa: una cabina para dos terapeutas');
    {
        const { profesionales: [ana, beto] } = await preparar(idNegocio, 'SPA Y ESTETICA', { funciones: { deposito: false } });
        const tipo = await Recursos.crearTipo(idNegocio, { nombre: `${MARCA} Cabina`, cantidad: 1 });
        const masaje = await servicio(idNegocio, {
            nombre: `${MARCA} Masaje cabina`, duracion_min: 60, precio: 100000, id_tipo_recurso: tipo.id_tipo_recurso,
        });
        const c1 = await Citas.crearCita({
            idNegocio, idProfesional: ana, idServicios: [masaje.id_servicio],
            fechaHoraInicioISO: a('11:00'), clienteNombre: `${MARCA} Cabina 1`, creadoPorIdUsuario: USUARIO,
        });
        ok(!!c1.id_recurso, 'la primera cita se lleva la cabina');
        await falla(Citas.crearCita({
            idNegocio, idProfesional: beto, idServicios: [masaje.id_servicio],
            fechaHoraInicioISO: a('11:00'), clienteNombre: `${MARCA} Cabina 2`, creadoPorIdUsuario: USUARIO,
        }), 'RECURSO_NO_DISPONIBLE', 'la segunda terapeuta no puede a la misma hora');
        const slots = await Disponibilidad.calcularSlots({
            idNegocio, idServicios: [masaje.id_servicio], idProfesional: beto, fechaISO: FECHA,
        });
        const horas = slots.slots.filter((s) => s.disponible).map((s) => s.hora);
        ok(!horas.includes('11:00') && horas.includes('12:15'), 'ni se la ofrece la agenda');
    }

    // ── 6. Estética: consentimiento ──
    console.log('\n6. Estética: consentimiento antes de completar');
    {
        const { profesionales: [ana], idMetodo } = await preparar(idNegocio, 'CENTRO DE ESTETICA',
            { funciones: { recursos: false, deposito: false } });
        const peeling = await servicio(idNegocio, {
            nombre: `${MARCA} Peeling`, duracion_min: 45, precio: 180000, requiere_consentimiento: true,
        });
        const cita = await Citas.crearCita({
            idNegocio, idProfesional: ana, idServicios: [peeling.id_servicio],
            fechaHoraInicioISO: a('09:00'), clienteNombre: `${MARCA} Paciente`, clienteTelefono: '3001112266',
            creadoPorIdUsuario: USUARIO,
        });
        await falla(Cobro.completarYCobrar({ idCita: cita.id_cita, idNegocio, idUsuario: USUARIO, idMetodoPago: idMetodo }),
            'CONSENTIMIENTO_PENDIENTE', 'no se completa sin consentimiento');
        await Ficha.crear(idNegocio, USUARIO, { id_cita: cita.id_cita, tipo: 'CONSENTIMIENTO', contenido: 'Firmado en papel' });
        const hecha = await Cobro.completarYCobrar({ idCita: cita.id_cita, idNegocio, idUsuario: USUARIO, idMetodoPago: idMetodo });
        ok(hecha.estado === 'completada', 'con el consentimiento registrado, sí');
        const ficha = await Ficha.listar(idNegocio, { idCita: cita.id_cita });
        ok(ficha.length === 1 && ficha[0].tipo === 'CONSENTIMIENTO', 'la ficha del cliente lo muestra');
    }

    // ── 7. Mascotas ──
    console.log('\n7. Mascotas');
    {
        const { profesionales: [ana] } = await preparar(idNegocio, 'PELUQUERIA CANINA');
        const perfil = await Perfiles.perfilDeNegocio(idNegocio);
        ok(perfil.funciones.includes('mascotas') && perfil.terminos.profesional === 'Groomer', 'perfil MASCOTAS');
        const bano = await servicio(idNegocio, {
            nombre: `${MARCA} Baño`, duracion_min: 60, precio: 45000,
            variantes: [
                { nombre: 'Pequeño', clave: 'PEQUENO', duracion_min: 45, precio: 35000 },
                { nombre: 'Grande', clave: 'GRANDE', duracion_min: 75, precio: 60000 },
            ],
        });
        await falla(Citas.crearCita({
            idNegocio, idProfesional: ana, idServicios: [bano.id_servicio],
            fechaHoraInicioISO: a('09:00'), clienteNombre: `${MARCA} Dueño`, clienteTelefono: '3001112277',
        }), 'MASCOTA_REQUERIDA', 'la cita exige mascota');
        const grande = bano.variantes.find((v) => v.clave === 'GRANDE');
        const c1 = await Citas.crearCita({
            idNegocio, idProfesional: ana, idServicios: [bano.id_servicio],
            variantes: { [bano.id_servicio]: grande.id_variante },
            mascota: { nombre: 'Firulais', especie: 'PERRO', raza: 'Labrador', tamano: 'GRANDE' },
            fechaHoraInicioISO: a('09:00'), clienteNombre: `${MARCA} Dueño`, clienteTelefono: '3001112277',
        });
        ok(!!c1.id_mascota && c1.mascota?.nombre === 'Firulais', 'el portal crea la mascota');
        ok(Number(c1.monto_total) === 60000, 'con el precio de su tamaño');
        const c2 = await Citas.crearCita({
            idNegocio, idProfesional: ana, idServicios: [bano.id_servicio],
            mascota: { nombre: 'firulais' },
            fechaHoraInicioISO: a('14:00'), clienteNombre: `${MARCA} Dueño`, clienteTelefono: '3001112277',
        });
        ok(c2.id_mascota === c1.id_mascota, 'la segunda vez la reconoce por nombre');
    }

    // ── 8. Alojamiento ──
    console.log('\n8. Alojamiento: estancias por noches');
    {
        const { idMetodo } = await preparar(idNegocio, 'HOTEL', {
            config: { deposito_pct: 50, instrucciones_pago: 'Bancolombia 123', ventana_cancelacion_horas: 72 },
        });
        const perfil = await Perfiles.perfilDeNegocio(idNegocio);
        ok(perfil.modos.join() === 'ESTANCIA' && !perfil.vistas.includes('/agenda') && perfil.vistas.includes('/ocupacion'),
            'perfil ALOJAMIENTO: solo estancias, sin agenda');
        await Models.ReservaUnidadTipo.update({ estado: 'I' }, { where: { id_negocio: idNegocio } });
        const sembradas = await Catalogo.sembrarUnidades(idNegocio);
        ok(sembradas.unidades === 4, 'catálogo de arranque: 3 tipos, 4 habitaciones', JSON.stringify(sembradas));

        const hoy = Reglas.fechaISOLocal(new Date());
        const d = (n) => Tarifas.sumarDias(hoy, n);
        const disp = await Estancias.disponibilidad(idNegocio, { entrada: hoy, salida: d(2), huespedes: 2 });
        const doble = disp.find((x) => x.nombre === 'Habitación doble');
        ok(doble?.libres === 2 && doble.total > 0, 'la doble tiene 2 libres y precio', JSON.stringify({ libres: doble?.libres, total: doble?.total }));

        const e1 = await Estancias.crear({
            idNegocio, idUnidadTipo: doble.id_unidad_tipo, entrada: hoy, salida: d(2), huespedes: 2,
            clienteNombre: `${MARCA} Huésped 1`, clienteTelefono: '3001113311',
            comprobantePath: '/uploads/reserva/comprobantes/verif.png',
        });
        ok(Number(e1.monto_abono) === Math.round(e1.monto_total / 2) && e1.pago_estado === 'pendiente_validacion',
            'anticipo del 50 % pendiente de validar');
        await Estancias.crear({
            idNegocio, idUnidadTipo: doble.id_unidad_tipo, entrada: d(1), salida: d(3), huespedes: 1,
            clienteNombre: `${MARCA} Huésped 2`, creadoPorIdUsuario: USUARIO,
        });
        await falla(Estancias.crear({
            idNegocio, idUnidadTipo: doble.id_unidad_tipo, entrada: d(1), salida: d(2), huespedes: 1,
            clienteNombre: `${MARCA} Sobrecupo`, creadoPorIdUsuario: USUARIO,
        }), 'UNIDAD_NO_DISPONIBLE', 'sin más dobles libres, no hay sobreventa');

        let sobrecupoBase = false;
        try {
            // En su propio savepoint: el error de la base abortaría la transacción externa.
            await sequelize.transaction(() => Models.ReservaEstancia.create({
                id_negocio: idNegocio, id_unidad: e1.id_unidad, id_unidad_tipo: e1.id_unidad_tipo,
                fecha_entrada: d(1), fecha_salida: d(2), cliente_nombre: `${MARCA} Directo`, codigo_publico: 'VERIFX01',
            }));
        } catch (err) {
            sobrecupoBase = (err.original?.code || err.parent?.code) === '23P01';
        }
        ok(sobrecupoBase, 'y la base rechaza la sobreventa aunque se salte el servicio');

        await Estancias.aprobarPago(idNegocio, e1.id_estancia, { idMetodoPago: idMetodo, idUsuario: USUARIO });
        await Estancias.agregarCargo(idNegocio, e1.id_estancia, { concepto: 'Minibar', valor: 20000, idUsuario: USUARIO });
        await Estancias.checkin(idNegocio, e1.id_estancia);
        const antes = await Estancias.getById(idNegocio, e1.id_estancia);
        ok(antes.estado === 'en_curso' && antes.saldo === antes.total - Number(e1.monto_abono),
            'llegada registrada; saldo = total + cargos − anticipo', JSON.stringify({ total: antes.total, saldo: antes.saldo }));
        await falla(Estancias.checkout(idNegocio, e1.id_estancia, { pagos: [{ id_metodo_pago: idMetodo, valor: 1 }], idUsuario: USUARIO }),
            'PAGO_NO_CUADRA', 'no sale debiendo');
        const fin = await Estancias.checkout(idNegocio, e1.id_estancia, { idMetodoPago: idMetodo, idUsuario: USUARIO });
        ok(fin.estado === 'finalizada' && fin.saldo === 0 && fin.pagado === fin.total, 'salida con saldo en cero; la caja tiene el total');

        // iCal: una reserva de Airbnb bloquea la suite.
        const suite = disp.find((x) => x.nombre === 'Suite');
        const idSuite = suite.unidades_libres[0].id_unidad;
        const cal = await Models.ReservaCalendarioExterno.create({
            id_negocio: idNegocio, id_unidad: idSuite, nombre: 'Airbnb', url_ical: 'https://example.invalid/cal.ics',
        });
        const ics = `BEGIN:VCALENDAR\nBEGIN:VEVENT\nDTSTART;VALUE=DATE:${d(5).replace(/-/g, '')}\nDTEND;VALUE=DATE:${d(7).replace(/-/g, '')}\nUID:verif-1@airbnb\nSUMMARY:Reserved\nEND:VEVENT\nEND:VCALENDAR`;
        const sync = await Ical.sincronizarCalendario(cal, { texto: ics });
        ok(sync.creados === 1, 'importa la reserva de Airbnb como bloqueo', JSON.stringify(sync));
        const tras = await Estancias.disponibilidad(idNegocio, { entrada: d(5), salida: d(6), huespedes: 2 });
        ok(tras.find((x) => x.nombre === 'Suite').libres === 0, 'la suite ya no se ofrece esas noches');
        const vacio = await Ical.sincronizarCalendario(cal, { texto: 'BEGIN:VCALENDAR\nEND:VCALENDAR' });
        ok(vacio.eliminados === 1, 'si Airbnb la cancela, se libera aquí');

        const unidadSuite = await Models.ReservaUnidad.findByPk(idSuite);
        await Estancias.crear({
            idNegocio, idUnidadTipo: suite.id_unidad_tipo, entrada: d(10), salida: d(12), huespedes: 2,
            clienteNombre: `${MARCA} Para exportar`, creadoPorIdUsuario: USUARIO,
        });
        const exp = await Ical.exportar(unidadSuite.ical_token);
        ok(exp.ics.includes(`DTSTART;VALUE=DATE:${d(10).replace(/-/g, '')}`) && !exp.ics.includes(MARCA),
            'el calendario exportado trae la estancia sin datos del huésped');

        const cancelable = await Estancias.crear({
            idNegocio, idUnidadTipo: suite.id_unidad_tipo, entrada: d(20), salida: d(22), huespedes: 2,
            clienteNombre: `${MARCA} Cancela`, clienteTelefono: '3001113322', comprobantePath: '/x.png',
        });
        const cancelada = await Estancias.cancelarPorCliente(cancelable.codigo_publico, 'cambio de planes');
        ok(cancelada.estado === 'cancelada', 'el huésped cancela desde «Mi reserva» dentro del plazo');

        const inf = await Estancias.informe(idNegocio, { desde: hoy, hasta: d(3) });
        ok(inf.noches_vendidas === 4 && inf.ocupacion_pct > 0, 'el informe cuenta las noches vendidas', JSON.stringify(inf));
    }
}

async function main() {
    const idNegocio = Number(process.argv[2] || process.env.VERIFICAR_ID_NEGOCIO || 4);
    console.log(`\n=== Verificación de perfiles de reserva — negocio ${idNegocio}, fecha ${FECHA} ===`);
    console.log('    (todo se revierte al terminar)');
    externa = await transaccionReal();
    try {
        await als.run(new Map([['transaction', externa]]), () => escenarios(idNegocio));
    } catch (err) {
        fallos += 1;
        console.log(`\n   ✗ Error inesperado: ${err.code || ''} ${err.message}`);
        console.log(err.stack.split('\n').slice(1, 6).join('\n'));
    } finally {
        await externa.rollback();
        await sequelize.close();
    }
    console.log(`\n${fallos === 0 ? '✓' : '✗'} ${pasos - fallos}/${pasos} comprobaciones correctas. Nada quedó escrito.\n`);
    process.exitCode = fallos === 0 ? 0 : 1;
}

main();
