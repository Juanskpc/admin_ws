const { Sequelize } = require('sequelize');
require('dotenv').config();

const sequelize = new Sequelize(
  process.env.DB_NAME,
  process.env.DB_USER,
  process.env.DB_PASS,
  {
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    dialect: 'postgres',
    dialectOptions: { ssl: { require: true, rejectUnauthorized: false } },
    logging: console.log,
  }
);

/**
 * Tipos de vehículos comunes para parqueaderos
 * Se insertarán para el negocio con id_negocio = 2 (PARKIN CR - PARQUEADERO)
 */
const tiposVehiculo = [
  {
    nombre: 'Automóvil',
    descripcion: 'Vehículos de pasajeros (autos, sedanes, SUVs compactos)',
    id_negocio: 2,
  },
  {
    nombre: 'Motocicleta',
    descripcion: 'Motos, motocicletas y ciclomotores',
    id_negocio: 2,
  },
  {
    nombre: 'Bicicleta',
    descripcion: 'Bicicletas y ciclos',
    id_negocio: 2,
  },
  {
    nombre: 'Camioneta',
    descripcion: 'Camionetas, pickups y vehículos tipo SUV grandes',
    id_negocio: 2,
  },
  {
    nombre: 'Camión',
    descripcion: 'Camiones de carga y vehículos comerciales pesados',
    id_negocio: 2,
  },
  {
    nombre: 'Minibús',
    descripcion: 'Minibuses, microbuses y vans de pasajeros',
    id_negocio: 2,
  },
  {
    nombre: 'Bus',
    descripcion: 'Buses de transporte público y autobuses',
    id_negocio: 2,
  },
];

(async () => {
  try {
    await sequelize.authenticate();
    console.log('✅ Conectado a la base de datos');

    const [count] = await sequelize.query(
      `SELECT COUNT(*) FROM parqueadero.parq_tipo_vehiculo WHERE id_negocio = 2`
    );
    const existentes = count[0].count;

    if (existentes > 0) {
      console.log(`⚠️  Ya existen ${existentes} tipos de vehículos para el negocio 2`);
      console.log('Procediendo con inserción (puede crear duplicados si existen)...\n');
    }

    // Insertar cada tipo
    for (const tipo of tiposVehiculo) {
      await sequelize.query(
        `INSERT INTO parqueadero.parq_tipo_vehiculo 
         (nombre, descripcion, id_negocio, estado, fecha_creacion)
         VALUES ($1, $2, $3, $4, NOW())`,
        {
          bind: [tipo.nombre, tipo.descripcion, tipo.id_negocio, 'A'],
          type: Sequelize.QueryTypes.INSERT,
        }
      );
      console.log(`✅ Insertado: ${tipo.nombre}`);
    }

    const [finalCount] = await sequelize.query(
      `SELECT COUNT(*) FROM parqueadero.parq_tipo_vehiculo WHERE id_negocio = 2`
    );
    console.log(`\n✅ Total de tipos de vehículos para negocio 2: ${finalCount[0].count}`);

    // Mostrar todos los tipos insertados
    const [tipos] = await sequelize.query(
      `SELECT id_tipo_vehiculo, nombre, descripcion, estado, fecha_creacion
       FROM parqueadero.parq_tipo_vehiculo
       WHERE id_negocio = 2
       ORDER BY id_tipo_vehiculo ASC`,
      { type: Sequelize.QueryTypes.SELECT }
    );

    console.log('\n📋 Tipos de vehículos registrados:');
    console.table(tipos);

  } catch (error) {
    console.error('❌ Error:', error.message);
  } finally {
    await sequelize.close();
  }
})();
