/**
 * Crea una conversación con la ventana de 24 h ABIERTA, para poder probar la Bandeja.
 *
 * ## Por qué hace falta
 *
 * La Bandeja solo deja escribir dentro de las 24 h siguientes al último mensaje de la persona —
 * es la regla de Meta, no una decisión nuestra. En una base de desarrollo, donde las
 * conversaciones se crearon hace días, **eso significa que el cuadro de texto no aparece nunca**
 * y la pantalla parece rota cuando en realidad está haciendo lo correcto.
 *
 * Este script deja una conversación con un entrante de hace unos minutos, que es lo único que
 * hace falta para que la Bandeja se pueda ejercitar entera: leer el hilo, responder, ver el
 * mensaje quedar en `pendiente` y la conversación pasar a `handoff_humano`.
 *
 * ## Uso
 *
 *   node scripts/bandeja_conversacion_prueba.js <id_negocio> [nombre]
 *
 * Imprime contra qué base va a escribir ANTES de hacerlo. Míralo: `DB_PORT=5433` es la base
 * compartida del VPS y ahí está trabajando la otra persona.
 *
 * No toca producción ni manda nada por WhatsApp: escribe dos filas en `intelligence`.
 */
'use strict';
require('dotenv').config();

const Models = require('../app_core/models/conection');

const sequelize = Models.sequelize;
const SELECT = { type: sequelize.QueryTypes.SELECT };

async function main() {
    const idNegocio = Number(process.argv[2]);
    const nombre = process.argv[3] || 'Cliente de prueba';

    if (!Number.isInteger(idNegocio) || idNegocio <= 0) {
        console.error('Uso: node scripts/bandeja_conversacion_prueba.js <id_negocio> [nombre]');
        process.exit(1);
    }

    console.log(
        `Base: ${process.env.DB_NAME} en ${process.env.DB_HOST}:${process.env.DB_PORT}` +
            (process.env.DB_PORT === '5433' ? '  ⚠️  ES LA COMPARTIDA DEL VPS' : '')
    );

    const [negocio] = await sequelize.query(
        `SELECT id_negocio, nombre FROM general.gener_negocio WHERE id_negocio = :id;`,
        { replacements: { id: idNegocio }, ...SELECT }
    );
    if (!negocio) {
        console.error(`No existe el negocio ${idNegocio}.`);
        process.exit(1);
    }

    // Un teléfono distinto en cada ejecución: si se repitiera, se reabriría la conversación
    // anterior —que puede estar ya en handoff— y no se probaría el camino completo.
    const telefono = `57300${String(Date.now()).slice(-7)}`;

    const t = await sequelize.transaction();
    try {
        const [conversacion] = await sequelize.query(
            `
            INSERT INTO intelligence.conversacion (id_negocio, canal, id_externo, estado, ultimo_mensaje_en)
            VALUES (:idNegocio, 'whatsapp', :telefono, 'activa', now())
            RETURNING id_conversacion;
            `,
            { replacements: { idNegocio, telefono }, transaction: t, ...SELECT }
        );

        await sequelize.query(
            `
            INSERT INTO intelligence.mensaje
                (id_conversacion, id_negocio, direccion, canal, contenido, enviado_en, creado_en)
            VALUES (:id, :idNegocio, 'entrante', 'whatsapp', :texto, now(), now());
            `,
            {
                replacements: {
                    id: conversacion.id_conversacion,
                    idNegocio,
                    texto: `Hola, soy ${nombre}. Tengo una duda que el bot no supo resolver.`,
                },
                transaction: t,
            }
        );

        await t.commit();

        console.log(`\n✓ Conversación creada en «${negocio.nombre}»`);
        console.log(`  teléfono: ${telefono}`);
        console.log(`  ventana:  abierta durante las próximas 24 h`);
        console.log(`\nAbre /admin/bandeja y debería salir la primera de la lista.`);
    } catch (error) {
        await t.rollback();
        throw error;
    }
}

main()
    .then(() => sequelize.close())
    .catch(async (error) => {
        console.error('Falló:', error.message);
        await sequelize.close();
        process.exit(1);
    });
