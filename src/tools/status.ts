import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { InflowClient } from '../client/inflow.js';
import type { InflowConfig } from '../config.js';
import { resolveCapabilities } from '../core/capabilities.js';
import { canonicalHash } from '../core/canonical-json.js';
import type { WriteDomain } from '../core/attestation.js';
import {
  resolveCoordinatorWriteGate,
  resolveManufacturingOperationCompletionGate,
} from '../core/gates.js';
import { getMutationJournalStatus, MUTATION_CONTRACT_VERSION, SERIALIZER_VERSION, stateFlags, type ApplicationState } from '../core/mutation.js';
import { MutationJournal, type MutationJournalRecord } from '../core/mutation-journal.js';
import { tenantFingerprint } from '../core/preview-token.js';
import { textResult } from '../core/results.js';
import {
  evaluateSafeWriteAuthorization,
  evaluateSafeWriteClassAuthorization,
  listSafeWritePolicies,
} from '../core/write-policy.js';
import { SERVER_NAME, SERVER_VERSION } from '../version.js';
import { fetchProductPrices, priceSemantic } from '../services/product-prices.js';
import { canonicalizeManufacturingConfig, fetchManufacturingProduct, normalizeManufacturingProduct } from './product-manufacturing.js';
import { productWriteSemantic } from './safe-standard-writes.js';

const DEPRECATED_GATE_DOMAINS = [
  'prices',
  'product-groups',
  'mo-serials',
  'standard',
] as const satisfies readonly WriteDomain[];

const DEPRECATED_GATE_REPLACEMENTS: Record<(typeof DEPRECATED_GATE_DOMAINS)[number], string> = {
  prices: 'INFLOW_ENABLE_SAFE_WRITES',
  'product-groups': 'INFLOW_ENABLE_SAFE_WRITES',
  'mo-serials': 'INFLOW_ENABLE_SAFE_WRITES + INFLOW_ENABLE_STOCK_WRITES',
  standard: 'per-operation classification under writePolicies.safe.operations',
};
const DEPRECATED_IMMEDIATE_TOOLS = [
  'upsert_product', 'upsert_sales_order', 'upsert_purchase_order',
  'receive_purchase_order', 'unreceive_purchase_order', 'upsert_customer',
  'upsert_vendor', 'upsert_stock_adjustment', 'upsert_stock_transfer',
  'upsert_stock_count', 'upsert_manufacturing_order', 'upsert_taxing_scheme',
  'upsert_webhook', 'delete_webhook',
];

export async function reconcileMutation(
  client: InflowClient,
  journal: MutationJournal,
  record: MutationJournalRecord
): Promise<{ record: MutationJournalRecord; reconciliation: Record<string, unknown> }> {
  if (!['dispatched', 'unknown_after_write', 'applied_unverified', 'partial_applied'].includes(record.state)) {
    return { record, reconciliation: { attempted: false, reasonCode: 'STATE_NOT_RECONCILABLE' } };
  }
  if (!record.resourceId) {
    return { record, reconciliation: { attempted: false, reasonCode: 'RESOURCE_ID_MISSING' } };
  }
  const semanticDomain = `semantic/${record.resourceType}/${record.adapterVersion}`;
  let currentSemanticHash: string;
  try {
    if (record.resourceType === 'product-manufacturing-config') {
      const product = await fetchManufacturingProduct(client, record.resourceId);
      currentSemanticHash = canonicalHash(
        canonicalizeManufacturingConfig(normalizeManufacturingProduct(product)),
        semanticDomain
      );
    } else if (record.resourceType === 'product-prices') {
      currentSemanticHash = canonicalHash(
        priceSemantic(await fetchProductPrices(client, record.resourceId)),
        semanticDomain
      );
    } else if (record.resourceType === 'product') {
      currentSemanticHash = canonicalHash(
        productWriteSemantic(await client.get<Record<string, unknown>>(`/products/${record.resourceId}`)),
        semanticDomain
      );
    } else {
      return { record, reconciliation: { attempted: false, reasonCode: 'ADAPTER_RECONCILIATION_NOT_REGISTERED' } };
    }
  } catch (error) {
    return {
      record,
      reconciliation: {
        attempted: true,
        advanced: false,
        reasonCode: 'RECONCILIATION_READ_FAILED',
        errorCode: error instanceof Error ? error.name : 'READ_ERROR',
      },
    };
  }
  if (currentSemanticHash !== record.desiredHash) {
    return {
      record,
      reconciliation: {
        attempted: true,
        advanced: false,
        reasonCode: 'DESIRED_STATE_NOT_OBSERVED',
        currentSemanticHash,
      },
    };
  }
  const updated = await journal.update(record.operationId, (current) => ({
    ...current,
    state: 'applied_verified',
    updatedAt: new Date().toISOString(),
    steps: current.steps.map((step) => step.state === 'dispatched' || step.state === 'unknown'
      ? { ...step, state: 'verified', updatedAt: new Date().toISOString() }
      : step),
  }));
  return {
    record: updated,
    reconciliation: { attempted: true, advanced: true, provenState: 'applied_verified', currentSemanticHash },
  };
}

function applicationStateFromJournal(state: MutationJournalRecord['state']): ApplicationState {
  if (state === 'prepared') return 'not_applied';
  if (state === 'dispatched') return 'unknown_after_write';
  return state;
}

export function mutationStatusEnvelope(record: MutationJournalRecord) {
  const applicationState = applicationStateFromJournal(record.state);
  return {
    schemaVersion: MUTATION_CONTRACT_VERSION,
    operationId: record.operationId,
    resourceType: record.resourceType,
    resourceId: record.resourceId,
    applicationState,
    ...stateFlags(applicationState),
    currentSemanticHash: record.currentSemanticHash,
    currentWriteShapeHash: record.currentWriteShapeHash,
    desiredHash: record.desiredHash,
    confirmation: record.confirmation
      ? {
          validated: true,
          hash: record.confirmation.hash,
          scope: record.confirmation.scope,
          receivedAt: record.confirmation.receivedAt,
        }
      : undefined,
    diff: { schemaVersion: 'diff/v1', operations: [] },
    completedSteps: record.steps.filter((step) => step.state === 'verified').map((step) => step.stepId),
    failedStep: record.steps.find((step) => step.state === 'failed')?.stepId,
    residualIds: record.residualIds,
    possibleResidualIds: record.possibleResidualIds,
    affectedResources: record.affectedResources,
    invalidationTags: record.invalidationTags,
    warnings: ['Journal status omits provider state payloads; use reconciliation for a fresh supported-adapter proof.'],
  };
}

export function registerStatusTools(server: McpServer, client: InflowClient, config: InflowConfig): void {
  const host = new URL(config.baseUrl).host.toLowerCase();
  const fingerprint = tenantFingerprint(config.companyId, config.apiKey, host);
  const journal = new MutationJournal(config.stateDir);

  server.tool('get_mcp_status', 'Inspect local inFlow MCP capabilities, safety gates, and optional API reachability.', {
    probeApi: z.boolean().default(false),
  }, async ({ probeApi }) => {
    // The manufacturing coordinator keeps its dedicated attestation. Ordinary
    // adapters use release canaries as build evidence, not runtime authority.
    const [coordinatorGate, operationCompletionGate] = await Promise.all([
      resolveCoordinatorWriteGate(config),
      resolveManufacturingOperationCompletionGate(config),
    ]);
    const ordinaryGate = evaluateSafeWriteClassAuthorization(config, 'ordinary');
    const stockGate = evaluateSafeWriteClassAuthorization(config, 'stock');
    const operationPolicies: Record<string, Record<string, unknown>> = Object.fromEntries(listSafeWritePolicies().map((policy) => {
      const authorization = evaluateSafeWriteAuthorization(config, policy.operation);
      return [policy.operation, {
        classification: policy.classification,
        staticSupport: policy.staticSupport,
        idempotency: policy.idempotency,
        requiredGates: authorization.requiredGates,
        effectiveApplyEnabled: authorization.effectiveApplyEnabled,
        reasonCode: authorization.reasonCode,
        ...(policy.unsupportedReason ? { unsupportedReason: policy.unsupportedReason } : {}),
      }];
    }));
    operationPolicies['manufacturing-pick-batch-v1'] = {
      classification: 'coordinator',
      staticSupport: true,
      idempotency: 'required',
      requiredGates: [
        'INFLOW_ENABLE_SAFE_WRITES',
        'INFLOW_ENABLE_STOCK_WRITES',
        'INFLOW_ENABLE_MANUFACTURING_PICK_BATCH_WRITES',
        'manufacturing-pick-batch-v1 attestation',
      ],
      effectiveApplyEnabled: coordinatorGate.enabled,
      reasonCode: coordinatorGate.reasonCode,
    };
    operationPolicies['manufacturing-operation-completion-v1'] = {
      classification: 'coordinator',
      staticSupport: true,
      idempotency: 'required',
      requiredGates: operationCompletionGate.requiredGates,
      effectiveApplyEnabled: operationCompletionGate.enabled,
      reasonCode: operationCompletionGate.reasonCode,
    };
    const deprecatedDomainGates = Object.fromEntries(DEPRECATED_GATE_DOMAINS.map((domain) => [domain, {
      domain,
      environmentEnabled: config.writeGates[domain] === true,
      attestationState: 'deprecated',
      enabled: false,
      reasonCode: 'DEPRECATED_GATE_IGNORED',
      deprecated: true,
      replacement: DEPRECATED_GATE_REPLACEMENTS[domain],
    }]));
    let probe: { attempted: boolean; reachable?: boolean; latencyMs?: number; errorCode?: string } = { attempted: false };
    if (probeApi) {
      const started = Date.now();
      try {
        await client.getList('/products', { pagination: { count: 1 } });
        probe = { attempted: true, reachable: true, latencyMs: Date.now() - started };
      } catch (error) {
        probe = { attempted: true, reachable: false, latencyMs: Date.now() - started, errorCode: error instanceof Error ? error.name : 'API_ERROR' };
      }
    }
    return textResult({
      schemaVersion: 'mcp-status/v2',
      server: {
        name: SERVER_NAME,
        packageVersion: SERVER_VERSION,
        mutationContractVersion: MUTATION_CONTRACT_VERSION,
        serializerVersion: SERIALIZER_VERSION,
        probeBuild: config.probeBuild,
        adapterManifestHash: config.adapterManifestHash,
      },
      api: { version: config.apiVersion, baseHost: host, tenantFingerprint: fingerprint },
      capabilities: resolveCapabilities(config.apiVersion),
      legacyMode: config.enableLegacyWrites,
      legacyBypassActive: true,
      legacyImmediateToolsRegistered: true,
      deprecatedImmediateTools: DEPRECATED_IMMEDIATE_TOOLS,
      deprecationTarget: '2.0.0',
      client: client.telemetrySnapshot(),
      gates: {
        'manufacturing-pick-batch-v1': coordinatorGate,
        'manufacturing-operation-completion-v1':
          operationCompletionGate,
        ...deprecatedDomainGates,
      },
      writePolicies: {
        safe: {
          mode: 'preview-apply',
          previewsAvailable: true,
          legacyWritesAffected: false,
          master: {
            environmentVariable: 'INFLOW_ENABLE_SAFE_WRITES',
            environmentEnabled: config.safeWritesEnabled,
            effectiveApplyEnabled: ordinaryGate.enabled,
            reasonCode: ordinaryGate.reasonCode,
          },
          stock: {
            environmentVariable: 'INFLOW_ENABLE_STOCK_WRITES',
            environmentEnabled: config.stockWritesEnabled,
            requiredGates: stockGate.requiredGates,
            effectiveApplyEnabled: stockGate.enabled,
            reasonCode: stockGate.reasonCode,
          },
          operations: operationPolicies,
        },
        productManufacturing: {
          mode: 'explicit-confirmation',
          previewRequired: true,
          masterGateRequired: true,
          effectiveApplyEnabled: config.safeWritesEnabled,
          reasonCode: config.safeWritesEnabled ? undefined : 'SAFE_WRITES_DISABLED',
          confirmationScope: 'full-preview-state',
          previewTtlMs: 15 * 60_000,
          trustBoundary: 'caller-asserted-scope-confirmation',
          humanIdentityAuthenticated: false,
          operations: [
            'set_product_manufacturing_config',
            'copy_product_manufacturing_config',
          ],
          deprecatedAuthorizationInputs: [
            'INFLOW_ENABLE_MANUFACTURING_WRITES',
            'attestations/manufacturing.json',
          ],
        },
      },
      deprecatedGates: {
        manufacturing: {
          status: 'retired-for-product-manufacturing',
          replacement: 'writePolicies.productManufacturing',
        },
        prices: {
          status: 'deprecated-disabled',
          replacement: DEPRECATED_GATE_REPLACEMENTS.prices,
        },
        'product-groups': {
          status: 'deprecated-disabled',
          replacement: DEPRECATED_GATE_REPLACEMENTS['product-groups'],
        },
        'mo-serials': {
          status: 'deprecated-disabled',
          replacement: DEPRECATED_GATE_REPLACEMENTS['mo-serials'],
        },
        standard: {
          status: 'deprecated-disabled',
          replacement: DEPRECATED_GATE_REPLACEMENTS.standard,
        },
      },
      probe,
    });
  });

  server.tool('get_mutation_status', 'Read durable mutation status. Reconciliation performs a fresh supported-adapter read and never repeats a write.', {
    operationId: z.string().regex(/^[A-Za-z0-9_-]+$/),
    reconcile: z.boolean().default(false),
  }, async ({ operationId, reconcile }) => {
    const record = await getMutationJournalStatus(journal, operationId);
    const result = reconcile
      ? await reconcileMutation(client, journal, record)
      : { record, reconciliation: { attempted: false } };
    return textResult({ schemaVersion: 'mutation-status/v1', ...result, mutation: mutationStatusEnvelope(result.record) });
  });
}
