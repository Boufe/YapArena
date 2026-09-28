import argon2 from "argon2";

const minimumPasswordLength = 15;
const maximumPasswordLength = 128;

const hashingOptions = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

export function validatePassword(password: unknown): string | null {
  if (typeof password !== "string") {
    return "password must be a string";
  }

  const length = [...password].length;

  if (length < minimumPasswordLength || length > maximumPasswordLength) {
    return `password must be between ${minimumPasswordLength} and ${maximumPasswordLength} characters`;
  }

  return null;
}

export function hashPassword(password: string) {
  return argon2.hash(password, hashingOptions);
}

export function verifyPassword(passwordHash: string, password: string) {
  return argon2.verify(passwordHash, password);
}
