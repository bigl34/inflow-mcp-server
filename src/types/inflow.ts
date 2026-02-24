// inFlow Inventory API Type Definitions

// Common types
export interface PaginationParams {
  skip?: number;
  count?: number;
  after?: string;
  before?: string;
  start?: number;
}

export interface SortParams {
  sort?: string;
  sortDesc?: boolean;
}

export interface QueryParams extends PaginationParams, SortParams {
  includeCount?: boolean;
}

export interface DateRangeFilter {
  fromDate?: string; // ISO date
  toDate?: string; // ISO date
}

export interface NumericRangeFilter {
  from?: number;
  to?: number;
}

export interface ListResponse<T> {
  data: T[];
  totalCount?: number;
}

export interface PaginatedResponse<T> {
  data: T[];
  hasMore?: boolean;
  nextCursor?: string;
}

// Product types
export interface Product {
  productId?: string;
  name: string;
  description?: string;
  barcode?: string;
  sku?: string;
  category?: Category;
  categoryId?: string;
  isActive?: boolean;
  isSerialized?: boolean;
  isManufacturable?: boolean;
  trackSerials?: boolean;
  cost?: number;
  defaultPrice?: number;
  reorderPoint?: number;
  reorderQuantity?: number;
  dimensions?: ProductDimensions;
  weight?: number;
  weightUnit?: string;
  customFields?: Record<string, unknown>;
  itemBoms?: ItemBom[];
  inventoryLines?: InventoryLine[];
  timestamp?: string;
  createdDate?: string;
  modifiedDate?: string;
}

export interface InventoryLine {
  serial?: string;
  locationId?: string;
  quantityOnHand?: string;
  sublocation?: string;
}

// Bill of Materials types
export interface ItemBom {
  itemBomId?: string;
  productId?: string;
  product?: Product;
  childProductId?: string;
  childProduct?: Product;
  quantity?: QuantityWithUom;
  timestamp?: string;
}

export interface QuantityWithUom {
  standardQuantity?: string;
  uomQuantity?: string;
  uom?: string;
  serialNumbers?: string[];
}

export interface ProductDimensions {
  length?: number;
  width?: number;
  height?: number;
  unit?: string;
}

export interface ProductSummary {
  productId: string;
  quantityOnHand: number;
  quantityAvailable: number;
  quantityOnOrder: number;
  quantityAllocated: number;
  locationSummaries?: LocationSummary[];
}

export interface LocationSummary {
  locationId: string;
  locationName: string;
  quantityOnHand: number;
  quantityAvailable: number;
  sublocationSummaries?: SublocationSummary[];
}

export interface SublocationSummary {
  sublocation: string;
  quantityOnHand: number;
}

export interface ProductFilter {
  [key: string]: string | number | boolean | undefined;
  name?: string;
  description?: string;
  barcode?: string;
  sku?: string;
  categoryId?: string;
  isActive?: boolean;
  trackSerials?: boolean;
  smart?: string;
}

// Category types
export interface Category {
  categoryId?: string;
  name: string;
  parentCategoryId?: string;
  parentCategory?: Category;
  subCategories?: Category[];
}

// Location types
export interface Location {
  id?: string;
  name: string;
  address?: Address;
  isActive?: boolean;
  isDefault?: boolean;
  sublocations?: string[];
}

export interface Address {
  street1?: string;
  street2?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
}

// Customer types
export interface Customer {
  customerId?: string;
  name: string;
  email?: string;
  phone?: string;
  fax?: string;
  website?: string;
  billingAddress?: Address;
  shippingAddress?: Address;
  pricingSchemeId?: string;
  pricingScheme?: PricingScheme;
  paymentTermsId?: string;
  paymentTerms?: PaymentTerms;
  taxingSchemeId?: string;
  currencyCode?: string;
  contacts?: Contact[];
  remarks?: string;
  customFields?: Record<string, unknown>;
  isActive?: boolean;
  timestamp?: string;
  createdDate?: string;
  modifiedDate?: string;
}

export interface Contact {
  id?: string;
  name?: string;
  email?: string;
  phone?: string;
  isPrimary?: boolean;
}

export interface CustomerFilter {
  [key: string]: string | number | boolean | undefined;
  name?: string;
  email?: string;
  phone?: string;
  locationId?: string;
  pricingSchemeId?: string;
  isActive?: boolean;
  smart?: string;
}

// Vendor types
export interface Vendor {
  vendorId?: string;
  name: string;
  email?: string;
  phone?: string;
  fax?: string;
  website?: string;
  address?: Address;
  paymentTermsId?: string;
  paymentTerms?: PaymentTerms;
  currencyCode?: string;
  contacts?: Contact[];
  customFields?: Record<string, unknown>;
  isActive?: boolean;
  timestamp?: string;
  createdDate?: string;
  modifiedDate?: string;
}

export interface VendorFilter {
  [key: string]: string | number | boolean | undefined;
  name?: string;
  email?: string;
  isActive?: boolean;
}

// Sales Order types
export interface SalesOrder {
  salesOrderId?: string;
  orderNumber?: string;
  orderDate?: string;
  requiredDate?: string;
  customerId?: string;
  customer?: Customer;
  locationId?: string;
  location?: Location;
  status?: OrderStatus;
  inventoryStatus?: string;
  billingAddress?: Address;
  shippingAddress?: Address;
  pricingSchemeId?: string;
  taxingSchemeId?: string;
  paymentTermsId?: string;
  currencyCode?: string;
  exchangeRate?: number;
  subtotal?: number;
  taxTotal?: number;
  total?: number;
  amountPaid?: number;
  balance?: number;
  lines?: SalesOrderLine[];
  orderRemarks?: string;
  customFields?: Record<string, unknown>;
  timestamp?: string;
  createdDate?: string;
  modifiedDate?: string;
}

export interface SalesOrderLine {
  salesOrderLineId?: string;
  productId?: string;
  product?: Product;
  description?: string;
  quantity: number | {
    standardQuantity: number;
    uomQuantity: number;
    uom?: string;
    serialNumbers?: string[];
  };
  quantityPicked?: number;
  quantityShipped?: number;
  unitPrice?: number;
  discount?: number;
  discountType?: 'Percent' | 'Amount';
  taxCodeId?: string;
  subtotal?: number;
  sublocation?: string;
}

export type OrderStatus =
  | 'Open'
  | 'PartiallyFulfilled'
  | 'Fulfilled'
  | 'Cancelled'
  | 'Closed';

export interface SalesOrderFilter {
  [key: string]: string | number | boolean | string[] | DateRangeFilter | NumericRangeFilter | undefined;
  orderNumber?: string;
  customerId?: string;
  status?: OrderStatus | OrderStatus[];
  locationId?: string;
  orderDate?: DateRangeFilter;
  requiredDate?: DateRangeFilter;
  total?: NumericRangeFilter;
  balance?: NumericRangeFilter;
  smart?: string;
  // Legacy support for flat date filters
  orderDateFrom?: string;
  orderDateTo?: string;
  requiredDateFrom?: string;
  requiredDateTo?: string;
  totalFrom?: number;
  totalTo?: number;
}

// Purchase Order types
export interface PurchaseOrder {
  purchaseOrderId?: string;
  orderNumber?: string;
  orderDate?: string;
  expectedDate?: string;
  vendorId?: string;
  vendor?: Vendor;
  locationId?: string;
  location?: Location;
  status?: PurchaseOrderStatus;
  inventoryStatus?: string;
  shippingAddress?: Address;
  currencyCode?: string;
  exchangeRate?: number;
  subtotal?: number;
  taxTotal?: number;
  total?: number;
  lines?: PurchaseOrderItem[];
  receiveLines?: PurchaseOrderReceiveLine[];
  unstockLines?: unknown[];
  orderRemarks?: string;
  customFields?: Record<string, unknown>;
  timestamp?: string;
  createdDate?: string;
  modifiedDate?: string;
}

export interface PurchaseOrderItem {
  purchaseOrderLineId?: string;
  productId?: string;
  product?: Product;
  description?: string;
  quantity: number | {
    standardQuantity: number;
    uomQuantity: number;
    uom?: string;
    serialNumbers?: string[];
  };
  unitPrice?: number;
  taxCodeId?: string;
  subtotal?: number;
  sublocation?: string;
}

export interface PurchaseOrderReceiveLine {
  purchaseOrderReceiveLineId?: string;
  productId?: string;
  description?: string;
  vendorItemCode?: string;
  quantity?: {
    standardQuantity: string;
    uomQuantity: string;
    uom?: string;
    serialNumbers?: string[];
  };
  locationId?: string;
  sublocation?: string;
  receiveDate?: string;
  timestamp?: string;
}

export type PurchaseOrderStatus =
  | 'Open'
  | 'PartiallyReceived'
  | 'Received'
  | 'Cancelled'
  | 'Closed';

export interface PurchaseOrderFilter {
  [key: string]: string | number | boolean | string[] | DateRangeFilter | undefined;
  orderNumber?: string;
  vendorId?: string;
  status?: PurchaseOrderStatus | PurchaseOrderStatus[];
  locationId?: string;
  orderDate?: DateRangeFilter;
  expectedDate?: DateRangeFilter;
  smart?: string;
  // Legacy support for flat date filters
  orderDateFrom?: string;
  orderDateTo?: string;
  expectedDateFrom?: string;
  expectedDateTo?: string;
}

// Stock Adjustment types
export interface StockAdjustment {
  stockAdjustmentId?: string;
  adjustmentNumber?: string;
  date?: string;
  locationId?: string;
  location?: Location;
  adjustmentReasonId?: string;
  reason?: AdjustmentReason;
  status?: 'Open' | 'Completed' | 'Cancelled';
  items?: StockAdjustmentItem[];
  remarks?: string;
  customFields?: Record<string, unknown>;
  timestamp?: string;
  createdDate?: string;
  modifiedDate?: string;
}

export interface StockAdjustmentItem {
  id?: string;
  productId?: string;
  product?: Product;
  quantity: number;
  sublocation?: string;
  serialNumbers?: string[];
  unitCost?: number;
}

export interface AdjustmentReason {
  id?: string;
  name: string;
  adjustmentType?: 'Add' | 'Remove';
}

export interface StockAdjustmentFilter {
  [key: string]: string | number | boolean | undefined;
  adjustmentNumber?: string;
  locationId?: string;
  adjustmentReasonId?: string;
  status?: 'Open' | 'Completed' | 'Cancelled';
  adjustmentDateFrom?: string;
  adjustmentDateTo?: string;
}

// Stock Transfer types
export interface StockTransfer {
  stockTransferId?: string;
  transferNumber?: string;
  transferDate?: string;
  fromLocationId?: string;
  fromLocation?: Location;
  toLocationId?: string;
  toLocation?: Location;
  status?: 'Open' | 'InTransit' | 'Completed' | 'Cancelled';
  items?: StockTransferItem[];
  remarks?: string;
  customFields?: Record<string, unknown>;
  timestamp?: string;
  createdDate?: string;
  modifiedDate?: string;
}

export interface StockTransferItem {
  id?: string;
  productId?: string;
  product?: Product;
  quantity: number;
  quantityShipped?: number;
  quantityReceived?: number;
  fromSublocation?: string;
  toSublocation?: string;
  serialNumbers?: string[];
}

export interface StockTransferFilter {
  [key: string]: string | number | boolean | undefined;
  transferNumber?: string;
  fromLocationId?: string;
  toLocationId?: string;
  status?: 'Open' | 'InTransit' | 'Completed' | 'Cancelled';
  transferDateFrom?: string;
  transferDateTo?: string;
}

// Stock Count types
export interface StockCount {
  stockCountId?: string;
  stockCountNumber?: string;
  countDate?: string;
  locationId?: string;
  location?: Location;
  status?: 'Open' | 'InProgress' | 'Completed' | 'Cancelled';
  isCancelled?: boolean;
  isCompleted?: boolean;
  isPrepared?: boolean;
  isReviewed?: boolean;
  isStarted?: boolean;
  countSheets?: CountSheet[];
  remarks?: string;
  timestamp?: string;
  createdDate?: string;
  modifiedDate?: string;
}

export interface CountSheet {
  id?: string;
  name?: string;
  items?: CountSheetItem[];
}

export interface CountSheetItem {
  productId?: string;
  product?: Product;
  sublocation?: string;
  expectedQuantity?: number;
  countedQuantity?: number;
  variance?: number;
  serialNumbers?: string[];
}

// Manufacturing Order types
export interface ManufacturingOrder {
  manufacturingOrderId?: string;
  manufacturingOrderNumber?: string;
  orderDate?: string;
  dueDate?: string;
  locationId?: string;
  location?: Location;
  status?: string;
  isCancelled?: boolean;
  isCompleted?: boolean;
  primaryFinishedProductId?: string;
  lines?: ManufacturingOrderLine[];
  remarks?: string;
  pickRemarks?: string;
  putAwayRemarks?: string;
  customFields?: Record<string, unknown>;
  timestamp?: string;
  createdDate?: string;
  modifiedDate?: string;
}

export interface ManufacturingOrderLine {
  manufacturingOrderLineId?: string;
  manufacturingOrderId?: string;
  parentManufacturingOrderLineId?: string | null;
  productId?: string;
  description?: string;
  quantity?: QuantityWithUom;
  manufacturingOrderLines?: ManufacturingOrderLine[];
  timestamp?: string;
}

export interface ManufacturingOrderFilter {
  [key: string]: string | number | boolean | undefined;
  manufacturingOrderNumber?: string;
  locationId?: string;
  status?: string;
  primaryFinishedProductId?: string;
  orderDateFrom?: string;
  orderDateTo?: string;
}

// Reference data types
export interface PricingScheme {
  id?: string;
  name: string;
  isDefault?: boolean;
}

export interface PaymentTerms {
  id?: string;
  name: string;
  dueDays?: number;
  discountDays?: number;
  discountPercent?: number;
}

export interface TaxingScheme {
  id?: string;
  name: string;
  isDefault?: boolean;
  taxCodes?: TaxCode[];
}

export interface TaxCode {
  id?: string;
  name: string;
  rate?: number;
  isDefault?: boolean;
}

export interface Currency {
  code: string;
  name: string;
  symbol?: string;
  exchangeRate?: number;
}

// Custom Fields types
export interface CustomFieldDefinition {
  id?: string;
  entityType: CustomFieldEntityType;
  name: string;
  fieldType: CustomFieldType;
  isRequired?: boolean;
  dropdownOptions?: string[];
}

export type CustomFieldEntityType =
  | 'Product'
  | 'Customer'
  | 'Vendor'
  | 'SalesOrder'
  | 'PurchaseOrder'
  | 'StockAdjustment'
  | 'StockTransfer'
  | 'ManufacturingOrder';

export type CustomFieldType =
  | 'Text'
  | 'Number'
  | 'Date'
  | 'Dropdown'
  | 'Checkbox';

export interface CustomFieldLabels {
  entityType: CustomFieldEntityType;
  labels: Record<string, string>; // fieldId -> label
}

// Webhook types
export interface Webhook {
  id?: string;
  url: string;
  events: WebhookEvent[];
  isActive?: boolean;
  secret?: string;
}

export type WebhookEvent =
  | 'customer.created'
  | 'customer.updated'
  | 'vendor.created'
  | 'vendor.updated'
  | 'product.created'
  | 'product.updated'
  | 'salesOrder.created'
  | 'salesOrder.updated'
  | 'purchaseOrder.created'
  | 'purchaseOrder.updated';

export interface WebhookCreateResponse extends Webhook {
  secret: string; // Only returned on creation
}

// Team Member types
export interface TeamMember {
  id?: string;
  name: string;
  email: string;
  role?: string;
  isActive?: boolean;
}

// API Error types
export interface ApiError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}
