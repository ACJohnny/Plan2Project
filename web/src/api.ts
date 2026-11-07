import { uuid } from './uuid';
/** Small typed fetch wrapper. Every request carries X-Client-Id so SSE echoes can be ignored (R-51). */

export const CLIENT_ID = (() => {
  try {
    const k = 'spm-client-id';
    let v = sessionStorage.getItem(k);
    if (!v) sessionStorage.setItem(k, (v = uuid()));
    return v;
  } catch {
    return uuid();
  }
})();

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public body?: any,
  ) {
    super(message);
  }
  get network() {
    return this.status === 0;
  }
}

async function request<T>(method: string, url: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: {
        'X-Client-Id': CLIENT_ID,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal,
    });
  } catch (e: any) {
    if (e?.name === 'AbortError') throw e;
    throw new ApiError(0, 'Network unavailable');
  }
  const text = await res.text();
  let json: any = undefined;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  if (!res.ok) {
    if (res.status === 401 && !url.startsWith('/api/auth/'))
      window.dispatchEvent(new CustomEvent('spm:unauthorized'));
    throw new ApiError(res.status, json?.error ?? `${res.status} ${res.statusText}`, json);
  }
  return json as T;
}

export const api = {
  get: <T>(u: string, signal?: AbortSignal) => request<T>('GET', u, undefined, signal),
  post: <T>(u: string, b: unknown = {}) => request<T>('POST', u, b),
  put: <T>(u: string, b: unknown) => request<T>('PUT', u, b),
  patch: <T>(u: string, b: unknown) => request<T>('PATCH', u, b),
  del: <T>(u: string) => request<T>('DELETE', u),
};

/** Multipart upload with progress (R-17). */
export function uploadFile<T>(
  url: string,
  file: File,
  onProgress: (fraction: number) => void,
): { promise: Promise<T>; abort: () => void } {
  const xhr = new XMLHttpRequest();
  const promise = new Promise<T>((resolve, reject) => {
    xhr.open('POST', url);
    xhr.withCredentials = true;
    xhr.setRequestHeader('X-Client-Id', CLIENT_ID);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      let json: any;
      try {
        json = JSON.parse(xhr.responseText);
      } catch {
        json = undefined;
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(json);
      else reject(new ApiError(xhr.status, json?.error ?? `Upload failed (${xhr.status})`, json));
    };
    xhr.onerror = () => reject(new ApiError(0, 'Network unavailable'));
    xhr.onabort = () => reject(new ApiError(0, 'Upload cancelled'));
    const fd = new FormData();
    fd.append('file', file);
    xhr.send(fd);
  });
  return { promise, abort: () => xhr.abort() };
}

export function download(url: string) {
  const a = document.createElement('a');
  a.href = url;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}
