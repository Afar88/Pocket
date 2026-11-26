// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Stores owner-controlled payout rules only. The registry never holds funds.
/// @dev Payments are executed by the owner's Altana wallet; msg.sender is that wallet.
contract PocketRegistry {
    uint8 public constant SKIP_RATE_BELOW_FLOOR = 1;
    uint8 public constant SKIP_OVER_CAP = 2;
    uint8 public constant SKIP_NO_QUOTE = 3;
    uint8 public constant SKIP_SESSION_EXPIRED = 4;
    uint8 private constant USDT_DECIMALS = 6;

    struct Pocket {
        address owner;
        address recipient;
        uint256 amountUsdt;
        address payoutToken;
        uint64 period;
        uint64 nextDue;
        string label;
        string note;
        bool paused;
        bool closed;
        bool deleted;
        address agent;
        bytes32 sessionKeyId;
        uint64 sessionExpiry;
        uint128 usdtDailyCap;
        uint128 payoutDailyCap;
        uint128 minOutPerUsdt;
        uint64 lastSkippedDue;
        uint8 lastSkippedReason;
        bytes encryptedSessionKey;
        string serializedSession;
    }

    struct LastPayment {
        address payoutToken;
        uint256 usdtSpent;
        uint256 amountOut;
        bytes32 txRef;
        uint64 timestamp;
    }

    uint256 public pocketCount;
    mapping(uint256 => Pocket) private _pockets;
    mapping(uint256 => LastPayment) private _lastPayments;
    mapping(bytes32 => bool) public usedTxRef;

    event PocketCreated(uint256 indexed pocketId, address indexed owner, address indexed recipient, uint256 amountUsdt, address payoutToken, uint64 period, uint64 nextDue, string label, string note);
    event PocketUpdated(uint256 indexed pocketId, address indexed recipient, uint256 amountUsdt, address payoutToken, uint64 period, uint64 nextDue, string label, string note);
    event PocketPaused(uint256 indexed pocketId, bool paused);
    event PocketDeleted(uint256 indexed pocketId);
    event AgentApproved(uint256 indexed pocketId, address indexed agent, bytes32 sessionKeyId, uint64 sessionExpiry, uint128 usdtDailyCap, uint128 payoutDailyCap);
    event MinRateUpdated(uint256 indexed pocketId, uint128 minOutPerUsdt);
    event PocketPaid(uint256 indexed pocketId, address indexed payoutToken, uint256 usdtSpent, uint256 amountOut, bytes32 txRef, uint64 timestamp, uint64 nextDue);
    event PocketSkipped(uint256 indexed pocketId, uint8 reasonCode, uint64 dueAt, uint64 timestamp);

    modifier onlyOwner(uint256 pocketId) {
        require(_exists(pocketId), "pocket missing");
        require(_pockets[pocketId].owner == msg.sender, "not owner");
        _;
    }

    modifier onlyAgent(uint256 pocketId) {
        require(_approvedAgent(pocketId), "not approved agent");
        require(block.timestamp <= _pockets[pocketId].sessionExpiry, "session expired");
        _;
    }

    modifier onlyApprovedAgent(uint256 pocketId) {
        require(_approvedAgent(pocketId), "not approved agent");
        _;
    }

    function createPocket(address recipient, uint256 amountUsdt, address payoutToken, uint64 period, uint64 firstDue, string calldata label, string calldata note, uint128 minOutPerUsdt) external returns (uint256 pocketId) {
        require(recipient != address(0), "zero recipient");
        require(payoutToken != address(0), "zero payout token");
        require(amountUsdt > 0, "zero amount");
        require(firstDue >= block.timestamp, "first due in past");
        require(bytes(label).length > 0 && bytes(label).length <= 64, "bad label");
        require(_utf8Length(bytes(note)) <= 80, "note too long");

        pocketId = ++pocketCount;
        _pockets[pocketId] = Pocket({
            owner: msg.sender,
            recipient: recipient,
            amountUsdt: amountUsdt,
            payoutToken: payoutToken,
            period: period,
            nextDue: firstDue,
            label: label,
            note: note,
            paused: false,
            closed: false,
            deleted: false,
            agent: address(0),
            sessionKeyId: bytes32(0),
            sessionExpiry: 0,
            usdtDailyCap: 0,
            payoutDailyCap: 0,
            minOutPerUsdt: minOutPerUsdt,
            lastSkippedDue: 0,
            lastSkippedReason: 0,
            encryptedSessionKey: "",
            serializedSession: ""
        });
        emit PocketCreated(pocketId, msg.sender, recipient, amountUsdt, payoutToken, period, firstDue, label, note);
    }

    function updatePocket(uint256 pocketId, address recipient, uint256 amountUsdt, address payoutToken, uint64 period, uint64 firstDue, string calldata label, string calldata note) external onlyOwner(pocketId) {
        Pocket storage pocket = _pockets[pocketId];
        require(!pocket.deleted, "pocket deleted");
        require(!pocket.closed, "pocket closed");
        require(recipient != address(0), "zero recipient");
        require(payoutToken != address(0), "zero payout token");
        require(amountUsdt > 0, "zero amount");
        require(firstDue >= block.timestamp, "first due in past");
        require(bytes(label).length > 0 && bytes(label).length <= 64, "bad label");
        require(_utf8Length(bytes(note)) <= 80, "note too long");

        pocket.recipient = recipient;
        pocket.amountUsdt = amountUsdt;
        pocket.payoutToken = payoutToken;
        pocket.period = period;
        pocket.nextDue = firstDue;
        pocket.label = label;
        pocket.note = note;
        emit PocketUpdated(pocketId, recipient, amountUsdt, payoutToken, period, firstDue, label, note);
    }

    /// @notice The rate floor can be changed independently from every other pocket field.
    function setMinRate(uint256 pocketId, uint128 minOutPerUsdt) external onlyOwner(pocketId) {
        require(!_pockets[pocketId].deleted, "pocket deleted");
        _pockets[pocketId].minOutPerUsdt = minOutPerUsdt;
        emit MinRateUpdated(pocketId, minOutPerUsdt);
    }

    function pausePocket(uint256 pocketId, bool paused) external onlyOwner(pocketId) {
        require(!_pockets[pocketId].deleted, "pocket deleted");
        require(!_pockets[pocketId].closed, "pocket closed");
        _pockets[pocketId].paused = paused;
        emit PocketPaused(pocketId, paused);
    }

    function deletePocket(uint256 pocketId) external onlyOwner(pocketId) {
        Pocket storage pocket = _pockets[pocketId];
        require(!pocket.deleted, "pocket deleted");
        pocket.deleted = true;
        pocket.paused = true;
        pocket.agent = address(0);
        pocket.sessionKeyId = bytes32(0);
        pocket.sessionExpiry = 0;
        pocket.usdtDailyCap = 0;
        pocket.payoutDailyCap = 0;
        pocket.encryptedSessionKey = "";
        pocket.serializedSession = "";
        emit PocketDeleted(pocketId);
    }

    function approveAgent(uint256 pocketId, address agent, bytes32 sessionKeyId, uint64 sessionExpiry, uint128 usdtDailyCap, uint128 payoutDailyCap, bytes calldata encryptedSessionKey, string calldata serializedSession) external onlyOwner(pocketId) {
        Pocket storage pocket = _pockets[pocketId];
        require(!pocket.deleted && !pocket.closed, "pocket unavailable");

        if (agent == address(0)) {
            require(sessionKeyId == bytes32(0) && sessionExpiry == 0 && usdtDailyCap == 0 && payoutDailyCap == 0 && encryptedSessionKey.length == 0 && bytes(serializedSession).length == 0, "bad revoke");
            pocket.agent = address(0);
            pocket.sessionKeyId = bytes32(0);
            pocket.sessionExpiry = 0;
            pocket.usdtDailyCap = 0;
            pocket.payoutDailyCap = 0;
            pocket.encryptedSessionKey = "";
            pocket.serializedSession = "";
        } else {
            require(sessionKeyId != bytes32(0), "zero key id");
            require(sessionExpiry > block.timestamp, "session expired");
            require(usdtDailyCap > 0 && payoutDailyCap > 0, "zero cap");
            require(encryptedSessionKey.length > 0, "missing session key");
            require(bytes(serializedSession).length > 0, "missing session");
            pocket.agent = agent;
            pocket.sessionKeyId = sessionKeyId;
            pocket.sessionExpiry = sessionExpiry;
            pocket.usdtDailyCap = usdtDailyCap;
            pocket.payoutDailyCap = payoutDailyCap;
            pocket.encryptedSessionKey = encryptedSessionKey;
            pocket.serializedSession = serializedSession;
        }
        emit AgentApproved(pocketId, agent, sessionKeyId, sessionExpiry, usdtDailyCap, payoutDailyCap);
    }

    /// @notice Mark after the transfer in the same Altana batch; any revert rolls back both calls.
    function markPaid(uint256 pocketId, address payoutToken, uint256 usdtSpent, uint256 amountOut, uint64 dueAt, bytes32 txRef) external onlyAgent(pocketId) {
        Pocket storage pocket = _pockets[pocketId];
        require(!pocket.paused && !pocket.closed, "pocket inactive");
        require(payoutToken == pocket.payoutToken, "wrong payout token");
        require(usdtSpent > 0 && usdtSpent <= pocket.amountUsdt && usdtSpent <= pocket.usdtDailyCap, "over usdt cap");
        require(amountOut > 0 && amountOut <= pocket.payoutDailyCap, "over payout cap");
        require(txRef != bytes32(0), "empty tx ref");
        require(!usedTxRef[txRef], "tx ref used");
        require(dueAt == pocket.nextDue, "stale period");
        require(block.timestamp >= dueAt, "not due");
        if (pocket.minOutPerUsdt > 0) {
            require(_ratePerUsdt(payoutToken, amountOut, usdtSpent) >= pocket.minOutPerUsdt, "rate below floor");
        }

        usedTxRef[txRef] = true;
        uint64 paidAt = uint64(block.timestamp);
        _lastPayments[pocketId] = LastPayment(payoutToken, usdtSpent, amountOut, txRef, paidAt);
        if (pocket.period == 0) {
            pocket.closed = true;
            pocket.nextDue = 0;
        } else {
            pocket.nextDue += pocket.period;
        }
        emit PocketPaid(pocketId, payoutToken, usdtSpent, amountOut, txRef, paidAt, pocket.nextDue);
    }

    /// @notice Records one public refusal per due period; later runs can retry the same due payment.
    /// @dev An expired session may still record its expiry; payment marks remain expiry-gated.
    function skipPocket(uint256 pocketId, uint8 reasonCode) external onlyApprovedAgent(pocketId) {
        Pocket storage pocket = _pockets[pocketId];
        require(!pocket.deleted && !pocket.closed, "pocket unavailable");
        require(!pocket.paused, "pocket paused");
        require(block.timestamp >= pocket.nextDue, "not due");
        require(reasonCode >= SKIP_RATE_BELOW_FLOOR && reasonCode <= SKIP_SESSION_EXPIRED, "bad skip reason");
        require(pocket.lastSkippedDue != pocket.nextDue, "already skipped this period");
        pocket.lastSkippedDue = pocket.nextDue;
        pocket.lastSkippedReason = reasonCode;
        emit PocketSkipped(pocketId, reasonCode, pocket.nextDue, uint64(block.timestamp));
    }

    function getPocket(uint256 pocketId) external view returns (Pocket memory) {
        require(_exists(pocketId), "pocket missing");
        return _pockets[pocketId];
    }

    function getLastPayment(uint256 pocketId) external view returns (LastPayment memory) {
        require(_exists(pocketId), "pocket missing");
        return _lastPayments[pocketId];
    }

    function _utf8Length(bytes memory value) private pure returns (uint256 characters) {
        for (uint256 i = 0; i < value.length; i++) {
            // UTF-8 continuation bytes start with 10xxxxxx; every other byte
            // begins a code point. This counts ASCII and multibyte characters.
            if ((uint8(value[i]) & 0xC0) != 0x80) characters++;
        }
    }

    function _ratePerUsdt(address token, uint256 amountOut, uint256 usdtSpent) private view returns (uint256) {
        (bool ok, bytes memory data) = token.staticcall(abi.encodeWithSignature("decimals()"));
        require(ok && data.length >= 32, "payout decimals unavailable");
        uint256 decimals = abi.decode(data, (uint256));
        require(decimals <= 24, "payout decimals too high");
        // Human output per human USDT, scaled to 1e18. Celo USDT has six decimals.
        return amountOut * (10 ** (18 + USDT_DECIMALS - decimals)) / usdtSpent;
    }

    function _approvedAgent(uint256 pocketId) private view returns (bool) {
        return _exists(pocketId) && !_pockets[pocketId].deleted && _pockets[pocketId].agent != address(0) && _pockets[pocketId].agent == msg.sender;
    }

    function _exists(uint256 pocketId) private view returns (bool) {
        return pocketId > 0 && pocketId <= pocketCount;
    }
}
