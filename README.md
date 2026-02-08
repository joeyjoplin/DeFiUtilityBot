# DeFi Utility Bots

**Overview**
DeFi Utility Bots is a machine-to-machine payments demo where users deposit USDC into an on-chain ExpenseVault. Utility agents pay merchants on-chain for services like gas pumps, laundry, and vending machines. Idle funds can be allocated to a liquidity pool strategy to earn yield until they are needed for spend.

**Business Case**
- Users pre-fund a vault for recurring utility expenses.
- Utility agents execute on-chain payments on behalf of users under spend policies.
- Vault idle balances can earn yield through a strategy, improving capital efficiency.

**Architecture**
- Smart contracts implement the ExpenseVault, spend policies, and a plug-in strategy that invests idle funds.
- Backend server issues invoices and verifies on-chain spend events before unlocking services.
- Python agents simulate device clients and submit `ExpenseVault.spend(...)` transactions.
- Frontend provides a user interface for deposits, policies, and demo flows.

**Repo Layout**
- `backend/smartcontract`: Foundry project with ExpenseVault and strategies.
- `backend/server`: Express API for invoices and on-chain verification.
- `backend/agents`: Python agents and device registry.
- `frontend`: Next.js UI.

**SmartContracts Address**

##### base-sepolia

Vault Contract Address: 0xcD0929E149EACfF1a1b3C4cd9dd08B4e17b6D2c1 </br>
SimulatedLiquidityPool contract address: 0x01Aad94D3071EC8c26dEF854f92aaD46DF5cf52A </br>
LiquidityPoolStrategy contract address: 0x25cDE49d19ca3BD2703E176c6e364a10be250fC8


**Quickstart**
Smart contracts:
```bash
cd backend/smartcontract
forge build
forge test
```

Server:
```bash
cd backend/server
npm install
npm run dev
```
Server runs on `http://localhost:3001` by default.

Agents:
```bash
cd backend/agents
# create a virtualenv, then install required deps
python m2m_client.py
```
Configure `backend/agents/.env` with RPC URL, vault address, spender key, and server URL before running.

Frontend:
```bash
cd frontend
npm install
npm run dev
```
UI runs on `http://localhost:3000` by default.

**Notes**
- `.env` files contain secrets. Do not commit real keys.
- The default configuration targets Base Sepolia for demo purposes.
