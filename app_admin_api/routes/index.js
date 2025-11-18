const express = require('express');
const router = express.Router();
const UsuarioController = require('./../controllers/usuarioController');

router.post('/loginUsuario', UsuarioController.loginUsuario);

module.exports = router;