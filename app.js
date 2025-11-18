require('dotenv').config();
const express = require('express');
const cors = require('cors');
const conection = require('./app_core/models/conection');
const adminRoutes = require('./app_admin_api/routes/index');
const sequelize = conection.sequelize;

const app = express();
const PORT = process.env.PORT || 3000;

// Middlewares
app.use(cors());
app.use(express.json());

// Rutas
app.use('/admin', adminRoutes);

// Ruta base
app.get('/', (req, res) => {
  res.send('✅ Web Service funcionando correctamente');
});

// Conexión y arranque del servidor
(async () => {
  try {
    await sequelize.authenticate();
    console.log('🟢 Conectado correctamente a la base de datos');

    // Sincroniza los modelos (crea tablas si no existen)
    // await sequelize.sync();

    app.listen(PORT, () => {
      console.log(`🚀 Servidor corriendo en: http://localhost:${PORT}`);
    });
  } catch (error) {
    console.error('❌ Error al iniciar el servidor:', error);
  }
})();