import { createHmac } from "node:crypto";
import { fetchWithTimeout } from "@/lib/exchanges/types";

export interface BitgetApiCredentials {
  apiKey: string;
  secretKey: string;
  passphrase: string;
}

/** Bitget HMAC: timestamp + METHOD + requestPath + ?queryString + body */
export function bitgetSign(
  secretKey: string,
  timestamp: string,
  method: string,
  requestPath: string,
  queryString: string,
  body: string
): string {
  let pre = timestamp + method.toUpperCase() + requestPath;
  if (queryString) pre += "?" + queryString;
  pre += body;
  return createHmac("sha256", secretKey).update(pre).digest("base64");
}

export function loadBitgetCredentials(): BitgetApiCredentials | null {
  const apiKey = process.env.BITGET_API_KEY?.trim() || "";
  const secretKey = process.env.BITGET_API_SECRET?.trim() || process.env.BITGET_SECRET_KEY?.trim() || "";
  const passphrase = process.env.BITGET_PASSPHRASE?.trim() || "";
  if (!apiKey || !secretKey || !passphrase) return null;
  return { apiKey, secretKey, passphrase };
}

export async function bitgetSignedGet(
  creds: BitgetApiCredentials,
  requestPath: string,
  query: Record<string, string>,
  timeoutMs = 15_000
): Promise<Response> {
  const timestamp = Date.now().toString();
  const queryString = new URLSearchParams(query).toString();
  const sign = bitgetSign(creds.secretKey, timestamp, "GET", requestPath, queryString, "");
  const url = `https://api.bitget.com${requestPath}${queryString ? `?${queryString}` : ""}`;
  return fetchWithTimeout(
    url,
    {
      method: "GET",
      headers: {
        "ACCESS-KEY": creds.apiKey,
        "ACCESS-SIGN": sign,
        "ACCESS-TIMESTAMP": timestamp,
        "ACCESS-PASSPHRASE": creds.passphrase,
      },
    },
    timeoutMs
  );
}

export async function bitgetSignedPost(
  creds: BitgetApiCredentials,
  requestPath: string,
  body: Record<string, string>,
  timeoutMs = 15_000
): Promise<Response> {
  const bodyStr = JSON.stringify(body);
  const timestamp = Date.now().toString();
  const sign = bitgetSign(creds.secretKey, timestamp, "POST", requestPath, "", bodyStr);
  return fetchWithTimeout(
    `https://api.bitget.com${requestPath}`,
    {
      method: "POST",
      headers: {
        "ACCESS-KEY": creds.apiKey,
        "ACCESS-SIGN": sign,
        "ACCESS-TIMESTAMP": timestamp,
        "ACCESS-PASSPHRASE": creds.passphrase,
        "Content-Type": "application/json",
        "locale": "en-US",
      },
      body: bodyStr,
    },
    timeoutMs
  );
}
