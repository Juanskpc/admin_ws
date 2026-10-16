/**
 * Direcciones, barrios, pagos y teléfonos escritos COMO LOS ESCRIBEN los clientes por WhatsApp.
 *
 * Inventados: ningún nombre, número ni dirección es de un cliente. El estilo sale de leer (solo
 * lectura, 2026-10-16) los ~4.400 mensajes de clientes de Zona Burger desde el 2026-10-01:
 * abreviaturas (cra, cll, mz, cs, b/), el barrio pegado al final sin la palabra «barrio», números
 * donde el catálogo pone romanos («quito lopez 3» por «Quito López III»), puntos y barras en medio
 * («el.Prado», «B/la florida»), erratas («Bsrrio»), y lugares de referencia que se parecen a un
 * barrio («frente al centro comercial», «atrás de san Andresito»).
 *
 * `barrio` es el nombre exacto del catálogo de Pasto que se espera, o `null` cuando lo correcto es
 * NO elegir (no lo dice, es ambiguo o es un conjunto que no está): con `null` el domicilio entra en
 * $0 y el cajero lo ajusta, que es mejor que cobrar el de otro barrio.
 */
'use strict';

const DIRECCIONES = [
    // ── El barrio al final, sin la palabra «barrio» ─────────────────────────────────
    ['Carrera 19, calle 27- 84 alameda', 'Alameda'],
    ['Cra 37#12-109 la castellana 3000000001', 'La Castellana'],
    ['A domicilio, vivo a una cuadra, cra 24 #29-64 el calvario, cuánto sería?', 'El Calvario'],
    ['Calle24#18-88 barrio centenario', 'Centenario'],
    ['Carrera 9 #16a-39 Fátima', 'Fátima'],
    ['Calle 19 # 1 - 61 el tejar 3000000002', 'El Tejar'],
    ['cra 40a #17A-15 el dorado por la Kia al costado', 'El Dorado'],
    ['Cra 20c 9-10 Atahualpa Pedro Pérez 3000000003 Transferencia', 'Atahualpa'],
    ['Manzana C5 casa 23 Nueva Aranda', 'Nueva Aranda'],
    ['Mz D7 casa 24 nueva aranda 3000000004', 'Nueva Aranda'],
    ['A la manzana d9 casa 11 nueva aranda pago en efectivo', 'Nueva Aranda'],
    ['Calle 16A n 43_61. La colina', 'La Colina'],
    ['La colina, calle 17 #42-25 3000000005', 'La Colina'],
    // ── Con «barrio», «b/», «brr» y erratas ────────────────────────────────────────
    ['CLL 22 A no. 29-77 barrio libertad', 'Libertad'],
    ['Carrera 15a #10-37 barrio san Miguel', 'San Miguel'],
    ['Cr 16#10-137 barrio san Miguel 3000000006', 'San Miguel'],
    ['Barrio San Miguel la zona de los hoteles en el hotel habitación 401', 'San Miguel'],
    ['Carrera 22 #3 sur 76 barrio bachue', 'Bachue'],
    ['Cra. 42 #17a-116 barrio el dorado', 'El Dorado'],
    ['Manzana G casa 23 barrio madrigal Ana 3000000007 Efectivo', 'Madrigal'],
    ['Calle 26 g número 23 20 barrio la lomita', 'La Lomita'],
    ['Cel 3000000008 Dirección Calle 29 #22-44 manzana H casa 4 piso 1 BARRIO LA LOMITA', 'La Lomita'],
    ['Calle 16 a 34bis 26A barrio Paraná edificio Monte rey pago en efectivo', 'Parana'],
    ['Una salchipapa Calle 16A #34bis-32 barrio parana edificio montebello apartamento 503', 'Parana'],
    ['Manzana 26 casa 5 barrio nuevo sol', 'Nuevo Sol'],
    ['barrio nuevo sol manzana 31 casa 8 número 3000000009', 'Nuevo Sol'],
    ['Manzan h casa 2 b/sol de oriente 3000000010', 'Sol De Oriente'],
    ['Mz Q casa 226 barrio Caicedonia Frente al salon comunal', 'Caicedonia'],
    ['Barrio Santa Monica Manzana E casa 124 Pago en efectivo por favor', 'Santa Mónica'],
    ['M c - c 73 b barrio santa Mónica 3000000011', 'Santa Mónica'],
    ['Mz 2 casa 4-61 barrio cantarana alto 3000000012', 'Cantarana'],
    ['Carrera 31b#20-95 barrio las cuadras una casa esquinera abajo del parqueadero las cuadras', 'Las Cuadras'],
    ['Carrera 22a N 9-35 barrio Santiago es por colchones bella luna', 'Santiago'],
    ['Calle 22#17B-48 avenida Colombia Teléfono:3000000013', 'Avenida Colombia'],
    ['manzana 3 casa 12 barrio agualongo, primer piso', 'Agualongo'],
    ['Mz C CASA 2 BARRIO SIMÓN BOLÍVAR', 'Simón Bolívar'],
    ['Carrera 40 #14-25 Barrio las margaritas 3000000014', 'Las Margaritas'],
    ['Ciudadela invipaz barrio San carlos, frente al mirador queda', 'San Carlos'],
    ['Mi nombre es Pedro Bsrrio el PILAR AL LADO DEL LAVADERO ANTES DE LLEGAR A LA PRINCIPAL', 'El Pilar'],
    ['Dirección: B/la florida', 'La Florida'],
    ['M5 C16 B/Corazon de Jesús', 'Corazón De Jesús'],
    ['Barrio corazón de Jesús manzana 14 casa 7 Pedro 3000000015 Efectivo', 'Corazón De Jesús'],
    ['Mz 1 cs 24, Corazón de jesus. Indicaciones: Subir al segundo piso por favor', 'Corazón De Jesús'],
    ['Cra 44 B #19 barrio pandiaco', 'Pandiaco'],
    ['Domicilio Crra 38 #19-34 Palermo 3000000016 Pago por nequi', 'Palermo'],
    ['carrera 2 # 21d-28 mercedario', 'Mercedario'],
    ['Udenar - Torobajo 205', 'Torobajo'],
    // ── Puntuación pegada ───────────────────────────────────────────────────────────
    ['Calle 21a N 18 38 barrio el.Prado, al respaldo de la droguería de la Av Colombia.', 'El Prado'],
    // ── Números donde el catálogo pone romanos ──────────────────────────────────────
    ['Cra 13 #1-11 barrio quito López 3', 'Quito López III'],
    ['Domicilio Manzana B casa 2 barrio quito López dos', 'Quito López II'],
    ['Mz39 casa 7 chambu 2', 'Chambú II'],
    ['Manzana 4 casa 19 tamasagra 1 3000000017', 'Tamasagra I'],
    ['Alameda 2 casa 14', 'Alameda II'],
    ['Alameda 2 entrada al barrio común', null], // «El Común» también es barrio (y hay dos): que lo confirme el cajero
    ['Calle 25 # 19-84 frente aquíne alto 2 Ana 3000000018 Efectivo', 'Aquine Alto'],
    // ── Sin artículo, justo después de «barrio» ─────────────────────────────────────
    ['Calle 12f n⁰ 4 -28 barrio pilar 3000000019', 'El Pilar'],
    ['Es para el barrio calvario veci', 'El Calvario'],
    // ── Dos lugares: gana el que va después de «barrio» ─────────────────────────────
    ['Cra 22a#14-63 barrio centro atrás de san Andresito', 'Centro'],
    ['Cra 8 Este #16 - 31 Barrio Praga, sector Altos del lorenzo', 'Praga'],
    // ── Lo correcto es NO elegir ────────────────────────────────────────────────────
    ['Mz 3 casa 4 frente al centro comercial', null], // «centro» es un lugar, no el barrio
    ['Calle 18 # 20-30 cerca al centro de salud', null],
    ['Mirador de aquine, torre 2 apto 602', null], // un conjunto: «aquine» solo no es un barrio
    ['Barrio Santa Fe CRA3E#18B37', null], // Santa Fe I o II: que lo diga
    ['Calle 22#29-77 apartamento 2 libertad por Aranda', null], // dos barrios, ninguno marcado
    ['Torres de Tundama apto 305', null],
    ['MZ 3 CS 4 bueno aires por la cárcel', null], // errata: no se adivina
    ['Av. Julian Buchelly #17-32', null], // calle, y escrita distinto al barrio
    ['Hotel jardín suite calle 22#1a 53-53', null],
    ['Conjunto residencial remansos del norte manzana B casa 8', null], // nombre de conjunto: no se da por barrio
    // ── Conjuntos, torres y hoteles con nombre de barrio: no dicen que estén en él ──────
    ['Torres de san Luis torre 10 apt 205', null], // San Luis es una vereda de La Laguna
    ['Condominio mirador de San Andrés torre 2 apto 1395', null],
    ['Hotel casa madrigal', null],
    ['Picada Torres de Fátima apartamento 314', null],
    ['Hotel hierbabuena cra 36 #18- 104 barrio Palermo', 'Palermo'], // con «barrio» sí
    ['Dirección cercana: Hotel del parque, Barrio Venecia, Cra. 7 #17-1', 'Venecia'],
    ['Carrera 40 #14-25 Barrio las palmeras del oriente', null], // no está en el catálogo
    ['Por definir', null],
    ['', null],
];

/** El barrio que el cliente escribe en el formulario («Barrio:»): corto, a su manera. */
const BARRIOS_DEL_FORMULARIO = [
    ['Betania', 'Betania'],
    ['betania', 'Betania'],
    ['barrio betania', 'Betania'],
    ['B/ Betania', 'Betania'],
    ['Corazón de jesus', 'Corazón De Jesús'],
    ['corazon de jesus 2', 'Corazón De Jesús II'],
    ['Quito Lopez 3', 'Quito López III'],
    ['quito lopez tres', 'Quito López III'],
    ['chambu 1', 'Chambú I'],
    ['Pilar', 'El Pilar'],
    ['el pilar', 'El Pilar'],
    ['Torobajo', 'Torobajo'],
    ['Las cuadras', 'Las Cuadras'],
    ['Simon bolivar', 'Simón Bolívar'],
    ['Avenida colombia', 'Avenida Colombia'],
    ['Centro', 'Centro'],
];

/** Cómo dicen la forma de pago (o que van a pagar), en mensajes del pedido en curso. */
const DICE_EL_PAGO = [
    'Pago por nequi',
    'Voy a pagar en efectivo',
    'Pero si voy a. Pagar en efectivo al recibir',
    'Todo por transferencia',
    'puedo pagar por llave bre-b?',
    'Se cancela por Nequi',
    'Te cancelo por Nequi de una vez',
    'Al domiciliario le cancelo todo entonces',
    'Nequi contra entrega',
    'Pago con uno de 50 mil',
    'Cancelo con un billete de 100',
    'El pago es físico o por transferencia?',
    'Pedro 3000000020 Efectivo',
    '💳 Medio de pago: *pago por nequi*',
    'porfa es que pago es con tarjeta',
];

/** Teléfonos como los escriben, con el número que se espera leer. */
const TELEFONOS = [
    ['3001234567', '3001234567'],
    ['300 123 4567', '3001234567'],
    ['300-123-4567', '3001234567'],
    ['+573001234567', '3001234567'],
    ['+57 300 123 4567', '3001234567'],
    ['3001234567/3109876543', '3001234567'],
    ['Cel 3001234567', '3001234567'],
];

module.exports = { DIRECCIONES, BARRIOS_DEL_FORMULARIO, DICE_EL_PAGO, TELEFONOS };
