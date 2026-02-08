import asyncio
import json
import math
import os
import sys
from datetime import datetime, timezone
from typing import Any, Dict, Tuple, Optional

import aiohttp
from dotenv import load_dotenv
from web3 import Web3
from web3.exceptions import ContractLogicError

from agents import Agent, Runner

load_dotenv()

# ---- Config ----
STABLECOIN = "USDC"
USDC_DECIMALS = 6
CHAIN_ID_BASE_SEPOLIA = 84532

SERVER_URL = os.getenv("SERVER_URL", "http://localhost:3001")
BASE_SEPOLIA_RPC_URL = os.getenv("BASE_SEPOLIA_RPC_URL")
SPENDER_PRIVATE_KEY = os.getenv("SPENDER_PRIVATE_KEY")

if not BASE_SEPOLIA_RPC_URL:
    raise SystemExit("Missing BASE_SEPOLIA_RPC_URL in .env")
if not SPENDER_PRIVATE_KEY:
    raise SystemExit("Missing SPENDER_PRIVATE_KEY in .env")

# For demo, we keep a stable "UI location" (Sao Paulo area).
DEFAULT_LOCATION = {"lat": -23.5505, "lon": -46.6333}

# ---- Minimal ABI ----
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


def now_iso_utc() -> str:
    return datetime.now(timezone.utc).isoformat()


def must_be_json(label: str, s: str) -> dict:
    try:
        return json.loads(s)
    except json.JSONDecodeError as e:
        raise SystemExit(f"{label} did not output valid JSON: {e}\nOutput was:\n{s}")


def load_devices(path: str = "devices.json") -> Dict[str, Any]:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def haversine_m(lat1, lon1, lat2, lon2) -> float:
    """Compute distance in meters between two lat/lon points."""
    R = 6371000
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


def pick_nearest_device(devices: list, client_loc: dict) -> Tuple[dict, int]:
    best = None
    best_d = 10**18
    for d in devices:
        dist = haversine_m(client_loc["lat"], client_loc["lon"], d["location"]["lat"], d["location"]["lon"])
        if dist < best_d:
            best = d
            best_d = dist
    return best, int(best_d)


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


def normalize_txhash(h: str) -> str:
    h = (h or "").strip()
    if not h.startswith("0x"):
        h = "0x" + h
    return h


def send_vault_spend_tx(
    vault_address: str,
    owner_address: str,
    merchant_address: str,
    amount_base_units: int,
) -> Tuple[Optional[str], Optional[dict]]:
    """
    Sends ExpenseVault.spend(owner, merchant, amount) from SPENDER_PRIVATE_KEY.
    Returns (tx_hash, error_json). Never raises.
    """
    w3 = build_web3()
    acct = w3.eth.account.from_key(SPENDER_PRIVATE_KEY)

    # Gas check
    eth_bal = w3.eth.get_balance(acct.address)
    if eth_bal == 0:
        return None, {
            "type": "INSUFFICIENT_GAS",
            "message": "Spender wallet has 0 ETH on Base Sepolia. Cannot pay gas for spend().",
            "spender_address": acct.address,
        }

    try:
        vault = w3.eth.contract(address=Web3.to_checksum_address(vault_address), abi=VAULT_SPEND_ABI)
        nonce = w3.eth.get_transaction_count(acct.address)

        tx = vault.functions.spend(
            Web3.to_checksum_address(owner_address),
            Web3.to_checksum_address(merchant_address),
            int(amount_base_units),
        ).build_transaction(
            {
                "from": acct.address,
                "nonce": nonce,
                "chainId": CHAIN_ID_BASE_SEPOLIA,
            }
        )

        # Estimate gas (can revert)
        gas_est = w3.eth.estimate_gas(tx)
        tx["gas"] = int(gas_est * 1.2)

        # EIP-1559 fees (simple defaults)
        latest = w3.eth.get_block("latest")
        base_fee = latest.get("baseFeePerGas", 0)

        max_priority = w3.to_wei(0.02, "gwei")
        max_fee = int(base_fee + w3.to_wei(0.2, "gwei"))
        tx["maxPriorityFeePerGas"] = max_priority
        tx["maxFeePerGas"] = max_fee

        signed = w3.eth.account.sign_transaction(tx, private_key=SPENDER_PRIVATE_KEY)

        raw = getattr(signed, "rawTransaction", None) or getattr(signed, "raw_transaction")
        tx_hash_bytes = w3.eth.send_raw_transaction(raw)

        receipt = w3.eth.wait_for_transaction_receipt(tx_hash_bytes, timeout=180)
        if receipt.status != 1:
            return None, {"type": "TX_FAILED", "message": "Transaction mined but failed (status != 1)."}

        h = tx_hash_bytes.hex()
        h = normalize_txhash(h)
        return h, None

    except ContractLogicError as e:
        msg = str(e)
        reason = "REVERTED"
        if "execution reverted:" in msg:
            reason = msg.split("execution reverted:")[1].split("'")[0].strip()
        return None, {
            "type": "CONTRACT_REVERT",
            "reason": reason,
            "message": "Vault spend() reverted.",
            "vault_address": vault_address,
            "owner_address": owner_address,
            "merchant_address": merchant_address,
            "amount_base_units": str(amount_base_units),
        }

    except Exception as e:
        return None, {"type": "TX_ERROR", "message": str(e)}


def extract_payment_required(resp: dict) -> Tuple[str, dict]:
    invoice_id = resp.get("invoiceId")
    pr = resp.get("payment_required") or {}
    if not invoice_id:
        raise SystemExit("Missing invoiceId in 402 response")
    required = ["vault_address", "owner_address", "merchant_address", "amount_base_units"]
    missing = [k for k in required if pr.get(k) is None]
    if missing:
        raise SystemExit(f"Missing fields in payment_required: {missing}")
    return invoice_id, pr


async def main():
    if len(sys.argv) < 2:
        raise SystemExit("Usage: python3 m2m_client.py gas_station|vending_machine|laundry")

    business_case = sys.argv[1].strip()
    if business_case not in ("gas_station", "vending_machine", "laundry"):
        raise SystemExit("business_case must be one of: gas_station, vending_machine, laundry")

    devices_db = load_devices("devices.json")
    client_location = DEFAULT_LOCATION

    # -----------------------------
    # Agent A: UI Request Builder
    # -----------------------------
    request_builder = Agent(
        name="M2M Request Builder Agent",
        instructions=(
            "You are a request builder for a machine-to-machine payment demo.\n"
            "Output VALID JSON only. No markdown.\n\n"
            "Input will include business_case and a location.\n"
            "You MUST output exactly this schema:\n"
            "{\n"
            '  "event": "USER_SELECTED_SERVICE",\n'
            '  "business_case": "gas_station" | "vending_machine" | "laundry",\n'
            '  "client_id": "client-001",\n'
            '  "timestamp": "ISO-8601 string",\n'
            '  "location": {"lat": number, "lon": number},\n'
            '  "preferences": {"priority": "CHEAPEST" | "BALANCED" | "FASTEST"},\n'
            '  "payment_token": "USDC",\n'
            '  "request": { ... }\n'
            "}\n\n"
            "Rules:\n"
            "- payment_token MUST be USDC.\n"
            "- business_case MUST match input.\n"
            "- Use realistic values.\n"
            "- For gas_station request:\n"
            '  {"fuel_type":"GASOLINE","liters":10-40,"max_price_per_liter_usd":2.2-2.8}\n'
            "- For vending_machine request:\n"
            '  {"sku":"WATER_500ML"|"SODA_350ML"|"CHIPS_45G","quantity":1-2,"max_unit_price_usd":1.5-3.0}\n'
            "- For laundry request:\n"
            '  {"program":"WASH_30"|"WASH_45"|"WASH_60","max_price_usd":4.0-9.0}\n'
            "- priority suggestion:\n"
            "  gas_station: FASTEST, vending_machine: CHEAPEST, laundry: BALANCED.\n"
        ),
    )

    ui_in = json.dumps(
        {"business_case": business_case, "location": client_location, "timestamp": now_iso_utc()},
        ensure_ascii=False,
    )
    ui_out = await Runner.run(request_builder, ui_in)
    ui_event = must_be_json("Request Builder Agent", ui_out.final_output)

    print("\n--- UI -> Client Bot (USER_SELECTED_SERVICE) ---")
    print(json.dumps(ui_event, indent=2))

    # -----------------------------
    # Discovery (deterministic)
    # -----------------------------
    candidates = devices_db[business_case]
    device, dist_m = pick_nearest_device(candidates, ui_event["location"])

    selected = {
        "event": "DEVICE_SELECTED",
        "business_case": business_case,
        "device": {
            "device_id": device["device_id"],
            "type": device["type"],
            "name": device.get("name", device["device_id"]),
            "location": device["location"],
        },
        "distance_meters": dist_m,
    }

    print("\n--- Discovery -> Client Bot (DEVICE_SELECTED) ---")
    print(json.dumps(selected, indent=2))

    # -----------------------------
    # Agent B: Negotiation/Quote Request Builder
    # -----------------------------
    negotiator = Agent(
        name="M2M Negotiation Agent",
        instructions=(
            "You are a negotiation agent for a machine-to-machine payment demo.\n"
            "You receive USER_SELECTED_SERVICE and DEVICE_SELECTED JSON.\n"
            "Output VALID JSON only. No markdown.\n\n"
            "You MUST output exactly this schema:\n"
            "{\n"
            '  "event": "QUOTE_REQUEST",\n'
            '  "business_case": "gas_station" | "vending_machine" | "laundry",\n'
            '  "device_id": "string",\n'
            '  "client_id": "client-001",\n'
            '  "timestamp": "ISO-8601 string",\n'
            '  "payment_token": "USDC",\n'
            '  "policy": {"priority": "CHEAPEST" | "BALANCED" | "FASTEST"},\n'
            '  "payload": { ... }\n'
            "}\n\n"
            "Rules:\n"
            "- payment_token MUST be USDC.\n"
            "- device_id MUST come from DEVICE_SELECTED.\n"
            "- business_case MUST match input.\n"
            "- payload MUST be:\n"
            "  gas_station: {fuel_type, liters, max_price_per_liter_usd}\n"
            "  vending_machine: {sku, quantity, max_unit_price_usd}\n"
            "  laundry: {program, max_price_usd}\n"
        ),
    )

    neg_in = json.dumps({"ui": ui_event, "selected": selected}, ensure_ascii=False)
    neg_out = await Runner.run(negotiator, neg_in)
    quote_req = must_be_json("Negotiation Agent", neg_out.final_output)

    print("\n--- Client Bot -> Server (QUOTE_REQUEST) ---")
    print(json.dumps(quote_req, indent=2))

    # -----------------------------
    # Purchase (Server) -> 402
    # -----------------------------
    client_id = quote_req["client_id"]
    device_id = quote_req["device_id"]
    payload = quote_req["payload"]

    if business_case == "gas_station":
        # Keep backwards compatibility with existing endpoint
        purchase_payload = {
            "car_id": client_id,  # reuse client_id as car_id
            "fuel_type": payload["fuel_type"],
            "liters": float(payload["liters"]),
            "max_price_per_liter_usd": float(payload["max_price_per_liter_usd"]),
        }
        status, resp = await http_post_json(f"{SERVER_URL}/fuel/purchase", purchase_payload)
    elif business_case == "vending_machine":
        status, resp = await http_post_json(
            f"{SERVER_URL}/vending/purchase",
            {"client_id": client_id, "device_id": device_id, "payload": payload},
        )
    else:  # laundry
        status, resp = await http_post_json(
            f"{SERVER_URL}/laundry/purchase",
            {"client_id": client_id, "device_id": device_id, "payload": payload},
        )

    print("\n--- Server purchase response ---")
    print("HTTP", status)
    print(json.dumps(resp, indent=2))

    if status != 402:
        raise SystemExit(f"Expected HTTP 402 from server purchase, got HTTP {status}")

    invoice_id, pr = extract_payment_required(resp)

    # -----------------------------
    # On-chain payment: vault.spend(...)
    # -----------------------------
    print("\n--- On-chain: calling vault.spend(...) ---")
    tx_hash, err = send_vault_spend_tx(
        vault_address=pr["vault_address"],
        owner_address=pr["owner_address"],
        merchant_address=pr["merchant_address"],
        amount_base_units=int(pr["amount_base_units"]),
    )

    if err:
        print("\n❌ PAYMENT_FAILED (agent continues)")
        print(json.dumps({"event": "PAYMENT_FAILED", "invoiceId": invoice_id, "error": err}, indent=2))
        return

    print("✅ spend() tx hash:", tx_hash)

    
    # -----------------------------
    # Confirm with server (retry)
    # -----------------------------
    print("\n--- Confirming with server /m2m/confirm ---")

    max_attempts = 6
    for attempt in range(1, max_attempts + 1):
        confirm_status, confirm_resp = await http_post_json(
            f"{SERVER_URL}/m2m/confirm",
            {"invoiceId": invoice_id, "txHash": tx_hash},
        )

        print(f"\n--- Server /m2m/confirm response (attempt {attempt}/{max_attempts}) ---")
        print("HTTP", confirm_status)
        print(json.dumps(confirm_resp, indent=2))

        if confirm_status == 200:
            print("\n✅ END-TO-END SUCCESS ✅")
            return

        # If not verified yet, wait and retry
        if confirm_status == 402 and confirm_resp.get("error") in ("PAYMENT_NOT_VERIFIED_YET", "PAYMENT_REQUIRED"):
            await asyncio.sleep(2)
            continue

        # Any other error: stop retrying but don't crash
        print("\n❌ CONFIRM_FAILED (agent continues)")
        return

    print("\n❌ CONFIRM_TIMEOUT (agent continues)")



if __name__ == "__main__":
    asyncio.run(main())
