import { z } from 'zod';

const identifier = z.string().min(1).max(256);
const boundedText = z.string().min(1).max(512);
const slackChannelId = z.string().regex(/^[A-Z0-9]{1,32}$/);
const slackThreadTs = z.string().regex(/^[0-9]{1,20}\.[0-9]{6}$/);
const httpsUrl = z.string().url().max(2_048).refine((value) => {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}, 'HTTPS URL required');
const decimal = z.string().min(1).max(64).regex(
  /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/,
  'quantity must be a plain decimal string'
);

export const manufacturingRunReadySchema = z.object({}).strict();

export const manufacturingRunNotificationContextSchema = z.object({
  slackChannelId,
  slackThreadTs,
  slackPermalink: httpsUrl.optional(),
}).strict();

export const manufacturingRunBeginSchema = z.object({
  idempotencyKey: z.string().min(1).max(512),
  identity: z.object({
    schemaVersion: z.literal('manufacturing-run-identity/v2'),
    companyId: identifier,
    finishedProductId: identifier,
    sourceSerial: identifier,
    finishedSerial: identifier,
  }).strict(),
  locationId: identifier,
  remarks: z.string().max(4_096).optional(),
  notificationContext: manufacturingRunNotificationContextSchema.optional(),
}).strict();

export const manufacturingRunComponentResolveSchema = z.object({
  operationId: identifier,
  rawLineId: identifier,
  recursiveChildren: z.array(z.object({
    sourceSerial: identifier,
    finishedSerial: identifier,
    locationId: identifier,
  }).strict()).min(1).max(100).optional(),
}).strict().refine(
  (value) =>
    value.recursiveChildren === undefined ||
    ['sourceSerial', 'finishedSerial'].every((field) =>
      new Set(
        value.recursiveChildren!.map((child) =>
          child[field as 'sourceSerial' | 'finishedSerial']
            .normalize('NFKC').trim().toUpperCase()
        )
      ).size === value.recursiveChildren!.length
    ),
  { message: 'recursive child source and finished serials must each be unique' }
);

export const manufacturingRunComponentSchema = z.object({
  operationId: identifier,
  rawLineId: identifier,
  productId: identifier,
  quantity: decimal,
  locationId: identifier,
  sublocation: identifier.optional(),
  lotId: identifier.nullable().optional(),
  serialized: z.boolean(),
  serialNumbers: z.array(identifier).max(100),
}).strict();

export const manufacturingRunStatusSchema = z.object({
  operationId: identifier,
}).strict();

export const manufacturingRunNotificationClaimSchema = z.object({
  notificationId: identifier,
  claimantId: identifier,
  claimTtlMs: z.number().int().min(1_000).max(3_600_000),
}).strict();

export const manufacturingRunNotificationAckSchema = z.object({
  notificationId: identifier,
  claimToken: boundedText,
  slackTimestamp: z.string().min(1).max(64),
  permalink: z.string().url().max(2_048),
}).strict();

export const manufacturingRunNotificationDeliveryUnknownSchema = z.object({
  notificationId: identifier,
  claimToken: boundedText,
  reason: boundedText,
}).strict();

export const manufacturingRunNotificationReconcileSchema = z.object({
  notificationId: identifier,
  action: z.enum([
    'acknowledge_existing',
    'retry_after_duplicate_risk',
  ]),
  operatorId: identifier,
  slackTimestamp: z.string().min(1).max(64).optional(),
  permalink: z.string().url().max(2_048).optional(),
}).strict().refine(
  (value) =>
    value.action === 'acknowledge_existing'
      ? Boolean(value.slackTimestamp && value.permalink)
      : value.slackTimestamp === undefined && value.permalink === undefined,
  {
    message:
      'acknowledge_existing requires Slack evidence; duplicate-risk retry forbids it',
  }
);

export const manufacturingRunOperatorResolveSchema = z.object({
  operationId: identifier,
  expectedRevision: z.number().int().nonnegative(),
  operatorId: identifier,
  action: z.literal('resolve'),
  approvedAt: z.number().int().positive(),
}).strict();

export const manufacturingRunOperatorRearmProvenNoWriteSchema = z.object({
  operationId: identifier,
  expectedRevision: z.number().int().nonnegative(),
}).strict();

export const manufacturingRunRouteSchemas = Object.freeze({
  '/v1/manufacturing-runs/ready': manufacturingRunReadySchema,
  '/v1/manufacturing-runs/begin': manufacturingRunBeginSchema,
  '/v1/manufacturing-runs/component/resolve':
    manufacturingRunComponentResolveSchema,
  '/v1/manufacturing-runs/component': manufacturingRunComponentSchema,
  '/v1/manufacturing-runs/status': manufacturingRunStatusSchema,
  '/v1/manufacturing-runs/notifications/claim':
    manufacturingRunNotificationClaimSchema,
  '/v1/manufacturing-runs/notifications/ack':
    manufacturingRunNotificationAckSchema,
  '/v1/manufacturing-runs/notifications/delivery-unknown':
    manufacturingRunNotificationDeliveryUnknownSchema,
  '/v1/manufacturing-runs/notifications/reconcile':
    manufacturingRunNotificationReconcileSchema,
  '/v1/manufacturing-runs/operator/resolve':
    manufacturingRunOperatorResolveSchema,
  '/v1/manufacturing-runs/operator/rearm-proven-no-write':
    manufacturingRunOperatorRearmProvenNoWriteSchema,
});

export type ManufacturingRunRoute =
  keyof typeof manufacturingRunRouteSchemas;
export type ManufacturingRunBeginRequest =
  z.infer<typeof manufacturingRunBeginSchema>;
export type ManufacturingRunNotificationContext =
  z.infer<typeof manufacturingRunNotificationContextSchema>;
export type ManufacturingRunComponentResolveRequest =
  z.infer<typeof manufacturingRunComponentResolveSchema>;
export type ManufacturingRunComponentRequest =
  z.infer<typeof manufacturingRunComponentSchema>;
export type ManufacturingRunStatusRequest =
  z.infer<typeof manufacturingRunStatusSchema>;
export type ManufacturingRunNotificationClaimRequest =
  z.infer<typeof manufacturingRunNotificationClaimSchema>;
export type ManufacturingRunNotificationAckRequest =
  z.infer<typeof manufacturingRunNotificationAckSchema>;
export type ManufacturingRunNotificationDeliveryUnknownRequest =
  z.infer<typeof manufacturingRunNotificationDeliveryUnknownSchema>;
export type ManufacturingRunNotificationReconcileRequest =
  z.infer<typeof manufacturingRunNotificationReconcileSchema>;
export type ManufacturingRunOperatorResolveRequest =
  z.infer<typeof manufacturingRunOperatorResolveSchema>;
export type ManufacturingRunOperatorRearmProvenNoWriteRequest =
  z.infer<typeof manufacturingRunOperatorRearmProvenNoWriteSchema>;

export function isManufacturingRunRoute(
  route: string
): route is ManufacturingRunRoute {
  return Object.hasOwn(manufacturingRunRouteSchemas, route);
}

export function parseManufacturingRunRouteBody(
  route: string,
  value: unknown
): unknown {
  if (!isManufacturingRunRoute(route)) {
    throw new Error(`UNKNOWN_MANUFACTURING_RUN_ROUTE: ${route}`);
  }
  return manufacturingRunRouteSchemas[route].parse(value);
}
