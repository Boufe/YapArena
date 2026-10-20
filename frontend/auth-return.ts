export function safeAuthReturn(
  value: string | null,
  origin: string,
): string | null {
  if (
    !value?.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\") ||
    [...value].some((character) => character.charCodeAt(0) < 32)
  )
    return null;
  const target = new URL(value, origin);
  if (
    target.origin !== origin ||
    target.pathname === "/account" ||
    target.username ||
    target.password
  )
    return null;
  for (const key of [...target.searchParams.keys()]) {
    if (key.startsWith("privy_")) target.searchParams.delete(key);
  }
  return target.pathname + target.search + target.hash;
}
