/**
 * Reglas de reserva en minutos (2026-09-29): valores por defecto de un negocio nuevo, el espejo
 * en horas que mantiene vivo el backend anterior, y cómo se leen las duraciones al cliente.
 * Sin base de datos: el hook del modelo se ejecuta a mano sobre instancias construidas.
 */
'use strict';

const { Sequelize, DataTypes } = require('sequelize');
const definirConfig = require('../../app_core/models/reserva.reserva_config');
const { duracionLegible } = require('../../app_reserva_api/services/duracionTexto');
const { PERFILES } = require('../../app_reserva_api/perfiles/definiciones');

// Sin conectar: solo se usa para definir el modelo y construir instancias.
const sequelize = new Sequelize('postgres://x:y@localhost:1/z', { logging: false });
const ReservaConfig = definirConfig(sequelize, DataTypes);

test('un negocio nuevo nace con 15 min de anticipación, 0 de limpieza y 60 de ventana', async () => {
    const cfg = ReservaConfig.build({ id_negocio: 1 });
    await ReservaConfig.runHooks('beforeSave', cfg, {});
    expect(cfg.anticipacion_min_minutos).toBe(15);
    expect(cfg.buffer_limpieza_min).toBe(0);
    expect(cfg.ventana_cancelacion_min).toBe(60);
    // El espejo en horas se redondea hacia arriba: el backend viejo nunca es más permisivo.
    expect(cfg.anticipacion_min_horas).toBe(1);
    expect(cfg.ventana_cancelacion_horas).toBe(1);
    expect(cfg.paso_slot_min).toBe(30);
});

test('guardar en minutos actualiza el espejo en horas', async () => {
    const cfg = ReservaConfig.build({ id_negocio: 1, anticipacion_min_minutos: 90, ventana_cancelacion_min: 120 }, { isNewRecord: false });
    cfg.changed('anticipacion_min_minutos', true);
    cfg.changed('ventana_cancelacion_min', true);
    await ReservaConfig.runHooks('beforeSave', cfg, {});
    expect(cfg.anticipacion_min_horas).toBe(2);
    expect(cfg.ventana_cancelacion_horas).toBe(2);
});

test('un script viejo que escribe en horas se traduce a minutos', async () => {
    const cfg = ReservaConfig.build({ id_negocio: 1, anticipacion_min_horas: 3 }, { isNewRecord: false });
    cfg.changed('anticipacion_min_horas', true);
    await ReservaConfig.runHooks('beforeSave', cfg, {});
    expect(cfg.anticipacion_min_minutos).toBe(180);
});

test('los perfiles de citas nacen con los mismos valores; el alojamiento conserva sus 72 h', () => {
    for (const perfil of Object.values(PERFILES)) {
        const ini = perfil.config_inicial || {};
        expect(ini.anticipacion_min_horas).toBeUndefined();
        expect(ini.ventana_cancelacion_horas).toBeUndefined();
        if ((perfil.fijas || []).includes('estancias')) {
            expect(ini.ventana_cancelacion_min).toBe(72 * 60);
            continue;
        }
        if (Object.keys(ini).length === 0) continue; // BASE: defaults del modelo
        expect(ini).toMatchObject({ anticipacion_min_minutos: 15, buffer_limpieza_min: 0, ventana_cancelacion_min: 60 });
    }
});

test('las duraciones se escriben como las dice una persona', () => {
    expect(duracionLegible(15)).toBe('15 minutos');
    expect(duracionLegible(1)).toBe('1 minuto');
    expect(duracionLegible(60)).toBe('1 hora');
    expect(duracionLegible(1440)).toBe('24 horas');
    expect(duracionLegible(90)).toBe('1 h 30 min');
    expect(duracionLegible(0)).toBe('0 minutos');
});
