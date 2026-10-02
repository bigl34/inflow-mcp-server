export interface CustomFieldDefinitionFixture {
  customFieldDefinitionId: string;
  categoryId: null;
  customFieldType: 'text' | 'checkbox' | 'date';
  entityType: string;
  isActive: boolean;
  label: string;
  propertyName: string;
}

function definition(
  entityType: string,
  propertyName: string,
  customFieldType: CustomFieldDefinitionFixture['customFieldType'],
  label: string,
  isActive = true
): CustomFieldDefinitionFixture {
  const entityPrefix = entityType.charAt(0).toUpperCase() + entityType.slice(1);
  return { customFieldDefinitionId: `${entityPrefix}-${propertyName}`, categoryId: null, customFieldType, entityType, isActive, label, propertyName };
}

export const FIXTURE_CUSTOM_FIELD_DEFINITIONS: readonly CustomFieldDefinitionFixture[] = [
  definition('product', 'custom10', 'text', 'Example product text custom10'),
  definition('product', 'custom9', 'checkbox', 'Example product checkbox custom9'),
  definition('product', 'custom8', 'checkbox', 'Example product checkbox custom8'),
  definition('product', 'custom7', 'date', 'Example product date custom7'),
  definition('product', 'custom6', 'checkbox', 'Example product checkbox custom6'),
  definition('product', 'custom5', 'checkbox', 'Example product checkbox custom5', false),
  definition('product', 'custom4', 'checkbox', 'Example product checkbox custom4'),
  definition('product', 'custom3', 'checkbox', 'Example product checkbox custom3'),
  definition('salesOrder', 'custom10', 'checkbox', 'Example salesOrder checkbox custom10'),
  definition('salesOrder', 'custom7', 'text', 'Example salesOrder text custom7'),
  definition('salesOrder', 'custom4', 'date', 'Example salesOrder date custom4'),
  definition('salesOrder', 'custom2', 'date', 'Example salesOrder date custom2'),
  definition('salesOrder', 'custom1', 'text', 'Example salesOrder text custom1'),
];

export function customFieldDefinitionsList(rows: readonly CustomFieldDefinitionFixture[] = FIXTURE_CUSTOM_FIELD_DEFINITIONS) {
  return async (path: string) => {
    if (path !== '/custom-field-definitions') throw new Error(`UNEXPECTED_LIST_PATH: ${path}`);
    return { data: rows.map((row) => ({ ...row })) };
  };
}
