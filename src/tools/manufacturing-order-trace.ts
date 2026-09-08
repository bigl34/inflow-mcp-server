import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { InflowClient } from '../client/inflow.js';
import type { InflowConfig } from '../config.js';
import { assertCapability } from '../core/capabilities.js';
import { stableStringify } from '../core/canonical-json.js';
import { executeMutation, type MutationAdapter, type MutationControl } from '../core/mutation.js';
import { createMutationRuntime } from '../core/runtime.js';
import { textResult } from '../core/results.js';
import { assertSafeWriteAuthorized, getSafeWritePolicy } from '../core/write-policy.js';
import {
  buildDesiredSerialState,
  fetchManufacturingOrderTrace,
  manufacturingOrderSerialSemantic,
  manufacturingOrderSerialWriteShape,
  normalizeManufacturingOrderTrace,
  type SerialReconcileInput,
} from '../services/manufacturing-order-trace.js';
import type { ManufacturingOrder } from '../types/inflow.js';

interface ReconcileInput extends MutationControl, SerialReconcileInput { manufacturingOrderId: string }
const serials = z.array(z.string().min(1)).refine((rows) => new Set(rows).size === rows.length, 'Serials must be unique');

function serialReadbackShape(order: ManufacturingOrder) {
  return JSON.parse(JSON.stringify(
    normalizeManufacturingOrderTrace(order),
    (key, value) => key === 'timestamp' || key === 'putDate' ? undefined : value
  )) as unknown;
}

export function registerManufacturingOrderTraceTools(server: McpServer, client: InflowClient, config: InflowConfig): void {
  server.tool('get_manufacturing_order_trace', 'Trace manufacturing output lines, input picks, pick matchings, and serial anomalies.', {
    manufacturingOrderId: z.string().min(1),
  }, async ({ manufacturingOrderId }) => {
    assertCapability('mo-trace.read', config.apiVersion);
    return textResult(normalizeManufacturingOrderTrace(await fetchManufacturingOrderTrace(client, manufacturingOrderId)));
  });

  server.tool('reconcile_manufacturing_order_serials', 'Preview exact-ID serial reconciliation. Apply requires a separately approved stock-moving canary.', {
    manufacturingOrderId: z.string().min(1),
    mode: z.enum(['patch', 'replace']),
    outputLines: z.array(z.object({ manufacturingOrderLineId: z.string().min(1), serialNumbers: serials })).optional(),
    inputPicks: z.array(z.object({ manufacturingOrderLineId: z.string().min(1), manufacturingOrderPickLineId: z.string().min(1), serialNumbers: serials })).optional(),
    dryRun: z.boolean().default(true),
    previewToken: z.string().optional(),
    idempotencyKey: z.string().min(1).optional(),
    expectedSemanticHash: z.string().optional(),
    expectedWriteShapeHash: z.string().optional(),
    expectedEntityTimestamp: z.string().optional(),
    expectedDesiredHash: z.string().optional(),
  }, async (args) => {
    assertCapability('mo-serials.write', config.apiVersion);
    const policy = getSafeWritePolicy('reconcile_manufacturing_order_serials');
    const adapter: MutationAdapter<ReconcileInput, ManufacturingOrder, ManufacturingOrder, ReturnType<typeof normalizeManufacturingOrderTrace>> = {
      operation: 'reconcile_manufacturing_order_serials',
      resourceType: 'manufacturing-order-serials',
      resourceId: (input) => input.manufacturingOrderId,
      mode: (input) => input.mode,
      adapterVersion: 'mo-serials/v1',
      read: (input) => fetchManufacturingOrderTrace(client, input.manufacturingOrderId),
      planIds: (input) => ({ pickMatchingIds: (input.inputPicks ?? []).flatMap((row) => row.serialNumbers.map(() => randomUUID())) }),
      buildDesired: (input, current, plannedIds) => buildDesiredSerialState(current!, input, plannedIds.pickMatchingIds),
      semantic: manufacturingOrderSerialSemantic,
      writeShape: (current) => current ? manufacturingOrderSerialWriteShape(current) : null,
      timestamp: (current) => current?.timestamp,
      output: normalizeManufacturingOrderTrace,
      validate: (_input, _current, desired) => {
        const trace = normalizeManufacturingOrderTrace(desired);
        if (trace.anomalies.length) throw new Error(`SERIAL_RECONCILIATION_INVALID: ${trace.anomalies.map((row) => row.code).join(',')}`);
      },
      prepareDispatch: async (_input, current, desired) => {
        const prepared = await client.prepareMutation<ManufacturingOrder>('PUT', '/manufacturing-orders', { body: {
          manufacturingOrderId: desired.manufacturingOrderId,
          timestamp: current?.timestamp,
          lines: desired.lines,
          pickLines: desired.pickLines,
          pickMatchings: desired.pickMatchings,
        } });
        return prepared.dispatch;
      },
      dispatch: async () => { throw new Error('UNPREPARED_DISPATCH'); },
      affectedResources: (input) => [{ type: 'manufacturing-order', id: input.manufacturingOrderId }, { type: 'inventory-serials' }],
      invalidationTags: (input) => [`mo:${input.manufacturingOrderId}`, 'inventory:serials'],
      verifyReadback: (_input, _current, desired, actual) => actual !== undefined &&
        stableStringify(serialReadbackShape(actual)) === stableStringify(serialReadbackShape(desired)),
      writesEnabled: policy.staticSupport,
      authorizeApply: () => assertSafeWriteAuthorized(config, 'reconcile_manufacturing_order_serials'),
      requiresIdempotency: true,
      disabledCode: 'OPERATION_UNSUPPORTED',
      disabledMessage: 'Serial reconciliation stays unavailable until its release canary passes for this build.',
    };
    return textResult(await executeMutation(createMutationRuntime(config), adapter, args as ReconcileInput));
  });
}
