module.exports = (sequelize, DataTypes) => {
    const GenerAvisoPlanEnviado = sequelize.define('GenerAvisoPlanEnviado', {
        id_aviso: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },
        id_negocio_plan: { type: DataTypes.INTEGER, allowNull: false },
        tipo_aviso: { type: DataTypes.STRING(20), allowNull: false },
        fecha_envio: { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
        email_enviado: { type: DataTypes.BOOLEAN, defaultValue: false },
        notificacion_creada: { type: DataTypes.BOOLEAN, defaultValue: false }
    }, {
        tableName: 'gener_aviso_plan_enviado',
        schema: 'general',
        timestamps: false
    });

    GenerAvisoPlanEnviado.associate = (models) => {
        GenerAvisoPlanEnviado.belongsTo(models.GenerNegocioPlan, {
            foreignKey: 'id_negocio_plan'
        });
    };

    return GenerAvisoPlanEnviado;
};
