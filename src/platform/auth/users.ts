export interface PublicUser {
  id: string;
  email: string | null;
  createdAt: Date;
}

export interface AuthenticationUser extends PublicUser {
  authGeneration: string;
}

export function publicUser(user: PublicUser): PublicUser {
  return { id: user.id, email: user.email, createdAt: user.createdAt };
}
