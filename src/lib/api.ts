// Thin fetch wrapper for the MailFlow Express API.
// By default requests go to the same origin under /mailflow (proxied to the backend by Vite in dev
// and by a Vercel rewrite in production), so the httpOnly auth cookie stays first-party.
// Set VITE_API_URL to call the API on another origin directly.
// Keep this in sync with backend/src/config/apiPath.js.
const API_PREFIX = "/mailflow";
const API_BASE = ((import.meta.env.VITE_API_URL as string | undefined) ?? "").replace(/\/$/, "");

export class ApiError extends Error {
  status: number;
  details?: { field: string; message: string }[];
  constructor(status: number, message: string, details?: { field: string; message: string }[]) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

type Query = Record<string, string | number | boolean | undefined>;

// Called when an authenticated request comes back 401 (expired or revoked session).
let onUnauthorized: (() => void) | undefined;
export const setUnauthorizedHandler = (fn: () => void) => {
  onUnauthorized = fn;
};

async function request<T>(method: string, path: string, body?: unknown, query?: Query): Promise<T> {
  let url = `${API_BASE}${API_PREFIX}${path}`;
  if (query) {
    const qs = new URLSearchParams();
    Object.entries(query).forEach(([k, v]) => v !== undefined && v !== "" && qs.set(k, String(v)));
    if (qs.size) url += `?${qs}`;
  }

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      credentials: "include",
      headers: {
        Accept: "application/json",
        "X-Requested-With": "mailflow",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError(0, "Can't reach the MailFlow server. Is the backend running?");
  }

  const data = await res.json().catch(() => null);
  if (res.status === 401 && !path.startsWith("/auth/")) onUnauthorized?.();
  if (!res.ok || data?.success === false) {
    const fallback = res.status === 502 || res.status === 504 ? "MailFlow server is unavailable" : `Request failed (${res.status})`;
    throw new ApiError(res.status, data?.message ?? fallback, data?.details);
  }
  return data as T;
}

/** Multipart upload with progress (fetch can't report upload progress, XHR can). */
function upload<T>(path: string, form: FormData, onProgress?: (fraction: number) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${API_BASE}${API_PREFIX}${path}`);
    xhr.withCredentials = true;
    xhr.setRequestHeader("X-Requested-With", "mailflow");
    xhr.setRequestHeader("Accept", "application/json");
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onerror = () => reject(new ApiError(0, "Can't reach the MailFlow server. Is the backend running?"));
    xhr.onload = () => {
      let data: { success?: boolean; message?: string; details?: ApiError["details"] } | null = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        /* non-JSON error page */
      }
      if (xhr.status === 401) onUnauthorized?.();
      if (xhr.status >= 400 || data?.success === false) {
        const fallback = xhr.status === 413 ? "Files are too large" : `Upload failed (${xhr.status})`;
        reject(new ApiError(xhr.status, data?.message ?? fallback, data?.details));
      } else resolve(data as T);
    };
    xhr.send(form);
  });
}

/** Authenticated binary download (resume preview / download). Files never get a public URL. */
async function blob(path: string): Promise<Blob> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${API_PREFIX}${path}`, { credentials: "include", headers: { "X-Requested-With": "mailflow" } });
  } catch {
    throw new ApiError(0, "Can't reach the MailFlow server. Is the backend running?");
  }
  if (res.status === 401) onUnauthorized?.();
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new ApiError(res.status, data?.message ?? `Download failed (${res.status})`);
  }
  return res.blob();
}

export const api = {
  get: <T>(path: string, query?: Query) => request<T>("GET", path, undefined, query),
  post: <T>(path: string, body?: unknown) => request<T>("POST", path, body ?? {}),
  put: <T>(path: string, body?: unknown) => request<T>("PUT", path, body ?? {}),
  patch: <T>(path: string, body?: unknown) => request<T>("PATCH", path, body ?? {}),
  del: <T>(path: string) => request<T>("DELETE", path),
  upload,
  blob,
};

/** Full URL of an API path, for browser APIs that need one (EventSource). */
export const apiUrl = (path: string) => `${API_BASE}${API_PREFIX}${path}`;

/** Save a Blob as a file via a temporary object URL. */
export function saveBlob(data: Blob, fileName: string) {
  const url = URL.createObjectURL(data);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const errorMessage = (err: unknown) => (err instanceof Error ? err.message : "Something went wrong");
