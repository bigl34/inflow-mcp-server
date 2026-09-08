import type { InflowConfig } from '../config.js';
import { MutationJournal } from './mutation-journal.js';
import { PreviewTokenService, tenantFingerprint } from './preview-token.js';
import type { MutationRuntime } from './mutation.js';

export function createMutationRuntime(config: InflowConfig): MutationRuntime {
  const baseHost = new URL(config.baseUrl).host.toLowerCase();
  return {
    tenantFingerprint: tenantFingerprint(config.companyId, config.apiKey, baseHost),
    baseHost,
    apiVersion: config.apiVersion,
    serverBuildIdentity: config.adapterManifestHash,
    tokenService: new PreviewTokenService(config.apiKey, config.companyId),
    journal: new MutationJournal(config.stateDir),
  };
}
