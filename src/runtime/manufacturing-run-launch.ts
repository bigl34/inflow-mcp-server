#!/usr/bin/env node

import {
  installCoordinatorCredentialEnvironment,
  readSecureCredentialEnvironment,
} from './credential-env.js';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_COORDINATOR_CREDENTIAL_FILE =
  'YOUR_CREDENTIALS_PATH/configs/inflow-manufacturing-coordinator.env';

interface LaunchArguments {
  credentialFile: string;
  validateOnly: boolean;
}

function parseLaunchArguments(argv: readonly string[]): LaunchArguments {
  let credentialFile = DEFAULT_COORDINATOR_CREDENTIAL_FILE;
  let validateOnly = false;
  let credentialFileSeen = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--validate-only') {
      if (validateOnly) throw new Error('ARGUMENT_VALIDATE_ONLY_DUPLICATE');
      validateOnly = true;
      continue;
    }
    if (argument === '--credential-file') {
      if (credentialFileSeen) {
        throw new Error('ARGUMENT_CREDENTIAL_FILE_DUPLICATE');
      }
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error('ARGUMENT_CREDENTIAL_FILE_REQUIRED');
      }
      credentialFile = value;
      credentialFileSeen = true;
      index += 1;
      continue;
    }
    throw new Error('ARGUMENT_UNKNOWN');
  }
  return { credentialFile, validateOnly };
}

export interface ManufacturingRunLaunchDependencies {
  environment: Record<string, string | undefined>;
  importCoordinator(): Promise<{
    startManufacturingRunHttp(): Promise<{
      server: { address(): unknown };
      close(): Promise<void>;
    }>;
  }>;
  signals: {
    once(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
    off(event: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
  };
}

export type ManufacturingRunLaunchResult =
  | { mode: 'validated'; credentialFile: string }
  | {
      mode: 'live';
      credentialFile: string;
      address: unknown;
      close(): Promise<void>;
    };

export async function launchManufacturingRun(
  argv: readonly string[],
  dependencies: Partial<ManufacturingRunLaunchDependencies> = {}
): Promise<ManufacturingRunLaunchResult> {
  const options = parseLaunchArguments(argv);
  const credentials = readSecureCredentialEnvironment(options.credentialFile);
  if (options.validateOnly) {
    return {
      mode: 'validated',
      credentialFile: options.credentialFile,
    };
  }
  const environment = dependencies.environment ?? process.env;
  const importCoordinator = dependencies.importCoordinator ??
    (() => import('../coordinator-http.js'));
  const signals = dependencies.signals ?? process;

  installCoordinatorCredentialEnvironment(credentials, environment);
  const coordinatorModule = await importCoordinator();
  // Keep the dedicated file authoritative even if a transitive import tries
  // to populate dotenv values.
  installCoordinatorCredentialEnvironment(credentials, environment);
  const runtime = await coordinatorModule.startManufacturingRunHttp();
  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closePromise) return closePromise;
    signals.off('SIGINT', onSignal);
    signals.off('SIGTERM', onSignal);
    closePromise = runtime.close();
    return closePromise;
  };
  const onSignal = (): void => {
    void close().catch(() => {
      process.exitCode = 1;
    });
  };
  signals.once('SIGINT', onSignal);
  signals.once('SIGTERM', onSignal);

  return {
    mode: 'live',
    credentialFile: options.credentialFile,
    address: runtime.server.address(),
    close,
  };
}

export function runtimeFailureCode(error: unknown): string {
  const code =
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
      ? error.code
      : undefined;
  return code !== undefined && /^[A-Z][A-Z0-9_]{2,80}$/.test(code)
    ? code
    : 'COORDINATOR_LAUNCH_FAILED';
}

async function main(): Promise<void> {
  const result = await launchManufacturingRun(process.argv.slice(2));
  if (result.mode === 'validated') {
    console.error(JSON.stringify({
      event: 'manufacturing_run_credentials_validated',
      mode: result.mode,
    }));
    return;
  }
  console.error(JSON.stringify({
    event: 'manufacturing_run_http_started',
    mode: result.mode,
    address: result.address,
  }));
}

const isMain =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  void main().catch((error: unknown) => {
    console.error(JSON.stringify({
      event: 'manufacturing_run_launch_fatal',
      code: runtimeFailureCode(error),
    }));
    process.exitCode = 1;
  });
}
