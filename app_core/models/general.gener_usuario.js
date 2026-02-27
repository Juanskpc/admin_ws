const bcrypt = require('bcrypt');

module.exports = (sequelize, DataTypes) => {
    const GenerUsuario = sequelize.define('GenerUsuario', {
        id_usuario: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        primer_nombre: { type: DataTypes.STRING(100), allowNull: false },
        segundo_nombre: DataTypes.STRING(100),
        primer_apellido: { type: DataTypes.STRING(100), allowNull: false },
        segundo_apellido: DataTypes.STRING(100),
        num_identificacion: { type: DataTypes.STRING(50), allowNull: false, unique: true },
        telefono: DataTypes.STRING(50),
        email: { type: DataTypes.STRING(255), unique: true, allowNull: false },
        password: { type: DataTypes.STRING(255), allowNull: false },
        fecha_nacimiento: DataTypes.DATEONLY,
        estado: {
            type: DataTypes.CHAR(1),
            defaultValue: 'A',
            validate: { isIn: [['A', 'I']] }
        },
        fecha_creacion: { type: DataTypes.DATE, defaultValue: DataTypes.NOW }
    }, {
        tableName: 'gener_usuario',
        schema: 'general',
        timestamps: false
    });

    // Hook: hashear contraseña automáticamente al crear usuario
    GenerUsuario.beforeCreate(async (usuario) => {
        if (usuario.password) {
            const salt = await bcrypt.genSalt(12);
            usuario.password = await bcrypt.hash(usuario.password, salt);
        }
    });

    // Hook: hashear contraseña si se actualiza
    GenerUsuario.beforeUpdate(async (usuario) => {
        if (usuario.changed('password')) {
            const salt = await bcrypt.genSalt(12);
            usuario.password = await bcrypt.hash(usuario.password, salt);
        }
    });

    GenerUsuario.associate = (models) => {
        GenerUsuario.hasMany(models.GenerNegocioUsuario, {
            foreignKey: 'id_usuario',
            as: 'negociosUsuario'
        });

        GenerUsuario.hasMany(models.GenerUsuarioRol, {
            foreignKey: 'id_usuario',
            as: 'roles'
        });

        GenerUsuario.hasMany(models.GenerNivelUsuario, {
            foreignKey: 'id_usuario'
        });
    };

    return GenerUsuario;
};
