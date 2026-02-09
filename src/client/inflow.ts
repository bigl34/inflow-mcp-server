// inFlow API HTTP Client with rate limiting

import type { InflowConfig } from '../config.js';
import type { PaginationParams, ApiError } from '../types/inflow.js';

export class RateLimiter {
  private tokens: number;
  private lastRefill: number;
  private readonly maxTokens: number;
  private readonly refillRate: number; // tokens per ms

  constructor(requestsPerMinute: number) {
    this.maxTokens = requestsPerMinute;
    this.tokens = requestsPerMinute;
    this.lastRefill = Date.now();
    this.refillRate = requestsPerMinute / 60000; // per millisecond
  }

  async acquire(): Promise<void> {
    this.refill();

    if (this.tokens < 1) {
      const waitTime = Math.ceil((1 - this.tokens) / this.refillRate);
      await this.sleep(waitTime);
      this.refill();
    }

    this.tokens -= 1;
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    this.tokens = Math.min(this.maxTokens, this.tokens + elapsed * this.refillRate);
    this.lastRefill = now;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export class InflowApiError extends Error {
  constructor(
    message: string,
    public statusCode: number,
    public apiError?: ApiError
  ) {
    super(message);
    this.name = 'InflowApiError';
  }
}

export class InflowClient {
  private readonly config: InflowConfig;
  private readonly rateLimiter: RateLimiter;

  constructor(config: InflowConfig) {
    this.config = config;
    this.rateLimiter = new RateLimiter(config.rateLimitPerMinute);
  }

  private buildUrl(
    path: string,
    params?: Record<string, string | number | boolean | undefined>
  ): string {
    const url = new URL(`${this.config.baseUrl}/${this.config.companyId}${path}`);

    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null && value !== '') {
          url.searchParams.append(key, String(value));
        }
      }
    }

    return url.toString();
  }

  private buildFilterParams(
    filters?: Record<string, unknown>
  ): Record<string, string> {
    const params: Record<string, string> = {};

    if (filters) {
      for (const [key, value] of Object.entries(filters)) {
        if (value === undefined || value === null || value === '') {
          continue;
        }

        if (typeof value === 'object') {
          // Arrays and objects get JSON stringified
          params[`filter[${key}]`] = JSON.stringify(value);
        } else {
          params[`filter[${key}]`] = String(value);
        }
      }
    }

    return params;
  }

  private getHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.config.apiKey}`,
      'Content-Type': 'application/json',
      Accept: `application/json;version=${this.config.apiVersion}`,
    };
  }

  private log(message: string, data?: unknown): void {
    if (this.config.debug) {
      const timestamp = new Date().toISOString();
      const dataStr = data !== undefined ? ` ${JSON.stringify(data)}` : '';
      console.error(`[inFlow ${timestamp}] ${message}${dataStr}`);
    }
  }

  private isRetryableError(error: unknown): boolean {
    if (error instanceof InflowApiError) {
      // Retry on 5xx errors and 429 (rate limit)
      return error.statusCode >= 500 || error.statusCode === 429;
    }
    // Retry on network errors (fetch throws TypeError for network issues)
    if (error instanceof TypeError) {
      return true;
    }
    return false;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async request<T>(
    method: 'GET' | 'PUT' | 'POST' | 'DELETE',
    path: string,
    options?: {
      params?: Record<string, string | number | boolean | undefined>;
      filters?: Record<string, unknown>;
      pagination?: PaginationParams;
      include?: string[];
      body?: unknown;
      headers?: Record<string, string>;
      sort?: string;
      sortDesc?: boolean;
    }
  ): Promise<T> {
    const maxRetries = this.config.maxRetries;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await this.executeRequest<T>(method, path, options);
      } catch (error) {
        const isLastAttempt = attempt === maxRetries;

        if (isLastAttempt || !this.isRetryableError(error)) {
          throw error;
        }

        // Exponential backoff: 1s, 2s, 4s, ...
        const delayMs = this.config.retryDelayMs * Math.pow(2, attempt);
        this.log(`Retrying ${method} ${path} (attempt ${attempt + 2}/${maxRetries + 1})`, {
          error: error instanceof Error ? error.message : String(error),
          delayMs,
        });
        await this.delay(delayMs);
      }
    }

    // This should never be reached, but TypeScript needs it
    throw new Error('Unexpected retry loop exit');
  }

  private async executeRequest<T>(
    method: 'GET' | 'PUT' | 'POST' | 'DELETE',
    path: string,
    options?: {
      params?: Record<string, string | number | boolean | undefined>;
      filters?: Record<string, unknown>;
      pagination?: PaginationParams;
      include?: string[];
      body?: unknown;
      headers?: Record<string, string>;
      sort?: string;
      sortDesc?: boolean;
    }
  ): Promise<T> {
    await this.rateLimiter.acquire();

    const allParams: Record<string, string | number | boolean | undefined> = {
      ...options?.params,
      ...this.buildFilterParams(options?.filters),
    };

    // Add pagination params
    if (options?.pagination) {
      if (options.pagination.skip !== undefined) {
        allParams.skip = options.pagination.skip;
      }
      if (options.pagination.count !== undefined) {
        allParams.count = options.pagination.count;
      }
      if (options.pagination.after) {
        allParams.after = options.pagination.after;
      }
      if (options.pagination.before) {
        allParams.before = options.pagination.before;
      }
      if (options.pagination.start !== undefined) {
        allParams.start = options.pagination.start;
      }
    }

    // Add include param
    if (options?.include && options.include.length > 0) {
      allParams.include = options.include.join(',');
    }

    // Add sorting params
    if (options?.sort) {
      allParams.sort = options.sort;
    }
    if (options?.sortDesc !== undefined) {
      allParams.sortDesc = options.sortDesc;
    }

    const url = this.buildUrl(path, allParams);
    this.log(`${method} ${path}`, { params: allParams });

    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      this.config.requestTimeoutMs
    );

    const fetchOptions: RequestInit = {
      method,
      headers: {
        ...this.getHeaders(),
        ...options?.headers,
      },
      signal: controller.signal,
    };

    if (options?.body && (method === 'PUT' || method === 'POST')) {
      fetchOptions.body = JSON.stringify(options.body);
    }

    let response: Response;
    try {
      response = await fetch(url, fetchOptions);
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof Error && error.name === 'AbortError') {
        throw new InflowApiError(
          `Request timed out after ${this.config.requestTimeoutMs}ms`,
          408
        );
      }
      throw error;
    }

    clearTimeout(timeoutId);
    this.log(`Response ${response.status}`, { path });

    if (!response.ok) {
      let apiError: ApiError | undefined;
      try {
        apiError = (await response.json()) as ApiError;
      } catch {
        // Response body is not JSON
      }

      throw new InflowApiError(
        apiError?.message || `HTTP ${response.status}: ${response.statusText}`,
        response.status,
        apiError
      );
    }

    // Handle 204 No Content
    if (response.status === 204) {
      return {} as T;
    }

    return (await response.json()) as T;
  }

  // Convenience methods
  async get<T>(
    path: string,
    options?: {
      params?: Record<string, string | number | boolean | undefined>;
      filters?: Record<string, unknown>;
      pagination?: PaginationParams;
      include?: string[];
      sort?: string;
      sortDesc?: boolean;
    }
  ): Promise<T> {
    return this.request<T>('GET', path, options);
  }

  async getList<T>(
    path: string,
    options?: {
      params?: Record<string, string | number | boolean | undefined>;
      filters?: Record<string, unknown>;
      pagination?: PaginationParams;
      include?: string[];
      sort?: string;
      sortDesc?: boolean;
      includeCount?: boolean;
    }
  ): Promise<{ data: T[]; totalCount?: number }> {
    await this.rateLimiter.acquire();

    const allParams: Record<string, string | number | boolean | undefined> = {
      ...options?.params,
      ...this.buildFilterParams(options?.filters),
    };

    // Add pagination params
    if (options?.pagination) {
      if (options.pagination.skip !== undefined) {
        allParams.skip = options.pagination.skip;
      }
      if (options.pagination.count !== undefined) {
        allParams.count = options.pagination.count;
      }
    }

    // Add include param
    if (options?.include && options.include.length > 0) {
      allParams.include = options.include.join(',');
    }

    // Add sorting params
    if (options?.sort) {
      allParams.sort = options.sort;
    }
    if (options?.sortDesc !== undefined) {
      allParams.sortDesc = options.sortDesc;
    }

    // Add includeCount param
    if (options?.includeCount) {
      allParams.includeCount = true;
    }

    const url = this.buildUrl(path, allParams);
    this.log(`GET ${path} (list)`, { params: allParams });

    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      this.config.requestTimeoutMs
    );

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'GET',
        headers: this.getHeaders(),
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof Error && error.name === 'AbortError') {
        throw new InflowApiError(
          `Request timed out after ${this.config.requestTimeoutMs}ms`,
          408
        );
      }
      throw error;
    }

    clearTimeout(timeoutId);
    this.log(`Response ${response.status}`, { path });

    if (!response.ok) {
      let apiError: ApiError | undefined;
      try {
        apiError = (await response.json()) as ApiError;
      } catch {
        // Response body is not JSON
      }

      throw new InflowApiError(
        apiError?.message || `HTTP ${response.status}: ${response.statusText}`,
        response.status,
        apiError
      );
    }

    const data = (await response.json()) as T[];
    const totalCount = options?.includeCount
      ? parseInt(response.headers.get('X-listCount') ?? '0', 10)
      : undefined;

    return { data, totalCount };
  }

  async put<T>(
    path: string,
    body: unknown,
    options?: {
      params?: Record<string, string | number | boolean | undefined>;
      headers?: Record<string, string>;
    }
  ): Promise<T> {
    return this.request<T>('PUT', path, { ...options, body });
  }

  async post<T>(
    path: string,
    body: unknown,
    options?: {
      params?: Record<string, string | number | boolean | undefined>;
      headers?: Record<string, string>;
    }
  ): Promise<T> {
    return this.request<T>('POST', path, { ...options, body });
  }

  async delete<T>(
    path: string,
    options?: {
      params?: Record<string, string | number | boolean | undefined>;
    }
  ): Promise<T> {
    return this.request<T>('DELETE', path, options);
  }
}
