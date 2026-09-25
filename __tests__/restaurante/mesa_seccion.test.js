/**
 * La sección de una mesa («Piso 1», «Patio», «Terraza»…): texto libre y opcional con el que el
 * administrador agrupa su salón.
 *
 * Lo que hay que sostener:
 *  1. Una mesa nueva puede llevar sección, y sin ella queda en NULL (el salón se ve como siempre).
 *  2. Editar SIN mandar la clave no la toca — editar el nombre no puede borrar la sección.
 *  3. Mandarla vacía la quita (NULL), no la deja como cadena vacía.
 *  4. El tablero (`dashboard`) y la lista para el POS la devuelven.
 *
 * Corre contra la base de verdad y borra lo que crea.
 */
'use strict';

require('dotenv').config();

const Models = require('../../app_core/models/conection');
const mesaService = require('../../app_restaurante_api/services/mesaService');

const sequelize = Models.sequelize;
const creadas = [];
let idNegocio;

async function crear(datos) {
    const mesa = await mesaService.crearMesa({ idNegocio, nombre: 'Mesa prueba sección', ...datos });
    creadas.push(mesa.id_mesa);
    return mesa;
}

beforeAll(async () => {
    const [negocio] = await sequelize.query(
        `SELECT id_negocio FROM general.gener_negocio ORDER BY id_negocio LIMIT 1`,
        { type: sequelize.QueryTypes.SELECT },
    );
    idNegocio = negocio.id_negocio;
});

afterAll(async () => {
    if (creadas.length > 0) {
        await Models.RestMesa.destroy({ where: { id_mesa: creadas } });
    }
    await sequelize.close();
});

describe('sección de la mesa', () => {
    it('una mesa nueva puede llevar sección, y sin ella queda en NULL', async () => {
        const con = await crear({ seccion: 'Piso 1' });
        const sin = await crear({});
        expect(con.seccion).toBe('Piso 1');
        expect(sin.seccion).toBeNull();
    });

    it('editar SIN mandar la sección no la toca', async () => {
        const mesa = await crear({ seccion: 'Patio' });
        const editada = await mesaService.actualizarMesa(mesa.id_mesa, { nombre: 'Mesa renombrada' });
        expect(editada.nombre).toBe('Mesa renombrada');
        expect(editada.seccion).toBe('Patio');
    });

    it('cambiarla la cambia, y mandarla vacía la quita (NULL, no cadena vacía)', async () => {
        const mesa = await crear({ seccion: 'Piso 1' });

        const movida = await mesaService.actualizarMesa(mesa.id_mesa, { seccion: 'Terraza' });
        expect(movida.seccion).toBe('Terraza');

        const quitada = await mesaService.actualizarMesa(mesa.id_mesa, { seccion: '' });
        expect(quitada.seccion).toBeNull();
    });

    it('el tablero y la lista del POS la devuelven', async () => {
        const mesa = await crear({ seccion: 'Piso 2' });

        const tablero = await mesaService.getMesasDashboard(idNegocio);
        expect(tablero.find((m) => m.id_mesa === mesa.id_mesa)?.seccion).toBe('Piso 2');

        const lista = await mesaService.getMesas(idNegocio);
        expect(lista.find((m) => m.id_mesa === mesa.id_mesa)?.seccion).toBe('Piso 2');
    });
});
