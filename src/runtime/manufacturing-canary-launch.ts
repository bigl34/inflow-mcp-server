#!/usr/bin/env node

import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
} from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  installCoordinatorCredentialEnvironment,
  readSecureCredentialEnvironment,
} from './credential-env.js';
import type { InflowConfig } from '../config.js';

export const DEFAULT_MANUFACTURING_CANARY_CREDENTIAL_FILE =
  'YOUR_CREDENTIALS_PATH/configs/inflow-manufacturing-coordinator.env';

const MAX_JSON_MATERIAL_BYTES = 256 * 1024;

const PRODUCTION_WRITE_GATE_ENVIRONMENT_NAMES = [
  'INFLOW_ENABLE_SAFE_WRITES',
  'INFLOW_ENABLE_STOCK_WRITES',
  'INFLOW_ENABLE_MANUFACTURING_PICK_BATCH_WRITES',
  'INFLOW_ENABLE_MANUFACTURING_OPERATION_COMPLETION_WRITES',
  'INFLOW_ENABLE_MANUFACTURING_WRITES',
  'INFLOW_ENABLE_PRICE_WRITES',
  'INFLOW_ENABLE_PRODUCT_GROUP_WRITES',
  'INFLOW_ENABLE_MO_SERIAL_WRITES',
  'INFLOW_ENABLE_STANDARD_WRITES',
  'INFLOW_ENABLE_LEGACY_WRITES',
] as const;

const FIXTURE_COMMANDS = [
  'plan',
  'create-products',
  'configure-products',
  'seed-stock',
  'handoff',
  'reverse-stock',
  'clear-config',
  'deactivate-products',
  'verify-cleanup',
  'status',
] as const;

type FixtureCommand = typeof FIXTURE_COMMANDS[number];

const MUTATING_FIXTURE_COMMANDS = new Set<FixtureCommand>([
  'create-products',
  'configure-products',
  'seed-stock',
  'reverse-stock',
  'clear-config',
  'deactivate-products',
]);

export class ManufacturingCanaryLaunchError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'ManufacturingCanaryLaunchError';
  }
}

interface PickBatchLaunchArguments {
  mode: 'pick-batch';
  credentialFile: string;
  scenarioPath: string;
  approvalsPath: string;
  runtimeMaterialPath: string;
}

interface FixtureLaunchArguments {
  mode: 'fixture';
  credentialFile: string;
  command: FixtureCommand;
  manifestPath: string;
  approvalPath?: string;
  stateDir: string;
  ownerId: string;
}

interface OperationCompletionLaunchArguments {
  mode: 'operation-completion';
  credentialFile: string;
  resourceId: string;
  fixturePath: string;
  approvalNonce: string;
}

export type ManufacturingCanaryLaunchArguments =
  | PickBatchLaunchArguments
  | FixtureLaunchArguments
  | OperationCompletionLaunchArguments;

function argumentValues(argv: readonly string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith('--')) {
      throw new ManufacturingCanaryLaunchError('CANARY_LAUNCH_ARGUMENT_INVALID');
    }
    if (value === undefined || value.startsWith('--')) {
      throw new ManufacturingCanaryLaunchError('CANARY_LAUNCH_ARGUMENT_VALUE_REQUIRED');
    }
    if (values.has(flag)) {
      throw new ManufacturingCanaryLaunchError('CANARY_LAUNCH_ARGUMENT_DUPLICATE');
    }
    values.set(flag, value);
  }
  return values;
}

function requireArgument(values: ReadonlyMap<string, string>, flag: string): string {
  const value = values.get(flag);
  if (!value) {
    throw new ManufacturingCanaryLaunchError('CANARY_LAUNCH_ARGUMENT_REQUIRED');
  }
  return value;
}

function assertOnlyArguments(
  values: ReadonlyMap<string, string>,
  allowed: ReadonlySet<string>
): void {
  for (const flag of values.keys()) {
    if (!allowed.has(flag)) {
      throw new ManufacturingCanaryLaunchError('CANARY_LAUNCH_ARGUMENT_UNKNOWN');
    }
  }
}

export function parseManufacturingCanaryLaunchArguments(
  argv: readonly string[]
): ManufacturingCanaryLaunchArguments {
  const values = argumentValues(argv);
  const mode = requireArgument(values, '--mode');
  if (
    mode !== 'pick-batch' &&
    mode !== 'fixture' &&
    mode !== 'operation-completion'
  ) {
    throw new ManufacturingCanaryLaunchError('CANARY_LAUNCH_MODE_INVALID');
  }
  const credentialFile = values.get('--credential-file') ??
    DEFAULT_MANUFACTURING_CANARY_CREDENTIAL_FILE;

  if (mode === 'pick-batch') {
    assertOnlyArguments(values, new Set([
      '--mode',
      '--credential-file',
      '--scenario',
      '--approvals',
      '--runtime-material',
    ]));
    return {
      mode,
      credentialFile,
      scenarioPath: requireArgument(values, '--scenario'),
      approvalsPath: requireArgument(values, '--approvals'),
      runtimeMaterialPath: requireArgument(values, '--runtime-material'),
    };
  }

  if (mode === 'operation-completion') {
    assertOnlyArguments(values, new Set([
      '--mode',
      '--credential-file',
      '--resource-id',
      '--fixture',
      '--approval-nonce',
    ]));
    return {
      mode,
      credentialFile,
      resourceId: requireArgument(values, '--resource-id'),
      fixturePath: requireArgument(values, '--fixture'),
      approvalNonce: requireArgument(values, '--approval-nonce'),
    };
  }

  assertOnlyArguments(values, new Set([
    '--mode',
    '--credential-file',
    '--command',
    '--manifest',
    '--approval',
    '--state-dir',
    '--owner-id',
  ]));
  const commandValue = requireArgument(values, '--command');
  if (!(FIXTURE_COMMANDS as readonly string[]).includes(commandValue)) {
    throw new ManufacturingCanaryLaunchError('CANARY_LAUNCH_FIXTURE_COMMAND_INVALID');
  }
  const command = commandValue as FixtureCommand;
  const manifestPath = requireArgument(values, '--manifest');
  const approvalPath = values.get('--approval');
  const stateDir = requireArgument(values, '--state-dir');
  const ownerId = requireArgument(values, '--owner-id');
  if (!isAbsolute(stateDir)) {
    throw new ManufacturingCanaryLaunchError('CANARY_LAUNCH_STATE_DIR_ABSOLUTE_REQUIRED');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(ownerId)) {
    throw new ManufacturingCanaryLaunchError('CANARY_LAUNCH_OWNER_ID_INVALID');
  }
  if (MUTATING_FIXTURE_COMMANDS.has(command) !== Boolean(approvalPath)) {
    throw new ManufacturingCanaryLaunchError(
      MUTATING_FIXTURE_COMMANDS.has(command)
        ? 'CANARY_LAUNCH_APPROVAL_REQUIRED'
        : 'CANARY_LAUNCH_APPROVAL_NOT_ALLOWED'
    );
  }
  return {
    mode,
    credentialFile,
    command,
    manifestPath,
    ...(approvalPath ? { approvalPath } : {}),
    stateDir,
    ownerId,
  };
}

export interface SecureJsonMaterial {
  raw: string;
  value: unknown;
}

export function readSecureJsonMaterial(path: string): SecureJsonMaterial {
  if (!isAbsolute(path)) {
    throw new ManufacturingCanaryLaunchError('CANARY_MATERIAL_ABSOLUTE_REQUIRED');
  }
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile()) {
      throw new ManufacturingCanaryLaunchError('CANARY_MATERIAL_NOT_REGULAR');
    }
    if (metadata.nlink !== 1) {
      throw new ManufacturingCanaryLaunchError('CANARY_MATERIAL_LINK_COUNT_INVALID');
    }
    const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
    if (uid !== undefined && metadata.uid !== uid) {
      throw new ManufacturingCanaryLaunchError('CANARY_MATERIAL_OWNER_INVALID');
    }
    const permissions = metadata.mode & 0o777;
    if (
      (permissions & 0o077) !== 0 ||
      (permissions & 0o400) === 0 ||
      (permissions & 0o100) !== 0
    ) {
      throw new ManufacturingCanaryLaunchError('CANARY_MATERIAL_MODE_INVALID');
    }
    if (metadata.size > MAX_JSON_MATERIAL_BYTES) {
      throw new ManufacturingCanaryLaunchError('CANARY_MATERIAL_TOO_LARGE');
    }
    const raw = readFileSync(descriptor, 'utf8');
    let value: unknown;
    try {
      value = JSON.parse(raw) as unknown;
    } catch {
      throw new ManufacturingCanaryLaunchError('CANARY_MATERIAL_JSON_INVALID');
    }
    return { raw: JSON.stringify(value), value };
  } catch (error) {
    if (error instanceof ManufacturingCanaryLaunchError) throw error;
    throw new ManufacturingCanaryLaunchError('CANARY_MATERIAL_OPEN_FAILED');
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

interface PickBatchRunnerResult {
  status: unknown;
  checkpoint: unknown;
  stage?: unknown;
  attestationIssued: unknown;
}

interface FixtureRunnerResult {
  command: unknown;
  stage: unknown;
  manifestHash: unknown;
  nextApproval?: unknown;
  stockBaselineHash?: unknown;
  seededStockHash?: unknown;
  approvedInertResiduals?: unknown;
}

interface OperationCompletionRunnerResult {
  resourceId: unknown;
  cleanupSucceeded: unknown;
  attestationIssued: unknown;
  passed: unknown;
  errors: unknown;
}

interface FixtureRunnerInput {
  command: FixtureCommand;
  manifest: unknown;
  approval?: unknown;
  client: unknown;
  stateDir: string;
  ownerId: string;
  runtimeIdentity: {
    tenantFingerprint: string;
    baseHost: string;
    apiVersion: string;
    probeBuild: string;
    adapterManifestHash: string;
  };
}

export interface ManufacturingCanaryRuntimeModule {
  loadConfig(): InflowConfig;
  createInflowClient(config: InflowConfig): unknown;
  tenantFingerprint(companyId: string, apiKey: string, baseHost?: string): string;
  runPickBatch(
    environment: Record<string, string | undefined>,
    dependencies: { loadConfig(): InflowConfig }
  ): Promise<PickBatchRunnerResult>;
  runFixture(input: FixtureRunnerInput): Promise<FixtureRunnerResult>;
  runOperationCompletion(
    resourceId: string,
    dependencies: {
      client: unknown;
      env: NodeJS.ProcessEnv;
      config: InflowConfig;
    }
  ): Promise<OperationCompletionRunnerResult>;
}

async function importManufacturingCanaryRuntime(): Promise<ManufacturingCanaryRuntimeModule> {
  const [
    configuration,
    inflow,
    preview,
    pickBatch,
    fixtures,
    domainCanaries,
  ] = await Promise.all([
    import('../config.js'),
    import('../client/inflow.js'),
    import('../core/preview-token.js'),
    import('../probes/manufacturing-pick-batch.js'),
    import('../probes/manufacturing-pick-batch-fixtures.js'),
    import('../probes/domain-write-canaries.js'),
  ]);
  return {
    loadConfig: configuration.loadConfig,
    createInflowClient: (config) => new inflow.InflowClient(config),
    tenantFingerprint: preview.tenantFingerprint,
    runPickBatch: (environment, dependencies) =>
      pickBatch.runManufacturingPickBatchCanaryCliFromEnvironment(
        environment,
        dependencies
      ),
    runFixture: (input) =>
      fixtures.runManufacturingPickBatchFixtureCommand({
        command: input.command,
        manifest: input.manifest,
        ...(input.approval === undefined ? {} : { approval: input.approval }),
        client: input.client as Parameters<
          typeof fixtures.runManufacturingPickBatchFixtureCommand
        >[0]['client'],
        stateDir: input.stateDir,
        ownerId: input.ownerId,
        runtimeIdentity: input.runtimeIdentity,
      }),
    runOperationCompletion: (resourceId, dependencies) =>
      domainCanaries.runApprovedOperationCompletionCanary(
        resourceId,
        {
          client: dependencies.client,
          env: dependencies.env,
          config: dependencies.config,
        } as NonNullable<Parameters<
          typeof domainCanaries.runApprovedOperationCompletionCanary
        >[1]>
      ),
  };
}

export interface ManufacturingCanaryLaunchDependencies {
  environment: Record<string, string | undefined>;
  readCredentialEnvironment(path: string): Record<string, string>;
  installCredentialEnvironment(
    values: Readonly<Record<string, string>>,
    target: Record<string, string | undefined>
  ): void;
  readJsonMaterial(path: string): SecureJsonMaterial;
  importRuntime(): Promise<ManufacturingCanaryRuntimeModule>;
}

type PickBatchStatus =
  | 'approval-required'
  | 'stage-input-required'
  | 'waiting-manual-completion'
  | 'attested';

export type ManufacturingCanaryLaunchResult =
  | {
      schemaVersion: 'manufacturing-canary-launch-result/v1';
      mode: 'pick-batch';
      status: PickBatchStatus;
      checkpointState: string;
      checkpointHash: string;
      stage?: string;
      attestationIssued: boolean;
    }
  | {
      schemaVersion: 'manufacturing-canary-launch-result/v1';
      mode: 'fixture';
      command: FixtureCommand;
      stage: string;
      manifestHash: string;
      nextApproval?: { stage: string; stagePlanHash: string };
      stockBaselineHash?: string;
      seededStockHash?: string;
      approvedInertResiduals?: Array<{
        type: 'product' | 'stock-adjustment';
        id: string;
        state: 'deactivated' | 'retained';
      }>;
    }
  | {
      schemaVersion: 'manufacturing-canary-launch-result/v1';
      mode: 'operation-completion';
      resourceId: string;
      cleanupSucceeded: boolean;
      attestationIssued: boolean;
      passed: boolean;
      errorCount: number;
    };

function safeToken(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value)) {
    throw new ManufacturingCanaryLaunchError('CANARY_RESULT_INVALID');
  }
  return value;
}

function sanitizePickBatchResult(result: PickBatchRunnerResult): ManufacturingCanaryLaunchResult {
  const statuses = new Set<unknown>([
    'approval-required',
    'stage-input-required',
    'waiting-manual-completion',
    'attested',
  ]);
  if (!statuses.has(result.status as string) || typeof result.attestationIssued !== 'boolean') {
    throw new ManufacturingCanaryLaunchError('CANARY_RESULT_INVALID');
  }
  if (!result.checkpoint || typeof result.checkpoint !== 'object' || Array.isArray(result.checkpoint)) {
    throw new ManufacturingCanaryLaunchError('CANARY_RESULT_INVALID');
  }
  const checkpoint = result.checkpoint as Record<string, unknown>;
  return {
    schemaVersion: 'manufacturing-canary-launch-result/v1',
    mode: 'pick-batch',
    status: result.status as PickBatchStatus,
    checkpointState: safeToken(checkpoint.state),
    checkpointHash: safeToken(checkpoint.checkpointHash),
    ...(result.stage === undefined ? {} : { stage: safeToken(result.stage) }),
    attestationIssued: result.attestationIssued,
  };
}

function optionalSafeToken(value: unknown): string | undefined {
  return value === undefined ? undefined : safeToken(value);
}

function sanitizeFixtureResult(result: FixtureRunnerResult): ManufacturingCanaryLaunchResult {
  const command = safeToken(result.command);
  if (!(FIXTURE_COMMANDS as readonly string[]).includes(command)) {
    throw new ManufacturingCanaryLaunchError('CANARY_RESULT_INVALID');
  }
  let nextApproval: { stage: string; stagePlanHash: string } | undefined;
  if (result.nextApproval !== undefined) {
    if (
      !result.nextApproval ||
      typeof result.nextApproval !== 'object' ||
      Array.isArray(result.nextApproval)
    ) {
      throw new ManufacturingCanaryLaunchError('CANARY_RESULT_INVALID');
    }
    const next = result.nextApproval as Record<string, unknown>;
    nextApproval = {
      stage: safeToken(next.stage),
      stagePlanHash: safeToken(next.stagePlanHash),
    };
  }
  let approvedInertResiduals: Array<{
    type: 'product' | 'stock-adjustment';
    id: string;
    state: 'deactivated' | 'retained';
  }> | undefined;
  if (result.approvedInertResiduals !== undefined) {
    if (!Array.isArray(result.approvedInertResiduals)) {
      throw new ManufacturingCanaryLaunchError('CANARY_RESULT_INVALID');
    }
    approvedInertResiduals = result.approvedInertResiduals.map((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new ManufacturingCanaryLaunchError('CANARY_RESULT_INVALID');
      }
      const value = entry as Record<string, unknown>;
      if (
        (value.type !== 'product' && value.type !== 'stock-adjustment') ||
        (value.state !== 'deactivated' && value.state !== 'retained')
      ) {
        throw new ManufacturingCanaryLaunchError('CANARY_RESULT_INVALID');
      }
      return {
        type: value.type,
        id: safeToken(value.id),
        state: value.state,
      };
    });
  }
  const stockBaselineHash = optionalSafeToken(result.stockBaselineHash);
  const seededStockHash = optionalSafeToken(result.seededStockHash);
  return {
    schemaVersion: 'manufacturing-canary-launch-result/v1',
    mode: 'fixture',
    command: command as FixtureCommand,
    stage: safeToken(result.stage),
    manifestHash: safeToken(result.manifestHash),
    ...(nextApproval ? { nextApproval } : {}),
    ...(stockBaselineHash ? { stockBaselineHash } : {}),
    ...(seededStockHash ? { seededStockHash } : {}),
    ...(approvedInertResiduals ? { approvedInertResiduals } : {}),
  };
}

function sanitizeOperationCompletionResult(
  result: OperationCompletionRunnerResult
): ManufacturingCanaryLaunchResult {
  if (
    typeof result.cleanupSucceeded !== 'boolean' ||
    typeof result.attestationIssued !== 'boolean' ||
    typeof result.passed !== 'boolean' ||
    !Array.isArray(result.errors)
  ) {
    throw new ManufacturingCanaryLaunchError('CANARY_RESULT_INVALID');
  }
  return {
    schemaVersion: 'manufacturing-canary-launch-result/v1',
    mode: 'operation-completion',
    resourceId: safeToken(result.resourceId),
    cleanupSucceeded: result.cleanupSucceeded,
    attestationIssued: result.attestationIssued,
    passed: result.passed,
    errorCount: result.errors.length,
  };
}

function assertWriteGatesClosed(config: InflowConfig): void {
  if (
    config.safeWritesEnabled !== false ||
    config.stockWritesEnabled !== false ||
    config.writeGates['manufacturing-pick-batch-v1'] !== false ||
    config.writeGates['manufacturing-operation-completion-v1'] !== false ||
    config.writeGates.manufacturing !== false ||
    config.enableManufacturingWrites === true
  ) {
    throw new ManufacturingCanaryLaunchError('CANARY_WRITE_GATE_MUST_BE_CLOSED');
  }
}

export async function launchManufacturingCanary(
  argv: readonly string[],
  dependencies: Partial<ManufacturingCanaryLaunchDependencies> = {}
): Promise<ManufacturingCanaryLaunchResult> {
  const options = parseManufacturingCanaryLaunchArguments(argv);
  const readJsonMaterial = dependencies.readJsonMaterial ?? readSecureJsonMaterial;

  const pickMaterials = options.mode === 'pick-batch'
    ? {
        scenario: readJsonMaterial(options.scenarioPath),
        approvals: readJsonMaterial(options.approvalsPath),
        runtimeMaterial: readJsonMaterial(options.runtimeMaterialPath),
      }
    : undefined;
  const fixtureMaterials = options.mode === 'fixture'
    ? {
        manifest: readJsonMaterial(options.manifestPath),
        ...(options.approvalPath
          ? { approval: readJsonMaterial(options.approvalPath) }
          : {}),
      }
    : undefined;
  const operationCompletionMaterial =
    options.mode === 'operation-completion'
      ? readJsonMaterial(options.fixturePath)
      : undefined;

  const environment = dependencies.environment ?? process.env;
  const readCredentialEnvironment = dependencies.readCredentialEnvironment ??
    readSecureCredentialEnvironment;
  const installCredentialEnvironment = dependencies.installCredentialEnvironment ??
    installCoordinatorCredentialEnvironment;
  const credentials = readCredentialEnvironment(options.credentialFile);
  installCredentialEnvironment(credentials, environment);
  // The production bundle may assert the currently deployed release hashes.
  // A canary must bind to the artifacts it is actually running, so discard
  // only those non-secret deployment assertions before loadConfig recomputes
  // and verifies the local build identity.
  delete environment.INFLOW_ADAPTER_MANIFEST_HASH;
  delete environment.INFLOW_PROBE_BUILD;
  for (const name of PRODUCTION_WRITE_GATE_ENVIRONMENT_NAMES) {
    environment[name] = 'false';
  }
  environment.INFLOW_RATE_LIMIT = '20';
  environment.INFLOW_MAX_RETRIES = '0';

  // No runtime module that could load configuration is imported until the
  // dedicated credential environment has replaced all stale INFLOW_* values.
  const runtime = await (dependencies.importRuntime ?? importManufacturingCanaryRuntime)();
  const loadedConfig = runtime.loadConfig();
  assertWriteGatesClosed(loadedConfig);

  if (options.mode === 'pick-batch') {
    if (!pickMaterials) {
      throw new ManufacturingCanaryLaunchError('CANARY_MATERIAL_REQUIRED');
    }
    const materialEnvironment: Record<string, string | undefined> = {
      ...environment,
      INFLOW_MANUFACTURING_PICK_BATCH_CANARY_SCENARIO_JSON: pickMaterials.scenario.raw,
      INFLOW_MANUFACTURING_PICK_BATCH_CANARY_APPROVALS_JSON: pickMaterials.approvals.raw,
      INFLOW_MANUFACTURING_PICK_BATCH_CANARY_RUNTIME_MATERIAL_JSON:
        pickMaterials.runtimeMaterial.raw,
    };
    const result = await runtime.runPickBatch(materialEnvironment, {
      loadConfig: () => loadedConfig,
    });
    return sanitizePickBatchResult(result);
  }

  if (options.mode === 'operation-completion') {
    if (!operationCompletionMaterial) {
      throw new ManufacturingCanaryLaunchError('CANARY_MATERIAL_REQUIRED');
    }
    const result = await runtime.runOperationCompletion(
      options.resourceId,
      {
        client: runtime.createInflowClient(loadedConfig),
        config: loadedConfig,
        env: {
          ...environment,
          INFLOW_CANARY_APPROVED: 'true',
          INFLOW_CANARY_RESOURCE_ID: options.resourceId,
          INFLOW_CANARY_APPROVAL_NONCE: options.approvalNonce,
          INFLOW_CANARY_OPERATION_COMPLETION_JSON:
            operationCompletionMaterial.raw,
        },
      }
    );
    return sanitizeOperationCompletionResult(result);
  }

  // Execute exactly the objects read through the owner-only no-follow
  // descriptors above. The fixture runtime never reopens the supplied paths.
  if (!fixtureMaterials) {
    throw new ManufacturingCanaryLaunchError('CANARY_MATERIAL_REQUIRED');
  }
  const baseHost = new URL(loadedConfig.baseUrl).host.toLowerCase();
  const runtimeIdentity = {
    tenantFingerprint: runtime.tenantFingerprint(
      loadedConfig.companyId,
      loadedConfig.apiKey,
      baseHost
    ),
    baseHost,
    apiVersion: loadedConfig.apiVersion,
    probeBuild: loadedConfig.probeBuild,
    adapterManifestHash: loadedConfig.adapterManifestHash,
  };
  const result = await runtime.runFixture({
    command: options.command,
    manifest: fixtureMaterials.manifest.value,
    ...(fixtureMaterials.approval
      ? { approval: fixtureMaterials.approval.value }
      : {}),
    client: runtime.createInflowClient(loadedConfig),
    stateDir: options.stateDir,
    ownerId: options.ownerId,
    runtimeIdentity,
  });
  return sanitizeFixtureResult(result);
}

export function manufacturingCanaryFailureCode(error: unknown): string {
  const code = typeof error === 'object' && error !== null &&
    'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
  return code && /^[A-Z][A-Z0-9_]{2,80}$/.test(code)
    ? code
    : 'MANUFACTURING_CANARY_LAUNCH_FAILED';
}

export interface ManufacturingCanaryLaunchIo {
  stdout(value: string): void;
  stderr(value: string): void;
}

export async function runManufacturingCanaryMain(
  argv: readonly string[],
  dependencies: Partial<ManufacturingCanaryLaunchDependencies> = {},
  io: ManufacturingCanaryLaunchIo = {
    stdout: (value) => process.stdout.write(value),
    stderr: (value) => process.stderr.write(value),
  }
): Promise<0 | 1> {
  try {
    const result = await launchManufacturingCanary(argv, dependencies);
    io.stdout(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    io.stderr(`${JSON.stringify({
      event: 'manufacturing_canary_launch_fatal',
      code: manufacturingCanaryFailureCode(error),
    })}\n`);
    return 1;
  }
}

const isMain = process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  void runManufacturingCanaryMain(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
