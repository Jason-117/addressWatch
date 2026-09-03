import { SMTPClient } from "https://deno.land/x/denomailer/mod.ts";

function requiredEnv(name: string): string {
  const v = Deno.env.get(name);
  if (!v) {
    throw new Error(`缺少必需的环境变量：${name}`);
  }
  return v;
}

function optionalEnv(name: string, defaultValue = ""): string {
  return Deno.env.get(name) ?? defaultValue;
}

function parseList(raw: string): string[] {
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

const WATCH_ADDRESSES = parseList(requiredEnv("WATCH_ADDRESSES"));
const MAIL_TO = parseList(requiredEnv("MAIL_TO"));
const TRONSCAN_API_KEY = optionalEnv("TRONSCAN_API_KEY");
const SMTP_SERVER = requiredEnv("SMTP_SERVER");
const SMTP_PORT = Number(optionalEnv("SMTP_PORT", "465"));
const SMTP_USER = requiredEnv("SMTP_USER");
const SMTP_PASS = requiredEnv("SMTP_PASS");
const CHECK_SECRET = optionalEnv("CHECK_SECRET");

// 官方 USDT-TRC20 合约地址
const OFFICIAL_USDT_TRC20_CONTRACT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";

// 轮询频率
const CRON_SCHEDULE = "* * * * *"; // 每 1 分钟检查一次

// Deno KV
let _kv: Deno.Kv | null = null;

async function getKv(): Promise<Deno.Kv> {
  if (_kv) return _kv;
  const kvPromise = Deno.openKv();
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error("Deno.openKv() KV库未连接")), 10000)
  );
  _kv = await Promise.race([kvPromise, timeoutPromise]);
  return _kv;
}

async function isSeen(txId: string): Promise<boolean> {
  const kv = await getKv();
  const res = await kv.get(["seen_tx", txId]);
  return res.value !== null;
}

async function markSeen(txId: string): Promise<void> {
  const kv = await getKv();
  await kv.set(["seen_tx", txId], true);
}

// 每个地址首次运行时，只记录历史交易、不发通知
async function isFirstRunFor(address: string): Promise<boolean> {
  const kv = await getKv();
  const res = await kv.get(["initialized", address]);
  return res.value === null;
}

async function markInitialized(address: string): Promise<void> {
  const kv = await getKv();
  await kv.set(["initialized", address], true);
}


interface NormalizedTx {
  txId: string;
  from: string;
  to: string;
  value: string;
  symbol: string;
  decimals: number;
  contractAddress: string;
}

async function fetchLatestTrc20Txs(address: string, limit = 20): Promise<any[]> {
  const url = new URL("https://apilist.tronscanapi.com/api/token_trc20/transfers");
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("start", "0");
  url.searchParams.set("sort", "-timestamp");
  url.searchParams.set("relatedAddress", address);

  const headers: Record<string, string> = {};
  if (TRONSCAN_API_KEY) headers["TRON-PRO-API-KEY"] = TRONSCAN_API_KEY;

  const resp = await fetch(url.toString(), { headers });
  if (!resp.ok) {
    throw new Error(`TronScan 请求失败：HTTP ${resp.status}`);
  }
  const data = await resp.json();
  return data.token_transfers ?? [];
}

function normalizeTx(raw: any): NormalizedTx {
  const tokenInfo = raw.tokenInfo ?? {};
  return {
    txId: raw.transaction_id ?? "?",
    from: raw.from_address ?? "?",
    to: raw.to_address ?? "?",
    value: String(raw.quant ?? "0"),
    symbol: tokenInfo.tokenAbbr ?? "",
    decimals: Number(tokenInfo.tokenDecimal ?? 6),
    contractAddress: raw.contract_address ?? "",
  };
}

function isExactUsdtSymbol(symbol: string): boolean {
  // 除 USDT 外，其他任意情况都视为异常
  return symbol === "USDT";
}

function formatAmount(rawValue: string, decimals: number): string {
  let raw: bigint;
  try {
    raw = BigInt(rawValue);
  } catch {
    return rawValue;
  }
  const negative = raw < 0n;
  const absRaw = negative ? -raw : raw;
  const divisor = 10n ** BigInt(decimals);
  const intPart = absRaw / divisor;
  let fracPart = (absRaw % divisor).toString().padStart(decimals, "0");
  fracPart = fracPart.replace(/0+$/, "");
  const sign = negative ? "-" : "";
  return fracPart.length > 0 ? `${sign}${intPart}.${fracPart}` : `${sign}${intPart}`;
}

function isTwoDecimalAmount(rawValue: string, decimals: number): boolean {
  // 判断金额是否符合 xx.xx（最多两位小数）格式，位数超过视为异常
  if (decimals <= 2) return true;
  try {
    const raw = BigInt(rawValue);
    const divisor = 10n ** BigInt(decimals - 2);
    return raw % divisor === 0n;
  } catch {
    return false;
  }
}

function isIntegerAmount(rawValue: string, decimals: number): boolean {
  // 判断金额是否为整数，整数视为异常
  if (decimals === 0) return true;
  try {
    const raw = BigInt(rawValue);
    const divisor = 10n ** BigInt(decimals);
    return raw % divisor === 0n;
  } catch {
    return false;
  }
}

function checkAnomalies(tx: NormalizedTx): string[] {
  const anomalies: string[] = [];

  // 1) Token 必须严格等于 USDT
  if (!isExactUsdtSymbol(tx.symbol)) {
    anomalies.push(
      `Token 异常：显示为「${tx.symbol}」，并非「USDT」，请高度警惕仿冒代币`,
    );
  }

  // 2) 代币地址校验：symbol
  if (tx.contractAddress && tx.contractAddress !== OFFICIAL_USDT_TRC20_CONTRACT) {
    anomalies.push(
      `代币地址异常：${tx.contractAddress} 不是官方 USDT 地址` +
      `（官方地址应为 ${OFFICIAL_USDT_TRC20_CONTRACT}），很可能是仿冒代币`,
    );
  }

  // 3) 金额格式校验：非 xx.xx（两位小数以内）一律提示
  if (!isTwoDecimalAmount(tx.value, tx.decimals)) {
    anomalies.push(
      `金额异常：${formatAmount(tx.value, tx.decimals)} 非 xx.xx（两位小数以内）`,
    );
  }

  // 4) 金额为整数，视为异常
  if (isIntegerAmount(tx.value, tx.decimals)) {
    anomalies.push(
      `金额异常：${formatAmount(tx.value, tx.decimals)} 为整数，请手动核实`,
    );
  }

  return anomalies;
}

function formatTxMessage(tx: NormalizedTx, watchAddress: string): { title: string; body: string } {
  const amountStr = formatAmount(tx.value, tx.decimals);
  const direction = tx.to === watchAddress ? "收款" : tx.from === watchAddress ? "转出" : "相关";
  const anomalies = checkAnomalies(tx);

  const title = anomalies.length > 0
    ? `异常交易提醒（${direction}）`
    : `新的 TRC-20 交易（${direction}）`;

  const lines: string[] = [];
  if (anomalies.length > 0) {
    lines.push("检测到以下异常，请仔细核实，谨防诈骗：");
    lines.push(...anomalies);
    lines.push("");
  }
  lines.push(`监控地址：${watchAddress}`);
  lines.push(`金额：${amountStr} ${tx.symbol}`);
  lines.push(`From：${tx.from}`);
  lines.push(`To：${tx.to}`);
  lines.push(`交易哈希：${tx.txId}`);
  lines.push(`查看详情：https://tronscan.org/#/transaction/${tx.txId}`);

  return { title, body: lines.join("\n") };
}


// 邮件发送
function encodeMimeSubject(subject: string): string {
  const bytes = new TextEncoder().encode(subject);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  const base64 = btoa(binary);
  return `=?UTF-8?B?${base64}?=`;
}

async function sendEmailNotification(title: string, body: string): Promise<void> {
  const client = new SMTPClient({
    connection: {
      hostname: SMTP_SERVER,
      port: SMTP_PORT,
      tls: true,
      auth: {
        username: SMTP_USER,
        password: SMTP_PASS,
      },
    },
  });

  try {
    await client.send({
      from: SMTP_USER,
      to: MAIL_TO,
      subject: encodeMimeSubject(title),
      content: body,
      contentType: "text/plain; charset=utf-8",
    });

    console.log(`邮件通知已发送给：${MAIL_TO.join(", ")}`);
  } finally {
    await client.close();
  }
}

async function checkAllAddresses(): Promise<void> {
  if (WATCH_ADDRESSES.length === 0) {
    console.warn("WATCH_ADDRESSES 为空，没有需要监控的地址");
    return;
  }

  for (const address of WATCH_ADDRESSES) {
    let rawTxs: any[];
    try {
      rawTxs = await fetchLatestTrc20Txs(address);
    } catch (e) {
      console.error(`[${address} 请求出错，跳过本轮]`, e);
      continue;
    }

    const txs = rawTxs.map(normalizeTx);

    if (await isFirstRunFor(address)) {
      for (const tx of txs) {
        await markSeen(tx.txId);
      }
      await markInitialized(address);
      continue;
    }

    const chronological = [...txs].reverse();
    for (const tx of chronological) {
      if (await isSeen(tx.txId)) continue;

      const { title, body } = formatTxMessage(tx, address);
      console.log(`发现新交易：\n${body}`);

      try {
        await sendEmailNotification(title, body);
        await markSeen(tx.txId);
        console.log(`邮件发送成功，交易已标记：${tx.txId}`);
      } catch (e) {
        console.error("[邮件发送失败，本次不标记为已处理]", e);

        const message = e instanceof Error ? (e.stack ?? e.message) : String(e);

        throw new Error(`邮件发送失败：${message}`);
      }

      await markSeen(tx.txId);
    }
  }
}

// Deno Cron 自动轮询
Deno.cron("trc20-monitor-check", CRON_SCHEDULE, async () => {
  try {
    await checkAllAddresses();
  } catch (e) {
    console.error("[定时任务异常]", e);
  }
});

Deno.serve(async (req: Request) => {
  try {
    const url = new URL(req.url);

    if (url.pathname === "/health") {
      return new Response("ok", { status: 200 });
    }

    if (url.pathname === "/check") {
      if (CHECK_SECRET && url.searchParams.get("secret") !== CHECK_SECRET) {
        return new Response("Unauthorized", { status: 401 });
      }
      try {
        await checkAllAddresses();
        return new Response("检查完成。请查看响应内容或服务器日志。", {
          status: 200,
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
      } catch (e) {

        const message = e instanceof Error ? (e.stack ?? e.message) : String(e);
        console.error("[/check 处理异常]", e);
        return new Response(`检查过程中出错：\n\n${message}`, {
          status: 500,
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
      }
    }

    return new Response("TRC-20 monitor is running.", { status: 200 });
  } catch (e) {
    const message = e instanceof Error ? (e.stack ?? e.message) : String(e);
    console.error("[顶层请求处理异常]", e);
    return new Response(`服务器出错：\n\n${message}`, {
      status: 500,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
});