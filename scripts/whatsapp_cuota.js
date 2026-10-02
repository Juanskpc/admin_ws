/**
 * Cuánto lleva gastado cada número de WhatsApp este mes, y cuántos mensajes cuesta una cita.
 *
 * Desde el 1 de octubre de 2026 Meta cobra los *service messages* pasada la asignación mensual de
 * cada número. Esto es la respuesta a «¿vamos bien?» sin esperar al aviso automático
 * (`intelligence/avisos/cuotaWhatsapp.js`) ni, peor, a la factura.
 *
 *   node scripts/whatsapp_cuota.js              # todos los números
 *   node scripts/whatsapp_cuota.js --negocio 10 # uno, con su gasto por cita
 *   node scripts/whatsapp_cuota.js --dias 7     # la media de la última semana
 *
 * Ojo con **qué base** está en el `.env`: la cuenta sale de `intelligence.mensaje`, así que en
 * local cuenta los mensajes de local. Para ver producción hay que correrlo por SSH en el VPS.
 */
'use strict';
require('dotenv').config();

const cuota = require('../intelligence/channels/whatsapp/cuota');
const Models = require('../app_core/models/conection');

function argumento(nombre, porDefecto = null) {
    const i = process.argv.indexOf(`--${nombre}`);
    return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : porDefecto;
}

/** Una barra de progreso de veinte caracteres. Un porcentaje se lee; una barra se ve. */
function barra(porcentaje) {
    const llenos = Math.min(20, Math.round(porcentaje * 20));
    return `[${'#'.repeat(llenos)}${'.'.repeat(20 - llenos)}]`;
}

async function main() {
    const idNegocio = argumento('negocio');
    const dias = Number(argumento('dias', 30));

    const consumos = await cuota.consumoDelMes();
    const filtrados = idNegocio
        ? consumos.filter((c) => c.id_negocio === Number(idNegocio))
        : consumos;

    if (filtrados.length === 0) {
        console.log(
            idNegocio
                ? `El negocio ${idNegocio} no tiene número de WhatsApp activo en platform.numero_canal.`
                : 'No hay ningún número de WhatsApp activo en platform.numero_canal.'
        );
        return;
    }

    console.log(`\nCuota de WhatsApp del mes — ${cuota.ASIGNACION_MENSUAL} mensajes de servicio gratis por número\n`);
    for (const c of filtrados) {
        const pct = Math.round(c.porcentaje * 100);
        console.log(
            `  ${String(c.id_negocio).padStart(3)} ${String(c.negocio).padEnd(24)} ` +
                `${barra(c.porcentaje)} ${String(c.servicio).padStart(4)}/${c.asignacion} (${pct}%)  ` +
                `quedan ${c.restantes}` +
                (c.plantilla ? `  ·  ${c.plantilla} plantillas (se cobran aparte)` : '')
        );
    }

    // El gasto por cita es LA métrica para decidir si el flujo está apretado: la asignación
    // partida por esto es cuántas citas al mes entran gratis.
    const porCita = await cuota.mensajesPorCita({ idNegocio: idNegocio ? Number(idNegocio) : null, dias });
    console.log(`\nMensajes por cita agendada (últimos ${dias} días)`);
    if (porCita.conversaciones === 0) {
        console.log('  Todavía no hay citas agendadas por el asistente en ese periodo.');
    } else {
        console.log(
            `  ${porCita.conversaciones} conversaciones con cita  ·  ` +
                `media ${porCita.promedio} mensajes  ·  la peor ${porCita.peor}  ·  ` +
                `caben ~${porCita.citasGratisAlMes} citas/mes dentro de lo gratis`
        );
    }
    console.log('');
}

main()
    .catch((error) => {
        console.error(`\nNo se pudo leer la cuota: ${error.message}\n`);
        process.exitCode = 1;
    })
    .finally(() => Models.sequelize.close());
