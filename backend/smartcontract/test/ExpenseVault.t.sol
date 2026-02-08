// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "forge-std/Test.sol";

import "../src/ExpenseVault.sol";
import "../src/SimulatedLiquidityPool.sol";
import "../src/LiquidityPoolStrategy.sol";

/*//////////////////////////////////////////////////////////////
                    TEST-ONLY USDC (6 decimals)
  NOTE: In local unit tests we need a mintable ERC20. This is not
  deployed in the demo; demo uses Base Sepolia USDC address.
//////////////////////////////////////////////////////////////*/
contract TestUSDC {
    string public name = "USD Coin";
    string public symbol = "USDC";
    uint8 public decimals = 6;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 amount);
    event Approval(address indexed owner, address indexed spender, uint256 amount);

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "insufficient");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        require(a >= amount, "allowance");
        require(balanceOf[from] >= amount, "insufficient");
        allowance[from][msg.sender] = a - amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
        return true;
    }
}

contract ExpenseVaultTest is Test {
    TestUSDC usdc;
    ExpenseVault vault;

    SimulatedLiquidityPool pool;
    LiquidityPoolStrategy strategy;

    uint256 ownerPk;
    address owner;

    uint256 spenderPk;
    address spender;

    address merchant = address(0xCAFE);
    address yieldFunder = address(0xF00D);

    function setUp() public {
        ownerPk = 0xA11CE;
        owner = vm.addr(ownerPk);

        spenderPk = 0xB0B;
        spender = vm.addr(spenderPk);

        usdc = new TestUSDC();

        // IMPORTANT: vault admin = msg.sender at deployment => this test contract
        vault = new ExpenseVault(address(usdc));

        pool = new SimulatedLiquidityPool(address(usdc), 500); // 5% APR simulated
        strategy = new LiquidityPoolStrategy(address(vault), address(usdc), address(pool));

        // Wire strategy into the vault (admin-only => this contract)
        vault.setStrategy(address(strategy));

        // Fund owner with 100 USDC
        usdc.mint(owner, 100e6);

        // Owner deposits 50 USDC into the vault
        vm.startPrank(owner);
        usdc.approve(address(vault), 50e6);
        vault.deposit(50e6);
        vm.stopPrank();
    }

    /*//////////////////////////////////////////////////////////////
                            BASIC TESTS
    //////////////////////////////////////////////////////////////*/

    function testDepositMintShares() public {
        assertEq(vault.balanceOf(owner), 50e6);
        assertEq(vault.totalSupply(), 50e6);
        assertEq(vault.totalAssets(), 50e6); // idle only (strategy empty)
        assertEq(usdc.balanceOf(address(vault)), 50e6);
    }

    function testWithdrawBasic() public {
        vm.startPrank(owner);
        vault.withdraw(10e6);
        vm.stopPrank();

        // Owner had 100e6, deposited 50e6 => wallet 50e6.
        // Withdraw 10e6 shares => gets 10e6 underlying back => 60e6.
        assertEq(usdc.balanceOf(owner), 60e6);
        assertEq(vault.balanceOf(owner), 40e6);
        assertEq(vault.totalSupply(), 40e6);
    }

    /*//////////////////////////////////////////////////////////////
                            POLICY TESTS
    //////////////////////////////////////////////////////////////*/

    function _setPolicyAndMerchant(bool whitelist) internal {
        vm.startPrank(owner);
        vault.setPolicy(spender, true, 20e6, 60e6, whitelist);
        if (whitelist) {
            vault.setMerchantAllowed(spender, merchant, true);
        }
        vm.stopPrank();
    }

    function testSpendWithPolicyWhitelist() public {
        _setPolicyAndMerchant(true);

        vm.prank(spender);
        vault.spend(owner, merchant, 12e6);

        assertEq(usdc.balanceOf(merchant), 12e6);
        assertTrue(vault.balanceOf(owner) < 50e6);
    }

    function testSpendFailsIfMerchantNotAllowed() public {
        vm.startPrank(owner);
        vault.setPolicy(spender, true, 20e6, 60e6, true);
        vm.stopPrank();

        vm.prank(spender);
        vm.expectRevert("merchant not allowed");
        vault.spend(owner, merchant, 1e6);
    }

    function testSpendFailsIfExceedsMaxPerTx() public {
        vm.startPrank(owner);
        vault.setPolicy(spender, true, 5e6, 60e6, false);
        vm.stopPrank();

        vm.prank(spender);
        vm.expectRevert("exceeds maxPerTx");
        vault.spend(owner, merchant, 6e6);
    }

    /*//////////////////////////////////////////////////////////////
            STRATEGY LIQUIDITY: spend() pulls from strategy
    //////////////////////////////////////////////////////////////*/

    function testSpendPullsLiquidityFromStrategyWhenIdleInsufficient() public {
        _setPolicyAndMerchant(true);

        // Invest most of vault idle into strategy so vault idle becomes small
        // Vault currently has 50e6 idle.
        vault.invest(45e6);
        assertEq(usdc.balanceOf(address(vault)), 5e6);

        // Fund yield reserve so strategy grows (not strictly required for liquidity pull)
        usdc.mint(yieldFunder, 5e6);
        vm.startPrank(yieldFunder);
        usdc.approve(address(pool), 5e6);
        pool.fundYield(5e6);
        vm.stopPrank();

        // Spend 10 USDC (idle is only 5 USDC) => vault must pull ~5 USDC from strategy
        vm.prank(spender);
        vault.spend(owner, merchant, 10e6);

        assertEq(usdc.balanceOf(merchant), 10e6);
        // vault should still be solvent
        assertTrue(vault.totalAssets() > 0);
    }

    /*//////////////////////////////////////////////////////////////
            YIELD FLOW: yield appears in vault.totalAssets()
    //////////////////////////////////////////////////////////////*/

    function testYieldAppearsInVaultTotalAssetsAndWithdrawWorks() public {
        // Invest 30 USDC from vault into strategy/pool
        vault.invest(30e6);

        uint256 taBefore = vault.totalAssets();
        assertEq(taBefore, 50e6); // no yield yet, just relocated

        // Fund yield reserve (10 USDC) so pool can "materialize" interest
        usdc.mint(yieldFunder, 10e6);
        vm.startPrank(yieldFunder);
        usdc.approve(address(pool), 10e6);
        pool.fundYield(10e6);
        vm.stopPrank();

        // Warp time and accrue interest
        vm.warp(block.timestamp + 180 days);
        pool.accrueInterest();

        uint256 taAfter = vault.totalAssets();
        assertTrue(taAfter > taBefore); // yield should be visible via strategy.totalAssets()

        // Owner withdraws all shares - vault should pull liquidity from strategy as needed
        uint256 shares = vault.balanceOf(owner);

        vm.startPrank(owner);
        vault.withdraw(shares);
        vm.stopPrank();

        // Owner should end > 100 USDC due to yield
        assertTrue(usdc.balanceOf(owner) > 100e6);
    }
}



