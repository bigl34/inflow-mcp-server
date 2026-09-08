import { randomUUID } from 'node:crypto';
import type { InflowConfig } from '../config.js';
import type { PaginationParams, ApiError } from '../types/inflow.js';

export interface RateLimiterSnapshot {
  capacity: number;
  availableTokens: number;
  queued: number;
  refillPerSecond: number;
}

export class RateLimiter {
  private tokens: number;
  private lastRefill = Date.now();
  private readonly refillRate: number;
  private tail: Promise<void> = Promise.resolve();
  private queued = 0;

  constructor(private readonly maxTokens: number) {
    this.tokens = maxTokens;
    this.refillRate = maxTokens / 60_000;
  }

  async acquire(signal?: AbortSignal): Promise<void> {
    this.queued += 1;
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      while (true) {
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        this.refill();
        if (this.tokens >= 1) {
          this.tokens -= 1;
          return;
        }
        const waitMs = Math.max(1, Math.ceil((1 - this.tokens) / this.refillRate));
        await this.sleep(waitMs, signal);
      }
    } finally {
      this.queued -= 1;
      release();
    }
  }

  snapshot(): RateLimiterSnapshot {
    this.refill();
    return {
      capacity: this.maxTokens,
      availableTokens: Math.max(0, this.tokens),
      queued: this.queued,
      refillPerSecond: this.refillRate * 1_000,
    };
  }

  private refill(): void {
    const now = Date.now();
    this.tokens = Math.min(this.maxTokens, this.tokens + (now - this.lastRefill) * this.refillRate);
    this.lastRefill = now;
  }

  private sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      }, { once: true });
    });
  }
}

export type RequestIntent = 'read' | 'mutation';

export class InflowApiError extends Error {
  constructor(
    message: string,
    public statusCode: number,
    public apiError?: ApiError,
    public retryAfterMs?: number
  ) {
    const transientStatus = statusCode === 408 || statusCode === 429 || statusCode >= 500;
    const statusMarker = transientStatus ? ` [httpStatus=${statusCode}]` : '';
    const retryMarker = statusCode === 429 && retryAfterMs !== undefined
      ? ` [retryAfterMs=${retryAfterMs}]`
      : '';
    super(`${message}${statusMarker}${retryMarker}`);
    this.name = 'InflowApiError';
  }
}

function parseRetryAfterMs(value: string | null | undefined, nowMs = Date.now()): number | undefined {
  if (!value?.trim()) return undefined;
  const normalized = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(normalized)) {
    const seconds = Number(normalized);
    return Number.isFinite(seconds) ? Math.max(0, seconds * 1_000) : undefined;
  }
  const timestamp = Date.parse(normalized);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - nowMs) : undefined;
}

interface RequestOptions {
  params?: Record<string, string | number | boolean | undefined>;
  filters?: Record<string, unknown>;
  pagination?: PaginationParams;
  include?: string[];
  body?: unknown;
  headers?: Record<string, string>;
  sort?: string;
  sortDesc?: boolean;
  includeCount?: boolean;
}

interface ResponseEnvelope<T> {
  data: T;
  headers: Headers;
  status: number;
}

export interface ClientTelemetry {
  timeoutMs: number;
  readRetryPolicy: { maxRetries: number; baseDelayMs: number };
  mutationRetryPolicy: { maxRetries: 0 };
  rateLimiter: RateLimiterSnapshot & { scope: 'process-local' };
}

export interface PreparedMutation<T> {
  correlationId: string;
  dispatch(): Promise<T>;
}

export class InflowClient {
  private readonly rateLimiter: RateLimiter;

  constructor(private readonly config: InflowConfig) {
    this.rateLimiter = new RateLimiter(config.rateLimitPerMinute);
  }

  telemetrySnapshot(): ClientTelemetry {
    return {
      timeoutMs: this.config.requestTimeoutMs,
      readRetryPolicy: {
        maxRetries: this.config.maxRetries,
        baseDelayMs: this.config.retryDelayMs,
      },
      mutationRetryPolicy: { maxRetries: 0 },
      rateLimiter: { ...this.rateLimiter.snapshot(), scope: 'process-local' },
    };
  }

  private buildUrl(path: string, params?: Record<string, string | number | boolean | undefined>): string {
    const url = new URL(`${this.config.baseUrl}/${this.config.companyId}${path}`);
    for (const [key, value] of Object.entries(params ?? {})) {
      if (value !== undefined && value !== null && value !== '') url.searchParams.append(key, String(value));
    }
    return url.toString();
  }

  private buildFilterParams(filters?: Record<string, unknown>): Record<string, string> {
    const params: Record<string, string> = {};
    for (const [key, value] of Object.entries(filters ?? {})) {
      if (value === undefined || value === null || value === '') continue;
      params[`filter[${key}]`] = typeof value === 'object' ? JSON.stringify(value) : String(value);
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

  private log(message: string, data?: Record<string, unknown>): void {
    if (this.config.debug) console.error(`[inFlow ${new Date().toISOString()}] ${message}`, data ?? '');
  }

  private isRetryableRead(error: unknown): boolean {
    return error instanceof TypeError ||
      (error instanceof InflowApiError && [408, 429].includes(error.statusCode)) ||
      (error instanceof InflowApiError && error.statusCode >= 500);
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private params(options?: RequestOptions): Record<string, string | number | boolean | undefined> {
    const result: Record<string, string | number | boolean | undefined> = {
      ...options?.params,
      ...this.buildFilterParams(options?.filters),
    };
    const pagination = options?.pagination;
    if (pagination) {
      if (pagination.skip !== undefined) result.skip = pagination.skip;
      if (pagination.count !== undefined) result.count = pagination.count;
      if (pagination.after) result.after = pagination.after;
      if (pagination.before) result.before = pagination.before;
      if (pagination.start !== undefined) result.start = pagination.start;
    }
    if (options?.include?.length) result.include = options.include.join(',');
    if (options?.sort) result.sort = options.sort;
    if (options?.sortDesc !== undefined) result.sortDesc = options.sortDesc;
    if (options?.includeCount) result.includeCount = true;
    return result;
  }

  private async executeOnce<T>(
    method: 'GET' | 'PUT' | 'POST' | 'DELETE',
    path: string,
    options: RequestOptions | undefined,
    correlationId: string
  ): Promise<ResponseEnvelope<T>> {
    await this.rateLimiter.acquire();
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
    const url = this.buildUrl(path, this.params(options));
    this.log(`${method} ${path}`, { correlationId });
    try {
      const response = await fetch(url, {
        method,
        headers: { ...this.getHeaders(), ...options?.headers },
        body: options?.body !== undefined && (method === 'PUT' || method === 'POST')
          ? JSON.stringify(options.body)
          : undefined,
        signal: controller.signal,
      });
      this.log(`Response ${response.status}`, { correlationId, path });
      if (!response.ok) {
        let apiError: ApiError | undefined;
        try { apiError = (await response.json()) as ApiError; } catch { /* non-JSON error */ }
        const retryAfterMs = parseRetryAfterMs(response.headers?.get?.('Retry-After'));
        throw new InflowApiError(
          apiError?.message || `HTTP ${response.status}: ${response.statusText}`,
          response.status,
          apiError,
          retryAfterMs
        );
      }
      if (response.status === 204) return { data: {} as T, headers: response.headers, status: response.status };
      const data = await response.json() as T;
      return { data, headers: response.headers, status: response.status };
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new InflowApiError(`Request timed out after ${this.config.requestTimeoutMs}ms`, 408);
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private async execute<T>(
    intent: RequestIntent,
    method: 'GET' | 'PUT' | 'POST' | 'DELETE',
    path: string,
    options?: RequestOptions
  ): Promise<ResponseEnvelope<T>> {
    const correlationId = randomUUID();
    const maxRetries = intent === 'read' ? this.config.maxRetries : 0;
    const started = Date.now();
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        return await this.executeOnce<T>(method, path, options, correlationId);
      } catch (error) {
        if (attempt === maxRetries || !this.isRetryableRead(error)) throw error;
        const backoff = this.config.retryDelayMs * 2 ** attempt;
        const retryAfter = error instanceof InflowApiError ? error.retryAfterMs ?? 0 : 0;
        const waitMs = Math.max(backoff, retryAfter);
        if (Date.now() - started + waitMs > this.config.readRetryBudgetMs) throw error;
        this.log(`Retrying read ${method} ${path}`, { correlationId, attempt: attempt + 2, waitMs });
        await this.delay(waitMs);
      }
    }
    throw new Error('Unexpected retry loop exit');
  }

  async request<T>(method: 'GET' | 'PUT' | 'POST' | 'DELETE', path: string, options?: RequestOptions): Promise<T> {
    return (await this.execute<T>(method === 'GET' ? 'read' : 'mutation', method, path, options)).data;
  }

  async get<T>(path: string, options?: RequestOptions): Promise<T> {
    return (await this.execute<T>('read', 'GET', path, options)).data;
  }

  async postRead<T>(path: string, body: unknown, options?: Omit<RequestOptions, 'body'>): Promise<T> {
    return (await this.execute<T>('read', 'POST', path, { ...options, body })).data;
  }

  async getList<T>(path: string, options?: RequestOptions): Promise<{ data: T[]; totalCount?: number }> {
    const response = await this.execute<T[]>('read', 'GET', path, options);
    const count = response.headers?.get?.('X-listCount');
    return {
      data: response.data,
      totalCount: options?.includeCount && count !== null && count !== undefined
        ? Number.parseInt(count, 10)
        : undefined,
    };
  }

  async prepareMutation<T>(
    method: 'PUT' | 'POST' | 'DELETE',
    path: string,
    options?: RequestOptions
  ): Promise<PreparedMutation<T>> {
    // Everything that can fail before `fetch()` belongs on the preparation
    // side of the journal boundary. Once the returned closure is called, any
    // failure is conservatively classified as possibly applied.
    const body = options?.body === undefined ? undefined : JSON.stringify(options.body);
    const url = this.buildUrl(path, this.params(options));
    const headers = { ...this.getHeaders(), ...options?.headers };
    await this.rateLimiter.acquire();
    const correlationId = randomUUID();
    let dispatched = false;
    return {
      correlationId,
      dispatch: async () => {
        if (dispatched) throw new Error('MUTATION_ALREADY_DISPATCHED');
        dispatched = true;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
        this.log(`${method} ${path}`, { correlationId });
        try {
          const response = await fetch(url, {
            method,
            headers,
            body: method === 'DELETE' ? undefined : body,
            signal: controller.signal,
          });
          this.log(`Response ${response.status}`, { correlationId, path });
          if (!response.ok) {
            let apiError: ApiError | undefined;
            try { apiError = (await response.json()) as ApiError; } catch { /* non-JSON error */ }
            const retryAfterMs = parseRetryAfterMs(response.headers?.get?.('Retry-After'));
            throw new InflowApiError(
              apiError?.message || `HTTP ${response.status}: ${response.statusText}`,
              response.status,
              apiError,
              retryAfterMs
            );
          }
          if (response.status === 204) return {} as T;
          return await response.json() as T;
        } catch (error) {
          if (error instanceof Error && error.name === 'AbortError') {
            throw new InflowApiError(`Request timed out after ${this.config.requestTimeoutMs}ms`, 408);
          }
          throw error;
        } finally {
          clearTimeout(timeoutId);
        }
      },
    };
  }

  async put<T>(path: string, body: unknown, options?: Omit<RequestOptions, 'body'>): Promise<T> {
    return (await this.execute<T>('mutation', 'PUT', path, { ...options, body })).data;
  }

  async post<T>(path: string, body: unknown, options?: Omit<RequestOptions, 'body'>): Promise<T> {
    return (await this.execute<T>('mutation', 'POST', path, { ...options, body })).data;
  }

  async delete<T>(path: string, options?: RequestOptions): Promise<T> {
    return (await this.execute<T>('mutation', 'DELETE', path, options)).data;
  }
}
