import { createHash, createHmac, randomUUID } from 'node:crypto';
import {
  MANUFACTURING_RUN_AUTH_VERSION,
  manufacturingRunCanonicalMaterial,
} from '../http/manufacturing-run-auth.js';
import type { WebhookEventRecord } from '../core/manufacturing-run-store.js';
import { stableStringify } from '../core/canonical-json.js';

export const MANUFACTURING_RUN_CALLBACK_VERSION =
  'manufacturing-run-callback/v1' as const;

export interface ManufacturingRunCallbackEnvelope {
  schemaVersion: typeof MANUFACTURING_RUN_CALLBACK_VERSION;
  kind: WebhookEventRecord['kind'];
  eventId: string;
  operationId: string;
  stateRevision: number;
  marker: string;
  audience: string;
  companyId: string;
  timestamp: string;
  nonce: string;
  kid: string;
  payload: string;
  payloadSha256: string;
  signature: string;
}

type UnsignedCallbackEnvelope = Omit<
  ManufacturingRunCallbackEnvelope,
  'signature'
>;

function canonicalCallbackField(value: string, name: string): string {
  if (value.length < 1 || value.includes('\n') || value.includes('\r')) {
    throw new Error(`CALLBACK_CANONICAL_FIELD_INVALID:${name}`);
  }
  return value;
}

export function manufacturingRunCallbackCanonicalMaterial(
  callback: UnsignedCallbackEnvelope
): string {
  if (
    !Number.isSafeInteger(callback.stateRevision) ||
    callback.stateRevision < 1
  ) {
    throw new Error('CALLBACK_CANONICAL_FIELD_INVALID:stateRevision');
  }
  if (!/^[0-9]+$/.test(callback.timestamp)) {
    throw new Error('CALLBACK_CANONICAL_FIELD_INVALID:timestamp');
  }
  if (!/^[0-9a-f]{64}$/.test(callback.payloadSha256)) {
    throw new Error('CALLBACK_CANONICAL_FIELD_INVALID:payloadSha256');
  }
  return [
    canonicalCallbackField(callback.schemaVersion, 'schemaVersion'),
    canonicalCallbackField(callback.kind, 'kind'),
    canonicalCallbackField(callback.eventId, 'eventId'),
    canonicalCallbackField(callback.operationId, 'operationId'),
    String(callback.stateRevision),
    canonicalCallbackField(callback.marker, 'marker'),
    canonicalCallbackField(callback.audience, 'audience'),
    canonicalCallbackField(callback.companyId, 'companyId'),
    callback.timestamp,
    canonicalCallbackField(callback.nonce, 'nonce'),
    canonicalCallbackField(callback.kid, 'kid'),
    callback.payloadSha256,
  ].join('\n');
}

function callbackPayloadIdentity(event: WebhookEventRecord): {
  operationId: string;
  stateRevision: number;
  marker: string;
  payload: string;
} {
  if (
    event.payload === null ||
    typeof event.payload !== 'object' ||
    Array.isArray(event.payload)
  ) {
    throw new Error('WEBHOOK_PAYLOAD_INVALID');
  }
  const value = event.payload as Record<string, unknown>;
  if (
    value.operationId !== event.operationId ||
    !Number.isSafeInteger(value.stateRevision) ||
    (value.stateRevision as number) < 1 ||
    typeof value.marker !== 'string' ||
    value.marker.length < 1
  ) {
    throw new Error('WEBHOOK_PAYLOAD_IDENTITY_INVALID');
  }
  if (
    event.kind === 'run_ready' &&
    value.marker !== event.operationMarker
  ) {
    throw new Error('WEBHOOK_PAYLOAD_MARKER_INVALID');
  }
  return {
    operationId: value.operationId,
    stateRevision: value.stateRevision as number,
    marker: value.marker,
    payload: stableStringify(value),
  };
}

interface WebhookStore {
  claimNextWebhookEvent(input: {
    claimTtlMs: number;
    now?: Date;
  }): WebhookEventRecord | undefined;
  completeWebhookEvent(input: {
    eventId: string;
    claimToken: string;
    now?: Date;
  }): WebhookEventRecord;
  retryWebhookEvent(input: {
    eventId: string;
    claimToken: string;
    maxAttempts: number;
    retryAt: Date;
    errorCode: string;
    now?: Date;
  }): WebhookEventRecord;
}

export interface ManufacturingWebhookDeliveryOptions {
  store: WebhookStore;
  endpoints: Record<WebhookEventRecord['kind'], string>;
  signing: {
    kid: string;
    secret: string | Uint8Array;
    audience: string;
    companyId: string;
  };
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
  nonce?: () => string;
  maxAttempts: number;
  retryDelayMs: number;
  timeoutMs: number;
  claimTtlMs: number;
}

export async function deliverNextManufacturingWebhook(
  options: ManufacturingWebhookDeliveryOptions
): Promise<'idle' | 'delivered' | 'retry_scheduled' | 'exhausted'> {
  if (
    !Number.isSafeInteger(options.timeoutMs) ||
    options.timeoutMs < 1 ||
    options.timeoutMs >= options.claimTtlMs
  ) {
    throw new Error('WEBHOOK_TIMEOUT_MUST_PRECEDE_CLAIM_TTL');
  }
  const now = options.now?.() ?? new Date();
  const event = options.store.claimNextWebhookEvent({
    claimTtlMs: options.claimTtlMs,
    now,
  });
  if (!event) return 'idle';
  if (!event.claimToken) throw new Error('WEBHOOK_CLAIM_TOKEN_MISSING');

  const endpoint = new URL(options.endpoints[event.kind]);
  if (endpoint.protocol !== 'https:') {
    throw new Error('WEBHOOK_HTTPS_REQUIRED');
  }
  const timestamp = String(Math.floor(now.getTime() / 1_000));
  const nonce = options.nonce?.() ?? randomUUID();
  const identity = callbackPayloadIdentity(event);
  const payloadSha256 = createHash('sha256')
    .update(identity.payload)
    .digest('hex');
  const unsignedCallback: UnsignedCallbackEnvelope = {
    schemaVersion: MANUFACTURING_RUN_CALLBACK_VERSION,
    kind: event.kind,
    eventId: event.eventId,
    operationId: identity.operationId,
    stateRevision: identity.stateRevision,
    marker: identity.marker,
    audience: options.signing.audience,
    companyId: options.signing.companyId,
    timestamp,
    nonce,
    kid: options.signing.kid,
    payload: identity.payload,
    payloadSha256,
  };
  const callback: ManufacturingRunCallbackEnvelope = {
    ...unsignedCallback,
    signature: createHmac('sha256', options.signing.secret)
      .update(manufacturingRunCallbackCanonicalMaterial(unsignedCallback))
      .digest('hex'),
  };
  const body = JSON.stringify(callback);
  const signature = createHmac('sha256', options.signing.secret)
    .update(manufacturingRunCanonicalMaterial({
      version: MANUFACTURING_RUN_AUTH_VERSION,
      method: 'POST',
      pathAndQuery: `${endpoint.pathname}${endpoint.search}`,
      audience: options.signing.audience,
      companyId: options.signing.companyId,
      timestamp,
      nonce,
      kid: options.signing.kid,
      rawBody: Buffer.from(body),
    }))
    .digest('hex');

  let errorCode: string | undefined;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  timeout.unref();
  try {
    const response = await (options.fetch ?? globalThis.fetch)(endpoint.toString(), {
      method: 'POST',
      body,
      headers: {
        'content-type': 'application/json',
        'x-inflow-auth-version': MANUFACTURING_RUN_AUTH_VERSION,
        'x-inflow-key-id': options.signing.kid,
        'x-inflow-timestamp': timestamp,
        'x-inflow-nonce': nonce,
        'x-inflow-audience': options.signing.audience,
        'x-inflow-company-id': options.signing.companyId,
        'x-inflow-signature': signature,
        'x-inflow-event-id': event.eventId,
      },
      redirect: 'error',
      signal: controller.signal,
    });
    if (response.status >= 200 && response.status < 300) {
      options.store.completeWebhookEvent({
        eventId: event.eventId,
        claimToken: event.claimToken,
        now,
      });
      return 'delivered';
    }
    errorCode = `WEBHOOK_HTTP_${response.status}`;
  } catch {
    errorCode = controller.signal.aborted
      ? 'WEBHOOK_TIMEOUT'
      : 'WEBHOOK_TRANSPORT_FAILED';
  } finally {
    clearTimeout(timeout);
  }

  options.store.retryWebhookEvent({
    eventId: event.eventId,
    claimToken: event.claimToken,
    maxAttempts: options.maxAttempts,
    retryAt: new Date(now.getTime() + options.retryDelayMs),
    errorCode,
    now,
  });
  return event.attemptCount >= options.maxAttempts
    ? 'exhausted'
    : 'retry_scheduled';
}
