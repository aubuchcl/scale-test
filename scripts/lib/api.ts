type Result<T> = { data?: T; error?: unknown; response: Response };

export class ApiError extends Error {
  constructor(
    readonly what: string,
    readonly status: number,
    readonly detail: string,
  ) {
    super(`${what} failed (HTTP ${status}): ${detail}`);
  }
}

/** Pull Cycle's error title/detail out of an error body. */
export function describeError(error: unknown): string {
  if (error && typeof error === "object" && "error" in error) {
    const inner = (error as { error?: { title?: string; detail?: string; code?: string } }).error;
    if (inner) {
      return [inner.code, inner.title, inner.detail].filter(Boolean).join(" - ");
    }
  }
  return JSON.stringify(error);
}

/** Await an API call and return its data, or throw an ApiError naming what failed. */
export async function must<T>(what: string, call: Promise<Result<T>>): Promise<T> {
  const { data, error, response } = await call;
  if (error !== undefined || data === undefined) {
    throw new ApiError(what, response.status, describeError(error));
  }
  return data;
}
