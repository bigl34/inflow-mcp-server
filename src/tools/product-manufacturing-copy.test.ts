import { chmod, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { InflowClient } from '../client/inflow.js';
import type { InflowConfig } from '../config.js';
import type { Product } from '../types/inflow.js';
import { registerManufacturingCopyTool } from './product-manufacturing-copy.js';

function product(productId: string, autoAssemble: boolean): Product {
  return {
    productId,
    name: productId,
    sku: productId.toUpperCase(),
    isActive: true,
    timestamp: `${productId}-ts-1`,
    autoAssemble,
    includeQuantityBuildable: false,
    itemBoms: productId === 'child'
      ? []
      : [{
          itemBomId: `${productId}-bom-1`,
          productId,
          childProductId: 'child',
          quantity: { standardQuantity: '1', uomQuantity: '1' },
          timestamp: `${productId}-bom-ts-1`,
        }],
    productOperations: [],
  };
}

function config(stateDir: string): InflowConfig {
  return {
    companyId: 'company',
    apiKey: 'secret',
    baseUrl: 'https://api.test',
    apiVersion: '2026-04-13',
    rateLimitPerMinute: 60,
    requestTimeoutMs: 1_000,
    maxRetries: 0,
    retryDelayMs: 1,
    readRetryBudgetMs: 1_000,
    debug: false,
    stateDir,
    adapterManifestHash: 'a'.repeat(64),
    probeBuild: 'b'.repeat(64),
    enableLegacyWrites: false,
    safeWritesEnabled: true,
    stockWritesEnabled: false,
    writeGates: {
      manufacturing: false,
      'manufacturing-pick-batch-v1': false,
      prices: false,
      'product-groups': false,
      'mo-serials': false,
      standard: false,
    },
  };
}

async function harness(options: { driftSourceBeforeDispatch?: boolean } = {}) {
  const stateDir = await mkdtemp(join(tmpdir(), 'inflow-manufacturing-copy-'));
  await chmod(stateDir, 0o700);
  let source = product('source', true);
  let target = product('target', false);
  let sourceReads = 0;
  const get = vi.fn(async (path: string) => {
    const id = path.split('/').at(-1);
    if (id === 'source') {
      sourceReads += 1;
      if (options.driftSourceBeforeDispatch && sourceReads >= 3) {
        source = { ...source, autoAssemble: false, timestamp: 'source-ts-2' };
      }
      return structuredClone(source);
    }
    if (id === 'target') return structuredClone(target);
    if (id === 'child') return product('child', false);
    throw new Error(`missing ${id}`);
  });
  const put = vi.fn(async (_path: string, body: Partial<Product>) => {
    target = { ...target, ...structuredClone(body), timestamp: 'target-ts-2' };
    return structuredClone(target);
  });
  const prepareMutation = vi.fn(async (
    _method: string,
    path: string,
    request: { body: Partial<Product> }
  ) => ({ dispatch: () => put(path, request.body) }));
  const client = { get, put, prepareMutation } as unknown as InflowClient;
  let handler: ((args: any) => Promise<any>) | undefined;
  const server = {
    tool(
      name: string,
      _description: string,
      _schema: unknown,
      candidate: (args: any) => Promise<any>
    ) {
      if (name === 'copy_product_manufacturing_config') handler = candidate;
    },
  } as unknown as McpServer;
  registerManufacturingCopyTool(server, client, config(stateDir));
  return { handler: handler!, put, prepareMutation };
}

function payload(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0]!.text);
}

function applyInput(preview: Record<string, any>) {
  const sourceHashes = preview.sourceHashes as Record<string, string>;
  return {
    sourceProductId: 'source',
    targetProductId: 'target',
    sections: ['settings'],
    mode: 'replace',
    dryRun: false,
    previewToken: preview.previewToken,
    idempotencyKey: preview.idempotencyKey,
    expectedSemanticHash: preview.currentSemanticHash,
    expectedWriteShapeHash: preview.currentWriteShapeHash,
    expectedEntityTimestamp: preview.entityTimestamp,
    expectedDesiredHash: preview.desiredHash,
    expectedSourceConfigHash: sourceHashes.sourceSemanticHash,
    expectedSourceWriteShapeHash: sourceHashes.sourceWriteShapeHash,
    confirmation: {
      scope: preview.confirmationScope,
      confirmationHash: preview.confirmationHash,
    },
  };
}

describe('manufacturing copy explicit confirmation', () => {
  it('binds both source hashes into the confirmation scope', async () => {
    const fixture = await harness();
    const preview = payload(await fixture.handler({
      sourceProductId: 'source',
      targetProductId: 'target',
      sections: ['settings'],
      mode: 'replace',
      dryRun: true,
    }));
    expect(preview.confirmationScope.sourceHashes).toEqual([
      { name: 'sourceSemanticHash', hash: preview.sourceHashes.sourceSemanticHash },
      { name: 'sourceWriteShapeHash', hash: preview.sourceHashes.sourceWriteShapeHash },
    ]);
    expect(preview.confirmationHash).toMatch(/^[a-f0-9]{64}$/);
    expect(fixture.put).not.toHaveBeenCalled();
  });

  it('rejects an unconfirmed copy and applies an exactly confirmed copy', async () => {
    const fixture = await harness();
    const preview = payload(await fixture.handler({
      sourceProductId: 'source',
      targetProductId: 'target',
      sections: ['settings'],
      mode: 'replace',
      dryRun: true,
    }));
    await expect(fixture.handler({
      ...applyInput(preview),
      confirmation: undefined,
    })).rejects.toThrow(/USER_CONFIRMATION_REQUIRED/);
    expect(fixture.put).not.toHaveBeenCalled();

    const applied = payload(await fixture.handler(applyInput(preview)));
    expect(applied).toMatchObject({
      applicationState: 'applied_verified',
      confirmationValidated: true,
    });
    expect(fixture.put).toHaveBeenCalledTimes(1);
  });

  it('rechecks the locked source immediately before target dispatch', async () => {
    const fixture = await harness({ driftSourceBeforeDispatch: true });
    const preview = payload(await fixture.handler({
      sourceProductId: 'source',
      targetProductId: 'target',
      sections: ['settings'],
      mode: 'replace',
      dryRun: true,
    }));
    await expect(fixture.handler(applyInput(preview))).rejects.toThrow(
      /source changed before dispatch/
    );
    expect(fixture.put).not.toHaveBeenCalled();
  });
});
