/**
 * Strip PEM armor and base64-decode the body to DER bytes,
 * detecting the key type from the PEM header.
 */
function pemToDerInner(pem: string): {
  der: Uint8Array;
  type: "privateKey" | "pkcs8" | "cert" | "spki";
} {
  const lines = pem.split("\n");
  const bodyLines: string[] = [];
  let inBody = false;
  let type: "privateKey" | "pkcs8" | "cert" | "spki" = "pkcs8";

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("-----BEGIN ")) {
      inBody = true;
      if (trimmed.includes("RSA PRIVATE KEY")) {
        type = "privateKey";
      } else if (trimmed.includes("CERTIFICATE")) {
        type = "cert";
      } else if (trimmed.includes("PUBLIC KEY")) {
        type = "spki";
      }
      continue;
    }
    if (trimmed.startsWith("-----END ")) {
      break;
    }
    if (inBody && trimmed.length > 0) {
      bodyLines.push(trimmed);
    }
  }

  const encoded = bodyLines.join("");
  const binaryString = atob(encoded);
  const result = new Uint8Array(binaryString.length);

  for (let index = 0; index < binaryString.length; index++) {
    // oxlint-disable-next-line typescript/no-non-null-assertion
    result[index] = binaryString.codePointAt(index)!;
  }

  return { der: result, type };
}

/**
 * Strip PEM armor and base64-decode the body to DER bytes.
 * Handles PKCS#8, PKCS#1, SPKI, and "-----BEGIN CERTIFICATE-----" headers.
 */
function stripPem(pem: string): Uint8Array {
  return pemToDerInner(pem).der;
}

/**
 * Base64url-encode a byte array (no padding).
 */
function b64urlEncode(data: Uint8Array): string {
  const codePoints: number[] = [];
  for (const byte of data) {
    codePoints.push(byte);
  }
  return btoa(String.fromCodePoint(...codePoints))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

/**
 * Base64url-decode a string to bytes (tolerates missing padding).
 */
function b64urlDecode(str: string): Uint8Array {
  // Restore standard base64
  let base64 = str.replaceAll("-", "+").replaceAll("_", "/");
  while (base64.length % 4 !== 0) {
    base64 += "=";
  }
  const binaryString = atob(base64);
  const result = new Uint8Array(binaryString.length);
  for (let index = 0; index < binaryString.length; index++) {
    // oxlint-disable-next-line typescript/no-non-null-assertion
    result[index] = binaryString.codePointAt(index)!;
  }
  return result;
}

export { b64urlDecode as base64urlDecode, b64urlEncode as base64urlEncode, stripPem as pemToDer };
