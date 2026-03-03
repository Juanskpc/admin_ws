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
    logging: false,
  }
);

(async () => {
  try {
    await sequelize.authenticate();

    const [neg] = await sequelize.query(
      `SELECT column_name, data_type, is_nullable 
       FROM information_schema.columns 
       WHERE table_schema='general' AND table_name='gener_negocio' 
       ORDER BY ordinal_position`
    );
    console.log('=== gener_negocio columns ===');
    neg.forEach(c => console.log(`  ${c.column_name} - ${c.data_type} ${c.is_nullable === 'NO' ? 'NOT NULL' : ''}`));

    const [negu] = await sequelize.query(
      `SELECT column_name, data_type, is_nullable 
       FROM information_schema.columns 
       WHERE table_schema='general' AND table_name='gener_negocio_usuario' 
       ORDER BY ordinal_position`
    );
    console.log('\n=== gener_negocio_usuario columns ===');
    negu.forEach(c => console.log(`  ${c.column_name} - ${c.data_type} ${c.is_nullable === 'NO' ? 'NOT NULL' : ''}`));

    const [negData] = await sequelize.query('SELECT * FROM general.gener_negocio LIMIT 10');
    console.log('\n=== Sample gener_negocio ===');
    console.log(JSON.stringify(negData, null, 2));

    const [negUData] = await sequelize.query('SELECT * FROM general.gener_negocio_usuario LIMIT 20');
    console.log('\n=== Sample gener_negocio_usuario ===');
    console.log(JSON.stringify(negUData, null, 2));

    // Also check related tables for tipo_negocio context
    const [tipoNeg] = await sequelize.query('SELECT * FROM general.gener_tipo_negocio ORDER BY id_tipo_negocio');
    console.log('\n=== gener_tipo_negocio ===');
    console.log(JSON.stringify(tipoNeg, null, 2));

  } catch (e) {
    console.error('ERROR:', e.message);
  } finally {
    await sequelize.close();
  }
})();
