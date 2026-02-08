# Agents

**Purpose**
Python agents simulate utility devices and clients. They call the backend server to get invoices, execute on-chain `ExpenseVault.spend(...)`, and confirm payments.

**Key Files**
- `m2m_client.py`: unified client flow for gas, laundry, and vending.
- `car_agent.py`: gas station demo with retry logic and demo mode.
- `devices.json`: registry of device locations and metadata for demos.

**Configuration**
Set these in `backend/agents/.env`:
- `BASE_SEPOLIA_RPC_URL`
- `VAULT_ADDRESS`
- `OWNER_ADDRESS`
- `MERCHANT_ADDRESS`
- `SPENDER_ADDRESS`
- `SPENDER_PRIVATE_KEY`
- `SERVER_URL`
- `DEMO_MODE` (optional)

**Run**
```bash
cd backend/agents
# create a virtualenv, then install required deps
python m2m_client.py
```

**Notes**
- The spender wallet needs ETH on Base Sepolia for gas.
- Do not commit real private keys.
