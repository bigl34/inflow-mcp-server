import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RateLimiter, InflowClient, InflowApiError } from './inflow.js';
import type { InflowConfig } from '../config.js';

describe('RateLimiter', () => {
  it('should allow immediate request when tokens available', async () => {
    const limiter = new RateLimiter(60);
    const start = Date.now();
    await limiter.acquire();
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(50);
  });

  it('should refill tokens over time', async () => {
    const limiter = new RateLimiter(60); // 1 per second

    // Use up a token
    await limiter.acquire();

    // Wait 100ms for partial refill
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Should still have capacity
    const start = Date.now();
    await limiter.acquire();
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(50);
  });
});

describe('InflowApiError', () => {
  it('should store status code and api error', () => {
    const apiError = { message: 'Not found', code: 'RESOURCE_NOT_FOUND' };
    const error = new InflowApiError('Resource not found', 404, apiError);

    expect(error.message).toBe('Resource not found');
    expect(error.statusCode).toBe(404);
    expect(error.apiError).toEqual(apiError);
    expect(error.name).toBe('InflowApiError');
  });

  it('should work without api error details', () => {
    const error = new InflowApiError('Server error', 500);

    expect(error.message).toBe('Server error');
    expect(error.statusCode).toBe(500);
    expect(error.apiError).toBeUndefined();
  });
});

describe('InflowClient', () => {
  const mockConfig: InflowConfig = {
    apiKey: 'test-api-key',
    companyId: 'test-company',
    baseUrl: 'https://api.inflowinventory.com/v1',
    apiVersion: '2023-01-01',
    rateLimitPerMinute: 60,
    maxRetries: 2,
    retryDelayMs: 100,
    requestTimeoutMs: 5000,
    debug: false,
  };

  let client: InflowClient;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    client = new InflowClient(mockConfig);
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetAllMocks();
  });

  describe('get', () => {
    it('should make GET request with correct URL and headers', async () => {
      const mockData = { id: '123', name: 'Test Product' };
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve(mockData),
      });

      const result = await client.get('/products/123');

      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, options] = fetchMock.mock.calls[0];
      expect(url).toBe('https://api.inflowinventory.com/v1/test-company/products/123');
      expect(options.method).toBe('GET');
      expect(options.headers).toMatchObject({
        Authorization: 'Bearer test-api-key',
        'Content-Type': 'application/json',
        Accept: 'application/json;version=2023-01-01',
      });
      expect(result).toEqual(mockData);
    });

    it('should include filters as query parameters', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve([]),
      });

      await client.get('/products', {
        filters: { name: 'Widget', isActive: true },
      });

      const [url] = fetchMock.mock.calls[0];
      expect(url).toContain('filter%5Bname%5D=Widget');
      expect(url).toContain('filter%5BisActive%5D=true');
    });

    it('should include pagination parameters', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve([]),
      });

      await client.get('/products', {
        pagination: { skip: 10, count: 25 },
      });

      const [url] = fetchMock.mock.calls[0];
      expect(url).toContain('skip=10');
      expect(url).toContain('count=25');
    });

    it('should include sort parameters', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve([]),
      });

      await client.get('/products', {
        sort: 'name',
        sortDesc: true,
      });

      const [url] = fetchMock.mock.calls[0];
      expect(url).toContain('sort=name');
      expect(url).toContain('sortDesc=true');
    });

    it('should include related data', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve([]),
      });

      await client.get('/products', {
        include: ['category', 'vendor'],
      });

      const [url] = fetchMock.mock.calls[0];
      expect(url).toContain('include=category%2Cvendor');
    });
  });

  describe('getList', () => {
    it('should return data array', async () => {
      const mockData = [{ id: '1' }, { id: '2' }];
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve(mockData),
        headers: new Map(),
      });

      const result = await client.getList('/products');

      expect(result.data).toEqual(mockData);
      expect(result.totalCount).toBeUndefined();
    });

    it('should parse X-listCount header when includeCount is true', async () => {
      const mockData = [{ id: '1' }, { id: '2' }];
      const headers = new Headers();
      headers.set('X-listCount', '42');

      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve(mockData),
        headers,
      });

      const result = await client.getList('/products', { includeCount: true });

      expect(result.data).toEqual(mockData);
      expect(result.totalCount).toBe(42);

      const [url] = fetchMock.mock.calls[0];
      expect(url).toContain('includeCount=true');
    });

    it('should include pagination, sort, and filter params', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve([]),
        headers: new Map(),
      });

      await client.getList('/products', {
        filters: { isActive: true },
        pagination: { skip: 5, count: 10 },
        sort: 'modifiedDate',
        sortDesc: true,
        include: ['category'],
      });

      const [url] = fetchMock.mock.calls[0];
      expect(url).toContain('filter%5BisActive%5D=true');
      expect(url).toContain('skip=5');
      expect(url).toContain('count=10');
      expect(url).toContain('sort=modifiedDate');
      expect(url).toContain('sortDesc=true');
      expect(url).toContain('include=category');
    });
  });

  describe('put', () => {
    it('should make PUT request with body', async () => {
      const requestBody = { name: 'Updated Product' };
      const mockResponse = { id: '123', name: 'Updated Product' };
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve(mockResponse),
      });

      const result = await client.put('/products', requestBody);

      expect(fetchMock).toHaveBeenCalledOnce();
      const [, options] = fetchMock.mock.calls[0];
      expect(options.method).toBe('PUT');
      expect(options.body).toBe(JSON.stringify(requestBody));
      expect(result).toEqual(mockResponse);
    });
  });

  describe('post', () => {
    it('should make POST request with body', async () => {
      const requestBody = { name: 'New Product' };
      const mockResponse = { id: '456', name: 'New Product' };
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 201,
        json: () => Promise.resolve(mockResponse),
      });

      const result = await client.post('/products', requestBody);

      const [, options] = fetchMock.mock.calls[0];
      expect(options.method).toBe('POST');
      expect(options.body).toBe(JSON.stringify(requestBody));
      expect(result).toEqual(mockResponse);
    });
  });

  describe('delete', () => {
    it('should make DELETE request', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 204,
        json: () => Promise.resolve({}),
      });

      await client.delete('/products/123');

      const [url, options] = fetchMock.mock.calls[0];
      expect(url).toContain('/products/123');
      expect(options.method).toBe('DELETE');
    });
  });

  describe('error handling', () => {
    it('should throw InflowApiError on 4xx response', async () => {
      const apiError = { message: 'Product not found', code: 'NOT_FOUND' };
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 404,
        statusText: 'Not Found',
        json: () => Promise.resolve(apiError),
      });

      try {
        await client.get('/products/invalid');
        expect.fail('Expected InflowApiError to be thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(InflowApiError);
        if (error instanceof InflowApiError) {
          expect(error.statusCode).toBe(404);
          expect(error.apiError).toEqual(apiError);
        }
      }
    });

    it('should retry on 5xx errors', async () => {
      fetchMock
        .mockResolvedValueOnce({
          ok: false,
          status: 500,
          statusText: 'Internal Server Error',
          json: () => Promise.resolve({ message: 'Server error' }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ id: '123' }),
        });

      const result = await client.get('/products/123');

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(result).toEqual({ id: '123' });
    });

    it('should retry on 429 rate limit', async () => {
      fetchMock
        .mockResolvedValueOnce({
          ok: false,
          status: 429,
          statusText: 'Too Many Requests',
          json: () => Promise.resolve({ message: 'Rate limited' }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ id: '123' }),
        });

      const result = await client.get('/products/123');

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(result).toEqual({ id: '123' });
    });

    it('should not retry on 4xx errors', async () => {
      fetchMock.mockResolvedValue({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        json: () => Promise.resolve({ message: 'Invalid request' }),
      });

      await expect(client.get('/products')).rejects.toThrow(InflowApiError);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('should exhaust retries on persistent 5xx errors', async () => {
      fetchMock.mockResolvedValue({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
        json: () => Promise.resolve({ message: 'Service down' }),
      });

      await expect(client.get('/products')).rejects.toThrow(InflowApiError);
      // Initial + maxRetries (2) = 3 attempts
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });
  });

  describe('filter serialization', () => {
    it('should serialize array filters as JSON', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve([]),
      });

      await client.get('/sales-orders', {
        filters: { status: ['Open', 'Fulfilled'] },
      });

      const [url] = fetchMock.mock.calls[0];
      expect(url).toContain('filter%5Bstatus%5D=%5B%22Open%22%2C%22Fulfilled%22%5D');
    });

    it('should skip undefined and null filter values', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve([]),
      });

      await client.get('/products', {
        filters: { name: 'Widget', category: undefined, vendor: null },
      });

      const [url] = fetchMock.mock.calls[0];
      expect(url).toContain('filter%5Bname%5D=Widget');
      expect(url).not.toContain('category');
      expect(url).not.toContain('vendor');
    });
  });
});
