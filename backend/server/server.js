import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import crypto from "crypto";
import { JsonRpcProvider, Interface, getAddress, parseUnits, Contract, formatUnits } from "ethers";
import { spawn } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const BASE_SEPOLIA_RPC_URL = process.env.BASE_SEPOLIA_RPC_URL;
if (!BASE_SEPOLIA_RPC_URL) throw new Error("Missing BASE_SEPOLIA_RPC_URL in .env");

// Base Sepolia
const CHAIN = "eip155:84532";
const BASE_SEPOLIA_CHAIN_ID = 84532;

// USDC on Base Sepolia (testnet)
const USDC_CONTRACT = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const USDC_DECIMALS = 6;
const TOKEN = "USDC";

// Vault payment configuration
const VAULT_ADDRESS = process.env.VAULT_ADDRESS;
const MERCHANT_ADDRESS = process.env.MERCHANT_ADDRESS;
const OWNER_ADDRESS = process.env.OWNER_ADDRESS;
const SPENDER_ADDRESS = process.env.SPENDER_ADDRESS || null;
const STRATEGY_ADDRESS = process.env.STRATEGY_ADDRESS || null;

if (!VAULT_ADDRESS) throw new Error("Missing VAULT_ADDRESS in .env");
if (!MERCHANT_ADDRESS) throw new Error("Missing MERCHANT_ADDRESS in .env");
if (!OWNER_ADDRESS) throw new Error("Missing OWNER_ADDRESS in .env");

const provider = new JsonRpcProvider(BASE_SEPOLIA_RPC_URL);

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
];
const VAULT_ABI = [
  "function totalAssets() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
];

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --------------------
// UI helpers: in-memory timeline + summary
// --------------------
const MAX_TIMELINE_EVENTS = 500;
const timelineEvents = [];

function nowIso() {
  return new Date().toISOString();
}

function addTimelineEvent(event) {
  const enriched = {
    id: event.id || `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    ts: event.ts || nowIso(),
    ...event,
  };

  timelineEvents.unshift(enriched);
  if (timelineEvents.length > MAX_TIMELINE_EVENTS) {
    timelineEvents.length = MAX_TIMELINE_EVENTS;
  }
  return enriched;
}

function summarizeInvoices() {
  const values = Object.values(invoices);
  let totalUsd = 0;
  let paidUsd = 0;
  let pendingUsd = 0;
  let expiredUsd = 0;

  for (const inv of values) {
    totalUsd += Number(inv.totalUsd || 0);
    if (inv.status === "PAID") paidUsd += Number(inv.totalUsd || 0);
    else if (inv.status === "EXPIRED") expiredUsd += Number(inv.totalUsd || 0);
    else pendingUsd += Number(inv.totalUsd || 0);
  }

  return {
    invoices_total: values.length,
    invoices_paid: values.filter((i) => i.status === "PAID").length,
    invoices_pending: values.filter((i) => i.status !== "PAID" && i.status !== "EXPIRED").length,
    invoices_expired: values.filter((i) => i.status === "EXPIRED").length,
    total_usd: Number(totalUsd.toFixed(2)),
    paid_usd: Number(paidUsd.toFixed(2)),
    pending_usd: Number(pendingUsd.toFixed(2)),
    expired_usd: Number(expiredUsd.toFixed(2)),
    last_event_at: timelineEvents[0]?.ts || null,
  };
}

async function getVaultUsdcBalance() {
  const token = new Contract(USDC_CONTRACT, ERC20_ABI, provider);
  const vault = new Contract(VAULT_ADDRESS, VAULT_ABI, provider);

  const [bal, totalAssets, totalSupply] = await Promise.all([
    token.balanceOf(VAULT_ADDRESS),
    vault.totalAssets(),
    vault.totalSupply(),
  ]);

  const amountUsdc = Number(formatUnits(bal, USDC_DECIMALS));
  const totalAssetsUsdc = Number(formatUnits(totalAssets, USDC_DECIMALS));
  const totalSupplyUsdc = Number(formatUnits(totalSupply, USDC_DECIMALS));

  const yieldUsdc = Math.max(0, totalAssetsUsdc - totalSupplyUsdc);
  const sharePrice = totalSupplyUsdc > 0 ? totalAssetsUsdc / totalSupplyUsdc : 0;
  return {
    vault_address: VAULT_ADDRESS,
    strategy_address: STRATEGY_ADDRESS,
    token: TOKEN,
    token_contract: USDC_CONTRACT,
    decimals: USDC_DECIMALS,
    amount_base_units: bal.toString(),
    amount_usdc: Number(amountUsdc.toFixed(6)),
    total_assets_base_units: totalAssets.toString(),
    total_assets_usdc: Number(totalAssetsUsdc.toFixed(6)),
    total_supply_base_units: totalSupply.toString(),
    total_supply_usdc: Number(totalSupplyUsdc.toFixed(6)),
    share_price: Number(sharePrice.toFixed(6)),
    yield_usdc: Number(yieldUsdc.toFixed(6)),
  };
}

function toUiTimelineEvent(ev) {
  const ts = ev.ts ? Date.parse(ev.ts) : Date.now();
  const timestamp = Number.isNaN(ts) ? Date.now() : ts;

  function base(type, title, description, status = "info", meta = {}) {
    return {
      id: ev.id,
      type,
      title,
      description,
      timestamp,
      status,
      meta,
    };
  }

  switch (ev.type) {
    case "USER_SELECTED_SERVICE":
      return base(
        "QUOTE_REQUESTED",
        "User Selected Service",
        `${ev.business_case || "service"} selected by user`,
        "info",
        ev.request || {}
      );

    case "DEVICE_SELECTED":
      return base(
        "QUOTE_REQUESTED",
        "Device Selected",
        ev.device_name ? `${ev.device_name} selected` : "Device selected",
        "info",
        {
          device_id: ev.device_id || null,
          distance_meters: ev.distance_meters ?? null,
        }
      );

    case "QUOTE_REQUEST":
      return base(
        "QUOTE_REQUESTED",
        "Quote Requested",
        `Quote requested for ${ev.business_case || "service"}`,
        "info",
        ev.payload || {}
      );

    case "PAYMENT_REQUIRED":
      return base(
        "PAYMENT_REQUIRED_402",
        "Micropayment Required",
        "Payment gate enforced before access",
        "warning",
        {
          Gate: ev.protocol || "x402",
          amount_usdc: ev.amount_usdc ?? null,
          invoice_id: ev.invoice_id || null,
        }
      );

    case "SPEND_TX_SENT":
      return base(
        "PAYMENT_SUBMITTED",
        "On-chain Payment Submitted",
        ev.tx_hash ? `tx: ${ev.tx_hash}` : "On-chain payment submitted",
        "info",
        { tx_hash: ev.tx_hash || null }
      );

    case "PAYMENT_CONFIRMED":
      return base(
        "PAYMENT_VERIFIED",
        "Payment Verified",
        "On-chain spend verified",
        "success",
        { tx_hash: ev.tx_hash || null }
      );

    case "SERVICE_UNLOCKED":
      return base(
        "ACCESS_GRANTED",
        "Service Unlocked",
        ev.message || "Access granted",
        "success",
        {
          invoice_id: ev.invoice_id || null,
          total_usd: ev.total_usd ?? null,
        }
      );

    case "PAYMENT_FAILED":
      return base(
        "ERROR",
        "Payment Failed",
        ev.reason || "Payment failed",
        "error",
        ev.error || {}
      );

    case "INVOICE_EXPIRED":
      return base(
        "FLOW_ABORTED",
        "Invoice Expired",
        "Payment window expired",
        "error",
        { invoice_id: ev.invoice_id || null }
      );

    case "CONFIRM_PENDING":
      return base(
        "PAYMENT_SUBMITTED",
        "Awaiting Confirmation",
        ev.reason || "Awaiting on-chain confirmation",
        "warning",
        { invoice_id: ev.invoice_id || null }
      );

    case "AGENT_RUN_FAILED":
      return base(
        "ERROR",
        "Agent Failed",
        ev.reason || "Agent execution failed",
        "error"
      );

    default:
      return base(
        "ERROR",
        "Unknown Event",
        "Unmapped event in timeline",
        "warning",
        { raw_type: ev.type || "UNKNOWN" }
      );
  }
}

// --------------------
// Agent runner (M2M)
// --------------------
const ALLOWED_BUSINESS_CASES = new Set(["gas_station", "vending_machine", "laundry"]);
const agentsDir = path.resolve(__dirname, "..", "agents");
const venvPython = path.join(agentsDir, ".venv", "bin", "python");
const PYTHON_BIN = process.env.PYTHON_BIN || (fs.existsSync(venvPython) ? venvPython : "python3");

function runM2MAgent(businessCase, { timeoutMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    if (!ALLOWED_BUSINESS_CASES.has(businessCase)) {
      reject(new Error(`Unsupported business_case: ${businessCase}`));
      return;
    }

    const scriptPath = path.join(agentsDir, "m2m_client.py");

    const child = spawn(PYTHON_BIN, [scriptPath, businessCase], {
      cwd: agentsDir,
      env: process.env,
    });

    let stdout = "";
    let stderr = "";
    let finished = false;

    const timer = setTimeout(() => {
      if (!finished) {
        child.kill("SIGKILL");
        reject(new Error(`Agent timeout after ${timeoutMs}ms`));
      }
    }, timeoutMs);

    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      finished = true;
      reject(err);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      finished = true;
      resolve({ code, stdout, stderr });
    });
  });
}

function extractJsonObjectsFromText(text) {
  const lines = String(text || "").split(/\r?\n/);
  const results = [];
  let buf = "";
  let depth = 0;
  let inString = false;
  let escape = false;

  function pushIfValid(str) {
    try {
      const obj = JSON.parse(str);
      results.push(obj);
    } catch {
      // ignore non-JSON blocks
    }
  }

  for (const line of lines) {
    if (!buf) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("{")) continue;
      buf = trimmed;
      depth = 0;
      inString = false;
      escape = false;
      // fallthrough to count braces in this line
    } else {
      buf += "\n" + line;
    }

    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === "\\") {
        escape = true;
        continue;
      }
      if (ch === "\"") {
        inString = !inString;
        continue;
      }
      if (inString) continue;
      if (ch === "{") depth += 1;
      if (ch === "}") depth -= 1;
    }

    if (buf && depth === 0) {
      pushIfValid(buf);
      buf = "";
    }
  }

  return results;
}

function extractSpendTxHash(text) {
  const m = String(text || "").match(/spend\(\) tx hash:\s*(0x[a-fA-F0-9]{64})/);
  return m ? m[1] : null;
}

function normalizeAgentEventsForTimeline(events, stdout, businessCase) {
  const items = [];

  for (const ev of events) {
    const evt = ev?.event;
    if (evt === "USER_SELECTED_SERVICE") {
      items.push({
        type: "USER_SELECTED_SERVICE",
        business_case: ev.business_case || businessCase,
        request: ev.request || null,
        client_id: ev.client_id || null,
        ts: ev.timestamp || undefined,
      });
      continue;
    }

    if (evt === "DEVICE_SELECTED") {
      items.push({
        type: "DEVICE_SELECTED",
        business_case: ev.business_case || businessCase,
        device_id: ev.device?.device_id || null,
        device_name: ev.device?.name || null,
        distance_meters: ev.distance_meters ?? null,
      });
      continue;
    }

    if (evt === "QUOTE_REQUEST") {
      items.push({
        type: "QUOTE_REQUEST",
        business_case: ev.business_case || businessCase,
        device_id: ev.device_id || null,
        client_id: ev.client_id || null,
        payload: ev.payload || null,
        ts: ev.timestamp || undefined,
      });
      continue;
    }

    if (evt === "PAYMENT_FAILED") {
      items.push({
        type: "PAYMENT_FAILED",
        invoice_id: ev.invoiceId || ev.invoice_id || null,
        reason: ev.error?.reason || ev.error?.type || null,
        error: ev.error || null,
      });
      continue;
    }

    if (evt === "SERVICE_UNLOCKED") {
      items.push({
        type: "SERVICE_UNLOCKED",
        invoice_id: ev.invoiceId || ev.invoice_id || null,
        business_case: ev.business_case || businessCase,
        device_id: ev.device_id || null,
        client_id: ev.client_id || null,
        total_usd: ev.totalUsd ?? null,
        message: ev.message || null,
      });
      continue;
    }

    if (ev?.payment_required?.protocol) {
      const pr = ev.payment_required;
      items.push({
        type: "PAYMENT_REQUIRED",
        protocol: pr.protocol,
        business_case: pr.business_case || businessCase,
        device_id: pr.device_id || null,
        client_id: pr.client_id || null,
        invoice_id: pr.invoice_id || ev.invoiceId || null,
        amount_usdc: pr.amount_usdc ?? null,
        amount_base_units: pr.amount_base_units || null,
      });
      continue;
    }
  }

  const txHash = extractSpendTxHash(stdout);
  if (txHash) {
    items.push({
      type: "SPEND_TX_SENT",
      tx_hash: txHash,
      business_case: businessCase,
    });
  }

  return items;
}

// ExpenseVault event ABI (minimal)
const VAULT_IFACE = new Interface([
  "event Spent(address indexed owner,address indexed spender,address indexed merchant,uint256 amount,uint256 sharesBurned,uint256 dayIndex)",
]);

// In-memory invoices store (demo)
const invoices = {};

function nowMs() {
  return Date.now();
}

function msFromSeconds(sec) {
  return sec * 1000;
}

function makeId(prefix = "INV") {
  return `${prefix}-${crypto.randomBytes(6).toString("hex")}`;
}

function clamp2(x) {
  return Math.round(Number(x) * 100) / 100;
}

function purchaseGasStation({ deviceId, payload }) {
  const stationId = payload?.station_id ?? deviceId ?? "station-777";
  const fuelType = payload?.fuel_type ?? "GASOLINE";
  const liters = Number(payload?.liters);
  const maxPrice = Number(payload?.max_price_per_liter_usd);

  if (!Number.isFinite(liters) || liters <= 0) throw new Error("Invalid liters");
  if (!Number.isFinite(maxPrice) || maxPrice <= 0) throw new Error("Invalid max_price_per_liter_usd");

  const pricePerLiterUsd = Math.max(0.5, clamp2(maxPrice - 0.05));
  const totalUsd = clamp2(liters * pricePerLiterUsd);

  return { totalUsd, meta: { stationId, fuelType, liters, pricePerLiterUsd } };
}

function purchaseVending({ deviceId, payload }) {
  const sku = payload?.sku;
  const quantity = Number(payload?.quantity ?? 1);
  const maxUnit = Number(payload?.max_unit_price_usd);

  if (!sku) throw new Error("Invalid sku");
  if (!Number.isFinite(quantity) || quantity <= 0) throw new Error("Invalid quantity");
  if (!Number.isFinite(maxUnit) || maxUnit <= 0) throw new Error("Invalid max_unit_price_usd");

  const unitPriceUsd = Math.max(0.5, clamp2(maxUnit - 0.05));
  const totalUsd = clamp2(unitPriceUsd * quantity);

  return { totalUsd, meta: { sku, quantity, unitPriceUsd, deviceId } };
}

function purchaseLaundry({ deviceId, payload }) {
  const program = payload?.program;
  const maxPrice = Number(payload?.max_price_usd);

  if (!program) throw new Error("Invalid program");
  if (!Number.isFinite(maxPrice) || maxPrice <= 0) throw new Error("Invalid max_price_usd");

  const totalUsd = Math.max(1.0, clamp2(maxPrice - 0.1));
  return { totalUsd, meta: { program, deviceId } };
}

function createInvoiceForPurchase({ businessCase, deviceId, payload }) {
  if (businessCase === "gas_station") return purchaseGasStation({ deviceId, payload });
  if (businessCase === "vending_machine") return purchaseVending({ deviceId, payload });
  if (businessCase === "laundry") return purchaseLaundry({ deviceId, payload });
  throw new Error("Unsupported business_case");
}

function computeTotals(liters, pricePerLiterUsd) {
  const total = Number(liters) * Number(pricePerLiterUsd);
  return clamp2(total);
}

function normalizeTxHash(txHash) {
  if (typeof txHash !== "string") return null;
  let h = txHash.trim();
  if (!h.startsWith("0x")) h = "0x" + h;
  if (h.length !== 66) return null;
  return h;
}

function buildPaymentRequired(inv) {
  return {
    protocol: "x402",
    chain: inv.chain,
    token: inv.token,
    token_contract: inv.tokenContract,
    decimals: inv.tokenDecimals,

    // Amounts
    amount_usdc: inv.totalUsd, // human-friendly number (2 decimals)
    amount_base_units: inv.amountBaseUnits, // exact integer string (USDC 6 decimals)

    // Vault spend instructions
    vault_address: inv.vaultAddress,
    owner_address: inv.ownerAddress,
    merchant_address: inv.merchantAddress,
    spender_address: inv.spenderAddress, // may be null

    // Extra context (helps the client UI/agent)
    business_case: inv.businessCase,
    device_id: inv.deviceId,
    client_id: inv.clientId,

    invoice_id: inv.invoiceId,
    expires_at: new Date(inv.expiresAt).toISOString(),

    next_step:
      "Client Bot must send an on-chain tx calling " +
      "ExpenseVault.spend(owner_address, merchant_address, amount_base_units) " +
      "from the spender wallet. Then call POST /m2m/confirm with { invoiceId, txHash }.",
  };
}

async function verifyVaultSpendOnBaseSepolia(inv, txHash) {
  // 1) Basic txHash sanity (accept with/without 0x)
  const h = normalizeTxHash(txHash);
  if (!h) return { ok: false, reason: "Invalid txHash format" };

  // 2) Confirm network
  const net = await provider.getNetwork();
  if (Number(net.chainId) !== BASE_SEPOLIA_CHAIN_ID) {
    return {
      ok: false,
      reason: `Wrong RPC network. Expected ${BASE_SEPOLIA_CHAIN_ID}, got ${net.chainId}`,
    };
  }

  // 3) Get receipt
  const receipt = await provider.getTransactionReceipt(h);
  if (!receipt) return { ok: false, reason: "Transaction not found yet (no receipt)" };
  if (receipt.status !== 1) return { ok: false, reason: "Transaction failed (status != 1)" };

  const vaultAddr = getAddress(inv.vaultAddress);
  const expectedOwner = getAddress(inv.ownerAddress);
  const expectedMerchant = getAddress(inv.merchantAddress);
  const expectedAmount = BigInt(inv.amountBaseUnits);

  // Optional: enforce spender sender
  if (inv.spenderAddress) {
    if (getAddress(receipt.from) !== getAddress(inv.spenderAddress)) {
      return { ok: false, reason: "Tx sender is not the configured spender" };
    }
  }

  // Optional: ensure tx was sent to the vault contract
  if (receipt.to && getAddress(receipt.to) !== vaultAddr) {
    return { ok: false, reason: "Tx was not sent to the Vault contract" };
  }

  // 4) Scan logs for matching Spent(owner, spender, merchant, amount, ...)
  for (const log of receipt.logs) {
    if (getAddress(log.address) !== vaultAddr) continue;

    try {
      const parsed = VAULT_IFACE.parseLog({ topics: log.topics, data: log.data });
      if (!parsed || parsed.name !== "Spent") continue;

      const owner = getAddress(parsed.args.owner);
      const spender = getAddress(parsed.args.spender);
      const merchant = getAddress(parsed.args.merchant);
      const amount = BigInt(parsed.args.amount.toString());

      const spenderOk = !inv.spenderAddress || spender === getAddress(inv.spenderAddress);

      if (owner === expectedOwner && merchant === expectedMerchant && amount === expectedAmount && spenderOk) {
        return { ok: true, normalizedTxHash: h };
      }
    } catch {
      // ignore non-matching logs
    }
  }

  return { ok: false, reason: "No matching Spent event found in receipt logs" };
}

function makeInvoiceBase({
  businessCase,
  deviceId,
  clientId,
  totalUsd,
  meta = {},
}) {
  const invoiceId = makeId("INV");
  const ttlSeconds = 120; // 2 minutes for demo
  const createdAt = nowMs();
  const expiresAt = createdAt + msFromSeconds(ttlSeconds);

  // exact USDC amount (6 decimals) as string
  const amountBaseUnits = parseUnits(String(totalUsd), USDC_DECIMALS).toString();

  const inv = {
    invoiceId,
    createdAt,
    expiresAt,

    businessCase,
    deviceId,
    clientId,

    totalUsd,

    chain: CHAIN,
    token: TOKEN,
    tokenContract: USDC_CONTRACT,
    tokenDecimals: USDC_DECIMALS,
    amountBaseUnits,

    // Vault payment metadata
    vaultAddress: VAULT_ADDRESS,
    ownerAddress: OWNER_ADDRESS,
    merchantAddress: MERCHANT_ADDRESS,
    spenderAddress: SPENDER_ADDRESS,

    status: "PENDING",
    meta,
  };

  invoices[invoiceId] = inv;

  addTimelineEvent({
    type: "INVOICE_CREATED",
    business_case: businessCase,
    device_id: deviceId,
    client_id: clientId,
    invoice_id: invoiceId,
    total_usd: totalUsd,
    status: inv.status,
  });

  return inv;
}

function buildPaidResponse(inv) {
  return {
    ok: true,
    event: "SERVICE_UNLOCKED",
    invoiceId: inv.invoiceId,
    business_case: inv.businessCase,
    device_id: inv.deviceId,
    client_id: inv.clientId,
    totalUsd: inv.totalUsd,
    token: inv.token,
    message: "Vault spend verified on-chain. Device unlocked (simulated).",
    meta: inv.meta || {},
  };
}

// --------------------
// Health
// --------------------
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "m2m-payments-server",
    chain: CHAIN,
    token: TOKEN,
    time: new Date().toISOString(),
    vault: VAULT_ADDRESS,
    merchant: MERCHANT_ADDRESS,
    owner: OWNER_ADDRESS,
    spender: SPENDER_ADDRESS,
  });
});

// --------------------
// Universal confirm
// POST /m2m/confirm
// Body: { invoiceId, txHash }
// --------------------
app.post("/m2m/confirm", async (req, res) => {
  const { invoiceId, txHash } = req.body || {};

  if (!invoiceId || typeof invoiceId !== "string") {
    return res.status(400).json({ ok: false, error: "Missing invoiceId" });
  }
  if (!txHash || typeof txHash !== "string") {
    return res.status(400).json({ ok: false, error: "Missing txHash" });
  }

  const inv = invoices[invoiceId];
  if (!inv) return res.status(404).json({ ok: false, error: "Invoice not found" });

  if (inv.status === "EXPIRED" || nowMs() > inv.expiresAt) {
    inv.status = "EXPIRED";
    addTimelineEvent({
      type: "INVOICE_EXPIRED",
      invoice_id: inv.invoiceId,
      business_case: inv.businessCase,
      device_id: inv.deviceId,
      client_id: inv.clientId,
      total_usd: inv.totalUsd,
    });
    return res.status(402).json({ ok: false, error: "Invoice expired", invoiceId: inv.invoiceId });
  }

  const result = await verifyVaultSpendOnBaseSepolia(inv, txHash);

  if (!result.ok) {
    addTimelineEvent({
      type: "CONFIRM_PENDING",
      invoice_id: inv.invoiceId,
      business_case: inv.businessCase,
      device_id: inv.deviceId,
      client_id: inv.clientId,
      reason: result.reason,
    });
    return res.status(402).json({
      ok: false,
      error: "PAYMENT_NOT_VERIFIED_YET",
      reason: result.reason,
      invoiceId: inv.invoiceId,
      payment_required: buildPaymentRequired(inv),
    });
  }

  inv.status = "PAID";
  inv.txHash = result.normalizedTxHash || normalizeTxHash(txHash) || txHash;

  addTimelineEvent({
    type: "PAYMENT_CONFIRMED",
    invoice_id: inv.invoiceId,
    business_case: inv.businessCase,
    device_id: inv.deviceId,
    client_id: inv.clientId,
    total_usd: inv.totalUsd,
    tx_hash: inv.txHash,
  });

  return res.status(200).json(buildPaidResponse(inv));
});

// Backwards-compatible alias: /fuel/confirm -> same as /m2m/confirm
app.post("/fuel/confirm", async (req, res) => {
  // Reuse the same handler by calling logic directly
  const { invoiceId, txHash } = req.body || {};
  if (!invoiceId || !txHash) {
    return res.status(400).json({ ok: false, error: "Missing invoiceId or txHash" });
  }

  const inv = invoices[invoiceId];
  if (!inv) return res.status(404).json({ ok: false, error: "Invoice not found" });

  if (inv.status === "EXPIRED" || nowMs() > inv.expiresAt) {
    inv.status = "EXPIRED";
    addTimelineEvent({
      type: "INVOICE_EXPIRED",
      invoice_id: inv.invoiceId,
      business_case: inv.businessCase,
      device_id: inv.deviceId,
      client_id: inv.clientId,
      total_usd: inv.totalUsd,
    });
    return res.status(402).json({ ok: false, error: "Invoice expired", invoiceId: inv.invoiceId });
  }

  const result = await verifyVaultSpendOnBaseSepolia(inv, txHash);

  if (!result.ok) {
    addTimelineEvent({
      type: "CONFIRM_PENDING",
      invoice_id: inv.invoiceId,
      business_case: inv.businessCase,
      device_id: inv.deviceId,
      client_id: inv.clientId,
      reason: result.reason,
    });
    return res.status(402).json({
      ok: false,
      error: "PAYMENT_NOT_VERIFIED_YET",
      reason: result.reason,
      invoiceId: inv.invoiceId,
      payment_required: buildPaymentRequired(inv),
    });
  }

  inv.status = "PAID";
  inv.txHash = result.normalizedTxHash || normalizeTxHash(txHash) || txHash;
  addTimelineEvent({
    type: "PAYMENT_CONFIRMED",
    invoice_id: inv.invoiceId,
    business_case: inv.businessCase,
    device_id: inv.deviceId,
    client_id: inv.clientId,
    total_usd: inv.totalUsd,
    tx_hash: inv.txHash,
  });

  // Keep old response shape for fuel clients:
  if (inv.businessCase === "gas_station") {
    return res.status(200).json({
      ok: true,
      event: "FUEL_PURCHASE_CONFIRMED",
      invoiceId: inv.invoiceId,
      stationId: inv.meta?.stationId,
      carId: inv.clientId,
      fuelType: inv.meta?.fuelType,
      liters: inv.meta?.liters,
      pricePerLiterUsd: inv.meta?.pricePerLiterUsd,
      totalUsd: inv.totalUsd,
      message: "Vault spend verified on-chain. Fuel pump unlocked (simulated).",
    });
  }

  // Otherwise return generic
  return res.status(200).json(buildPaidResponse(inv));
});

// --------------------
// POST /m2m/purchase (unified)
// Body:
// {
//   business_case: "gas_station"|"vending_machine"|"laundry",
//   client_id: "client-001",
//   device_id: "xxx-123",
//   payload: {...}
// }
// Always returns 402 with vault payment instructions.
// --------------------
app.post("/m2m/purchase", async (req, res) => {
  const {
    business_case: businessCase,
    client_id: clientId = "client-001",
    device_id: deviceId = "device-unknown",
    payload = {},
  } = req.body || {};

  if (!businessCase || typeof businessCase !== "string") {
    return res.status(400).json({ ok: false, error: "Missing business_case" });
  }

  try {
    addTimelineEvent({
      type: "PURCHASE_REQUESTED",
      business_case: businessCase,
      device_id: deviceId,
      client_id: clientId,
      payload,
    });

    if (businessCase === "gas_station") {
      const {
        station_id: stationId = "station-777",
        fuel_type: fuelType = "GASOLINE",
        liters,
        max_price_per_liter_usd: maxPrice,
      } = payload || {};

      if (typeof liters !== "number" || liters <= 0) {
        return res.status(400).json({ ok: false, error: "Invalid liters" });
      }
      if (typeof maxPrice !== "number" || maxPrice <= 0) {
        return res.status(400).json({ ok: false, error: "Invalid max_price_per_liter_usd" });
      }

      // Demo pricing: slightly cheaper than max
      const pricePerLiterUsd = Math.max(0.5, clamp2(maxPrice - 0.05));
      const totalUsd = computeTotals(liters, pricePerLiterUsd);

      const inv = makeInvoiceBase({
        businessCase,
        deviceId,
        clientId,
        totalUsd,
        meta: { stationId, fuelType, liters, pricePerLiterUsd },
      });

      addTimelineEvent({
        type: "PAYMENT_REQUIRED",
        invoice_id: inv.invoiceId,
        business_case: businessCase,
        device_id: deviceId,
        client_id: clientId,
        total_usd: totalUsd,
      });

      return res.status(402).json({
        ok: false,
        error: "PAYMENT_REQUIRED",
        invoiceId: inv.invoiceId,
        payment_required: buildPaymentRequired(inv),
      });
    }

    if (businessCase === "vending_machine") {
      const { sku, quantity, max_unit_price_usd: maxUnit } = payload || {};

      if (!sku) return res.status(400).json({ ok: false, error: "Invalid sku" });

      const qty = Number(quantity ?? 1);
      if (!Number.isFinite(qty) || qty <= 0) return res.status(400).json({ ok: false, error: "Invalid quantity" });

      const max = Number(maxUnit);
      if (!Number.isFinite(max) || max <= 0) return res.status(400).json({ ok: false, error: "Invalid max_unit_price_usd" });

      const unitPriceUsd = Math.max(0.5, clamp2(max - 0.05));
      const totalUsd = clamp2(unitPriceUsd * qty);

      const inv = makeInvoiceBase({
        businessCase,
        deviceId,
        clientId,
        totalUsd,
        meta: { sku, quantity: qty, unitPriceUsd },
      });

      addTimelineEvent({
        type: "PAYMENT_REQUIRED",
        invoice_id: inv.invoiceId,
        business_case: businessCase,
        device_id: deviceId,
        client_id: clientId,
        total_usd: totalUsd,
      });

      return res.status(402).json({
        ok: false,
        error: "PAYMENT_REQUIRED",
        invoiceId: inv.invoiceId,
        payment_required: buildPaymentRequired(inv),
      });
    }

    if (businessCase === "laundry") {
      const { program, max_price_usd: maxPrice } = payload || {};
      if (!program) return res.status(400).json({ ok: false, error: "Invalid program" });

      const max = Number(maxPrice);
      if (!Number.isFinite(max) || max <= 0) return res.status(400).json({ ok: false, error: "Invalid max_price_usd" });

      const totalUsd = Math.max(1.0, clamp2(max - 0.1));

      const inv = makeInvoiceBase({
        businessCase,
        deviceId,
        clientId,
        totalUsd,
        meta: { program },
      });

      addTimelineEvent({
        type: "PAYMENT_REQUIRED",
        invoice_id: inv.invoiceId,
        business_case: businessCase,
        device_id: deviceId,
        client_id: clientId,
        total_usd: totalUsd,
      });

      return res.status(402).json({
        ok: false,
        error: "PAYMENT_REQUIRED",
        invoiceId: inv.invoiceId,
        payment_required: buildPaymentRequired(inv),
      });
    }

    return res.status(400).json({
      ok: false,
      error: "Unsupported business_case",
      supported: ["gas_station", "vending_machine", "laundry"],
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: "Internal error", detail: String(e) });
  }
});

// --------------------
// Backwards compatible endpoints
// --------------------

// POST /fuel/purchase (existing clients)
// Always returns 402 with vault payment instructions.
app.post("/fuel/purchase", async (req, res) => {
  const {
    car_id: carId = "car-001",
    station_id: stationId = "station-777",
    fuel_type: fuelType = "GASOLINE",
    liters,
    max_price_per_liter_usd: maxPrice,
  } = req.body || {};

  if (typeof liters !== "number" || liters <= 0) {
    return res.status(400).json({ ok: false, error: "Invalid liters" });
  }
  if (typeof maxPrice !== "number" || maxPrice <= 0) {
    return res.status(400).json({ ok: false, error: "Invalid max_price_per_liter_usd" });
  }

  const pricePerLiterUsd = Math.max(0.5, clamp2(maxPrice - 0.05));
  const totalUsd = computeTotals(liters, pricePerLiterUsd);

  const inv = makeInvoiceBase({
    businessCase: "gas_station",
    deviceId: stationId,
    clientId: carId,
    totalUsd,
    meta: { stationId, fuelType, liters, pricePerLiterUsd },
  });

  addTimelineEvent({
    type: "PURCHASE_REQUESTED",
    business_case: "gas_station",
    device_id: stationId,
    client_id: carId,
    payload: { fuel_type: fuelType, liters, max_price_per_liter_usd: maxPrice },
  });
  addTimelineEvent({
    type: "PAYMENT_REQUIRED",
    invoice_id: inv.invoiceId,
    business_case: "gas_station",
    device_id: stationId,
    client_id: carId,
    total_usd: totalUsd,
  });

  return res.status(402).json({
    ok: false,
    error: "PAYMENT_REQUIRED",
    invoiceId: inv.invoiceId,
    payment_required: buildPaymentRequired(inv),
  });
});

// vending purchase 
app.post("/vending/purchase", async (req, res) => {
  const clientId = req.body?.client_id ?? "client-001";
  const deviceId = req.body?.device_id ?? "vending-unknown";
  const payload = req.body?.payload ?? {};

  try {
    addTimelineEvent({
      type: "PURCHASE_REQUESTED",
      business_case: "vending_machine",
      device_id: deviceId,
      client_id: clientId,
      payload,
    });

    const { totalUsd, meta } = createInvoiceForPurchase({
      businessCase: "vending_machine",
      clientId,
      deviceId,
      payload,
    });

    const inv = makeInvoiceBase({
      businessCase: "vending_machine",
      deviceId,
      clientId,
      totalUsd,
      meta,
    });

    addTimelineEvent({
      type: "PAYMENT_REQUIRED",
      invoice_id: inv.invoiceId,
      business_case: "vending_machine",
      device_id: deviceId,
      client_id: clientId,
      total_usd: totalUsd,
    });

    return res.status(402).json({
      ok: false,
      error: "PAYMENT_REQUIRED",
      invoiceId: inv.invoiceId,
      payment_required: buildPaymentRequired(inv),
    });
  } catch (e) {
    return res.status(400).json({ ok: false, error: String(e?.message || e) });
  }
});

// laundry purchase 
app.post("/laundry/purchase", async (req, res) => {
  const clientId = req.body?.client_id ?? "client-001";
  const deviceId = req.body?.device_id ?? "laundry-unknown";
  const payload = req.body?.payload ?? {};

  try {
    addTimelineEvent({
      type: "PURCHASE_REQUESTED",
      business_case: "laundry",
      device_id: deviceId,
      client_id: clientId,
      payload,
    });

    const { totalUsd, meta } = createInvoiceForPurchase({
      businessCase: "laundry",
      clientId,
      deviceId,
      payload,
    });

    const inv = makeInvoiceBase({
      businessCase: "laundry",
      deviceId,
      clientId,
      totalUsd,
      meta,
    });

    addTimelineEvent({
      type: "PAYMENT_REQUIRED",
      invoice_id: inv.invoiceId,
      business_case: "laundry",
      device_id: deviceId,
      client_id: clientId,
      total_usd: totalUsd,
    });

    return res.status(402).json({
      ok: false,
      error: "PAYMENT_REQUIRED",
      invoiceId: inv.invoiceId,
      payment_required: buildPaymentRequired(inv),
    });
  } catch (e) {
    return res.status(400).json({ ok: false, error: String(e?.message || e) });
  }
});

// --------------------
// GET invoice debug (unified)
// --------------------
app.get("/m2m/invoice/:id", (req, res) => {
  const { id } = req.params;
  const inv = invoices[id];
  if (!inv) return res.status(404).json({ ok: false, error: "Invoice not found" });

  if (inv.status !== "PAID" && nowMs() > inv.expiresAt) inv.status = "EXPIRED";

  res.json({ ok: true, invoice: inv, payment_required: buildPaymentRequired(inv) });
});

// Keep old debug endpoint too
app.get("/fuel/invoice/:id", (req, res) => {
  const { id } = req.params;
  const inv = invoices[id];
  if (!inv) return res.status(404).json({ ok: false, error: "Invoice not found" });

  if (inv.status !== "PAID" && nowMs() > inv.expiresAt) inv.status = "EXPIRED";

  res.json({ ok: true, invoice: inv, payment_required: buildPaymentRequired(inv) });
});

// --------------------
// UI helpers
// --------------------
app.get("/ui/timeline", (req, res) => {
  const {
    limit = "50",
    invoiceId,
    clientId,
    businessCase,
    since,
  } = req.query || {};

  let items = [...timelineEvents];

  if (invoiceId) items = items.filter((e) => e.invoice_id === invoiceId);
  if (clientId) items = items.filter((e) => e.client_id === clientId);
  if (businessCase) items = items.filter((e) => e.business_case === businessCase);
  if (since) {
    const sinceMs = Date.parse(String(since));
    if (!Number.isNaN(sinceMs)) {
      items = items.filter((e) => Date.parse(e.ts) >= sinceMs);
    }
  }

  const lim = Math.max(1, Math.min(200, Number(limit) || 50));
  const rawItems = items.slice(0, lim);
  const uiItems = rawItems.map(toUiTimelineEvent);
  res.json({ ok: true, items: uiItems, raw_items: rawItems });
});

app.get("/ui/summary", (req, res) => {
  res.json({ ok: true, summary: summarizeInvoices() });
});

app.get("/ui/vault", async (req, res) => {
  try {
    const balance = await getVaultUsdcBalance();
    res.json({ ok: true, balance });
  } catch (e) {
    res.status(500).json({ ok: false, error: "Vault balance fetch failed", detail: String(e?.message || e) });
  }
});

app.post("/ui/timeline/clear", (req, res) => {
  timelineEvents.length = 0;
  res.json({ ok: true });
});

// --------------------
// Agent API
// --------------------
app.post("/agents/m2m/run", async (req, res) => {
  const { business_case: businessCase } = req.body || {};

  if (!businessCase || typeof businessCase !== "string") {
    return res.status(400).json({ ok: false, error: "Missing business_case" });
  }

  if (!ALLOWED_BUSINESS_CASES.has(businessCase)) {
    return res.status(400).json({
      ok: false,
      error: "Unsupported business_case",
      supported: Array.from(ALLOWED_BUSINESS_CASES),
    });
  }

  addTimelineEvent({
    type: "AGENT_RUN_REQUESTED",
    business_case: businessCase,
  });

  try {
    const result = await runM2MAgent(businessCase);
    const ok = result.code === 0;

    const parsedEvents = extractJsonObjectsFromText(result.stdout);
    const timelineItems = normalizeAgentEventsForTimeline(parsedEvents, result.stdout, businessCase);
    for (const item of timelineItems) {
      addTimelineEvent(item);
    }

    addTimelineEvent({
      type: ok ? "AGENT_RUN_COMPLETED" : "AGENT_RUN_FAILED",
      business_case: businessCase,
      exit_code: result.code,
    });

    return res.status(ok ? 200 : 500).json({
      ok,
      business_case: businessCase,
      exit_code: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
    });
  } catch (e) {
    addTimelineEvent({
      type: "AGENT_RUN_FAILED",
      business_case: businessCase,
      reason: String(e?.message || e),
    });
    return res.status(500).json({ ok: false, error: "Agent run failed", detail: String(e?.message || e) });
  }
});

// --------------------
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
