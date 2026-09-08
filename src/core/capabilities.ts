export type CapabilityId =
  | 'manufacturing.read'
  | 'manufacturing.write'
  | 'operation-types.read'
  | 'product-groups.read'
  | 'group-audit.read'
  | 'bom-requirements.read'
  | 'prices.read'
  | 'prices.write'
  | 'mo-trace.read'
  | 'mo-serials.write'
  | 'product-groups.write'
  | 'standard-writes.safe';

export interface CapabilityStatus {
  id: CapabilityId;
  available: boolean;
  minimumApiVersion?: string;
  writeDomain?: string;
  reasonCode?: 'UNSUPPORTED_API_VERSION';
}
const SPECS: Record<CapabilityId, { minimumApiVersion?: string; writeDomain?: string }> = {
  'manufacturing.read': { minimumApiVersion: '2026-04-13' },
  'manufacturing.write': { minimumApiVersion: '2026-04-13', writeDomain: 'manufacturing' },
  'operation-types.read': { minimumApiVersion: '2026-04-13' },
  'product-groups.read': { minimumApiVersion: '2026-04-13' },
  'group-audit.read': { minimumApiVersion: '2026-04-13' },
  'bom-requirements.read': { minimumApiVersion: '2026-04-13' },
  'prices.read': { minimumApiVersion: '2026-04-13' },
  'prices.write': { minimumApiVersion: '2026-04-13', writeDomain: 'prices' },
  'mo-trace.read': { minimumApiVersion: '2026-04-13' },
  'mo-serials.write': { minimumApiVersion: '2026-04-13', writeDomain: 'mo-serials' },
  'product-groups.write': { minimumApiVersion: '2026-04-13', writeDomain: 'product-groups' },
  'standard-writes.safe': { minimumApiVersion: '2026-04-13', writeDomain: 'standard' },
};

export function parseApiVersion(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`INVALID_API_VERSION: ${value}`);
  const parsed = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== value) {
    throw new Error(`INVALID_API_VERSION: ${value}`);
  }
  return parsed;
}

export function resolveCapabilities(apiVersion: string): CapabilityStatus[] {
  const current = parseApiVersion(apiVersion);
  return (Object.entries(SPECS) as Array<[CapabilityId, typeof SPECS[CapabilityId]]>)
    .map(([id, spec]) => {
      const available = spec.minimumApiVersion === undefined || current >= parseApiVersion(spec.minimumApiVersion);
      return {
        id,
        available,
        ...spec,
        ...(available ? {} : { reasonCode: 'UNSUPPORTED_API_VERSION' as const }),
      };
    });
}

export function assertCapability(id: CapabilityId, apiVersion: string): void {
  const status = resolveCapabilities(apiVersion).find((row) => row.id === id)!;
  if (!status.available) {
    throw new Error(`UNSUPPORTED_API_VERSION: ${id} requires ${status.minimumApiVersion}; configured ${apiVersion}`);
  }
}
