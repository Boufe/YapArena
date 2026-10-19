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
  return target.pathname + target.search + target.hash;
}
