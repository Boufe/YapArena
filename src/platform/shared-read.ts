// Share only overlapping reads. No stale TTL cache and no viewer-specific values.
export class SharedReadCapacityError extends Error {}
export function createSharedRead<T>(capacity = 64) {
  const pending = new Map<string, Promise<T>>();
  return (key: string, read: () => Promise<T>): Promise<T> => {
    const existing = pending.get(key);
    if (existing) return existing;
    if (pending.size >= capacity)
      return Promise.reject(
        new SharedReadCapacityError("public read capacity reached"),
      );
    const value = Promise.resolve()
      .then(read)
      .finally(() => pending.delete(key));
    pending.set(key, value);
    return value;
  };
}
