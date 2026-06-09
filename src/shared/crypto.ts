export const textEncoder = new TextEncoder();

export function randomId(): string {
  return `${Date.now()}-${randomBase64Url(8)}`;
}

export function randomSessionCode(): string {
  const alphabet = "23456789abcdefghjkmnpqrstuvwxyz";
  let value = "";
  while (value.length < 8) {
    const bytes = crypto.getRandomValues(new Uint8Array(8));
    for (const byte of bytes) {
      if (byte >= 248) continue;
      value += alphabet[byte % alphabet.length];
      if (value.length === 8) break;
    }
  }
  return value;
}

function randomBase64Url(size: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(size));
  let value = "";
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function base64Encode(value: string): string {
  const bytes = textEncoder.encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
