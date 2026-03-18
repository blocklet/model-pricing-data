/**
 * HTTP fetch utility using Node.js built-in http/https modules.
 * Supports redirect following, timeouts, and simple User-Agent.
 */

import http from 'http';
import https from 'https';

export const USER_AGENT = 'Mozilla/5.0 (compatible; ModelPricingData/1.0)';

export interface HttpFetchOptions {
  /** Maximum number of redirects to follow (default: 5) */
  maxRedirects?: number;
  /** Request timeout in milliseconds (default: 30000) */
  timeoutMs?: number;
  /** Additional headers to include */
  headers?: Record<string, string>;
}

/**
 * Fetch a URL and return the response body as a string.
 * Follows 301/302/307/308 redirects up to `maxRedirects` times.
 */
export function httpFetch(
  url: string,
  options: HttpFetchOptions = {},
): Promise<string> {
  const { maxRedirects = 5, timeoutMs = 30_000, headers = {} } = options;

  return new Promise((resolve, reject) => {
    const get = (u: string, remaining: number): void => {
      const mod = u.startsWith('https') ? https : http;
      const req = mod.get(
        u,
        {
          headers: { 'User-Agent': USER_AGENT, ...headers },
          timeout: timeoutMs,
        },
        (res) => {
          const statusCode = res.statusCode ?? 0;

          // Follow redirects
          if (
            [301, 302, 307, 308].includes(statusCode) &&
            res.headers.location &&
            remaining > 0
          ) {
            res.resume(); // drain the response
            const next = new URL(res.headers.location, u).href;
            return get(next, remaining - 1);
          }

          // Error status codes
          if (statusCode >= 400) {
            res.resume();
            return reject(new Error(`HTTP ${statusCode} for ${u}`));
          }

          // Collect body
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
          res.on('error', reject);
        },
      );
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error(`Timeout after ${timeoutMs}ms: ${u}`));
      });
    };

    get(url, maxRedirects);
  });
}

export interface PostJsonOptions {
  /** Request timeout in milliseconds (default: 60000) */
  timeoutMs?: number;
}

/**
 * POST JSON to a URL and return the parsed JSON response.
 * Used internally for LLM API calls.
 */
export function postJson<T = unknown>(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
  options: PostJsonOptions = {},
): Promise<T> {
  const { timeoutMs = 60_000 } = options;

  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const payload = JSON.stringify(body);
    const req = https.request(
      {
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload).toString(),
          'User-Agent': USER_AGENT,
          ...headers,
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf-8');
          const statusCode = res.statusCode ?? 0;
          if (statusCode >= 400) {
            return reject(
              new Error(`HTTP ${statusCode}: ${text.slice(0, 200)}`),
            );
          }
          try {
            resolve(JSON.parse(text) as T);
          } catch {
            reject(new Error(`Invalid JSON response: ${text.slice(0, 200)}`));
          }
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Timeout after ${timeoutMs}ms: ${url}`));
    });
    req.write(payload);
    req.end();
  });
}
