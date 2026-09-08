import { describe, expect, it, vi } from 'vitest';
import type { InflowClient } from '../client/inflow.js';
import { calculateBomRequirements } from './bom-requirements.js';

const products = {
  root: { productId: 'root', name: 'Root', itemBoms: [
    { childProductId: 'a', quantity: { standardQuantity: '2', uomQuantity: '2' } },
    { childProductId: 'b', quantity: { standardQuantity: '3', uomQuantity: '3' } },
  ] },
  a: { productId: 'a', name: 'A', itemBoms: [{ childProductId: 'c', quantity: { standardQuantity: '4', uomQuantity: '4' } }] },
  b: { productId: 'b', name: 'B', itemBoms: [{ childProductId: 'c', quantity: { standardQuantity: '5', uomQuantity: '5' } }] },
  c: { productId: 'c', name: 'C', itemBoms: [] },
};

function client() {
  return {
    get: vi.fn(async (path: string) => structuredClone(products[path.split('/').at(-1)! as keyof typeof products])),
    postRead: vi.fn(async (_path: string, body: Array<{ productId: string }>) => body.map(({ productId }) => ({
      productId,
      quantityOnHand: productId === 'a' ? '1' : productId === 'c' ? '10' : '0',
      quantityAvailable: productId === 'a' ? '1' : productId === 'c' ? '10' : '0',
      quantityOnOrder: '0', quantityAllocated: '0',
      locationSummaries: [{ locationId: 'loc', locationName: 'Warehouse', quantityOnHand: productId === 'a' ? '1' : productId === 'c' ? '10' : '0', quantityAvailable: productId === 'a' ? '1' : productId === 'c' ? '10' : '0' }],
    }))),
  } as unknown as InflowClient;
}

describe('BOM requirements', () => {
  it('aggregates a shared leaf before stock allocation in leaf and net modes', async () => {
    const common = { productId: 'root', buildQuantity: '1', locationId: 'loc', stockBasis: 'available' as const, maxDepth: 10, maxProducts: 20 };
    const leaf = await calculateBomRequirements(client(), { ...common, mode: 'leaf' });
    expect(leaf.requirements).toEqual([expect.objectContaining({ productId: 'c', grossRequired: '23', requestedBuildShortage: '13' })]);
    const net = await calculateBomRequirements(client(), { ...common, mode: 'net' });
    expect(net.requirements.find((row) => row.productId === 'c')).toEqual(expect.objectContaining({ grossRequired: '19', requestedBuildShortage: '9' }));
  });

  it('detects indirect cycles', async () => {
    const cyclic = client() as unknown as { get: ReturnType<typeof vi.fn>; postRead: ReturnType<typeof vi.fn> };
    cyclic.get = vi.fn(async (path: string) => path.endsWith('/root')
      ? { productId: 'root', name: 'Root', itemBoms: [{ childProductId: 'a', quantity: { standardQuantity: '1' } }] }
      : { productId: 'a', name: 'A', itemBoms: [{ childProductId: 'root', quantity: { standardQuantity: '1' } }] });
    await expect(calculateBomRequirements(cyclic as unknown as InflowClient, { productId: 'root', buildQuantity: '1', locationId: 'loc', mode: 'net', stockBasis: 'available', maxDepth: 10, maxProducts: 20 })).rejects.toThrow(/BOM_CYCLE/);
    await expect(calculateBomRequirements(cyclic as unknown as InflowClient, { productId: 'root', buildQuantity: '1', locationId: 'loc', mode: 'direct', stockBasis: 'available', maxDepth: 1, maxProducts: 20 })).resolves.toMatchObject({
      complete: true,
      requirements: [expect.objectContaining({ productId: 'a' })],
    });
  });

  it('scopes direct-mode inventory reads to immediate components', async () => {
    const directClient = client() as unknown as { get: ReturnType<typeof vi.fn>; postRead: ReturnType<typeof vi.fn> };
    const result = await calculateBomRequirements(directClient as unknown as InflowClient, {
      productId: 'root', buildQuantity: '1', locationId: 'loc', mode: 'direct',
      stockBasis: 'available', maxDepth: 10, maxProducts: 20,
    });
    expect(directClient.postRead).toHaveBeenCalledWith('/products/summary', [
      { productId: 'a' },
      { productId: 'b' },
    ]);
    expect(result.requirements.map((row) => row.productId)).toEqual(['a', 'b']);
    expect(result.missingProductIds).not.toContain('c');
  });
});
