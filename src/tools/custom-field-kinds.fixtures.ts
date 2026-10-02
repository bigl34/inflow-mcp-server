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

export const TENANT_CUSTOM_FIELD_DEFINITIONS: readonly CustomFieldDefinitionFixture[] = [
  definition('product', 'custom1', 'text', 'Shopify Link'),
  definition('product', 'custom2', 'checkbox', 'Variant?'),
  definition('product', 'custom3', 'checkbox', 'Link Issue?'),
  definition('product', 'custom4', 'date', 'Last Auto Update'),
  definition('product', 'custom5', 'checkbox', 'Barcode not SKU?'),
  definition('product', 'custom6', 'checkbox', 'Draft or Archived Shopify Product?'),
  definition('product', 'custom7', 'checkbox', 'Deactivated', false),
  definition('product', 'custom8', 'checkbox', 'Screw?'),
  definition('salesOrder', 'custom1', 'checkbox', 'Picklist Printed'),
  definition('salesOrder', 'custom4', 'text', 'Shopify Order Link'),
  definition('salesOrder', 'custom7', 'date', 'Last Auto Update'),
  definition('salesOrder', 'custom9', 'date', 'Chosen Delivery Date'),
  definition('salesOrder', 'custom10', 'text', 'Shipments & Cost'),
];

export function customFieldDefinitionsList(rows: readonly CustomFieldDefinitionFixture[] = TENANT_CUSTOM_FIELD_DEFINITIONS) {
  return async (path: string) => {
    if (path !== '/custom-field-definitions') throw new Error(`UNEXPECTED_LIST_PATH: ${path}`);
    return { data: rows.map((row) => ({ ...row })) };
  };
}
