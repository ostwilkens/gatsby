"use strict";

const _ = require(`lodash`);

const {
  ObjectTypeComposer
} = require(`graphql-compose`);

const {
  GraphQLList
} = require(`graphql`);

const invariant = require(`invariant`);

const report = require(`gatsby-cli/lib/reporter`);

const {
  isFile
} = require(`./is-file`);

const {
  isDate
} = require(`../types/date`);

const {
  addDerivedType
} = require(`../types/derived-types`);

const is32BitInteger = require(`./is-32-bit-integer`);

const addInferredFields = ({
  schemaComposer,
  typeComposer,
  exampleValue,
  nodeStore,
  typeMapping,
  parentSpan
}) => {
  const config = getInferenceConfig({
    typeComposer,
    defaults: {
      shouldAddFields: true,
      shouldAddDefaultResolvers: typeComposer.hasExtension(`infer`) ? false : true
    }
  });
  addInferredFieldsImpl({
    schemaComposer,
    typeComposer,
    nodeStore,
    exampleObject: exampleValue,
    prefix: typeComposer.getTypeName(),
    typeMapping,
    config
  });
};

module.exports = {
  addInferredFields
};

const addInferredFieldsImpl = ({
  schemaComposer,
  typeComposer,
  nodeStore,
  exampleObject,
  typeMapping,
  prefix,
  config
}) => {
  const fields = [];
  Object.keys(exampleObject).forEach(unsanitizedKey => {
    const key = createFieldName(unsanitizedKey);
    fields.push({
      key,
      unsanitizedKey,
      exampleValue: exampleObject[unsanitizedKey]
    });
  });

  const fieldsByKey = _.groupBy(fields, field => field.key);

  Object.keys(fieldsByKey).forEach(key => {
    const possibleFields = fieldsByKey[key];
    let selectedField;

    if (possibleFields.length > 1) {
      const field = resolveMultipleFields(possibleFields);
      const possibleFieldsNames = possibleFields.map(field => `\`${field.unsanitizedKey}\``).join(`, `);
      report.warn(`Multiple node fields resolve to the same GraphQL field \`${prefix}.${field.key}\` - [${possibleFieldsNames}]. Gatsby will use \`${field.unsanitizedKey}\`.`);
      selectedField = field;
    } else {
      selectedField = possibleFields[0];
    }

    const fieldConfig = getFieldConfig(Object.assign({}, selectedField, {
      schemaComposer,
      typeComposer,
      nodeStore,
      prefix,
      typeMapping,
      config
    }));
    if (!fieldConfig) return;

    if (!typeComposer.hasField(key)) {
      if (config.shouldAddFields) {
        typeComposer.addFields({
          [key]: fieldConfig
        });
        typeComposer.setFieldExtension(key, `createdFrom`, `inference`);
      }
    } else {
      // Deprecated, remove in v3
      if (config.shouldAddDefaultResolvers) {
        // Add default resolvers to existing fields if the type matches
        // and the field has neither args nor resolver explicitly defined.
        const field = typeComposer.getField(key);

        if (field.type.toString().replace(/[[\]!]/g, ``) === fieldConfig.type.toString() && _.isEmpty(field.args) && !field.resolve) {
          const {
            extensions
          } = fieldConfig;

          if (extensions) {
            Object.keys(extensions).filter(name => // It is okay to list allowed extensions explicitly here,
            // since this is deprecated anyway and won't change.
            [`dateformat`, `fileByRelativePath`, `link`, `proxy`].includes(name)).forEach(name => {
              if (!typeComposer.hasFieldExtension(key, name)) {
                typeComposer.setFieldExtension(key, name, extensions[name]);
                report.warn(`Deprecation warning - adding inferred resolver for field ` + `${typeComposer.getTypeName()}.${key}. In Gatsby v3, ` + `only fields with an explicit directive/extension will ` + `get a resolver.`);
              }
            });
          }
        }
      }
    }
  });
  return typeComposer;
};

const getFieldConfig = ({
  schemaComposer,
  typeComposer,
  nodeStore,
  prefix,
  exampleValue,
  key,
  unsanitizedKey,
  typeMapping,
  config
}) => {
  const selector = `${prefix}.${key}`;
  let arrays = 0;
  let value = exampleValue;

  while (Array.isArray(value)) {
    value = value[0];
    arrays++;
  }

  let fieldConfig;

  if (hasMapping(typeMapping, selector)) {
    // TODO: Use `prefix` instead of `selector` in hasMapping and getFromMapping?
    // i.e. does the config contain sanitized field names?
    fieldConfig = getFieldConfigFromMapping({
      typeMapping,
      selector
    });
  } else if (unsanitizedKey.includes(`___NODE`)) {
    fieldConfig = getFieldConfigFromFieldNameConvention({
      schemaComposer,
      nodeStore,
      value: exampleValue,
      key: unsanitizedKey
    });
    arrays = arrays + (value.multiple ? 1 : 0);
  } else {
    fieldConfig = getSimpleFieldConfig({
      schemaComposer,
      typeComposer,
      nodeStore,
      key,
      value,
      selector,
      typeMapping,
      config,
      arrays
    });
  }

  if (!fieldConfig) return null; // Proxy resolver to unsanitized fieldName in case it contained invalid characters

  if (key !== unsanitizedKey.split(`___NODE`)[0]) {
    fieldConfig = Object.assign({}, fieldConfig, {
      extensions: Object.assign({}, fieldConfig.extensions || {}, {
        proxy: {
          from: unsanitizedKey
        }
      })
    });
  }

  while (arrays > 0) {
    fieldConfig = Object.assign({}, fieldConfig, {
      type: [fieldConfig.type]
    });
    arrays--;
  }

  return fieldConfig;
};

const resolveMultipleFields = possibleFields => {
  const nodeField = possibleFields.find(field => field.unsanitizedKey.includes(`___NODE`));

  if (nodeField) {
    return nodeField;
  }

  const canonicalField = possibleFields.find(field => field.unsanitizedKey === field.key);

  if (canonicalField) {
    return canonicalField;
  }

  return _.sortBy(possibleFields, field => field.unsanitizedKey)[0];
}; // XXX(freiksenet): removing this as it's a breaking change
// Deeper nested levels should be inferred as JSON.
// const MAX_DEPTH = 5


const hasMapping = (mapping, selector) => mapping && Object.keys(mapping).includes(selector);

const getFieldConfigFromMapping = ({
  typeMapping,
  selector
}) => {
  const [type, ...path] = typeMapping[selector].split(`.`);
  return {
    type,
    extensions: {
      link: {
        by: path.join(`.`) || `id`
      }
    }
  };
}; // probably should be in example value


const getFieldConfigFromFieldNameConvention = ({
  schemaComposer,
  nodeStore,
  value,
  key
}) => {
  const path = key.split(`___NODE___`)[1]; // Allow linking by nested fields, e.g. `author___NODE___contact___email`

  const foreignKey = path && path.replace(/___/g, `.`);

  const getNodeBy = value => foreignKey ? nodeStore.getNodes().find(node => _.get(node, foreignKey) === value) : nodeStore.getNode(value);

  const linkedNodes = value.linkedNodes.map(getNodeBy);

  const linkedTypes = _.uniq(linkedNodes.filter(Boolean).map(node => node.internal.type));

  invariant(linkedTypes.length, `Encountered an error trying to infer a GraphQL type for: \`${key}\`. ` + `There is no corresponding node with the \`id\` field matching: "${value.linkedNodes}".`);
  let type; // If the field value is an array that links to more than one type,
  // create a GraphQLUnionType. Note that we don't support the case where
  // scalar fields link to different types. Similarly, an array of objects
  // with foreign-key fields will produce union types if those foreign-key
  // fields are arrays, but not if they are scalars. See the tests for an example.

  if (linkedTypes.length > 1) {
    const typeName = linkedTypes.sort().join(``) + `Union`;
    type = schemaComposer.getOrCreateUTC(typeName, utc => {
      utc.setTypes(linkedTypes.map(typeName => schemaComposer.getOTC(typeName)));
      utc.setResolveType(node => node.internal.type);
    });
  } else {
    type = linkedTypes[0];
  }

  return {
    type,
    extensions: {
      link: {
        by: foreignKey || `id`,
        from: key
      }
    }
  };
};

const getSimpleFieldConfig = ({
  schemaComposer,
  typeComposer,
  nodeStore,
  key,
  value,
  selector,
  typeMapping,
  config,
  arrays
}) => {
  switch (typeof value) {
    case `boolean`:
      return {
        type: `Boolean`
      };

    case `number`:
      return {
        type: is32BitInteger(value) ? `Int` : `Float`
      };

    case `string`:
      if (isDate(value)) {
        return {
          type: `Date`,
          extensions: {
            dateformat: {}
          }
        };
      }

      if (isFile(nodeStore, selector, value)) {
        // NOTE: For arrays of files, where not every path references
        // a File node in the db, it is semi-random if the field is
        // inferred as File or String, since the exampleValue only has
        // the first entry (which could point to an existing file or not).
        return {
          type: `File`,
          extensions: {
            fileByRelativePath: {}
          }
        };
      }

      return {
        type: `String`
      };

    case `object`:
      if (value instanceof Date) {
        return {
          type: `Date`,
          extensions: {
            dateformat: {}
          }
        };
      }

      if (value instanceof String) {
        return {
          type: `String`
        };
      }

      if (value
      /* && depth < MAX_DEPTH*/
      ) {
          let fieldTypeComposer;

          if (typeComposer.hasField(key)) {
            fieldTypeComposer = typeComposer.getFieldTC(key); // If we have an object as a field value, but the field type is
            // explicitly defined as something other than an ObjectType
            // we can bail early.

            if (!(fieldTypeComposer instanceof ObjectTypeComposer)) return null; // If the array depth of the field value and of the explicitly
            // defined field type don't match we can also bail early.

            let lists = 0;
            let fieldType = typeComposer.getFieldType(key);

            while (fieldType.ofType) {
              if (fieldType instanceof GraphQLList) lists++;
              fieldType = fieldType.ofType;
            }

            if (lists !== arrays) return null;
          } else {
            // When the field type has not been explicitly defined, we
            // don't need to continue in case of @dontInfer, because
            // "addDefaultResolvers: true" only makes sense for
            // pre-existing types.
            if (!config.shouldAddFields) return null;
            const typeName = createTypeName(selector);

            if (schemaComposer.has(typeName)) {
              // Type could have been already created via schema customization
              fieldTypeComposer = schemaComposer.getOTC(typeName);
            } else {
              fieldTypeComposer = ObjectTypeComposer.create(typeName, schemaComposer);
              fieldTypeComposer.setExtension(`createdFrom`, `inference`);
              fieldTypeComposer.setExtension(`plugin`, typeComposer.getExtension(`plugin`));
              addDerivedType({
                typeComposer,
                derivedTypeName: fieldTypeComposer.getTypeName()
              });
            }
          } // Inference config options are either explicitly defined on a type
          // with directive/extension, or inherited from the parent type.


          const inferenceConfig = getInferenceConfig({
            typeComposer: fieldTypeComposer,
            defaults: config
          });
          return {
            type: addInferredFieldsImpl({
              schemaComposer,
              typeComposer: fieldTypeComposer,
              nodeStore,
              exampleObject: value,
              typeMapping,
              prefix: selector,
              config: inferenceConfig
            })
          };
        }

  }

  throw new Error(`Can't determine type for "${value}" in \`${selector}\`.`);
};

const createTypeName = selector => {
  const keys = selector.split(`.`);
  const suffix = keys.slice(1).map(_.upperFirst).join(``);
  return `${keys[0]}${suffix}`;
};

const NON_ALPHA_NUMERIC_EXPR = new RegExp(`[^a-zA-Z0-9_]`, `g`);
/**
 * GraphQL field names must be a string and cannot contain anything other than
 * alphanumeric characters and `_`. They also can't start with `__` which is
 * reserved for internal fields (`___foo` doesn't work either).
 */

const createFieldName = key => {
  // Check if the key is really a string otherwise GraphQL will throw.
  invariant(typeof key === `string`, `GraphQL field name (key) is not a string: \`${key}\`.`);
  const fieldName = key.split(`___NODE`)[0];
  const replaced = fieldName.replace(NON_ALPHA_NUMERIC_EXPR, `_`); // key is invalid; normalize with leading underscore and rest with x

  if (replaced.match(/^__/)) {
    return replaced.replace(/_/g, (char, index) => index === 0 ? `_` : `x`);
  } // key is invalid (starts with numeric); normalize with leading underscore


  if (replaced.match(/^[0-9]/)) {
    return `_` + replaced;
  }

  return replaced;
};

const getInferenceConfig = ({
  typeComposer,
  defaults
}) => {
  return {
    shouldAddFields: typeComposer.hasExtension(`infer`) ? typeComposer.getExtension(`infer`) : defaults.shouldAddFields,
    shouldAddDefaultResolvers: typeComposer.hasExtension(`addDefaultResolvers`) ? typeComposer.getExtension(`addDefaultResolvers`) : defaults.shouldAddDefaultResolvers
  };
};
//# sourceMappingURL=add-inferred-fields.js.map