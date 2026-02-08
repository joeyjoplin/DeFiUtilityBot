// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Script.sol";

import "../src/ExpenseVault.sol";
import "../src/SimulatedLiquidityPool.sol";
import "../src/LiquidityPoolStrategy.sol";

contract DeployAndSetup is Script {
    // Base Sepolia USDC (faucet token)
    address constant BASE_SEPOLIA_USDC = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;

    function run() external {
        /**
         * ENV required:
         * - DEPLOYER_PRIVATE_KEY : broadcasts txs (this address becomes vault.admin)
         *
         * ENV optional:
         * - TOKEN_ADDRESS        : defaults to Base Sepolia USDC
         * - ANNUAL_RATE_BPS      : defaults to 500 (5% APR simulated; only used by accrueInterest)
         *
         * Roles / demo addresses:
         * - OWNER_PRIVATE_KEY    : used to sign EIP-712 permits (can be same as deployer)
         * - OWNER_ADDRESS        : optional check that OWNER_PRIVATE_KEY matches expected owner
         * - SPENDER_ADDRESS      : spender (agent) address (defaults to deployer)
         * - MERCHANT_ADDRESS     : merchant address (defaults to deployer)
         *
         * Policy config (USDC = 6 decimals):
         * - MAX_PER_TX           : defaults to 10e6 (10 USDC)
         * - DAILY_LIMIT          : defaults to 50e6 (50 USDC)
         * - WHITELIST            : defaults to true
         *
         * Setup actions:
         * - DO_DEPOSIT           : true/false (default true)
         * - DEPOSIT_AMOUNT       : defaults to 50e6 (50 USDC)
         *
         * - DO_SET_STRATEGY      : true/false (default true)
         *
         * - DO_INVEST            : true/false (default true)
         * - INVEST_AMOUNT        : defaults to 30e6 (30 USDC)
         *
         * - DO_PERMITS           : true/false (default true)
         *
         * Yield reserve + instant accrual (recommended for demo):
         * - DO_FUND_YIELD         : true/false (default false)
         * - YIELD_FUND_AMOUNT     : defaults to 10e6 (10 USDC)
         *
         * - DO_ACCRUE_FROM_RESERVE: true/false (default true)
         * - ACCRUE_AMOUNT         : defaults to YIELD_FUND_AMOUNT (apply this much reserve as yield immediately)
         *
         * NOTE:
         * - accrueFromReserve requires pool.totalShares > 0 (i.e., strategy deposited into pool).
         *   So order is: deposit -> invest -> fundYield -> accrueFromReserve.
         */

        // --- Deployer/admin ---
        uint256 deployerPk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer = vm.addr(deployerPk);

        // --- Token and pool params ---
        address tokenAddr = vm.envOr("TOKEN_ADDRESS", BASE_SEPOLIA_USDC);
        uint256 annualRateBps = vm.envOr("ANNUAL_RATE_BPS", uint256(500));

        // --- Demo addresses ---
        address spender = vm.envOr("SPENDER_ADDRESS", deployer);
        address merchant = vm.envOr("MERCHANT_ADDRESS", deployer);

        // --- Policy values (USDC 6 decimals) ---
        uint256 maxPerTx = vm.envOr("MAX_PER_TX", uint256(10e6));
        uint256 dailyLimit = vm.envOr("DAILY_LIMIT", uint256(50e6));
        bool whitelist = vm.envOr("WHITELIST", true);

        // --- Setup toggles ---
        bool doDeposit = vm.envOr("DO_DEPOSIT", true);
        uint256 depositAmount = vm.envOr("DEPOSIT_AMOUNT", uint256(50e6));

        bool doSetStrategy = vm.envOr("DO_SET_STRATEGY", true);

        bool doInvest = vm.envOr("DO_INVEST", true);
        uint256 investAmount = vm.envOr("INVEST_AMOUNT", uint256(30e6));

        bool doPermits = vm.envOr("DO_PERMITS", true);
        uint256 ownerPk = vm.envOr("OWNER_PRIVATE_KEY", uint256(0));
        address owner = ownerPk == 0 ? address(0) : vm.addr(ownerPk);

        address expectedOwner = vm.envOr("OWNER_ADDRESS", address(0));
        if (expectedOwner != address(0)) {
            require(ownerPk != 0, "OWNER_PRIVATE_KEY required when OWNER_ADDRESS is set");
            require(owner == expectedOwner, "OWNER_PRIVATE_KEY does not match OWNER_ADDRESS");
        }

        // If no explicit owner provided, default to deployer (best for demos)
        if (owner == address(0)) {
            owner = deployer;
        }

        // Yield reserve and instant accrual
        bool doFundYield = vm.envOr("DO_FUND_YIELD", false);
        uint256 yieldFundAmount = vm.envOr("YIELD_FUND_AMOUNT", uint256(10e6));

        bool doAccrueFromReserve = vm.envOr("DO_ACCRUE_FROM_RESERVE", true);
        uint256 accrueAmount = vm.envOr("ACCRUE_AMOUNT", yieldFundAmount);

        uint256 deadline = block.timestamp + 7 days;

        // --- Broadcast as deployer/admin ---
        vm.startBroadcast(deployerPk);

        // 1) Deploy Vault (admin = deployer)
        ExpenseVault vault = new ExpenseVault(tokenAddr);

        // 2) Deploy pool
        SimulatedLiquidityPool pool = new SimulatedLiquidityPool(tokenAddr, annualRateBps);

        // 3) Deploy strategy
        LiquidityPoolStrategy strategy = new LiquidityPoolStrategy(address(vault), tokenAddr, address(pool));

        // 4) Wire strategy into vault
        if (doSetStrategy) {
            vault.setStrategy(address(strategy));
        }

        // 5) Deposit into vault (owner funds)
        if (doDeposit) {
            require(owner == deployer, "DO_DEPOSIT requires OWNER == DEPLOYER (same private key)");
            IERC20(tokenAddr).approve(address(vault), depositAmount);
            vault.deposit(depositAmount);
        }

        // 6) Invest from vault into strategy/pool (admin-only)
        if (doInvest) {
            require(doSetStrategy, "DO_INVEST requires DO_SET_STRATEGY=true");
            vault.invest(investAmount);
        }

        // 7) Configure policy/merchant (via permits recommended)
        if (doPermits) {
            require(ownerPk != 0, "DO_PERMITS=true requires OWNER_PRIVATE_KEY");

            // a) SetPolicy signature
            uint256 nonce1 = vault.nonces(owner);

            bytes32 structHash1 = keccak256(
                abi.encode(
                    vault.SET_POLICY_TYPEHASH(),
                    owner,
                    spender,
                    true,
                    maxPerTx,
                    dailyLimit,
                    whitelist,
                    nonce1,
                    deadline
                )
            );

            bytes32 digest1 = keccak256(abi.encodePacked("\x19\x01", vault.DOMAIN_SEPARATOR(), structHash1));
            (uint8 v1, bytes32 r1, bytes32 s1) = vm.sign(ownerPk, digest1);

            vault.setPolicyWithSig(
                owner,
                spender,
                true,
                maxPerTx,
                dailyLimit,
                whitelist,
                deadline,
                v1, r1, s1
            );

            // b) Merchant allow (only if whitelist enabled)
            if (whitelist) {
                uint256 nonce2 = vault.nonces(owner);

                bytes32 structHash2 = keccak256(
                    abi.encode(
                        vault.SET_MERCHANT_TYPEHASH(),
                        owner,
                        spender,
                        merchant,
                        true,
                        nonce2,
                        deadline
                    )
                );

                bytes32 digest2 = keccak256(abi.encodePacked("\x19\x01", vault.DOMAIN_SEPARATOR(), structHash2));
                (uint8 v2, bytes32 r2, bytes32 s2) = vm.sign(ownerPk, digest2);

                vault.setMerchantAllowedWithSig(
                    owner,
                    spender,
                    merchant,
                    true,
                    deadline,
                    v2, r2, s2
                );
            }
        } else {
            require(owner == deployer, "Direct setPolicy requires OWNER == DEPLOYER");
            vault.setPolicy(spender, true, maxPerTx, dailyLimit, whitelist);
            if (whitelist) {
                vault.setMerchantAllowed(spender, merchant, true);
            }
        }

        // 8) Fund yield reserve, then instantly materialize yield from reserve
        if (doFundYield) {
            require(owner == deployer, "DO_FUND_YIELD assumes deployer/owner wallet funds it");
            // Fund reserve (USDC -> pool)
            IERC20(tokenAddr).approve(address(pool), yieldFundAmount);
            pool.fundYield(yieldFundAmount);

            // Instantly apply yield so it shows up in Vault.totalAssets() immediately
            if (doAccrueFromReserve) {
                // Requires pool.totalShares > 0 -> make sure DO_INVEST already happened (strategy deposited)
                pool.accrueFromReserve(accrueAmount);
            }
        }

        vm.stopBroadcast();

        // --- Logs ---
        console2.log("Deployer (vault.admin):", deployer);
        console2.log("Owner:", owner);
        console2.log("Spender:", spender);
        console2.log("Merchant:", merchant);

        console2.log("Token (USDC):", tokenAddr);
        console2.log("ExpenseVault:", address(vault));
        console2.log("SimulatedLiquidityPool:", address(pool));
        console2.log("LiquidityPoolStrategy:", address(strategy));

        console2.log("Policy maxPerTx:", maxPerTx);
        console2.log("Policy dailyLimit:", dailyLimit);
        console2.log("Whitelist enabled:", whitelist);

        console2.log("DO_DEPOSIT:", doDeposit);
        console2.log("DEPOSIT_AMOUNT:", depositAmount);

        console2.log("DO_INVEST:", doInvest);
        console2.log("INVEST_AMOUNT:", investAmount);

        console2.log("DO_FUND_YIELD:", doFundYield);
        console2.log("YIELD_FUND_AMOUNT:", yieldFundAmount);
        console2.log("DO_ACCRUE_FROM_RESERVE:", doAccrueFromReserve);
        console2.log("ACCRUE_AMOUNT:", accrueAmount);
    }
}




