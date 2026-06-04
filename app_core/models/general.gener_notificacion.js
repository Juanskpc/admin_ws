module.exports = (sequelize, DataTypes) => {
    const GenerNotificacion = sequelize.define('GenerNotificacion', {
        id_notificacion: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        id_negocio: { type: DataTypes.INTEGER, allowNull: false },
        tipo: { type: DataTypes.STRING(50), allowNull: false },
        titulo: { type: DataTypes.STRING(255), allowNull: false },
        mensaje: { type: DataTypes.TEXT, allowNull: false },
        leida: { type: DataTypes.BOOLEAN, defaultValue: false },
        fecha_creacion: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
        fecha_lectura: { type: DataTypes.DATE, allowNull: true }
    }, {
        tableName: 'gener_notificacion',
        schema: 'general',
        timestamps: false
    });

    GenerNotificacion.associate = (models) => {
        GenerNotificacion.belongsTo(models.GenerNegocio, {
            foreignKey: 'id_negocio'
        });
    };

    return GenerNotificacion;
};
