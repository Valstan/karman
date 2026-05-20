export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export async function apiRequest<T>(url: string, options?: RequestInit): Promise<T> {
  const headers = new Headers(options?.headers || {});
  headers.set('Accept', 'application/json');
  if (options?.body) {
    headers.set('Content-Type', 'application/json');
  }

  const response = await fetch(url, {
    credentials: 'include',
    ...options,
    headers,
  });

  const text = await response.text();
  let payload: unknown = undefined;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }

  if (!response.ok) {
    const messageFromPayload =
      typeof payload === 'object' && payload && 'message' in payload
        ? String((payload as { message?: unknown }).message || '')
        : typeof payload === 'string'
          ? payload
          : '';
    throw new ApiError(response.status, messageFromPayload || `HTTP ${response.status}`);
  }

  return payload as T;
}
