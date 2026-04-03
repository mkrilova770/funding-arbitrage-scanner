/**
 * One-off: load .env.local and call signed isolated interest (same as scan probe).
 * Usage: npx --yes tsx scripts/bitget-margin-probe.ts
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

function loadEnvLocal() {
  const envPath = join(process.cwd(), ".env.local");
  if (!existsSync(envPath)) {
    console.error("Missing .env.local");
    process.exit(1);
  }
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i < 0) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    process.env[k] = v;
  }
}

async function main() {
  loadEnvLocal();

  const { bitgetSignedGet, loadBitgetCredentials } = await import(
    "../lib/bitget-sign"
  );

  const creds = loadBitgetCredentials();
  if (!creds) {
    console.error("Set BITGET_API_KEY, BITGET_API_SECRET, BITGET_PASSPHRASE");
    process.exit(1);
  }

  const path = "/api/v2/margin/isolated/interest-rate-and-limit";
  const res = await bitgetSignedGet(creds, path, { symbol: "BTCUSDT" });
  const json: unknown = await res.json();
  console.log("HTTP", res.status);
  console.log(JSON.stringify(json, null, 2));
  const code = (json as { code?: string }).code;
  if (code === "00000") {
    console.log(
      "\nOK — маржинальный isolated API доступен, сканер сможет тянуть лимиты."
    );
  } else if (code === "50021") {
    console.log(
      "\n50021 — маржа по API всё ещё не видна; проверьте активацию / тип аккаунта."
    );
  } else if (code === "40006") {
    console.log("\n40006 — ошибка ключей или passphrase.");
  } else {
    console.log("\nНеизвестный ответ — см. code/msg выше.");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
