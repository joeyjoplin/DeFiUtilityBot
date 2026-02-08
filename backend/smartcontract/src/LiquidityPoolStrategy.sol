// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "./IERC20.sol";

interface ISimulatedLiquidityPool {
    function deposit(uint256 amount) external;
    function withdraw(uint256 amount) external;
    function balances(address account) external view returns (uint256);
}

contract LiquidityPoolStrategy {
    /// @notice The vault that is allowed to call deposit/withdraw.
    address public immutable vault;

    /// @notice Underlying asset (USDC on Base Sepolia for the demo).
    IERC20 public immutable asset;

    /// @notice Liquidity pool where we "earn yield" (simulated).
    ISimulatedLiquidityPool public immutable pool;

    event DepositedToPool(uint256 amount);
    event WithdrawnFromPool(uint256 amount);

    modifier onlyVault() {
        require(msg.sender == vault, "only vault");
        _;
    }

    constructor(address _vault, address _asset, address _pool) {
        require(_vault != address(0), "bad vault");
        require(_asset != address(0), "bad asset");
        require(_pool != address(0), "bad pool");

        vault = _vault;
        asset = IERC20(_asset);
        pool = ISimulatedLiquidityPool(_pool);
    }

    /// @notice Total assets managed by this strategy (pool + idle balance).
    function totalAssets() external view returns (uint256) {
        uint256 inPool = pool.balances(address(this));
        uint256 idle = asset.balanceOf(address(this));
        return inPool + idle;
    }

    /// @notice Pull funds from the vault and deposit into the pool.
    /// @dev The vault must have approved this strategy beforehand.
    function depositFromVault(uint256 amount) external onlyVault {
        require(amount > 0, "amount=0");

        // Pull from vault
        require(asset.transferFrom(vault, address(this), amount), "transferFrom failed");

        // Approve pool (reset to 0 first for compatibility with some ERC20s)
        require(asset.approve(address(pool), 0), "approve reset failed");
        require(asset.approve(address(pool), amount), "approve failed");

        // Deposit into pool
        pool.deposit(amount);

        emit DepositedToPool(amount);
    }

    /// @notice Withdraw from the pool and send funds back to the vault.
    function withdrawToVault(uint256 amount) external onlyVault {
        require(amount > 0, "amount=0");

        // Withdraw from pool (pool is assumed to track balances for this strategy)
        pool.withdraw(amount);

        // Return to vault
        require(asset.transfer(vault, amount), "transfer failed");

        emit WithdrawnFromPool(amount);
    }
}

