module.exports = (sequelize, DataTypes) => {
    const GenerDepartamento = sequelize.define(
        'GenerDepartamento',
        {
            codigo: { type: DataTypes.CHAR(2), primaryKey: true },
            nombre: { type: DataTypes.STRING(100), allowNull: false },
        },
        {
            tableName: 'gener_departamento',
            schema: 'general',
            timestamps: false,
        }
    );

    return GenerDepartamento;
};
