import { chmod, mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { MutationJournal } from './mutation-journal.js';
import {
  executeMutation,
  type ExplicitMutationConfirmation,
  type MutationAdapter,
} from './mutation.js';
import { PreviewTokenService, tenantFingerprint } from './preview-token.js';

type Row = { id: string; name: string; timestamp: string; rowId: string };
type Input = {
  id: string;
  name: string;
  dryRun?: boolean;
  previewToken?: string;
  idempotencyKey?: string;
  expectedSemanticHash?: string;
  expectedWriteShapeHash?: string;
  expectedEntityTimestamp?: string;
  expectedDesiredHash?: string;
  confirmation?: ExplicitMutationConfirmation;
};

async function harness(writeThrows = false) {
  const stateDir = await mkdtemp(join(tmpdir(), 'inflow-mutation-'));
  await chmod(stateDir, 0o700);
  let current: Row = { id: 'p-1', name: 'Before', timestamp: 't-1', rowId: 'row-1' };
  const dispatch = vi.fn(async (_input: Input, _before: Row | undefined, desired: Row) => {
    current = { ...desired, timestamp: 't-2' };
    if (writeThrows) throw new TypeError('lost response');
  });
  const adapter: MutationAdapter<Input, Row, Row, Row> = {
    operation: 'set_product',
    resourceType: 'product',
    resourceId: (input) => input.id,
    mode: () => 'patch',
    adapterVersion: 'product/v1',
    read: async () => structuredClone(current),
    buildDesired: (input, before) => ({ ...before!, name: input.name }),
    semantic: (row) => ({ id: row.id, name: row.name }),
    writeShape: (row) => row ? { rowId: row.rowId } : null,
    timestamp: (row) => row?.timestamp,
    output: (row) => row,
    dispatch,
    affectedResources: (input) => [{ type: 'product', id: input.id }],
    invalidationTags: (input) => [`product:${input.id}`],
    writesEnabled: true,
  };
  const runtime = {
    tenantFingerprint: tenantFingerprint('company', 'secret'),
    baseHost: 'api.test',
    apiVersion: '2026-04-13',
    serverBuildIdentity: 'a'.repeat(64),
    tokenService: new PreviewTokenService('secret', 'company'),
    journal: new MutationJournal(stateDir),
  };
  return { adapter, runtime, dispatch, stateDir };
}

function confirmationFrom(preview: {
  confirmationScope?: ExplicitMutationConfirmation['scope'];
  confirmationHash?: string;
}): ExplicitMutationConfirmation {
  return {
    scope: preview.confirmationScope!,
    confirmationHash: preview.confirmationHash!,
  };
}

describe('mutation executor', () => {
  it('previews, applies with preconditions, verifies, and double-applies as no-op', async () => {
    const { adapter, runtime, dispatch } = await harness();
    const preview = await executeMutation(runtime, adapter, { id: 'p-1', name: 'After' });
    expect(preview.applicationState).toBe('preview');
    expect(dispatch).not.toHaveBeenCalled();
    const applied = await executeMutation(runtime, adapter, {
      id: 'p-1',
      name: 'After',
      dryRun: false,
      previewToken: preview.previewToken,
      expectedSemanticHash: preview.currentSemanticHash,
      expectedWriteShapeHash: preview.currentWriteShapeHash,
      expectedEntityTimestamp: preview.entityTimestamp,
      expectedDesiredHash: preview.desiredHash,
    });
    expect(applied.applicationState).toBe('applied_verified');
    expect(dispatch).toHaveBeenCalledTimes(1);
    const repeatedPreview = await executeMutation(runtime, adapter, {
      id: 'p-1',
      name: 'After',
    });
    const noOp = await executeMutation(runtime, adapter, {
      id: 'p-1', name: 'After', dryRun: false,
      previewToken: repeatedPreview.previewToken,
      expectedSemanticHash: repeatedPreview.currentSemanticHash,
      expectedWriteShapeHash: repeatedPreview.currentWriteShapeHash,
      expectedEntityTimestamp: repeatedPreview.entityTimestamp,
      expectedDesiredHash: repeatedPreview.desiredHash,
    });
    expect(noOp.applicationState).toBe('no_op');
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('recovers a lost response through semantic readback', async () => {
    const { adapter, runtime } = await harness(true);
    const preview = await executeMutation(runtime, adapter, { id: 'p-1', name: 'After' });
    const result = await executeMutation(runtime, adapter, {
      id: 'p-1', name: 'After', dryRun: false,
      previewToken: preview.previewToken,
      expectedSemanticHash: preview.currentSemanticHash,
      expectedWriteShapeHash: preview.currentWriteShapeHash,
      expectedEntityTimestamp: preview.entityTimestamp,
      expectedDesiredHash: preview.desiredHash,
    });
    expect(result.applicationState).toBe('applied_verified');
    expect(result.warnings[0]).toMatch(/readback proved/);
  });

  it('reconciles an uncertain idempotent replay by readback and never redispatches', async () => {
    const { adapter, runtime } = await harness();
    adapter.requiresIdempotency = true;
    const uncertainDispatch = vi.fn(async () => {
      throw new TypeError('connection lost before outcome was known');
    });
    adapter.dispatch = uncertainDispatch;
    const preview = await executeMutation(runtime, adapter, { id: 'p-1', name: 'After' });
    const apply = {
      id: 'p-1',
      name: 'After',
      dryRun: false,
      previewToken: preview.previewToken,
      idempotencyKey: preview.idempotencyKey,
      expectedSemanticHash: preview.currentSemanticHash,
      expectedWriteShapeHash: preview.currentWriteShapeHash,
      expectedEntityTimestamp: preview.entityTimestamp,
      expectedDesiredHash: preview.desiredHash,
    } satisfies Input;

    await expect(executeMutation(runtime, adapter, apply)).resolves.toMatchObject({
      applicationState: 'unknown_after_write',
    });
    expect(uncertainDispatch).toHaveBeenCalledTimes(1);

    await expect(executeMutation(runtime, adapter, apply)).resolves.toMatchObject({
      applicationState: 'unknown_after_write',
      error: { code: 'IDEMPOTENT_REPLAY_RECONCILIATION_REQUIRED' },
    });
    expect(uncertainDispatch).toHaveBeenCalledTimes(1);
    await expect(runtime.journal.get(preview.operationId)).resolves.toMatchObject({
      state: 'unknown_after_write',
    });

    let plannedReadbackReady = false;
    const originalBuildDesired = adapter.buildDesired;
    adapter.buildDesired = (...args) => {
      plannedReadbackReady = true;
      return originalBuildDesired(...args);
    };
    adapter.read = async () => plannedReadbackReady
      ? { id: 'p-1', name: 'After', timestamp: 't-2', rowId: 'row-1' }
      : { id: 'p-1', name: 'Before', timestamp: 't-1', rowId: 'row-1' };
    // Simulate a saga handler whose first read cannot discover planned child
    // IDs until buildDesired restores them from the idempotency mapping.
    plannedReadbackReady = false;
    await expect(executeMutation(runtime, adapter, apply)).resolves.toMatchObject({
      applicationState: 'applied_verified',
      verified: true,
      warnings: [expect.stringMatching(/readback only/)],
    });
    expect(uncertainDispatch).toHaveBeenCalledTimes(1);
    await expect(runtime.journal.get(preview.operationId)).resolves.toMatchObject({
      state: 'applied_verified',
      steps: [{ stepId: 'write', state: 'verified' }],
    });
  });

  it('rejects stale preconditions with zero writes', async () => {
    const { adapter, runtime, dispatch } = await harness();
    const preview = await executeMutation(runtime, adapter, { id: 'p-1', name: 'After' });
    await expect(executeMutation(runtime, adapter, {
      id: 'p-1', name: 'After', dryRun: false,
      previewToken: preview.previewToken,
      expectedSemanticHash: 'stale',
      expectedWriteShapeHash: preview.currentWriteShapeHash,
      expectedEntityTimestamp: preview.entityTimestamp,
      expectedDesiredHash: preview.desiredHash,
    })).rejects.toThrow(/MUTATION_CONFLICT/);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('requires a strict exact confirmation before dispatch', async () => {
    const { adapter, runtime, dispatch } = await harness();
    adapter.requiresExplicitConfirmation = true;
    const preview = await executeMutation(runtime, adapter, { id: 'p-1', name: 'After' });
    const baseApply = {
      id: 'p-1',
      name: 'After',
      dryRun: false,
      previewToken: preview.previewToken,
      expectedSemanticHash: preview.currentSemanticHash,
      expectedWriteShapeHash: preview.currentWriteShapeHash,
      expectedEntityTimestamp: preview.entityTimestamp,
      expectedDesiredHash: preview.desiredHash,
    } satisfies Input;

    await expect(executeMutation(runtime, adapter, baseApply)).rejects.toThrow(
      /USER_CONFIRMATION_REQUIRED/
    );
    await expect(executeMutation(runtime, adapter, {
      ...baseApply,
      confirmation: {
        ...confirmationFrom(preview),
        confirmationHash: preview.confirmationHash!.toUpperCase(),
      },
    })).rejects.toThrow(/USER_CONFIRMATION_SCOPE_MISMATCH/);
    await expect(executeMutation(runtime, adapter, {
      ...baseApply,
      confirmation: {
        scope: {
          ...preview.confirmationScope!,
          resourceId: 'another-product',
        },
        confirmationHash: preview.confirmationHash!,
      },
    })).rejects.toThrow(/USER_CONFIRMATION_SCOPE_MISMATCH/);
    expect(dispatch).not.toHaveBeenCalled();

    await expect(executeMutation(runtime, adapter, {
      ...baseApply,
      confirmation: confirmationFrom(preview),
    })).resolves.toMatchObject({
      applicationState: 'applied_verified',
      confirmationValidated: true,
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('leaves no operation or idempotency files when confirmation is rejected', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'inflow-mutation-confirmation-reject-'));
    await chmod(stateDir, 0o700);
    let current: Row | undefined;
    const dispatch = vi.fn(async (_input: Input, _before: Row | undefined, desired: Row) => {
      current = desired;
    });
    const adapter: MutationAdapter<Input, Row, Row, Row> = {
      operation: 'set_product',
      resourceType: 'product',
      resourceId: () => undefined,
      mode: () => 'replace',
      adapterVersion: 'product-create-confirmed/v1',
      isCreate: () => true,
      read: async () => current,
      planIds: () => ({ resourceIds: ['p-created'] }),
      buildDesired: (input, _before, ids) => ({
        id: ids.resourceIds[0]!,
        name: input.name,
        timestamp: 't-1',
        rowId: 'row-1',
      }),
      semantic: (row) => ({ id: row.id, name: row.name }),
      writeShape: () => null,
      timestamp: () => undefined,
      output: (row) => row,
      dispatch,
      affectedResources: () => [{ type: 'product', id: 'p-created' }],
      invalidationTags: () => ['product:p-created'],
      writesEnabled: true,
      requireTimestamp: false,
      requiresExplicitConfirmation: true,
    };
    const runtime = {
      tenantFingerprint: tenantFingerprint('company', 'secret'),
      baseHost: 'api.test',
      apiVersion: '2026-04-13',
      serverBuildIdentity: 'a'.repeat(64),
      tokenService: new PreviewTokenService('secret', 'company'),
      journal: new MutationJournal(stateDir),
    };
    const preview = await executeMutation(runtime, adapter, {
      id: '',
      name: 'Created',
    });
    await expect(executeMutation(runtime, adapter, {
      id: '',
      name: 'Created',
      dryRun: false,
      previewToken: preview.previewToken,
      idempotencyKey: preview.idempotencyKey,
      expectedDesiredHash: preview.desiredHash,
    })).rejects.toThrow(/USER_CONFIRMATION_REQUIRED/);
    expect(dispatch).not.toHaveBeenCalled();
    expect(await readdir(join(stateDir, 'operations'))).toEqual([]);
    expect(await readdir(join(stateDir, 'idempotency'))).toEqual([]);
  });

  it('rejects confirmation replay across server builds and tenants', async () => {
    const { adapter, runtime, dispatch } = await harness();
    adapter.requiresExplicitConfirmation = true;
    const preview = await executeMutation(runtime, adapter, { id: 'p-1', name: 'After' });
    const apply = {
      id: 'p-1',
      name: 'After',
      dryRun: false,
      previewToken: preview.previewToken,
      expectedSemanticHash: preview.currentSemanticHash,
      expectedWriteShapeHash: preview.currentWriteShapeHash,
      expectedEntityTimestamp: preview.entityTimestamp,
      expectedDesiredHash: preview.desiredHash,
      confirmation: confirmationFrom(preview),
    } satisfies Input;

    await expect(executeMutation({
      ...runtime,
      serverBuildIdentity: 'b'.repeat(64),
    }, adapter, apply)).rejects.toThrow(/USER_CONFIRMATION_SCOPE_MISMATCH/);
    await expect(executeMutation({
      ...runtime,
      tenantFingerprint: tenantFingerprint('another-company', 'secret'),
    }, adapter, apply)).rejects.toThrow(/PREVIEW_TOKEN_SCOPE_MISMATCH/);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('dispatches exactly once when confirmed and unconfirmed same-key creates race', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'inflow-mutation-confirmation-race-'));
    await chmod(stateDir, 0o700);
    let current: Row | undefined;
    const dispatch = vi.fn(async (_input: Input, _before: Row | undefined, desired: Row) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      current = desired;
    });
    const adapter: MutationAdapter<Input, Row, Row, Row> = {
      operation: 'set_product',
      resourceType: 'product',
      resourceId: () => undefined,
      mode: () => 'replace',
      adapterVersion: 'product-create-confirmed/v1',
      isCreate: () => true,
      read: async () => current,
      planIds: () => ({ resourceIds: ['p-created'] }),
      buildDesired: (input, _before, ids) => ({
        id: ids.resourceIds[0]!,
        name: input.name,
        timestamp: 't-1',
        rowId: 'row-1',
      }),
      semantic: (row) => ({ id: row.id, name: row.name }),
      writeShape: () => null,
      timestamp: () => undefined,
      output: (row) => row,
      dispatch,
      affectedResources: () => [{ type: 'product', id: 'p-created' }],
      invalidationTags: () => ['product:p-created'],
      writesEnabled: true,
      requireTimestamp: false,
      requiresExplicitConfirmation: true,
    };
    const runtime = {
      tenantFingerprint: tenantFingerprint('company', 'secret'),
      baseHost: 'api.test',
      apiVersion: '2026-04-13',
      serverBuildIdentity: 'a'.repeat(64),
      tokenService: new PreviewTokenService('secret', 'company'),
      journal: new MutationJournal(stateDir),
    };
    const preview = await executeMutation(runtime, adapter, { id: '', name: 'Created' });
    const baseApply = {
      id: '',
      name: 'Created',
      dryRun: false,
      previewToken: preview.previewToken,
      idempotencyKey: preview.idempotencyKey,
      expectedDesiredHash: preview.desiredHash,
    } satisfies Input;

    const outcomes = await Promise.allSettled([
      executeMutation(runtime, adapter, {
        ...baseApply,
        confirmation: confirmationFrom(preview),
      }),
      executeMutation(runtime, adapter, baseApply),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(await readdir(join(stateDir, 'idempotency'))).toHaveLength(1);
    expect((await readdir(join(stateDir, 'operations')))
      .filter((entry) => entry.endsWith('.json'))).toHaveLength(1);
  });

  it('mints and token-binds idempotency for a tokenless create preview', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'inflow-mutation-create-'));
    await chmod(stateDir, 0o700);
    let current: Row | undefined;
    const dispatch = vi.fn(async (_input: Input, _before: Row | undefined, desired: Row) => { current = desired; });
    const adapter: MutationAdapter<Input, Row, Row, Row> = {
      operation: 'set_product', resourceType: 'product', resourceId: () => undefined,
      mode: () => 'replace', adapterVersion: 'product-create/v1', isCreate: () => true,
      read: async () => current, planIds: () => ({ resourceIds: ['p-created'] }),
      buildDesired: (input, _before, ids) => ({ id: ids.resourceIds[0], name: input.name, timestamp: 't-1', rowId: 'row-1' }),
      semantic: (row) => ({ id: row.id, name: row.name }), writeShape: () => null,
      timestamp: () => undefined, output: (row) => row, dispatch,
      affectedResources: () => [{ type: 'product', id: 'p-created' }],
      invalidationTags: () => ['product:p-created'], writesEnabled: true, requireTimestamp: false,
    };
    const runtime = {
      tenantFingerprint: tenantFingerprint('company', 'secret'), baseHost: 'api.test', apiVersion: '2026-04-13',
      serverBuildIdentity: 'a'.repeat(64),
      tokenService: new PreviewTokenService('secret', 'company'), journal: new MutationJournal(stateDir),
    };
    const preview = await executeMutation(runtime, adapter, { id: '', name: 'Created' });
    expect(preview.applicationState).toBe('preview');
    expect(preview.idempotencyKey).toBeTruthy();
    await expect(executeMutation(runtime, adapter, {
      id: '', name: 'Created', dryRun: false, previewToken: preview.previewToken,
      idempotencyKey: preview.idempotencyKey, expectedDesiredHash: preview.desiredHash,
    })).resolves.toMatchObject({ applicationState: 'applied_verified', resourceId: 'p-created' });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('requires idempotency for an additive existing-resource mutation', async () => {
    const { adapter, runtime, dispatch } = await harness();
    adapter.requiresIdempotency = true;
    const preview = await executeMutation(runtime, adapter, { id: 'p-1', name: 'After' });
    expect(preview.idempotencyKey).toBeTruthy();

    await expect(executeMutation(runtime, adapter, {
      id: 'p-1',
      name: 'After',
      dryRun: false,
      previewToken: preview.previewToken,
      expectedSemanticHash: preview.currentSemanticHash,
      expectedWriteShapeHash: preview.currentWriteShapeHash,
      expectedEntityTimestamp: preview.entityTimestamp,
      expectedDesiredHash: preview.desiredHash,
    })).rejects.toThrow(/missing idempotency key/);
    expect(dispatch).not.toHaveBeenCalled();

    await expect(executeMutation(runtime, adapter, {
      id: 'p-1',
      name: 'After',
      dryRun: false,
      previewToken: preview.previewToken,
      idempotencyKey: preview.idempotencyKey,
      expectedSemanticHash: preview.currentSemanticHash,
      expectedWriteShapeHash: preview.currentWriteShapeHash,
      expectedEntityTimestamp: preview.entityTimestamp,
      expectedDesiredHash: preview.desiredHash,
    })).resolves.toMatchObject({ applicationState: 'applied_verified' });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it('does not require idempotency for deterministic full replacement with readback', async () => {
    const { adapter, runtime } = await harness();
    adapter.requiresIdempotency = false;
    const preview = await executeMutation(runtime, adapter, { id: 'p-1', name: 'After' });
    expect(preview.idempotencyKey).toBeUndefined();
    await expect(executeMutation(runtime, adapter, {
      id: 'p-1',
      name: 'After',
      dryRun: false,
      previewToken: preview.previewToken,
      expectedSemanticHash: preview.currentSemanticHash,
      expectedWriteShapeHash: preview.currentWriteShapeHash,
      expectedEntityTimestamp: preview.entityTimestamp,
      expectedDesiredHash: preview.desiredHash,
    })).resolves.toMatchObject({ applicationState: 'applied_verified' });
  });

  it('rejects an apply when its gate closes after preview', async () => {
    const { adapter, runtime, dispatch } = await harness();
    let gateOpen = true;
    adapter.authorizeApply = () => {
      if (!gateOpen) throw new Error('SAFE_WRITES_DISABLED: gate closed');
    };
    const preview = await executeMutation(runtime, adapter, { id: 'p-1', name: 'After' });
    gateOpen = false;
    await expect(executeMutation(runtime, adapter, {
      id: 'p-1',
      name: 'After',
      dryRun: false,
      previewToken: preview.previewToken,
      expectedSemanticHash: preview.currentSemanticHash,
      expectedWriteShapeHash: preview.currentWriteShapeHash,
      expectedEntityTimestamp: preview.entityTimestamp,
      expectedDesiredHash: preview.desiredHash,
    })).rejects.toThrow(/SAFE_WRITES_DISABLED/);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('does not let a no-op apply bypass a closed gate', async () => {
    const { adapter, runtime, dispatch } = await harness();
    adapter.isNoOp = () => true;
    adapter.authorizeApply = () => {
      throw new Error('SAFE_WRITES_DISABLED: gate closed');
    };
    const preview = await executeMutation(runtime, adapter, { id: 'p-1', name: 'After' });
    await expect(executeMutation(runtime, adapter, {
      id: 'p-1',
      name: 'After',
      dryRun: false,
      previewToken: preview.previewToken,
      expectedSemanticHash: preview.currentSemanticHash,
      expectedWriteShapeHash: preview.currentWriteShapeHash,
      expectedEntityTimestamp: preview.entityTimestamp,
      expectedDesiredHash: preview.desiredHash,
    })).rejects.toThrow(/SAFE_WRITES_DISABLED/);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('rechecks authorization immediately before dispatch and journals closure as not applied', async () => {
    const { adapter, runtime, dispatch } = await harness();
    let gateOpen = true;
    const originalDispatch = adapter.dispatch;
    adapter.authorizeApply = () => {
      if (!gateOpen) throw new Error('SAFE_WRITES_DISABLED: gate closed');
    };
    adapter.prepareDispatch = async (input, current, desired) => {
      gateOpen = false;
      return () => originalDispatch(input, current, desired);
    };
    const preview = await executeMutation(runtime, adapter, { id: 'p-1', name: 'After' });
    await expect(executeMutation(runtime, adapter, {
      id: 'p-1',
      name: 'After',
      dryRun: false,
      previewToken: preview.previewToken,
      expectedSemanticHash: preview.currentSemanticHash,
      expectedWriteShapeHash: preview.currentWriteShapeHash,
      expectedEntityTimestamp: preview.entityTimestamp,
      expectedDesiredHash: preview.desiredHash,
    })).rejects.toThrow(/SAFE_WRITES_DISABLED/);
    expect(dispatch).not.toHaveBeenCalled();
    await expect(runtime.journal.get(preview.operationId)).resolves.toMatchObject({
      state: 'not_applied',
      steps: [{ stepId: 'write', state: 'failed', errorCode: 'SAFE_WRITES_DISABLED' }],
    });
  });

  it('verifies exact-target deletion by absence and reports repeated absence', async () => {
    const stateDir = await mkdtemp(join(tmpdir(), 'inflow-mutation-delete-'));
    await chmod(stateDir, 0o700);
    let current: Row | undefined = {
      id: 'w-1',
      name: 'Webhook',
      timestamp: 't-1',
      rowId: 'row-1',
    };
    const dispatch = vi.fn(async () => {
      current = undefined;
    });
    const adapter: MutationAdapter<Input, Row, Row, Row> = {
      operation: 'remove_webhook',
      resourceType: 'webhook',
      resourceId: (input) => input.id,
      mode: () => 'delete',
      adapterVersion: 'webhook-delete/v1',
      isCreate: () => false,
      read: async () => current && structuredClone(current),
      buildDesired: (input) => ({
        id: input.id,
        name: 'deleted',
        timestamp: 'deleted',
        rowId: 'deleted',
      }),
      semantic: (row) => ({ id: row.id, name: row.name }),
      writeShape: (row) => row ? { id: row.id, rowId: row.rowId } : null,
      timestamp: (row) => row?.timestamp,
      output: (row) => row,
      dispatch,
      affectedResources: (input) => [{ type: 'webhook', id: input.id }],
      invalidationTags: (input) => [`webhook:${input.id}`],
      writesEnabled: true,
      requiresIdempotency: false,
      isNoOp: (_input, before) => before === undefined,
      noOpResultCode: () => 'already_absent',
      verifyReadback: (_input, _before, _desired, actual) => actual === undefined,
      requireTimestamp: false,
    };
    const runtime = {
      tenantFingerprint: tenantFingerprint('company', 'secret'),
      baseHost: 'api.test',
      apiVersion: '2026-04-13',
      serverBuildIdentity: 'a'.repeat(64),
      tokenService: new PreviewTokenService('secret', 'company'),
      journal: new MutationJournal(stateDir),
    };

    const preview = await executeMutation(runtime, adapter, { id: 'w-1', name: '' });
    await expect(executeMutation(runtime, adapter, {
      id: 'w-1',
      name: '',
      dryRun: false,
      previewToken: preview.previewToken,
      expectedSemanticHash: preview.currentSemanticHash,
      expectedWriteShapeHash: preview.currentWriteShapeHash,
      expectedEntityTimestamp: preview.entityTimestamp,
      expectedDesiredHash: preview.desiredHash,
    })).resolves.toMatchObject({ applicationState: 'applied_verified', verified: true });
    expect(dispatch).toHaveBeenCalledTimes(1);

    const repeatedPreview = await executeMutation(runtime, adapter, { id: 'w-1', name: '' });
    await expect(executeMutation(runtime, adapter, {
      id: 'w-1',
      name: '',
      dryRun: false,
      previewToken: repeatedPreview.previewToken,
      expectedDesiredHash: repeatedPreview.desiredHash,
    })).resolves.toMatchObject({
      applicationState: 'no_op',
      resultCode: 'already_absent',
      verified: true,
    });
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});
