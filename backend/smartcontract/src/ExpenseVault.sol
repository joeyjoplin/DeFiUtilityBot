// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "./IERC20.sol";

abstract contract ReentrancyGuard {
    uint256 private _locked = 1;

    modifier nonReentrant() {
        require(_locked == 1, "reentrancy");
        _locked = 2;
        _;
        _locked = 1;
    }
}

interface ILiquidityPoolStrategy {
    function totalAssets() external view returns (uint256);
    function depositFromVault(uint256 amount) external;
    function withdrawToVault(uint256 amount) external;
}

contract ExpenseVault is ReentrancyGuard {
    /// @dev Underlying asset (USDC on Base Sepolia for the demo).
    IERC20 public immutable token; // USDC uses 6 decimals

    /// @dev Admin for configuring strategy/keeper-like actions (hackathon-friendly).
    address public immutable admin;

    /// @dev Optional yield strategy.
    ILiquidityPoolStrategy public strategy;

    // Shares accounting
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf; // shares per user

    // --- Policy layer ---
    struct Policy {
        bool enabled;
        bool enforceMerchantWhitelist;
        uint256 maxPerTx;   // 20e6 => 20 USDC
        uint256 dailyLimit; // 60e6 => 60 USDC/day
    }

    // owner => spender => policy
    mapping(address => mapping(address => Policy)) public policyOf;

    // owner => spender => merchant => allowed
    mapping(address => mapping(address => mapping(address => bool))) public merchantAllowed;

    // owner => spender => dayIndex => spentAmount
    mapping(address => mapping(address => mapping(uint256 => uint256))) public spentPerDay;

    // --- EIP-712 nonces ---
    mapping(address => uint256) public nonces;

    // --- EIP-712 domain ---
    bytes32 public immutable DOMAIN_SEPARATOR;

    bytes32 private constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant NAME_HASH = keccak256("ExpenseVault");
    bytes32 private constant VERSION_HASH = keccak256("1");

    // Expose typehashes for tests / integrators
    bytes32 public constant SET_POLICY_TYPEHASH =
        keccak256(
            "SetPolicy(address owner,address spender,bool enabled,uint256 maxPerTx,uint256 dailyLimit,bool enforceMerchantWhitelist,uint256 nonce,uint256 deadline)"
        );

    bytes32 public constant SET_MERCHANT_TYPEHASH =
        keccak256(
            "SetMerchant(address owner,address spender,address merchant,bool allowed,uint256 nonce,uint256 deadline)"
        );

    event Deposit(address indexed owner, uint256 amount, uint256 sharesMinted);
    event Withdraw(address indexed owner, uint256 sharesBurned, uint256 amount);

    event PolicySet(
        address indexed owner,
        address indexed spender,
        bool enabled,
        uint256 maxPerTx,
        uint256 dailyLimit,
        bool enforceMerchantWhitelist
    );

    event MerchantAllowedSet(
        address indexed owner,
        address indexed spender,
        address indexed merchant,
        bool allowed
    );

    event Spent(
        address indexed owner,
        address indexed spender,
        address indexed merchant,
        uint256 amount,
        uint256 sharesBurned,
        uint256 dayIndex
    );

    event StrategySet(address indexed newStrategy);
    event Invested(uint256 amount);
    event Divested(uint256 amount);

    modifier onlyAdmin() {
        require(msg.sender == admin, "only admin");
        _;
    }

    constructor(address _token) {
        require(_token != address(0), "bad token");
        token = IERC20(_token);
        admin = msg.sender;

        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH,
                NAME_HASH,
                VERSION_HASH,
                block.chainid,
                address(this)
            )
        );
    }

    /// @notice Total assets owned by the vault (idle in vault + invested in strategy).
    function totalAssets() public view returns (uint256) {
        uint256 idle = token.balanceOf(address(this));
        address strat = address(strategy);
        if (strat == address(0)) return idle;

        uint256 invested = strategy.totalAssets();
        return idle + invested;
    }

    function setStrategy(address _strategy) external onlyAdmin {
        // Allow setting to zero to disable strategy.
        if (_strategy != address(0)) {
            // Basic sanity: strategy must target this vault (enforced in strategy constructor in your version),
            // but we don't depend on it here.
        }
        strategy = ILiquidityPoolStrategy(_strategy);
        emit StrategySet(_strategy);
    }

    /// @notice Move idle funds from the vault into the strategy (to generate yield).
    /// @dev Admin-controlled for hackathon/demo safety.
    function invest(uint256 amount) external onlyAdmin nonReentrant {
        require(amount > 0, "amount=0");
        address strat = address(strategy);
        require(strat != address(0), "no strategy");

        // Ensure we have enough idle funds.
        uint256 idle = token.balanceOf(address(this));
        require(idle >= amount, "insufficient idle");

        // Approve strategy to pull funds from the vault.
        // Reset to 0 first for compatibility with some ERC20s.
        require(token.approve(strat, 0), "approve reset failed");
        require(token.approve(strat, amount), "approve failed");

        // Strategy will transferFrom(vault -> strategy) and deposit into pool.
        strategy.depositFromVault(amount);

        emit Invested(amount);
    }

    /// @notice Pull funds back from the strategy into the vault.
    function divest(uint256 amount) external onlyAdmin nonReentrant {
        require(amount > 0, "amount=0");
        address strat = address(strategy);
        require(strat != address(0), "no strategy");

        strategy.withdrawToVault(amount);
        emit Divested(amount);
    }

    // ---------- Shares math ----------
    function _mint(address _to, uint256 _shares) private {
        totalSupply += _shares;
        balanceOf[_to] += _shares;
    }

    function _burn(address _from, uint256 _shares) private {
        balanceOf[_from] -= _shares;
        totalSupply -= _shares;
    }

    /// @dev Ensure the vault has at least `amount` tokens available locally.
    /// Pulls from strategy if needed.
    function _ensureVaultLiquidity(uint256 amount) internal {
        uint256 idle = token.balanceOf(address(this));
        if (idle >= amount) return;

        address strat = address(strategy);
        require(strat != address(0), "insufficient liquidity");

        uint256 shortfall = amount - idle;
        strategy.withdrawToVault(shortfall);

        // After withdrawToVault, vault should have enough.
        require(token.balanceOf(address(this)) >= amount, "liquidity still insufficient");
    }

    /// @notice Deposit underlying token and receive shares.
    /// Anyone can deposit (demo-friendly).
    function deposit(uint256 _amount) external nonReentrant {
        require(_amount > 0, "amount=0");

        uint256 taBefore = totalAssets();
        require(totalSupply == 0 || taBefore > 0, "empty vault");

        uint256 shares;
        if (totalSupply == 0) {
            shares = _amount;
        } else {
            // shares = amount * totalSupply / totalAssetsBefore
            shares = (_amount * totalSupply) / taBefore;
        }

        _mint(msg.sender, shares);

        // Pull underlying from user into the vault
        require(token.transferFrom(msg.sender, address(this), _amount), "transferFrom failed");

        emit Deposit(msg.sender, _amount, shares);
    }

    /// @notice Burn shares and withdraw underlying token.
    /// Anyone can withdraw their own shares.
    function withdraw(uint256 _shares) external nonReentrant {
        require(_shares > 0, "shares=0");
        require(totalSupply > 0, "empty");

        uint256 ta = totalAssets();
        require(ta > 0, "empty vault");

        uint256 amount = (_shares * ta) / totalSupply;

        _burn(msg.sender, _shares);

        _ensureVaultLiquidity(amount);
        require(token.transfer(msg.sender, amount), "transfer failed");

        emit Withdraw(msg.sender, _shares, amount);
    }

    // ---------- Direct policy management (owner sends tx) ----------
    function setPolicy(
        address spender,
        bool enabled,
        uint256 maxPerTx,
        uint256 dailyLimit,
        bool enforceMerchantWhitelist
    ) external {
        _setPolicy(msg.sender, spender, enabled, maxPerTx, dailyLimit, enforceMerchantWhitelist);
    }

    function setMerchantAllowed(address spender, address merchant, bool allowed) external {
        _setMerchantAllowed(msg.sender, spender, merchant, allowed);
    }

    // ---------- Off-chain signature policy management (spender/anyone submits) ----------
    function setPolicyWithSig(
        address owner,
        address spender,
        bool enabled,
        uint256 maxPerTx,
        uint256 dailyLimit,
        bool enforceMerchantWhitelist,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        require(owner != address(0), "bad owner");
        require(block.timestamp <= deadline, "expired");

        uint256 nonce = nonces[owner]++;

        bytes32 structHash = keccak256(
            abi.encode(
                SET_POLICY_TYPEHASH,
                owner,
                spender,
                enabled,
                maxPerTx,
                dailyLimit,
                enforceMerchantWhitelist,
                nonce,
                deadline
            )
        );

        _verifySig(owner, structHash, v, r, s);
        _setPolicy(owner, spender, enabled, maxPerTx, dailyLimit, enforceMerchantWhitelist);
    }

    function setMerchantAllowedWithSig(
        address owner,
        address spender,
        address merchant,
        bool allowed,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        require(owner != address(0), "bad owner");
        require(block.timestamp <= deadline, "expired");

        uint256 nonce = nonces[owner]++;

        bytes32 structHash = keccak256(
            abi.encode(
                SET_MERCHANT_TYPEHASH,
                owner,
                spender,
                merchant,
                allowed,
                nonce,
                deadline
            )
        );

        _verifySig(owner, structHash, v, r, s);
        _setMerchantAllowed(owner, spender, merchant, allowed);
    }

    function _verifySig(
        address signer,
        bytes32 structHash,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) internal view {
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
        address recovered = ecrecover(digest, v, r, s);
        require(recovered != address(0) && recovered == signer, "bad sig");
    }

    function _setPolicy(
        address owner,
        address spender,
        bool enabled,
        uint256 maxPerTx,
        uint256 dailyLimit,
        bool enforceMerchantWhitelist
    ) internal {
        require(spender != address(0), "bad spender");
        require(maxPerTx > 0, "maxPerTx=0");
        require(dailyLimit >= maxPerTx, "daily<perTx");

        policyOf[owner][spender] = Policy({
            enabled: enabled,
            enforceMerchantWhitelist: enforceMerchantWhitelist,
            maxPerTx: maxPerTx,
            dailyLimit: dailyLimit
        });

        emit PolicySet(owner, spender, enabled, maxPerTx, dailyLimit, enforceMerchantWhitelist);
    }

    function _setMerchantAllowed(
        address owner,
        address spender,
        address merchant,
        bool allowed
    ) internal {
        require(spender != address(0), "bad spender");
        require(merchant != address(0), "bad merchant");

        merchantAllowed[owner][spender][merchant] = allowed;
        emit MerchantAllowedSet(owner, spender, merchant, allowed);
    }

    // ---------- Automated spend ----------
    function spend(address owner, address merchant, uint256 amount) external nonReentrant {
        require(owner != address(0), "bad owner");
        require(merchant != address(0), "bad merchant");
        require(amount > 0, "amount=0");

        Policy memory p = policyOf[owner][msg.sender];
        require(p.enabled, "policy disabled");
        require(amount <= p.maxPerTx, "exceeds maxPerTx");

        if (p.enforceMerchantWhitelist) {
            require(merchantAllowed[owner][msg.sender][merchant], "merchant not allowed");
        }

        uint256 dayIndex = block.timestamp / 1 days;
        uint256 spentToday = spentPerDay[owner][msg.sender][dayIndex];
        require(spentToday + amount <= p.dailyLimit, "exceeds dailyLimit");
        spentPerDay[owner][msg.sender][dayIndex] = spentToday + amount;

        uint256 ta = totalAssets();
        require(ta > 0 && totalSupply > 0, "empty vault");

        // sharesToBurn = ceil(amount * totalSupply / totalAssets)
        uint256 sharesToBurn = (amount * totalSupply) / ta;
        if ((sharesToBurn * ta) / totalSupply < amount) {
            sharesToBurn += 1;
        }

        require(balanceOf[owner] >= sharesToBurn, "insufficient shares");
        _burn(owner, sharesToBurn);

        _ensureVaultLiquidity(amount);
        require(token.transfer(merchant, amount), "transfer failed");

        emit Spent(owner, msg.sender, merchant, amount, sharesToBurn, dayIndex);
    }
}
