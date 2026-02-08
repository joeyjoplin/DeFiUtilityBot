import asyncio
import json
import os
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Dict, Optional, Tuple

import aiohttp
from dotenv import load_dotenv
from web3 import Web3
from web3.exceptions import ContractLogicError

from agents import Agent, Runner

# -----------------------------
# Env / Config
# -----------------------------
load_dotenv()

STABLECOIN = "USDC"
USDC_DECIMALS = 6
CHAIN_ID_BASE_SEPOLIA = 84532

SERVER_URL = os.getenv("SERVER_URL", "http://localhost:3001")
BASE_SEPOLIA_RPC_URL = os.getenv("BASE_SEPOLIA_RPC_URL")
SPENDER_PRIVATE_KEY = os.getenv("SPENDER_PRIVATE_KEY")

# Demo mode: adapt liters to fit maxPerTx before calling /fuel/purchase
DEMO_MODE = os.getenv("DEMO_MODE", "0") == "1"

# Required when DEMO_MODE=1 (so we can read policy before purchase)
DEMO_VAULT_ADDRESS = os.getenv("VAULT_ADDRESS")      # same as server VAULT_ADDRESS
DEMO_OWNER_ADDRESS = os.getenv("OWNER_ADDRESS")      # same as server OWNER_ADDRESS

if not BASE_SEPOLIA_RPC_URL:
    raise SystemExit("Missing BASE_SEPOLIA_RPC_URL in .env")
if not SPENDER_PRIVATE_KEY:
    raise SystemExit("Missing SPENDER_PRIVATE_KEY in .env (spender needs ETH for gas)")

# -----------------------------
# Minimal ABIs
# -----------------------------
# ExpenseVault.spend(owner, merchant, amount)
VAULT_SPEND_ABI = [
    {
        "type": "function",
        "name": "spend",
        "stateMutability": "nonpayable",
        "inputs": [
            {"name": "owner", "type": "address"},
            {"name": "merchant", "type": "address"},
            {"name": "amount", "type": "uint256"},
        ],
        "outputs": [],
    }
]

# ExpenseVault.policyOf(owner, spender) -> (enabled, enforceMerchantWhitelist, maxPerTx, dailyLimit)
VAULT_POLICY_ABI = [
    {
        "type": "function",
        "name": "policyOf",
        "stateMutability": "view",
        "inputs": [
            {"name": "owner", "type": "address"},
            {"name": "spender", "type": "address"},
        ],
        "outputs": [
            {"name": "enabled", "type": "bool"},
            {"name": "enforceMerchantWhitelist", "type": "bool"},
            {"name": "maxPerTx", "type": "uint256"},
            {"name": "dailyLimit", "type": "uint256"},
        ],
    }
]

# -----------------------------
# Retry behavior when maxPerTx is exceeded (fallback)
# -----------------------------
MAX_RETRIES_EXCEEDS_MAXPERTX = 2   # additional attempts after the first
LITERS_REDUCTION_FACTOR = 0.5      # halve liters each retry


# -----------------------------
# Helpers
# -----------------------------
def must_be_json(label: str, s: str) -> dict:
    """Fail fast if an agent output isn't valid JSON."""
    try:
        return json.loads(s)
    except json.JSONDecodeError as e:
        raise SystemExit(f"{label} did not output valid JSON: {e}\nOutput was:\n{s}")


def now_iso_utc() -> str:
    return datetime.now(timezone.utc).isoformat()


async def http_post_json(url: str, payload: dict) -> Tuple[int, dict]:
    async with aiohttp.ClientSession() as session:
        async with session.post(url, json=payload) as resp:
            text = await resp.text()
            try:
                data = json.loads(text)
            except json.JSONDecodeError:
                data = {"raw": text}
            return resp.status, data


def build_web3() -> Web3:
    return Web3(Web3.HTTPProvider(BASE_SEPOLIA_RPC_URL))


def parse_revert_reason(err: Exception) -> str:
    msg = str(err)
    m = re.search(r"execution reverted: ([^']+)", msg)
    return m.group(1).strip() if m else "REVERTED"


def to_usdc_base_units(amount_usd_float: float) -> int:
    # USDC decimals = 6
    return int(round(amount_usd_float * (10 ** USDC_DECIMALS)))


def from_usdc_base_units(amount: int) -> float:
    return float(amount) / (10 ** USDC_DECIMALS)


@dataclass
class SpendResult:
    tx_hash: Optional[str]
    error: Optional[Dict[str, Any]]


def send_vault_spend_tx_safe(
    vault_address: str,
    owner: str,
    merchant: str,
    amount_base_units: int,
) -> SpendResult:
    """
    Sends ExpenseVault.spend(owner, merchant, amount) from the spender wallet.
    Returns SpendResult without raising.
    """
    w3 = build_web3()
    acct = w3.eth.account.from_key(SPENDER_PRIVATE_KEY)

    # Quick ETH balance check (gas)
    eth_bal = w3.eth.get_balance(acct.address)
    if eth_bal == 0:
        return SpendResult(
            tx_hash=None,
            error={
                "type": "INSUFFICIENT_GAS",
                "message": "Spender wallet has 0 ETH on Base Sepolia. Cannot pay gas for spend().",
                "spender_address": acct.address,
            },
        )

    try:
        vault = w3.eth.contract(
            address=Web3.to_checksum_address(vault_address),
            abi=VAULT_SPEND_ABI,
        )

        nonce = w3.eth.get_transaction_count(acct.address)

        tx = vault.functions.spend(
            Web3.to_checksum_address(owner),
            Web3.to_checksum_address(merchant),
            int(amount_base_units),
        ).build_transaction(
            {
                "from": acct.address,
                "nonce": nonce,
                "chainId": CHAIN_ID_BASE_SEPOLIA,
            }
        )

        # Estimate gas (may revert if the call would revert)
        gas_est = w3.eth.estimate_gas(tx)
        tx["gas"] = int(gas_est * 1.2)

        # EIP-1559 fees (simple defaults for testnet)
        latest = w3.eth.get_block("latest")
        base_fee = latest.get("baseFeePerGas", 0)

        max_priority = w3.to_wei(0.02, "gwei")
        max_fee = int(base_fee + w3.to_wei(0.2, "gwei"))

        tx["maxPriorityFeePerGas"] = max_priority
        tx["maxFeePerGas"] = max_fee

        signed = w3.eth.account.sign_transaction(tx, private_key=SPENDER_PRIVATE_KEY)

        # web3.py compatibility
        raw = getattr(signed, "rawTransaction", None) or getattr(signed, "raw_transaction")
        tx_hash_bytes = w3.eth.send_raw_transaction(raw)

        receipt = w3.eth.wait_for_transaction_receipt(tx_hash_bytes, timeout=180)
        if receipt.status != 1:
            return SpendResult(
                tx_hash=None,
                error={
                    "type": "TX_FAILED",
                    "message": "Transaction mined but failed (status != 1).",
                    "tx_hash": tx_hash_bytes.hex(),
                },
            )

        h = tx_hash_bytes.hex()
        if not h.startswith("0x"):
            h = "0x" + h
        return SpendResult(tx_hash=h, error=None)


    except ContractLogicError as e:
        reason = parse_revert_reason(e)
        return SpendResult(
            tx_hash=None,
            error={
                "type": "CONTRACT_REVERT",
                "reason": reason,
                "message": "Vault spend() reverted. Likely policy/limits/whitelist.",
                "vault_address": vault_address,
                "owner_address": owner,
                "merchant_address": merchant,
                "amount_base_units": str(amount_base_units),
            },
        )

    except Exception as e:
        return SpendResult(
            tx_hash=None,
            error={"type": "TX_ERROR", "message": str(e)},
        )


def make_payment_failed_event(invoice_id: str, err: Dict[str, Any]) -> Dict[str, Any]:
    suggestions = [
        "Ensure spender wallet has ETH on Base Sepolia for gas.",
        "Ensure policy is enabled and merchant is whitelisted.",
        "Ensure amount fits within maxPerTx and dailyLimit.",
    ]
    if err.get("type") == "CONTRACT_REVERT" and err.get("reason") == "exceeds maxPerTx":
        suggestions.insert(0, "Reduce liters to fit maxPerTx, or increase maxPerTx policy.")

    return {
        "event": "PAYMENT_FAILED",
        "invoiceId": invoice_id,
        "error": err,
        "suggested_actions": suggestions,
    }


# -----------------------------
# Demo Mode: read policy and cap liters BEFORE purchase
# -----------------------------
def read_policy_max_per_tx(vault_address: str, owner: str, spender: str) -> Dict[str, Any]:
    """
    Reads policyOf(owner, spender) from the Vault.
    Returns dict with enabled/maxPerTx/dailyLimit.
    """
    w3 = build_web3()
    vault = w3.eth.contract(
        address=Web3.to_checksum_address(vault_address),
        abi=VAULT_POLICY_ABI,
    )

    enabled, enforce_whitelist, max_per_tx, daily_limit = vault.functions.policyOf(
        Web3.to_checksum_address(owner),
        Web3.to_checksum_address(spender),
    ).call()

    return {
        "enabled": bool(enabled),
        "enforceMerchantWhitelist": bool(enforce_whitelist),
        "maxPerTx": int(max_per_tx),
        "dailyLimit": int(daily_limit),
    }


def cap_liters_to_fit_max_per_tx(
    liters: float,
    max_price_per_liter_usd: float,
    max_per_tx_base_units: int,
) -> float:
    """
    Conservative cap: ensure liters * max_price_per_liter_usd <= maxPerTx.
    We use worst-case price = max_price_per_liter_usd (server may quote <= this).
    """
    if max_price_per_liter_usd <= 0:
        return max(1.0, liters)

    max_total_usd = from_usdc_base_units(max_per_tx_base_units)
    max_liters = max_total_usd / float(max_price_per_liter_usd)

    # Keep at least 1 liter, and round to 2 decimals for nicer payloads
    capped = max(1.0, round(min(liters, max_liters), 2))
    return capped


# -----------------------------
# Server flow helpers
# -----------------------------
async def request_purchase_from_server(
    car_id: str,
    fuel_type: str,
    liters: float,
    max_price_per_liter_usd: float,
) -> Tuple[int, dict]:
    payload = {
        "car_id": car_id,
        "fuel_type": fuel_type,
        "liters": float(liters),
        "max_price_per_liter_usd": float(max_price_per_liter_usd),
    }
    return await http_post_json(f"{SERVER_URL}/fuel/purchase", payload)


def extract_vault_payment_required(purchase_resp: dict) -> Tuple[str, dict]:
    invoice_id = purchase_resp.get("invoiceId")
    pr = purchase_resp.get("payment_required") or {}

    required = ["vault_address", "owner_address", "merchant_address", "amount_base_units", "token", "decimals"]
    missing = [k for k in required if pr.get(k) is None]
    if not invoice_id or missing:
        raise SystemExit(f"Server 402 missing required fields: invoiceId={invoice_id}, missing={missing}")

    if pr.get("token") != STABLECOIN:
        raise SystemExit(f"Payment token mismatch: expected {STABLECOIN}, got {pr.get('token')}")
    if int(pr.get("decimals")) != USDC_DECIMALS:
        raise SystemExit(f"Decimals mismatch: expected {USDC_DECIMALS}, got {pr.get('decimals')}")

    return invoice_id, pr


async def confirm_with_server(invoice_id: str, tx_hash: str) -> Tuple[int, dict]:
    payload = {"invoiceId": invoice_id, "txHash": tx_hash}
    return await http_post_json(f"{SERVER_URL}/fuel/confirm", payload)


# -----------------------------
# Main demo flow
# -----------------------------
async def main():
    # Agent 1: Car Sensors
    sensors_agent = Agent(
        name="Car Sensors Agent",
        instructions=(
            "You simulate car sensors. Output VALID JSON only. No markdown.\n\n"
            "Output exactly the event:\n\n"
            "{\n"
            '  "event": "FUEL_LOW_DETECTED",\n'
            '  "car_id": "car-001",\n'
            '  "timestamp": "ISO-8601 string",\n'
            '  "location": {"lat": number, "lon": number},\n'
            '  "odometer_km": number,\n'
            '  "fuel_level_percent": number,\n'
            '  "range_km_estimate": number,\n'
            '  "severity": "LOW" | "MEDIUM" | "HIGH"\n'
            "}\n\n"
            "Rules:\n"
            "- Use realistic values.\n"
            "- Severity thresholds: LOW if > 25; MEDIUM if 10-25; HIGH if < 10.\n"
            "- location should look like a real coordinate (e.g., Sao Paulo area).\n"
            "- timestamp must be ISO-8601.\n"
            "- Keep it simple."
        ),
    )

    # Agent 2: Car Trader (policy-based)
    trader_agent = Agent(
        name="Car Trader Agent",
        instructions=(
            "You are a car trading agent. You receive a sensor JSON event.\n"
            "Output VALID JSON only. No markdown.\n\n"
            "If event is FUEL_OK: output:\n"
            '{ "event": "NO_ACTION", "car_id": "car-001", "reason": "Fuel level OK" }\n\n'
            "If event is FUEL_LOW_DETECTED: create a fuel purchase request as VALID JSON only.\n\n"
            "Fuel request schema:\n"
            "{\n"
            '  "event": "FUEL_REQUEST",\n'
            '  "car_id": "string",\n'
            '  "timestamp": "ISO-8601 string",\n'
            '  "location": {"lat": number, "lon": number},\n'
            '  "fuel_type": "GASOLINE" | "ETHANOL" | "DIESEL",\n'
            '  "liters": number,\n'
            '  "max_price_per_liter_usd": number,\n'
            f'  "payment_token": "{STABLECOIN}",\n'
            '  "delivery_deadline_minutes": number,\n'
            '  "policy": {\n'
            '    "severity": "LOW" | "MEDIUM" | "HIGH",\n'
            '    "priority": "CHEAPEST" | "BALANCED" | "FASTEST"\n'
            "  },\n"
            '  "reason": "string"\n'
            "}\n\n"
            "Policy rules (MUST follow):\n"
            "- Stablecoin only (payment_token fixed).\n"
            "- If severity HIGH:\n"
            "  liters: 35-45, max_price_per_liter_usd: 2.2-2.8, deadline: 10-15, priority: FASTEST.\n"
            "- If severity MEDIUM:\n"
            "  liters: 20-30, max_price_per_liter_usd: 1.8-2.4, deadline: 15-25, priority: BALANCED.\n"
            "- If severity LOW:\n"
            "  liters: 10-20, max_price_per_liter_usd: 1.4-2.0, deadline: 25-40, priority: CHEAPEST.\n"
            "- Use the incoming timestamp/location from sensors in the request.\n"
            "- reason must mention the severity and the chosen priority.\n\n"
            "Hard constraints:\n"
            "- NEVER output max_price_per_liter_usd below 1.0.\n"
        ),
    )

    # ----------------------
    # Step 1: Sensors checks
    # ----------------------
    sensors_input = f"check sensors now; timestamp={now_iso_utc()}"
    sensors_out = await Runner.run(sensors_agent, sensors_input)
    sensors_json = sensors_out.final_output
    print("\n--- Sensors -> Trader (event) ---")
    print(sensors_json)
    sensors_event = must_be_json("Sensors Agent", sensors_json)

    # ----------------------
    # Step 2: Trader decides
    # ----------------------
    trader_in = json.dumps(sensors_event, ensure_ascii=False)
    trader_out = await Runner.run(trader_agent, trader_in)
    trader_json = trader_out.final_output
    print("\n--- Trader -> Server (request or no action) ---")
    print(trader_json)
    trader_event = must_be_json("Trader Agent", trader_json)

    if trader_event.get("event") == "NO_ACTION":
        print("\n✅ No action needed (fuel OK).")
        return

    # Extract trader request
    car_id = trader_event["car_id"]
    fuel_type = trader_event["fuel_type"]
    max_price = float(trader_event["max_price_per_liter_usd"])
    liters_original = float(trader_event["liters"])

    liters_attempt = liters_original

    # ----------------------
    # DEMO MODE: adjust liters using on-chain policy before calling server
    # ----------------------
    if DEMO_MODE:
        if not DEMO_VAULT_ADDRESS or not DEMO_OWNER_ADDRESS:
            raise SystemExit("DEMO_MODE=1 requires VAULT_ADDRESS and OWNER_ADDRESS in agents .env")

        w3 = build_web3()
        spender_addr = w3.eth.account.from_key(SPENDER_PRIVATE_KEY).address

        policy = read_policy_max_per_tx(DEMO_VAULT_ADDRESS, DEMO_OWNER_ADDRESS, spender_addr)

        print("\n--- DEMO MODE: policyOf(owner, spender) ---")
        print(json.dumps(
            {
                "enabled": policy["enabled"],
                "maxPerTx_base_units": str(policy["maxPerTx"]),
                "maxPerTx_usdc": from_usdc_base_units(policy["maxPerTx"]),
                "dailyLimit_base_units": str(policy["dailyLimit"]),
                "dailyLimit_usdc": from_usdc_base_units(policy["dailyLimit"]),
            },
            indent=2,
        ))

        if not policy["enabled"]:
            print("\n❌ POLICY_DISABLED (agent continues)")
            print(json.dumps(
                {
                    "event": "PAYMENT_BLOCKED",
                    "reason": "Policy is disabled for this spender.",
                    "suggested_actions": ["Run Foundry setup to setPolicy(spender, enabled=true, ...)"],
                },
                indent=2,
            ))
            return

        liters_capped = cap_liters_to_fit_max_per_tx(
            liters=liters_attempt,
            max_price_per_liter_usd=max_price,
            max_per_tx_base_units=policy["maxPerTx"],
        )

        if liters_capped < liters_attempt:
            print(f"\n✅ DEMO MODE: capping liters to fit maxPerTx: {liters_attempt} -> {liters_capped}")
            liters_attempt = liters_capped

    # ----------------------
    # Step 3+: purchase -> spend -> confirm
    # (fallback retry still exists if server price causes exceed)
    # ----------------------
    attempts = 0
    max_attempts = 1 + MAX_RETRIES_EXCEEDS_MAXPERTX

    while attempts < max_attempts:
        attempts += 1

        print(f"\n--- Attempt {attempts}/{max_attempts}: /fuel/purchase (liters={liters_attempt}) ---")
        status, purchase_resp = await request_purchase_from_server(
            car_id=car_id,
            fuel_type=fuel_type,
            liters=liters_attempt,
            max_price_per_liter_usd=max_price,
        )

        print("HTTP", status)
        print(json.dumps(purchase_resp, indent=2))

        if status != 402:
            print("\n❌ Unexpected server response (agent continues)")
            print(json.dumps(
                {
                    "event": "SERVER_ERROR",
                    "message": f"Expected 402 PAYMENT_REQUIRED, got HTTP {status}",
                    "response": purchase_resp,
                },
                indent=2,
            ))
            return

        invoice_id, pr = extract_vault_payment_required(purchase_resp)

        vault_address = pr["vault_address"]
        owner_address = pr["owner_address"]
        merchant_address = pr["merchant_address"]
        amount_base_units = int(pr["amount_base_units"])

        print("\n--- On-chain: calling vault.spend(...) ---")
        spend_res = send_vault_spend_tx_safe(
            vault_address=vault_address,
            owner=owner_address,
            merchant=merchant_address,
            amount_base_units=amount_base_units,
        )

        if spend_res.error:
            print("\n❌ PAYMENT_FAILED (agent continues)")
            print(json.dumps(make_payment_failed_event(invoice_id, spend_res.error), indent=2))

            # Retry only if this specific policy error happens
            if spend_res.error.get("type") == "CONTRACT_REVERT" and spend_res.error.get("reason") == "exceeds maxPerTx":
                if attempts < max_attempts:
                    liters_attempt = max(1.0, round(liters_attempt * LITERS_REDUCTION_FACTOR, 2))
                    print(f"\n↩️ Retrying due to exceeds maxPerTx. New liters={liters_attempt}")
                    continue

            return

        tx_hash = spend_res.tx_hash
        print("✅ spend() tx hash:", tx_hash)

        c_status, c_resp = await confirm_with_server(invoice_id, tx_hash)

        print("\n--- Server /fuel/confirm response ---")
        print("HTTP", c_status)
        print(json.dumps(c_resp, indent=2))

        if c_status != 200:
            print("\n❌ CONFIRM_FAILED (agent continues)")
            print(json.dumps(
                {
                    "event": "CONFIRM_FAILED",
                    "invoiceId": invoice_id,
                    "txHash": tx_hash,
                    "server_response": c_resp,
                },
                indent=2,
            ))
            return

        print("\n✅ Flow complete: server 402 → vault spend → server confirm → pump unlocked (simulated).")
        return

    print("\n❌ All attempts exhausted (agent continues)")
    print(json.dumps(
        {
            "event": "PAYMENT_ABORTED",
            "reason": "Exceeded retry limit for policy constraints.",
            "attempts": attempts,
        },
        indent=2,
    ))


if __name__ == "__main__":
    asyncio.run(main())

