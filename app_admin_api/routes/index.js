const express = require('express');
const router = express.Router();
const UsuarioController = require('./../controllers/usuarioController');

router.post('/loginUsuario', UsuarioController.loginUsuario);
router.post('/createUsuario', UsuarioController.createUsuario);
router.get('/getListaRoles', UsuarioController.getListaRoles);

module.exports = router;