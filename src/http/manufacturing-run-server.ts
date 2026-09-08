import { createHash, randomUUID } from 'node:crypto';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { ZodError } from 'zod';
import { canonicalHash } from '../core/canonical-json.js';
import { normalizeDecimal } from '../core/decimal.js';
import type { ManufacturingRunStore } from '../core/manufacturing-run-store.js';
import type {
  ManufacturingCoordinatorBeginInput,
  ManufacturingCoordinatorChildBeginInput,
  ManufacturingRunEnvelopeSnapshot,
  ManufacturingRunStatus,
  ManufacturingManualApprovalEvidence,
  ManufacturingRunBlockerEvidence,
  StoredSourceSerialBinding,
} from '../services/manufacturing-run-coordinator.js';
import { createManufacturingRunBlockerEvidence } from '../services/manufacturing-run-coordinator.js';
import type { ManufacturingComponentIntent } from '../services/manufacturing-run-planner.js';
import type {
  ManufacturingOrder,
  ManufacturingOrderLine,
  Product,
  ProductSummary,
} from '../types/inflow.js';
import {
  ManufacturingRunAuthError,
  verifyManufacturingRunRequest,
  type ManufacturingRunAuthContext,
  type ManufacturingRunAuthOptions,
  type ManufacturingRunHmacKeyring,
} from './manufacturing-run-auth.js';
import { effectiveBuildRunAvailableQuantity } from '../services/inventory-summaries.js';
import {
  createManufacturingRunEnvelope,
  decodeManufacturingRunRemarks,
  encodeManufacturingRunRemarks,
  manufacturingRunHttpStatus,
  sanitizeManufacturingRunFailure,
  type ManufacturingRunFailure,
  type ManufacturingRunNotificationDisposition,
} from './manufacturing-run-envelope.js';
import type { ManufacturingRunReadiness } from './manufacturing-run-readiness.js';
import {
  isManufacturingRunRoute,
  parseManufacturingRunRouteBody,
  type ManufacturingRunBeginRequest,
  type ManufacturingRunComponentRequest,
  type ManufacturingRunComponentResolveRequest,
  type ManufacturingRunNotificationAckRequest,
  type ManufacturingRunNotificationClaimRequest,
  type ManufacturingRunNotificationDeliveryUnknownRequest,
  type ManufacturingRunNotificationReconcileRequest,
  type ManufacturingRunNotificationContext,
  type ManufacturingRunOperatorRearmProvenNoWriteRequest,
  type ManufacturingRunOperatorResolveRequest,
  type ManufacturingRunStatusRequest,
} from './manufacturing-run-schemas.js';

export interface ManufacturingRunCoordinatorHttpFacade {
  begin(input: ManufacturingCoordinatorBeginInput): ManufacturingRunStatus;
  beginChildWithDependency(
    input: ManufacturingCoordinatorChildBeginInput
  ): ManufacturingRunStatus;
  registerComponent(
    input: { operationId: string } & ManufacturingComponentIntent
  ): ManufacturingRunStatus;
  status(operationId: string): Promise<ManufacturingRunStatus>;
  rearmProvenNoWrite(input: {
    operationId: string;
    expectedRevision: number;
  }): Promise<ManufacturingRunStatus>;
  snapshot(operationId: string): ManufacturingRunEnvelopeSnapshot;
  resolveManual(input: {
    operationId: string;
    expectedRevision: number;
    operatorId: string;
    action: 'resolve';
    approvedAt: number;
    approvalEvidence: ManufacturingManualApprovalEvidence;
  }): ManufacturingRunStatus;
  finalizeSatisfiedDependencyLine(input: {
    operationId: string;
    rawLineId: string;
  }): ManufacturingRunStatus;
}

export interface ManufacturingRunHttpStore {
  claimNonce: ManufacturingRunStore['claimNonce'];
  getRunArtifact(
    operationId: string,
    artifactType: string
  ): { artifact: unknown } | undefined;
  getNotification(
    notificationId: string
  ): { operationId: string } | undefined;
  claimNextNotification(input: {
    notificationId: string;
    claimantId: string;
    claimTtlMs: number;
    now?: string | Date | number;
  }): { operationId: string; status: string } | undefined;
  ackNotification(input: {
    notificationId: string;
    claimToken: string;
    slackTimestamp: string;
    permalink: string;
    now?: string | Date | number;
  }): { operationId: string; status: string };
  markNotificationDeliveryUnknown(input: {
    notificationId: string;
    claimToken: string;
    reason: string;
    now?: string | Date | number;
  }): { operationId: string; status: string };
  reconcileNotification(input: {
    notificationId: string;
    action: 'acknowledge_existing' | 'retry_after_duplicate_risk';
    operatorId: string;
    slackTimestamp?: string;
    permalink?: string;
    now?: string | Date | number;
  }): { operationId: string; status: string };
}

export interface ManufacturingRunComponentResolver {
  resolve(
    input: ManufacturingRunComponentResolveRequest
  ): Promise<ManufacturingRunEnvelopeSnapshot>;
}

export interface CoordinatorComponentResolverOptions {
  coordinator: ManufacturingRunCoordinatorHttpFacade & {
    blockComponent(input: {
      operationId: string;
      rawLineId: string;
      reason: string;
      evidenceHash: string;
      blockerEvidence?: ManufacturingRunBlockerEvidence;
    }): ManufacturingRunStatus;
  };
  store: {
    consumeRateBudget(input: {
      now?: string | Date | number;
      count?: number;
    }): { allowed: boolean; remaining: number; retryAfterMs: number };
    getRunArtifact?(
      operationId: string,
      artifactType: string
    ): { artifact: unknown } | undefined;
  };
  client: {
    get<T>(
      path: string,
      options?: { include?: string[] }
    ): Promise<T>;
  };
  companyId: string;
  now?: () => Date;
}

interface DurableRunMetadata {
  finishedSerial: string | null;
  locationId: string | null;
  notificationContext: ManufacturingRunNotificationContext | null;
}

interface ManufacturingRunArtifactReader {
  getRunArtifact?(
    operationId: string,
    artifactType: string
  ): { artifact: unknown } | undefined;
  getLatestRunArtifactByPrefix?(
    operationId: string,
    artifactTypePrefix: string
  ): { artifact: unknown } | undefined;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function normalizedSerial(value: string): string {
  return value.normalize('NFKC').trim().toUpperCase();
}

function durableRunMetadata(
  store: ManufacturingRunArtifactReader,
  operationId: string
): DurableRunMetadata {
  const artifact = object(
    store.getRunArtifact?.(operationId, 'begin_plan')?.artifact
  );
  const begin = object(artifact?.begin);
  const identity = object(begin?.normalizedIdentity);
  const finishedSerial = typeof identity?.finishedSerial === 'string'
    ? normalizedSerial(identity.finishedSerial)
    : '';
  const locationId = typeof artifact?.locationId === 'string'
    ? artifact.locationId.trim()
    : '';
  let notificationContext: ManufacturingRunNotificationContext | null = null;
  const notificationArtifact = object(
    store.getLatestRunArtifactByPrefix?.(
      operationId,
      'notification_context/v1:'
    )?.artifact
  );
  const notificationRemarks = typeof notificationArtifact?.remarks === 'string'
    ? notificationArtifact.remarks
    : typeof artifact?.remarks === 'string'
      ? artifact.remarks
      : undefined;
  if (notificationRemarks !== undefined) {
    try {
      notificationContext = decodeManufacturingRunRemarks(
        notificationRemarks
      ).notificationContext;
    } catch {
      notificationContext = null;
    }
  }
  return {
    finishedSerial: finishedSerial || null,
    locationId: locationId || null,
    notificationContext,
  };
}

function blockerEvidenceForRun(
  store: ManufacturingRunArtifactReader,
  operationId: string,
  stateRevision: number
): ManufacturingRunBlockerEvidence | null {
  const artifactRecord =
    store.getLatestRunArtifactByPrefix?.(
      operationId,
      'blocker_evidence/v1'
    ) ?? store.getRunArtifact?.(operationId, 'blocker_evidence/v1');
  const artifactType = typeof artifactRecord === 'object' &&
    artifactRecord !== null &&
    'artifactType' in artifactRecord &&
    typeof artifactRecord.artifactType === 'string'
      ? artifactRecord.artifactType
      : 'blocker_evidence/v1';
  const blockerRevision = Number(
    /:revision:(\d+)$/.exec(artifactType)?.[1]
  );
  if (
    blockerRevision !== stateRevision - 1 &&
    !(artifactType === 'blocker_evidence/v1' && stateRevision === 2)
  ) {
    return null;
  }
  const artifact = object(artifactRecord?.artifact);
  return artifact?.schemaVersion === 'manufacturing-run-blocker/v1'
    ? artifact as unknown as ManufacturingRunBlockerEvidence
    : null;
}

function sourceSerialBindingForRun(
  store: ManufacturingRunArtifactReader,
  operationId: string
): StoredSourceSerialBinding | null {
  const artifact = object(
    store.getRunArtifact?.(operationId, 'source_serial_binding/v1')?.artifact
  );
  return artifact?.schemaVersion === 'source_serial_binding/v1'
    ? artifact as unknown as StoredSourceSerialBinding
    : null;
}

function contextualEnvelope(
  store: ManufacturingRunArtifactReader,
  snapshot: ManufacturingRunEnvelopeSnapshot,
  notificationDisposition?: ManufacturingRunNotificationDisposition
): ReturnType<typeof createManufacturingRunEnvelope> {
  const metadata = durableRunMetadata(store, snapshot.operationId);
  return createManufacturingRunEnvelope({
    snapshot,
    notificationContext: metadata.notificationContext,
    blockerEvidence: blockerEvidenceForRun(
      store,
      snapshot.operationId,
      snapshot.stateRevision
    ),
    ...(notificationDisposition === undefined
      ? {}
      : { notificationDisposition }),
  });
}

export interface ManufacturingRunServerLimits {
  bodyLimitBytes: number;
  requestTimeoutMs: number;
  headersTimeoutMs: number;
  keepAliveTimeoutMs: number;
  maxHeaderBytes: number;
}

export interface ManufacturingRunRuntimeIdentity {
  instanceId: string;
  processId: number;
  releaseOid: string;
  materialSha256: string;
  startedAt: string;
}

export interface ManufacturingRunServerOptions {
  coordinator: ManufacturingRunCoordinatorHttpFacade;
  store: ManufacturingRunHttpStore;
  componentResolver: ManufacturingRunComponentResolver;
  readiness(): Promise<ManufacturingRunReadiness>;
  keyring(): ManufacturingRunHmacKeyring;
  expectedAudience: string;
  expectedCompanyId: string;
  now?: () => Date;
  limits: ManufacturingRunServerLimits;
  logger?: (entry: Record<string, unknown>) => void;
  runtimeIdentity?: ManufacturingRunRuntimeIdentity;
}

class RequestFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly publicMessage: string
  ) {
    super(code);
    this.name = 'RequestFailure';
  }
}

function sendJson(
  response: ServerResponse,
  status: number,
  value: unknown,
  close = false
): void {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.byteLength,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...(close ? { connection: 'close' } : {}),
  });
  response.end(body);
}

function sendFailure(
  response: ServerResponse,
  status: number,
  failure: ManufacturingRunFailure,
  close = false
): void {
  sendJson(
    response,
    status,
    createManufacturingRunEnvelope({ failure }),
    close
  );
}

function contentTypeIsJson(request: IncomingMessage): boolean {
  const contentType = request.headers['content-type'];
  return (
    typeof contentType === 'string' &&
    /^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType.trim())
  );
}

function readRawBody(
  request: IncomingMessage,
  response: ServerResponse,
  limits: ManufacturingRunServerLimits
): Promise<Buffer> {
  const declaredLength = request.headers['content-length'];
  if (
    typeof declaredLength === 'string' &&
    Number(declaredLength) > limits.bodyLimitBytes
  ) {
    request.resume();
    throw new RequestFailure(
      413,
      'REQUEST_BODY_TOO_LARGE',
      'Request body exceeds the coordinator limit'
    );
  }
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let length = 0;
    let settled = false;
    const finish = (operation: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      operation();
    };
    const timer = setTimeout(() => {
      finish(() => {
        reject(new RequestFailure(
          408,
          'REQUEST_TIMEOUT',
          'Request body was not received in time'
        ));
        response.once('finish', () => request.destroy());
      });
    }, limits.requestTimeoutMs);
    timer.unref();
    request.on('data', (chunk: Buffer | string) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      length += buffer.byteLength;
      if (length > limits.bodyLimitBytes) {
        finish(() => {
          request.pause();
          reject(new RequestFailure(
            413,
            'REQUEST_BODY_TOO_LARGE',
            'Request body exceeds the coordinator limit'
          ));
        });
        return;
      }
      chunks.push(buffer);
    });
    request.once('end', () => finish(() => resolve(Buffer.concat(chunks, length))));
    request.once('aborted', () => finish(() => reject(new RequestFailure(
      400,
      'REQUEST_ABORTED',
      'Request was aborted'
    ))));
    request.once('error', () => finish(() => reject(new RequestFailure(
      400,
      'REQUEST_READ_FAILED',
      'Request body could not be read'
    ))));
  });
}

function notificationDisposition(
  status: string | undefined
): ManufacturingRunNotificationDisposition {
  switch (status) {
    case 'pending':
    case 'claimed':
    case 'delivery_unknown':
    case 'acknowledged':
      return status;
    default:
      return status === undefined ? 'empty' : 'none';
  }
}

interface InventoryBucket {
  locationId: string;
  sublocation: string;
  quantityOnHand: number;
  quantityAvailable?: number;
  serialNumbers: Set<string>;
}

function positiveInventoryQuantity(value: string | undefined): number {
  if (value === undefined) return 0;
  try {
    const number = Number(normalizeDecimal(value));
    return Number.isFinite(number) && number > 0 ? number : 0;
  } catch {
    return 0;
  }
}

function availabilityQuantityText(value: number): string {
  return Number.isFinite(value) ? normalizeDecimal(String(value)) : 'unknown';
}

function inventoryBuckets(product: Product): InventoryBucket[] {
  const buckets = new Map<string, InventoryBucket>();
  for (const line of product.inventoryLines ?? []) {
    const locationId = line.locationId?.trim() ?? '';
    if (!locationId) continue;
    const sublocation = line.sublocation?.trim() ?? '';
    const quantity = positiveInventoryQuantity(line.quantityOnHand);
    if (quantity <= 0) continue;
    const key = `${locationId}\0${sublocation}`;
    const bucket = buckets.get(key) ?? {
      locationId,
      sublocation,
      quantityOnHand: 0,
      serialNumbers: new Set<string>(),
    };
    bucket.quantityOnHand += quantity;
    const serial = line.serial?.trim();
    if (serial) bucket.serialNumbers.add(serial);
    buckets.set(key, bucket);
  }
  return [...buckets.values()].sort(
    (left, right) =>
      left.locationId.localeCompare(right.locationId) ||
      left.sublocation.localeCompare(right.sublocation)
  );
}

function flattenedManufacturingOrderLines(
  order: ManufacturingOrder
): Array<{ line: ManufacturingOrderLine; depth: number }> {
  const flattened: Array<{ line: ManufacturingOrderLine; depth: number }> = [];
  const stack = (order.lines ?? []).map((line) => ({ line, depth: 0 }));
  while (stack.length > 0) {
    const entry = stack.shift()!;
    flattened.push(entry);
    stack.unshift(
      ...(entry.line.manufacturingOrderLines ?? []).map((line) => ({
        line,
        depth: entry.depth + 1,
      }))
    );
  }
  return flattened;
}

function activeManufacturingOrderOwnsComponent(input: {
  order: ManufacturingOrder;
  manufacturingOrderId: string;
  rawLineId: string;
  productId: string;
  quantity: string;
  locationId: string | null;
}): { owned: boolean; nested: boolean } {
  const status = input.order.status?.trim().toLowerCase() ?? '';
  if (
    input.order.isCancelled === true ||
    input.order.isCompleted === true ||
    ['cancelled', 'canceled', 'completed', 'closed'].includes(status) ||
    input.order.manufacturingOrderId !== input.manufacturingOrderId ||
    input.locationId === null ||
    input.order.locationId !== input.locationId
  ) {
    return { owned: false, nested: false };
  }
  const matches = flattenedManufacturingOrderLines(input.order).filter(
    (entry) => entry.line.manufacturingOrderLineId === input.rawLineId
  );
  if (matches.length !== 1 || matches[0]!.line.productId !== input.productId) {
    return { owned: false, nested: false };
  }
  const quantity = matches[0]!.line.quantity?.standardQuantity ??
    matches[0]!.line.quantity?.uomQuantity;
  try {
    const owned = quantity !== undefined &&
      normalizeDecimal(quantity) === normalizeDecimal(input.quantity);
    return { owned, nested: owned && matches[0]!.depth > 1 };
  } catch {
    return { owned: false, nested: false };
  }
}

function availableInventoryBuckets(
  summary: ProductSummary,
  options: {
    buildReservedLocationId: string | null;
    ownedBuildReservedQuantity?: number;
    ownedManufacturingReservedQuantity?: number;
    requiredQuantity: number;
  }
): InventoryBucket[] {
  const buckets: InventoryBucket[] = [];
  for (const location of summary.locationSummaries ?? []) {
    const locationId = location.locationId?.trim() ?? '';
    if (!locationId) continue;
    const sublocations = location.sublocationSummaries ?? [];
    if (sublocations.length === 0) {
      const quantity = options.buildReservedLocationId === locationId
        ? effectiveBuildRunAvailableQuantity(location, {
          allowBuildReserved: true,
          ownedBuildReservedQuantity: options.ownedBuildReservedQuantity,
          ownedManufacturingReservedQuantity:
            options.ownedManufacturingReservedQuantity,
            requiredQuantity: options.requiredQuantity,
          })
        : positiveInventoryQuantity(location.quantityAvailable);
      if (quantity > 0) {
        buckets.push({
          locationId,
          sublocation: '',
          quantityOnHand: positiveInventoryQuantity(location.quantityOnHand),
          quantityAvailable: quantity,
          serialNumbers: new Set(),
        });
      }
      continue;
    }
    for (const sublocation of sublocations) {
      const name = sublocation.sublocation?.trim() ?? '';
      const quantity = options.buildReservedLocationId === locationId
        ? effectiveBuildRunAvailableQuantity(sublocation, {
          allowBuildReserved: true,
          ownedBuildReservedQuantity: options.ownedBuildReservedQuantity,
          ownedManufacturingReservedQuantity:
            options.ownedManufacturingReservedQuantity,
            requiredQuantity: options.requiredQuantity,
          })
        : positiveInventoryQuantity(sublocation.quantityAvailable);
      if (quantity > 0) {
        buckets.push({
          locationId,
          sublocation: name,
          quantityOnHand: positiveInventoryQuantity(
            sublocation.quantityOnHand
          ),
          quantityAvailable: quantity,
          serialNumbers: new Set(),
        });
      }
    }
  }
  return buckets.sort(
    (left, right) =>
      left.locationId.localeCompare(right.locationId) ||
      left.sublocation.localeCompare(right.sublocation)
  );
}

export function createCoordinatorComponentResolver(
  options: CoordinatorComponentResolverOptions
): ManufacturingRunComponentResolver {
  return {
    resolve: async (input) => {
      const parent = options.coordinator.snapshot(input.operationId);
      const matches = parent.expectedComponents.filter(
        (component) => component.rawLineId === input.rawLineId
      );
      if (matches.length !== 1) throw new Error('COMPONENT_STATE_DRIFT');
      const expected = matches[0]!;
      const requiredQuantity = Number(normalizeDecimal(expected.quantity));
      if (
        !Number.isSafeInteger(requiredQuantity) ||
        requiredQuantity <= 0 ||
        requiredQuantity > 100
      ) {
        throw new Error('UNSUPPORTED_COMPONENT_QUANTITY');
      }
      const recursiveChildren = (input.recursiveChildren ?? []).map((child) => ({
            sourceSerial: normalizedSerial(child.sourceSerial),
            finishedSerial: normalizedSerial(child.finishedSerial),
            locationId: child.locationId.trim(),
          }));
      if (
        recursiveChildren.some(
          (child) =>
            !child.sourceSerial || !child.finishedSerial || !child.locationId
        ) ||
        ['sourceSerial', 'finishedSerial'].some((field) =>
          new Set(
            recursiveChildren.map((child) =>
              child[field as 'sourceSerial' | 'finishedSerial']
            )
          ).size !== recursiveChildren.length
        )
      ) {
        throw new Error('RECURSIVE_CHILD_SERIALS_INVALID');
      }
      if (
        recursiveChildren.length > 0 &&
        recursiveChildren.length !== requiredQuantity
      ) {
        throw new Error('RECURSIVE_CHILD_CARDINALITY_MISMATCH');
      }
      const parentMetadata = durableRunMetadata(
        options.store,
        parent.operationId
      );
      if (expected.disposition === 'dependency_satisfied') {
        options.coordinator.finalizeSatisfiedDependencyLine({
          operationId: parent.operationId,
          rawLineId: expected.rawLineId,
        });
        return options.coordinator.snapshot(parent.operationId);
      }
      if (
        expected.disposition !== 'missing' &&
        !(
          expected.disposition === 'dependency_pending' &&
          recursiveChildren.length > 0
        )
      ) {
        return parent;
      }
      const rate = options.store.consumeRateBudget({
        now: options.now?.() ?? new Date(),
      });
      if (!rate.allowed) throw new Error('RATE_BUDGET_EXHAUSTED');
      const product = await options.client.get<Product>(
        `/products/${expected.productId}`,
        { include: ['inventoryLines', 'itemBoms'] }
      );
      const summaryRate = options.store.consumeRateBudget({
        now: options.now?.() ?? new Date(),
      });
      if (!summaryRate.allowed) throw new Error('RATE_BUDGET_EXHAUSTED');
      const summary = await options.client.get<ProductSummary>(
        `/products/${expected.productId}/summary`,
        { include: ['locationSummaries', 'sublocationSummaries'] }
      );
      const serialized =
        product.trackSerials === true || product.isSerialized === true;
      const buckets = inventoryBuckets(product);
      let allowBuildReserved = false;
      let ownedBuildReservedQuantity: number | undefined;
      let ownedManufacturingReservedQuantity: number | undefined;
      const sameProductComponents = parent.expectedComponents.filter(
        (component) => component.productId === expected.productId
      );
      const quantities = sameProductComponents.map((component) =>
        Number(normalizeDecimal(component.quantity))
      );
      const quantitiesAreValid = quantities.every(
        (quantity) => Number.isSafeInteger(quantity) && quantity > 0
      );
      const potentialOwnedManufacturingReservedQuantity = quantitiesAreValid
        ? quantities.reduce((sum, quantity) => sum + quantity, 0)
        : undefined;
      const potentialOwnedBuildReservedQuantity = positiveInventoryQuantity(
        summary.quantityReservedForBuilds
      );
      const potentialAvailableBuckets =
        potentialOwnedManufacturingReservedQuantity === undefined
          ? []
          : availableInventoryBuckets(summary, {
              buildReservedLocationId: parentMetadata.locationId,
              ...(potentialOwnedBuildReservedQuantity > 0
                ? {
                    ownedBuildReservedQuantity:
                      potentialOwnedBuildReservedQuantity,
                  }
                : {}),
              ownedManufacturingReservedQuantity:
                potentialOwnedManufacturingReservedQuantity,
              requiredQuantity,
            });
      const potentialEffectiveAggregateAvailable =
        potentialOwnedManufacturingReservedQuantity === undefined
          ? positiveInventoryQuantity(summary.quantityAvailable)
          : effectiveBuildRunAvailableQuantity(summary, {
              allowBuildReserved: true,
              ...(potentialOwnedBuildReservedQuantity > 0
                ? {
                    ownedBuildReservedQuantity:
                      potentialOwnedBuildReservedQuantity,
                  }
                : {}),
              ownedManufacturingReservedQuantity:
                potentialOwnedManufacturingReservedQuantity,
              requiredQuantity,
            });
      const potentialAggregateFallback =
        potentialOwnedManufacturingReservedQuantity !== undefined &&
        (summary.locationSummaries ?? []).length === 0 &&
        potentialEffectiveAggregateAvailable >= requiredQuantity &&
        parentMetadata.locationId !== null &&
        buckets.length === 1 &&
        buckets[0]!.locationId === parentMetadata.locationId &&
        buckets[0]!.quantityOnHand >= requiredQuantity;
      const reservationCouldCoverShortage =
        potentialOwnedManufacturingReservedQuantity !== undefined &&
        (
          potentialAvailableBuckets.some(
            (bucket) =>
              (bucket.quantityAvailable ?? 0) >= requiredQuantity
          ) ||
          potentialAggregateFallback
        );
      if (
        !serialized &&
        positiveInventoryQuantity(summary.quantityAvailable) <
          requiredQuantity &&
        reservationCouldCoverShortage
      ) {
        const orderRate = options.store.consumeRateBudget({
          now: options.now?.() ?? new Date(),
        });
        if (!orderRate.allowed) throw new Error('RATE_BUDGET_EXHAUSTED');
        const currentOrder = await options.client.get<ManufacturingOrder>(
          `/manufacturing-orders/${parent.manufacturingOrderId}`,
          { include: ['lines'] }
        );
        const ownership = sameProductComponents.map((component) => ({
          component,
          ownership: activeManufacturingOrderOwnsComponent({
            order: currentOrder,
            manufacturingOrderId: parent.manufacturingOrderId,
            rawLineId: component.rawLineId,
            productId: component.productId,
            quantity: component.quantity,
            locationId: parentMetadata.locationId,
          }),
        }));
        allowBuildReserved =
          ownership.length > 0 &&
          ownership.every((entry) => entry.ownership.owned) &&
          quantitiesAreValid;
        if (allowBuildReserved) {
          ownedManufacturingReservedQuantity = quantities.reduce(
            (sum, quantity) => sum + quantity,
            0
          );
          ownedBuildReservedQuantity = ownership.reduce(
            (sum, entry, index) =>
              entry.ownership.nested ? sum + quantities[index]! : sum,
            0
          );
        }
      }
      const availableBuckets = availableInventoryBuckets(summary, {
        buildReservedLocationId: allowBuildReserved
          ? parentMetadata.locationId
          : null,
        ...(allowBuildReserved
          ? {
              ...(ownedBuildReservedQuantity === undefined ||
              ownedBuildReservedQuantity === 0
                ? {}
                : { ownedBuildReservedQuantity }),
              ...(ownedManufacturingReservedQuantity === undefined
                ? {}
                : { ownedManufacturingReservedQuantity }),
            }
          : {}),
        requiredQuantity,
      });
      const sourceBinding = sourceSerialBindingForRun(
        options.store,
        parent.operationId
      );
      if (sourceBinding?.rawLineId === expected.rawLineId) {
        if (
          sourceBinding.productId !== expected.productId ||
          normalizeDecimal(expected.quantity) !== '1'
        ) {
          throw new Error('SOURCE_SERIAL_BINDING_COMPONENT_DRIFT');
        }
        const exactInventoryLines = (product.inventoryLines ?? []).filter(
          (line) =>
            normalizedSerial(line.serial ?? '') ===
              sourceBinding.sourceSerial &&
            line.locationId?.trim() === sourceBinding.locationId &&
            (line.sublocation?.trim() || null) ===
              sourceBinding.sublocation &&
            positiveInventoryQuantity(line.quantityOnHand) > 0
        );
        // inFlow can omit the per-location summary projection even when the
        // authoritative product total is populated. The binding already
        // proves that this exact serial has one positive inventory line at the
        // selected location; the v2 contract deliberately pairs that proof
        // with aggregate availability so unrelated reservations do not make
        // the selected serial appear unavailable.
        const exactAvailable = positiveInventoryQuantity(
          summary.quantityAvailable
        );
        if (
          serialized &&
          exactInventoryLines.length === 1 &&
          exactAvailable >= requiredQuantity
        ) {
          options.coordinator.registerComponent({
            operationId: input.operationId,
            rawLineId: expected.rawLineId,
            productId: expected.productId,
            quantity: expected.quantity,
            locationId: sourceBinding.locationId,
            ...(sourceBinding.sublocation
              ? { sublocation: sourceBinding.sublocation }
              : {}),
            serialized: true,
            serialNumbers: [sourceBinding.sourceSerial],
          });
          return options.coordinator.snapshot(input.operationId);
        }
        const blocker = createManufacturingRunBlockerEvidence({
          code: 'SOURCE_SERIAL_UNAVAILABLE',
          sku: product.sku?.trim() || 'unknown',
          productId: expected.productId,
          rawLineId: expected.rawLineId,
          requiredQuantity: expected.quantity,
          availableQuantity: normalizeDecimal(String(exactAvailable)),
          locationId: sourceBinding.locationId,
          sourceSerial: sourceBinding.sourceSerial,
          detail:
            'the immutably bound source serial is not authoritatively available; no alternative serial was considered',
        });
        options.coordinator.blockComponent({
          operationId: parent.operationId,
          rawLineId: expected.rawLineId,
          reason: blocker.detail,
          evidenceHash: canonicalHash(
            {
              blocker,
              exactInventoryLineCount: exactInventoryLines.length,
            },
            'manufacturing-run/source-serial-resolution-evidence/v1'
          ),
          blockerEvidence: blocker,
        });
        return options.coordinator.snapshot(parent.operationId);
      }
      const requestedSerials =
        serialized &&
        product.isManufacturable === true &&
        recursiveChildren.length === requiredQuantity
          ? recursiveChildren.map((child) =>
              normalizedSerial(child.finishedSerial)
            )
          : [];
      const requestedSerialSet = new Set(requestedSerials);
      const presentRequestedSerials = new Set<string>();
      for (const bucket of buckets) {
        for (const serial of bucket.serialNumbers) {
          const normalized = normalizedSerial(serial);
          if (requestedSerialSet.has(normalized)) {
            presentRequestedSerials.add(normalized);
          }
        }
      }
      const serializedAvailabilityAmbiguous = serialized && buckets.some(
        (bucket) => {
          const summaryBucket = availableBuckets.find(
            (candidate) =>
              candidate.locationId === bucket.locationId &&
              candidate.sublocation === bucket.sublocation
          );
          return (
            (summaryBucket?.quantityAvailable ?? 0) < bucket.quantityOnHand
          );
        }
      );
      const aggregateAvailable = positiveInventoryQuantity(
        summary.quantityAvailable
      );
      const effectiveAggregateAvailable = serialized
        ? aggregateAvailable
        : effectiveBuildRunAvailableQuantity(summary, {
            allowBuildReserved,
            ...(allowBuildReserved
              ? {
                  ...(ownedBuildReservedQuantity === undefined ||
                  ownedBuildReservedQuantity === 0
                    ? {}
                    : { ownedBuildReservedQuantity }),
                  ...(ownedManufacturingReservedQuantity === undefined
                    ? {}
                    : { ownedManufacturingReservedQuantity }),
                }
              : {}),
            requiredQuantity,
          });
      // inFlow can omit the location-summary availability projection while
      // still returning both authoritative aggregate availability and a
      // positive product inventory line. For an ordinary (non-serialized)
      // component, use that pair only when the run's selected location and
      // the product inventory identify one unambiguous positive bucket. This
      // keeps the fallback fail-closed when stock spans locations or
      // sublocations, where aggregate availability cannot prove which bucket
      // is free.
      const aggregateFallbackBucket =
        !serialized &&
        (summary.locationSummaries ?? []).length === 0 &&
        effectiveAggregateAvailable >= requiredQuantity &&
        parentMetadata.locationId !== null &&
        buckets.length === 1 &&
        buckets[0]!.locationId === parentMetadata.locationId &&
        buckets[0]!.quantityOnHand >= requiredQuantity
          ? {
              ...buckets[0]!,
              quantityAvailable: effectiveAggregateAvailable,
            }
          : undefined;
      const available = serialized
        ? buckets.find((bucket) => {
            const summaryBucket = availableBuckets.find(
              (candidate) =>
                candidate.locationId === bucket.locationId &&
                candidate.sublocation === bucket.sublocation
            );
            const exactRequestedSerialsAvailable =
              requestedSerials.length === 0 ||
              requestedSerials.every((requested) =>
                [...bucket.serialNumbers].some(
                  (serial) => normalizedSerial(serial) === requested
                )
              );
            return (
              exactRequestedSerialsAvailable &&
              bucket.serialNumbers.size >= requiredQuantity &&
              (summaryBucket?.quantityAvailable ?? 0) >= requiredQuantity &&
              (summaryBucket?.quantityAvailable ?? 0) >=
                bucket.quantityOnHand
            );
          })
        : availableBuckets.find(
            (bucket) =>
              (bucket.quantityAvailable ?? 0) >= requiredQuantity
          ) ?? aggregateFallbackBucket;
      if (available && expected.disposition === 'missing') {
        const serialNumbers = serialized
          ? requestedSerials.length > 0
            ? requestedSerials.map((requested) =>
                [...available.serialNumbers].find(
                  (serial) => normalizedSerial(serial) === requested
                )!
              )
            : [...available.serialNumbers].sort().slice(0, requiredQuantity)
          : [];
        options.coordinator.registerComponent({
          operationId: input.operationId,
          rawLineId: expected.rawLineId,
          productId: expected.productId,
          quantity: expected.quantity,
          locationId: available.locationId,
          ...(available.sublocation
            ? { sublocation: available.sublocation }
            : {}),
          serialized,
          serialNumbers,
        });
        return options.coordinator.snapshot(input.operationId);
      }
      if (
        (
          requestedSerials.length > 0
            ? presentRequestedSerials.size === 0
            : !serializedAvailabilityAmbiguous
        ) &&
        product.isManufacturable === true &&
        (product.itemBoms?.length ?? 0) > 0 &&
        recursiveChildren.length > 0
      ) {
        for (const [parentChildIndex, child] of recursiveChildren.entries()) {
          const idempotencyKeyHash = createHash('sha256')
            .update([
              'manufacturing-run/component-child/v2',
              parent.runHash,
              expected.rawLineId,
              String(parentChildIndex),
              child.sourceSerial,
              child.finishedSerial,
            ].join('\n'))
            .digest('hex');
          options.coordinator.beginChildWithDependency({
            parentOperationId: parent.operationId,
            parentRawLineId: expected.rawLineId,
            parentChildIndex,
            idempotencyKeyHash,
            identity: {
              schemaVersion: 'manufacturing-run-identity/v2',
              companyId: options.companyId,
              finishedProductId: expected.productId,
              sourceSerial: child.sourceSerial,
              finishedSerial: child.finishedSerial,
            },
            locationId: child.locationId,
            remarks: encodeManufacturingRunRemarks({
              remarks:
                `recursive child ${parentChildIndex + 1}/${requiredQuantity} ` +
                `for ${parent.operationId}/${expected.rawLineId}`,
              ...(parentMetadata.notificationContext === null
                ? {}
                : {
                    notificationContext:
                      parentMetadata.notificationContext,
                  }),
            }),
          });
        }
        return options.coordinator.snapshot(parent.operationId);
      }
      const evidenceHash = canonicalHash(
        {
          productId: expected.productId,
          quantity: expected.quantity,
          serialized,
          isManufacturable: product.isManufacturable === true,
          hasBom: (product.itemBoms?.length ?? 0) > 0,
          inventory: buckets.map((bucket) => ({
            locationId: bucket.locationId,
            sublocation: bucket.sublocation,
            quantityOnHand: normalizeDecimal(String(bucket.quantityOnHand)),
            serialNumbers: [...bucket.serialNumbers].sort(),
          })),
          availability: availableBuckets.map((bucket) => ({
            locationId: bucket.locationId,
            sublocation: bucket.sublocation,
            quantityOnHand: normalizeDecimal(String(bucket.quantityOnHand)),
            quantityAvailable: normalizeDecimal(
              String(bucket.quantityAvailable ?? 0)
            ),
          })),
          aggregateAvailability: normalizeDecimal(
            String(aggregateAvailable)
          ),
          effectiveAggregateAvailability: availabilityQuantityText(
            effectiveAggregateAvailable
          ),
          aggregateFallbackEligible: aggregateFallbackBucket !== undefined,
          serializedAvailabilityAmbiguous,
        },
        'manufacturing-run/component-resolution-evidence/v1'
      );
      options.coordinator.blockComponent({
        operationId: parent.operationId,
        rawLineId: expected.rawLineId,
        reason:
          'authoritative inventory shortage with no safe recursive resolution',
        evidenceHash,
        blockerEvidence: createManufacturingRunBlockerEvidence({
          code: 'COMPONENT_INVENTORY_SHORTAGE',
          sku: product.sku?.trim() || 'unknown',
          productId: expected.productId,
          rawLineId: expected.rawLineId,
          requiredQuantity: expected.quantity,
          availableQuantity: availabilityQuantityText(
            (summary.locationSummaries ?? []).length === 0
              ? effectiveAggregateAvailable
              : Math.max(
                  0,
                  ...availableBuckets.map(
                    (bucket) => bucket.quantityAvailable ?? 0
                  )
                )
          ),
          locationId:
            parentMetadata.locationId ??
            availableBuckets[0]?.locationId ??
            'unknown',
          sourceSerial: null,
          detail:
            'authoritative inventory shortage with no safe recursive resolution',
        }),
      });
      return options.coordinator.snapshot(parent.operationId);
    },
  };
}

async function dispatchRoute(
  route: string,
  body: unknown,
  options: ManufacturingRunServerOptions,
  authContext: ManufacturingRunAuthContext
): Promise<{ status: number; body: unknown }> {
  if (route === '/v1/manufacturing-runs/ready') {
    const readiness = await options.readiness();
    const failure = readiness.ready
      ? null
      : {
          code: Object.values(readiness.checks).find(
            (check) => !check.ok
          )?.code ?? 'WRITE_GATE_CLOSED',
          message: 'Coordinator unavailable',
        };
    return {
      status: readiness.ready ? 200 : 503,
      body: {
        ...createManufacturingRunEnvelope({ failure }),
        readiness,
      },
    };
  }
  if (route === '/v1/manufacturing-runs/begin') {
    const request = body as ManufacturingRunBeginRequest;
    if (
      request.identity.companyId.toLowerCase() !==
      options.expectedCompanyId.toLowerCase()
    ) {
      throw new RequestFailure(
        403,
        'AUTH_COMPANY_BODY_MISMATCH',
        'Request tenant does not match authenticated tenant'
      );
    }
    const idempotencyKeyHash = createHash('sha256')
      .update(request.idempotencyKey)
      .digest('hex');
    const status = options.coordinator.begin({
      idempotencyKeyHash,
      identity: request.identity,
      locationId: request.locationId,
      remarks: encodeManufacturingRunRemarks({
        remarks: request.remarks,
        notificationContext: request.notificationContext,
      }),
    });
    const snapshot = options.coordinator.snapshot(status.operationId);
    return {
      status: 202,
      body: contextualEnvelope(options.store, snapshot),
    };
  }
  if (route === '/v1/manufacturing-runs/component/resolve') {
    const snapshot = await options.componentResolver.resolve(
      body as ManufacturingRunComponentResolveRequest
    );
    return {
      status: manufacturingRunHttpStatus({ snapshot }),
      body: contextualEnvelope(options.store, snapshot),
    };
  }
  if (route === '/v1/manufacturing-runs/component') {
    const request = body as ManufacturingRunComponentRequest;
    const { operationId, ...component } = request;
    const status = options.coordinator.registerComponent({
      operationId,
      ...component,
    });
    const snapshot = options.coordinator.snapshot(status.operationId);
    return {
      status: manufacturingRunHttpStatus({ snapshot }),
      body: contextualEnvelope(options.store, snapshot),
    };
  }
  if (route === '/v1/manufacturing-runs/status') {
    const request = body as ManufacturingRunStatusRequest;
    await options.coordinator.status(request.operationId);
    const snapshot = options.coordinator.snapshot(request.operationId);
    return {
      status: manufacturingRunHttpStatus({ snapshot }),
      body: contextualEnvelope(options.store, snapshot),
    };
  }
  if (route === '/v1/manufacturing-runs/notifications/claim') {
    const request = body as ManufacturingRunNotificationClaimRequest;
    const pending = options.store.getNotification(request.notificationId);
    const pendingContext = pending
      ? durableRunMetadata(options.store, pending.operationId)
          .notificationContext
      : null;
    if (pending && pendingContext === null) {
      throw new Error('NOTIFICATION_CONTEXT_REQUIRED');
    }
    const notification = options.store.claimNextNotification({
      ...request,
      now: options.now?.() ?? new Date(),
    });
    const snapshot = notification
      ? options.coordinator.snapshot(notification.operationId)
      : undefined;
    const notificationContext = notification
      ? pendingContext ?? durableRunMetadata(
          options.store,
          notification.operationId
        ).notificationContext
      : null;
    const envelope = snapshot
      ? contextualEnvelope(
          options.store,
          snapshot,
          notificationDisposition(notification?.status)
        )
      : createManufacturingRunEnvelope({
          notificationDisposition: notificationDisposition(
            notification?.status
          ),
        });
    return {
      status: 200,
      body: {
        ...envelope,
        notification: notification && notificationContext
          ? { ...notification, ...notificationContext }
          : notification ?? null,
      },
    };
  }
  if (route === '/v1/manufacturing-runs/notifications/ack') {
    const request = body as ManufacturingRunNotificationAckRequest;
    const notification = options.store.ackNotification({
      ...request,
      now: options.now?.() ?? new Date(),
    });
    const snapshot = options.coordinator.snapshot(notification.operationId);
    const notificationContext = durableRunMetadata(
      options.store,
      notification.operationId
    ).notificationContext;
    return {
      status: 200,
      body: {
        ...contextualEnvelope(
          options.store,
          snapshot,
          notificationDisposition(notification.status)
        ),
        notification: notificationContext
          ? { ...notification, ...notificationContext }
          : notification,
      },
    };
  }
  if (route === '/v1/manufacturing-runs/notifications/delivery-unknown') {
    const request = body as ManufacturingRunNotificationDeliveryUnknownRequest;
    const notification = options.store.markNotificationDeliveryUnknown({
      ...request,
      now: options.now?.() ?? new Date(),
    });
    const snapshot = options.coordinator.snapshot(notification.operationId);
    const notificationContext = durableRunMetadata(
      options.store,
      notification.operationId
    ).notificationContext;
    return {
      status: 200,
      body: {
        ...contextualEnvelope(
          options.store,
          snapshot,
          notificationDisposition(notification.status)
        ),
        notification: notificationContext
          ? { ...notification, ...notificationContext }
          : notification,
      },
    };
  }
  if (route === '/v1/manufacturing-runs/notifications/reconcile') {
    const request = body as ManufacturingRunNotificationReconcileRequest;
    const notification = options.store.reconcileNotification({
      ...request,
      now: options.now?.() ?? new Date(),
    });
    const snapshot = options.coordinator.snapshot(notification.operationId);
    const notificationContext = durableRunMetadata(
      options.store,
      notification.operationId
    ).notificationContext;
    return {
      status: 200,
      body: {
        ...contextualEnvelope(
          options.store,
          snapshot,
          notificationDisposition(notification.status)
        ),
        notification: notificationContext
          ? { ...notification, ...notificationContext }
          : notification,
      },
    };
  }
  if (route === '/v1/manufacturing-runs/operator/resolve') {
    const request = body as ManufacturingRunOperatorResolveRequest;
    if (request.approvedAt !== authContext.timestamp) {
      throw new RequestFailure(
        400,
        'MANUAL_APPROVAL_TIMESTAMP_MISMATCH',
        'Approval timestamp must match the authenticated request timestamp'
      );
    }
    const status = options.coordinator.resolveManual({
      ...request,
      approvalEvidence: authContext,
    });
    const snapshot = options.coordinator.snapshot(status.operationId);
    return {
      status: 200,
      body: contextualEnvelope(options.store, snapshot),
    };
  }
  if (route === '/v1/manufacturing-runs/operator/rearm-proven-no-write') {
    const request = body as ManufacturingRunOperatorRearmProvenNoWriteRequest;
    const status = await options.coordinator.rearmProvenNoWrite(request);
    const snapshot = options.coordinator.snapshot(status.operationId);
    return {
      status: 200,
      body: contextualEnvelope(options.store, snapshot),
    };
  }
  throw new RequestFailure(404, 'NOT_FOUND', 'Route not found');
}

function publicRouteFailure(error: unknown): {
  status: number;
  failure: ManufacturingRunFailure;
} {
  if (error instanceof RequestFailure) {
    return {
      status: error.status,
      failure: { code: error.code, message: error.publicMessage },
    };
  }
  const failure = sanitizeManufacturingRunFailure(error);
  return {
    status: manufacturingRunHttpStatus({ failure }),
    failure,
  };
}

export function createManufacturingRunServer(
  options: ManufacturingRunServerOptions
): Server {
  const logger = options.logger ?? ((entry: Record<string, unknown>) => {
    console.error(JSON.stringify(entry));
  });
  const server = createServer(
    {
      maxHeaderSize: options.limits.maxHeaderBytes,
      requireHostHeader: true,
    },
    async (request, response) => {
      const requestId = randomUUID();
      const started = Date.now();
      let status = 500;
      let code = 'INTERNAL_ERROR';
      const method = request.method ?? '';
      const exactUrl = request.url ?? '';
      let route = '';
      try {
        const parsedUrl = new URL(exactUrl, 'http://coordinator.invalid');
        route = parsedUrl.pathname;
        if (
          method === 'GET' &&
          exactUrl === '/healthz'
        ) {
          status = 200;
          code = 'HEALTHY';
          sendJson(response, status, { status: 'ok' });
          return;
        }
        if (method === 'GET' && route === '/healthz' && parsedUrl.searchParams.has('probe')) {
          const nonce = parsedUrl.searchParams.get('probe') ?? '';
          if (!/^[A-Za-z0-9_-]{16,128}$/.test(nonce) || parsedUrl.searchParams.size !== 1) {
            status = 400;
            code = 'IDENTITY_PROBE_INVALID';
            sendJson(response, status, { error: { code } });
            return;
          }
          const identity = options.runtimeIdentity;
          if (!identity || !/^[0-9a-f]{40}$/.test(identity.releaseOid)
            || !/^[0-9a-f]{64}$/.test(identity.materialSha256)) {
            status = 503;
            code = 'RUNTIME_IDENTITY_UNAVAILABLE';
            sendJson(response, status, { error: { code } });
            return;
          }
          status = 200;
          code = 'RUNTIME_IDENTITY';
          sendJson(response, status, {
            status: 'ok',
            nonce,
            releaseOid: identity.releaseOid,
            materialSha256: identity.materialSha256,
            instanceId: identity.instanceId,
            processId: identity.processId,
            startedAt: identity.startedAt,
          });
          return;
        }
        if (!isManufacturingRunRoute(route) || exactUrl !== route) {
          status = 404;
          code = 'NOT_FOUND';
          sendJson(response, status, { error: { code } });
          return;
        }
        if (method !== 'POST') {
          status = 405;
          code = 'METHOD_NOT_ALLOWED';
          response.setHeader('allow', 'POST');
          sendJson(response, status, { error: { code } });
          return;
        }
        if (!contentTypeIsJson(request)) {
          throw new RequestFailure(
            415,
            'JSON_CONTENT_TYPE_REQUIRED',
            'Content-Type must be application/json'
          );
        }
        const rawBody = await readRawBody(request, response, options.limits);
        const authOptions: ManufacturingRunAuthOptions = {
          expectedAudience: options.expectedAudience,
          expectedCompanyId: options.expectedCompanyId,
          keyring: options.keyring,
          nonceStore: options.store,
          now: options.now,
        };
        let authContext: ManufacturingRunAuthContext;
        try {
          authContext = verifyManufacturingRunRequest({
            method,
            url: exactUrl,
            rawBody,
            headers: request.headers,
            ...authOptions,
          });
        } catch (error) {
          if (!(error instanceof ManufacturingRunAuthError)) throw error;
          throw new RequestFailure(
            401,
            'AUTHENTICATION_FAILED',
            'Request authentication failed'
          );
        }
        let parsedBody: unknown;
        try {
          parsedBody = JSON.parse(rawBody.toString('utf8')) as unknown;
        } catch {
          throw new RequestFailure(400, 'INVALID_JSON', 'Request body is not valid JSON');
        }
        try {
          parsedBody = parseManufacturingRunRouteBody(route, parsedBody);
        } catch (error) {
          if (!(error instanceof ZodError)) throw error;
          throw new RequestFailure(
            400,
            'INVALID_REQUEST_BODY',
            'Request body does not match the route contract'
          );
        }
        const result = await dispatchRoute(
          route,
          parsedBody,
          options,
          authContext
        );
        status = result.status;
        code = status < 400 ? 'OK' : 'OPERATION_FAILED';
        sendJson(response, status, result.body);
      } catch (error) {
        if (response.headersSent) return;
        const result = publicRouteFailure(error);
        status = result.status;
        code = result.failure.code;
        sendFailure(
          response,
          status,
          result.failure,
          status === 408 || status === 413
        );
      } finally {
        logger({
          event: 'manufacturing_run_http_request',
          requestId,
          method,
          route: route || 'invalid',
          status,
          code,
          durationMs: Math.max(0, Date.now() - started),
        });
      }
    }
  );
  server.requestTimeout = options.limits.requestTimeoutMs;
  server.headersTimeout = options.limits.headersTimeoutMs;
  server.keepAliveTimeout = options.limits.keepAliveTimeoutMs;
  server.maxHeadersCount = 100;
  server.maxRequestsPerSocket = 100;
  return server;
}
