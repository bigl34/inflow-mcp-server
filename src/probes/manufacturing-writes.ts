#!/usr/bin/env node

import 'dotenv/config';
import { randomUUID } from 'crypto';
import { pathToFileURL } from 'url';
import { loadConfig } from '../config.js';
import { InflowApiError, InflowClient } from '../client/inflow.js';
import type { Product } from '../types/inflow.js';
import {
  MANUFACTURING_INCLUDE,
  assertManufacturingApiVersion,
} from '../tools/product-manufacturing.js';
import { assertCanaryAttestationReady, issuePassingCanaryAttestation } from './canary-attestation.js';

export interface ProbeResult {
  parentProductId: string;
  componentProductId: string;
  clientSuppliedItemBomIdRetained?: boolean;
  clientSuppliedOperationIdRetained?: boolean;
  addWorked?: boolean;
  updateWorked?: boolean;
  operationRemoveWorked?: boolean;
  removeWorked?: boolean;
  clearWorked?: boolean;
  inactiveComponentAccepted?: boolean;
  staleTimestampRejected?: boolean;
  staleTimestampStatus?: number;
  staleTimestampCode?: string;
  cleanupSucceeded?: boolean;
  errors: string[];
}

async function getProduct(client: InflowClient, productId: string): Promise<Product> {
  return client.get<Product>(`/products/${productId}`, {
    include: MANUFACTURING_INCLUDE,
  });
}

async function putProduct(
  client: InflowClient,
  body: Record<string, unknown>
): Promise<Product> {
  return client.put<Product>('/products', body);
}

export async function cleanupCanaryProducts(
  client: InflowClient,
  parentProductId: string,
  componentProductId: string
): Promise<{ cleanupSucceeded: boolean; errors: string[] }> {
  const errors: string[] = [];
  let parentClean = false;
  let componentClean = false;
  try {
    const parent = await getProduct(client, parentProductId);
    await putProduct(client, {
      productId: parentProductId,
      timestamp: parent.timestamp,
      itemBoms: [],
      productOperations: [],
      autoAssemble: false,
      includeQuantityBuildable: false,
      isActive: false,
    });
    const readback = await getProduct(client, parentProductId);
    parentClean =
      readback.isActive === false &&
      (readback.itemBoms?.length ?? 0) === 0 &&
      (readback.productOperations?.length ?? 0) === 0 &&
      readback.autoAssemble === false &&
      readback.includeQuantityBuildable === false;
  } catch (error) {
    errors.push(
      `Parent cleanup failed; residual product ID ${parentProductId}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  try {
    const component = await getProduct(client, componentProductId);
    await putProduct(client, {
      productId: componentProductId,
      timestamp: component.timestamp,
      isActive: false,
    });
    componentClean =
      (await getProduct(client, componentProductId)).isActive === false;
  } catch (error) {
    errors.push(
      `Component cleanup failed; residual product ID ${componentProductId}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  const cleanupSucceeded = parentClean && componentClean;
  if (!cleanupSucceeded) {
    errors.push(
      `Cleanup readback failed; inspect residual product IDs ${parentProductId}, ${componentProductId}`
    );
  }
  return { cleanupSucceeded, errors };
}

export function evaluateProbeResult(result: ProbeResult) {
  const requiredChecks = {
    addWorked: result.addWorked === true,
    updateWorked: result.updateWorked === true,
    operationRemoveWorked: result.operationRemoveWorked === true,
    removeWorked: result.removeWorked === true,
    clearWorked: result.clearWorked === true,
    inactiveComponentAccepted: result.inactiveComponentAccepted === true,
    staleTimestampRejected: result.staleTimestampRejected === true,
    clientSuppliedItemBomIdRetained:
      result.clientSuppliedItemBomIdRetained === true,
    clientSuppliedOperationIdRetained:
      result.clientSuppliedOperationIdRetained === true,
    cleanupSucceeded: result.cleanupSucceeded === true,
  };
  return {
    requiredChecks,
    passed: Object.values(requiredChecks).every(Boolean),
  };
}

export function isTimestampConcurrencyConflict(
  error: unknown
): error is InflowApiError {
  if (!(error instanceof InflowApiError)) return false;
  if (![400, 409, 412, 422].includes(error.statusCode)) return false;
  const evidence = [
    error.message,
    error.apiError?.code,
    error.apiError?.message,
    error.apiError?.details
      ? JSON.stringify(error.apiError.details)
      : undefined,
  ]
    .filter(Boolean)
    .join(' ');
  return /(?:timestamp|stale|concurr|row.?version|modified by another|has changed).*(?:conflict|stale|mismatch|modified|changed|concurr|version)|(?:conflict|stale|mismatch|modified|changed|concurr|version).*(?:timestamp|row.?version)/i.test(
    evidence
  );
}

async function main(): Promise<void> {
  if (process.env.INFLOW_CANARY_APPROVED !== 'true') {
    throw new Error(
      'Canary refused: set INFLOW_CANARY_APPROVED=true only after explicit approval for inactive product writes'
    );
  }
  const operationTypeId = process.env.INFLOW_CANARY_OPERATION_TYPE_ID;
  if (!operationTypeId) {
    throw new Error(
      'INFLOW_CANARY_OPERATION_TYPE_ID is required so operation add/update/remove can be characterized'
    );
  }

  const config = loadConfig();
  assertManufacturingApiVersion(config.apiVersion);
  const approvalNonce = assertCanaryAttestationReady(config);
  const client = new InflowClient(config);
  const suffix = new Date().toISOString().replace(/[-:.TZ]/g, '');
  const parentProductId = randomUUID();
  const componentProductId = randomUUID();
  const itemBomId = randomUUID();
  const productOperationId = randomUUID();
  const result: ProbeResult = {
    parentProductId,
    componentProductId,
    errors: [],
  };
  let beforeSnapshot: unknown;
  let afterCleanupSnapshot: unknown;

  try {
    await putProduct(client, {
      productId: componentProductId,
      name: `__MCP_BOM_CANARY_COMPONENT__${suffix}`,
      itemType: 'StockedProduct',
      isActive: false,
    });
    await putProduct(client, {
      productId: parentProductId,
      name: `__MCP_BOM_CANARY_PARENT__${suffix}`,
      itemType: 'StockedProduct',
      isActive: false,
      autoAssemble: false,
      includeQuantityBuildable: false,
    });

    let parent = await getProduct(client, parentProductId);
    beforeSnapshot = {
      parent: {
        isActive: parent.isActive,
        itemBoms: parent.itemBoms ?? [],
        productOperations: parent.productOperations ?? [],
        autoAssemble: parent.autoAssemble ?? false,
        includeQuantityBuildable: parent.includeQuantityBuildable ?? false,
      },
      component: { isActive: (await getProduct(client, componentProductId)).isActive },
    };
    const staleTimestamp = parent.timestamp;
    await putProduct(client, {
      productId: parentProductId,
      timestamp: parent.timestamp,
      itemBoms: [
        {
          itemBomId,
          productId: parentProductId,
          childProductId: componentProductId,
          quantity: { standardQuantity: '1', uomQuantity: '1' },
        },
      ],
      productOperations: [
        {
          productOperationId,
          productId: parentProductId,
          operationTypeId,
          lineNum: 1,
          instructions: 'MCP canary add',
          trackTime: false,
        },
      ],
    });
    parent = await getProduct(client, parentProductId);
    result.addWorked =
      parent.itemBoms?.length === 1 && parent.productOperations?.length === 1;
    result.inactiveComponentAccepted = result.addWorked;
    result.clientSuppliedItemBomIdRetained =
      parent.itemBoms?.[0]?.itemBomId === itemBomId;
    result.clientSuppliedOperationIdRetained =
      parent.productOperations?.[0]?.productOperationId === productOperationId;

    const liveBom = parent.itemBoms?.[0];
    const liveOperation = parent.productOperations?.[0];
    await putProduct(client, {
      productId: parentProductId,
      timestamp: parent.timestamp,
      itemBoms: [
        {
          itemBomId: liveBom?.itemBomId,
          productId: parentProductId,
          childProductId: componentProductId,
          timestamp: liveBom?.timestamp,
          quantity: { standardQuantity: '2', uomQuantity: '2' },
        },
      ],
      productOperations: [
        {
          productOperationId: liveOperation?.productOperationId,
          productId: parentProductId,
          operationTypeId,
          lineNum: 1,
          instructions: 'MCP canary update',
          trackTime: true,
          timestamp: liveOperation?.timestamp,
        },
      ],
    });
    parent = await getProduct(client, parentProductId);
    result.updateWorked =
      parent.itemBoms?.[0]?.quantity?.standardQuantity === '2' &&
      parent.productOperations?.[0]?.instructions === 'MCP canary update';

    if (staleTimestamp) {
      try {
        await putProduct(client, {
          productId: parentProductId,
          timestamp: staleTimestamp,
          autoAssemble: true,
        });
        result.staleTimestampRejected = false;
      } catch (error) {
        if (!isTimestampConcurrencyConflict(error)) throw error;
        result.staleTimestampRejected = true;
        result.staleTimestampStatus = error.statusCode;
        result.staleTimestampCode = error.apiError?.code;
      }
    }

    parent = await getProduct(client, parentProductId);
    await putProduct(client, {
      productId: parentProductId,
      timestamp: parent.timestamp,
      itemBoms: parent.itemBoms,
      productOperations: [],
      autoAssemble: false,
      includeQuantityBuildable: false,
    });
    parent = await getProduct(client, parentProductId);
    result.operationRemoveWorked =
      (parent.itemBoms?.length ?? 0) === 1 &&
      (parent.productOperations?.length ?? 0) === 0;

    await putProduct(client, {
      productId: parentProductId,
      timestamp: parent.timestamp,
      itemBoms: [],
      productOperations: [],
      autoAssemble: false,
      includeQuantityBuildable: false,
    });
    parent = await getProduct(client, parentProductId);
    result.removeWorked = (parent.itemBoms?.length ?? 0) === 0;

    await putProduct(client, {
      productId: parentProductId,
      timestamp: parent.timestamp,
      itemBoms: [],
      productOperations: [],
      autoAssemble: false,
      includeQuantityBuildable: false,
    });
    parent = await getProduct(client, parentProductId);
    result.clearWorked =
      (parent.itemBoms?.length ?? 0) === 0 &&
      (parent.productOperations?.length ?? 0) === 0;
  } catch (error) {
    result.errors.push(error instanceof Error ? error.message : String(error));
  } finally {
    const cleanup = await cleanupCanaryProducts(
      client,
      parentProductId,
      componentProductId
    );
    result.cleanupSucceeded = cleanup.cleanupSucceeded;
    result.errors.push(...cleanup.errors);
    if (cleanup.cleanupSucceeded) {
      try {
        const [parent, component] = await Promise.all([
          getProduct(client, parentProductId),
          getProduct(client, componentProductId),
        ]);
        afterCleanupSnapshot = {
          parent: {
            isActive: parent.isActive,
            itemBoms: parent.itemBoms ?? [],
            productOperations: parent.productOperations ?? [],
            autoAssemble: parent.autoAssemble ?? false,
            includeQuantityBuildable: parent.includeQuantityBuildable ?? false,
          },
          component: { isActive: component.isActive },
        };
      } catch (error) {
        result.cleanupSucceeded = false;
        result.errors.push(`Cleanup snapshot failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  const { requiredChecks, passed } = evaluateProbeResult(result);
  if (!passed) {
    result.errors.push(
      `Required canary checks failed: ${Object.entries(requiredChecks)
        .filter(([, ok]) => !ok)
        .map(([name]) => name)
        .join(', ')}`
    );
  }
  if (passed && result.errors.length === 0) {
    await issuePassingCanaryAttestation(config, {
      domain: 'manufacturing',
      approvalNonce,
      observedSemantics: {
        add: true,
        update: true,
        remove: true,
        clear: true,
        rowIdStrategy: 'client-supplied',
        readback: true,
      },
      optimisticConcurrency: 'enforced',
      beforeSnapshot,
      afterCleanupSnapshot,
      confirmedResidualIds: [parentProductId, componentProductId],
      approvedInertArtifactIds: [parentProductId, componentProductId],
    });
  }
  process.stdout.write(`${JSON.stringify({ ...result, requiredChecks, passed, attestationIssued: passed && result.errors.length === 0 }, null, 2)}\n`);
  if (!passed || result.errors.length > 0) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
