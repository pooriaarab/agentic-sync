const MIN_SECRET_BYTES = 32;

// Throws unless the host set a secret of at least 32 bytes.
export function assertAdminSecret(secret: string | undefined): string {
  if (secret === undefined || new TextEncoder().encode(secret).length < MIN_SECRET_BYTES) {
    throw new Error(`SYNC_ADMIN_SECRET must be at least ${MIN_SECRET_BYTES} bytes`);
  }
  return secret;
}

// Hashing first gives both sides one length. The compare reads every byte.
export async function matchesSecret(given: string, secret: string): Promise<boolean> {
  const digest = (value: string) => crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  const [a, b] = await Promise.all([digest(given), digest(secret)]);
  const [x, y] = [new Uint8Array(a), new Uint8Array(b)];
  let difference = 0;
  for (let i = 0; i < x.length; i++) difference |= x[i] ^ y[i];
  return difference === 0;
}
