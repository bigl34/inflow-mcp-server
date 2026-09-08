import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { manufacturingRunCanonicalMaterial } from '../http/manufacturing-run-auth.js';

const deliveryModule = await import('./manufacturing-run-webhook-delivery.js')
  .catch(() => ({})) as Record<string, any>;

function event(attemptCount = 1) {
  return {
    eventId: 'manufacturing-run-wake/v1:run_ready:operation-1:1',
    operationId: 'operation-1',
    kind: 'run_ready',
    operationMarker: 'operation-1:1',
    payload: {
      schemaVersion: 'manufacturing-run/v1',
      marker: 'operation-1:1',
      operationId: 'operation-1',
      state: 'collecting',
      stateRevision: 1,
    },
    status: 'claimed',
    claimToken: 'claim-1',
    attemptCount,
  };
}

describe('durable manufacturing webhook delivery', () => {
  it('rejects line breaks in callback metadata before canonical signing', () => {
    expect(() => deliveryModule.manufacturingRunCallbackCanonicalMaterial({
      schemaVersion: 'manufacturing-run-callback/v1',
      kind: 'run_ready',
      eventId: 'event-1\ninjected-operation',
      operationId: 'operation-1',
      stateRevision: 1,
      marker: 'operation-1:1',
      audience: 'zapier-webhook',
      companyId: 'company-1',
      timestamp: '1785268800',
      nonce: 'wake-nonce-1',
      kid: 'current',
      payload: '{}',
      payloadSha256: 'a'.repeat(64),
    })).toThrow(/CALLBACK_CANONICAL_FIELD_INVALID/);
  });

  it('HMAC-signs a claimed wake and acknowledges only a 2xx response', async () => {
    expect(deliveryModule.deliverNextManufacturingWebhook)
      .toBeTypeOf('function');
    const completeWebhookEvent = vi.fn();
    const retryWebhookEvent = vi.fn();
    const fetch = vi.fn(async (
      _input: string | URL | Request,
      _init?: RequestInit
    ) => new Response(null, { status: 204 }));
    const now = new Date('2026-07-28T20:00:00.000Z');
    const result = await deliveryModule.deliverNextManufacturingWebhook({
      store: {
        claimNextWebhookEvent: () => event(),
        completeWebhookEvent,
        retryWebhookEvent,
      },
      endpoints: {
        run_ready: 'https://hooks.zapier.invalid/run-ready',
        terminal: 'https://hooks.zapier.invalid/terminal',
      },
      signing: {
        kid: 'current',
        secret: 's'.repeat(32),
        audience: 'zapier-webhook',
        companyId: 'company-1',
      },
      fetch,
      now: () => now,
      nonce: () => 'wake-nonce-1',
      maxAttempts: 3,
      retryDelayMs: 1_000,
      timeoutMs: 1_000,
      claimTtlMs: 5_000,
    });

    expect(result).toBe('delivered');
    expect(retryWebhookEvent).not.toHaveBeenCalled();
    expect(completeWebhookEvent).toHaveBeenCalledWith({
      eventId: event().eventId,
      claimToken: 'claim-1',
      now,
    });
    const request = fetch.mock.calls[0]!;
    const body = String(request[1]?.body);
    const callback = JSON.parse(body);
    const headers = request[1]?.headers as Record<string, string>;
    const payload =
      '{"marker":"operation-1:1","operationId":"operation-1","schemaVersion":"manufacturing-run/v1","state":"collecting","stateRevision":1}';
    const payloadSha256 = createHash('sha256').update(payload).digest('hex');
    const callbackMaterial = [
      'manufacturing-run-callback/v1',
      'run_ready',
      event().eventId,
      'operation-1',
      '1',
      'operation-1:1',
      'zapier-webhook',
      'company-1',
      String(Math.floor(now.getTime() / 1_000)),
      'wake-nonce-1',
      'current',
      payloadSha256,
    ].join('\n');
    expect(request[0]).toBe('https://hooks.zapier.invalid/run-ready');
    expect(callback).toEqual({
      schemaVersion: 'manufacturing-run-callback/v1',
      kind: 'run_ready',
      eventId: event().eventId,
      operationId: 'operation-1',
      stateRevision: 1,
      marker: 'operation-1:1',
      audience: 'zapier-webhook',
      companyId: 'company-1',
      timestamp: String(Math.floor(now.getTime() / 1_000)),
      nonce: 'wake-nonce-1',
      kid: 'current',
      payload,
      payloadSha256,
      signature: createHmac('sha256', 's'.repeat(32))
        .update(callbackMaterial)
        .digest('hex'),
    });
    expect(headers['x-inflow-signature']).toBe(
      createHmac('sha256', 's'.repeat(32))
        .update(manufacturingRunCanonicalMaterial({
          version: 'manufacturing-run-hmac/v1',
          method: 'POST',
          pathAndQuery: '/run-ready',
          audience: 'zapier-webhook',
          companyId: 'company-1',
          timestamp: String(Math.floor(now.getTime() / 1_000)),
          nonce: 'wake-nonce-1',
          kid: 'current',
          rawBody: Buffer.from(body),
        }))
        .digest('hex')
    );
  });

  it('retries ambiguous wake delivery at least once but exhausts the durable bound', async () => {
    const retryWebhookEvent = vi.fn();
    const fetch = vi.fn(async (
      _input: string | URL | Request,
      _init?: RequestInit
    ) => {
      throw new Error('response lost');
    });
    const base = {
      endpoints: {
        run_ready: 'https://hooks.zapier.invalid/run-ready',
        terminal: 'https://hooks.zapier.invalid/terminal',
      },
      signing: {
        kid: 'current',
        secret: 's'.repeat(32),
        audience: 'zapier-webhook',
        companyId: 'company-1',
      },
      fetch,
      now: () => new Date('2026-07-28T20:00:00.000Z'),
      nonce: () => 'wake-nonce-2',
      maxAttempts: 3,
      retryDelayMs: 1_000,
      claimTtlMs: 5_000,
      timeoutMs: 1_000,
    };

    await expect(deliveryModule.deliverNextManufacturingWebhook({
      ...base,
      store: {
        claimNextWebhookEvent: () => event(1),
        completeWebhookEvent: vi.fn(),
        retryWebhookEvent,
      },
    })).resolves.toBe('retry_scheduled');
    expect(retryWebhookEvent).toHaveBeenLastCalledWith(expect.objectContaining({
      eventId: event().eventId,
      maxAttempts: 3,
      errorCode: 'WEBHOOK_TRANSPORT_FAILED',
    }));

    retryWebhookEvent.mockClear();
    await expect(deliveryModule.deliverNextManufacturingWebhook({
      ...base,
      store: {
        claimNextWebhookEvent: () => event(3),
        completeWebhookEvent: vi.fn(),
        retryWebhookEvent,
      },
    })).resolves.toBe('exhausted');
    expect(retryWebhookEvent).toHaveBeenLastCalledWith(expect.objectContaining({
      maxAttempts: 3,
    }));
  });

  it('aborts a wedged delivery before its durable claim can expire', async () => {
    vi.useFakeTimers();
    try {
      const retryWebhookEvent = vi.fn();
      let observedSignal: AbortSignal | undefined;
      const fetch = vi.fn((
        _input: string | URL | Request,
        init?: RequestInit
      ) => new Promise<Response>((_resolve, reject) => {
        observedSignal = init?.signal ?? undefined;
        observedSignal?.addEventListener('abort', () => {
          reject(new DOMException('timed out', 'AbortError'));
        });
      }));
      const delivery = deliveryModule.deliverNextManufacturingWebhook({
        store: {
          claimNextWebhookEvent: () => event(1),
          completeWebhookEvent: vi.fn(),
          retryWebhookEvent,
        },
        endpoints: {
          run_ready: 'https://hooks.zapier.invalid/run-ready',
          terminal: 'https://hooks.zapier.invalid/terminal',
        },
        signing: {
          kid: 'current',
          secret: 's'.repeat(32),
          audience: 'zapier-webhook',
          companyId: 'company-1',
        },
        fetch,
        now: () => new Date('2026-07-28T20:00:00.000Z'),
        nonce: () => 'wake-nonce-timeout',
        maxAttempts: 3,
        retryDelayMs: 1_000,
        timeoutMs: 1_000,
        claimTtlMs: 5_000,
      });

      await vi.advanceTimersByTimeAsync(1_000);

      await expect(delivery).resolves.toBe('retry_scheduled');
      expect(observedSignal?.aborted).toBe(true);
      expect(retryWebhookEvent).toHaveBeenCalledWith(expect.objectContaining({
        errorCode: 'WEBHOOK_TIMEOUT',
      }));
    } finally {
      vi.useRealTimers();
    }
  });
});
