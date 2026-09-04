/**
 * Identidad fiscal del negocio (FE-1). Ver docs/facturacion-electronica.md §5.2.
 *
 * Todo es nullable salvo `modo_facturacion`, que nace en 'NINGUNO': un negocio que no factura
 * no tiene que llenar un solo campo de aquí. La validación no vive en el modelo sino en
 * `app_core/facturacion/datosFiscales.js`, y ocurre al ACTIVAR, no al guardar.
 */
module.exports = (sequelize, DataTypes) => {
    const GenerNegocioFiscal = sequelize.define(
        'GenerNegocioFiscal',
        {
            id_negocio: { type: DataTypes.INTEGER, primaryKey: true },

            // 'NINGUNO' | 'POS' | 'COMPLETO'
            modo_facturacion: {
                type: DataTypes.STRING(10),
                allowNull: false,
                defaultValue: 'NINGUNO',
            },

            // 'NO_DECLARADO' | 'SIN_REGISTRO' | 'REGISTRADO'. NO_DECLARADO y SIN_REGISTRO no son
            // lo mismo: al primero hay que preguntarle, al segundo no hay que molestarlo más.
            estado_registro: {
                type: DataTypes.STRING(15),
                allowNull: false,
                defaultValue: 'NO_DECLARADO',
            },

            // Lo declara el cliente. No se deduce: ver §4.2 del documento.
            obligado_a_facturar: DataTypes.BOOLEAN,
            declarado_por: DataTypes.INTEGER,
            declarado_en: DataTypes.DATE,

            // '1' jurídica (siempre obligada) · '2' natural (depende de umbrales)
            tipo_persona: DataTypes.CHAR(1),
            tipo_documento: DataTypes.STRING(2),
            // Solo dígitos, sin puntos, sin guiones y sin el DV.
            numero_documento: DataTypes.STRING(20),
            dv: DataTypes.CHAR(1),

            razon_social: DataTypes.STRING(255),
            nombre_comercial: DataTypes.STRING(255),
            primer_apellido: DataTypes.STRING(100),
            segundo_apellido: DataTypes.STRING(100),
            primer_nombre: DataTypes.STRING(100),
            otros_nombres: DataTypes.STRING(100),

            responsabilidades_fiscales: DataTypes.ARRAY(DataTypes.STRING(20)),
            tributos: DataTypes.ARRAY(DataTypes.STRING(4)),
            responsable_iva: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
            responsable_inc: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
            regimen: DataTypes.STRING(20),
            tipo_contribuyente: DataTypes.STRING(30),
            actividad_ciiu: DataTypes.STRING(10),
            matricula_mercantil: DataTypes.STRING(50),

            direccion_fiscal: DataTypes.STRING(255),
            // Código DANE de 5 dígitos. El catálogo completo llega en FE-2.
            municipio_dane: DataTypes.CHAR(5),
            departamento_dane: DataTypes.CHAR(2),
            pais: { type: DataTypes.CHAR(2), allowNull: false, defaultValue: 'CO' },
            codigo_postal: DataTypes.STRING(10),

            correo_facturacion: DataTypes.STRING(255),
            telefono_facturacion: DataTypes.STRING(30),

            creado_en: DataTypes.DATE,
            actualizado_en: DataTypes.DATE,
        },
        {
            tableName: 'gener_negocio_fiscal',
            schema: 'general',
            timestamps: false,
        }
    );

    GenerNegocioFiscal.associate = (models) => {
        GenerNegocioFiscal.belongsTo(models.GenerNegocio, {
            foreignKey: 'id_negocio',
            as: 'negocio',
        });
        GenerNegocioFiscal.belongsTo(models.GenerDepartamento, {
            foreignKey: 'departamento_dane',
            targetKey: 'codigo',
            as: 'departamento',
        });
    };

    return GenerNegocioFiscal;
};
