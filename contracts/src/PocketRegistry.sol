// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Stores recurring payment instructions only. It never accepts or holds funds.
/// @dev The owner is the Altana wallet address. Agent calls reach this contract through
///      Altana session execution, so msg.sender is that wallet, not the session-key EOA.
contract PocketRegistry {
    struct Pocket {
        address owner;
        address recipient;
        uint256 amountUsdt;
        uint64 period;
        uint64 nextDue;
        string label;
        bool paused;
        bool deleted;
        address agent;
        bytes32 sessionKeyId;
        uint64 sessionExpiry;
        uint128 usdtDailyCap;
        uint128 cngnDailyCap;
    }

    uint256 public pocketCount;
    mapping(uint256 => Pocket) private _pockets;
    mapping(bytes32 => bool) public usedTxRef;

    event PocketCreated(
        uint256 indexed pocketId,
        address indexed owner,
        address indexed recipient,
        uint256 amountUsdt,
        uint64 period,
        uint64 nextDue,
        string label
    );
    event PocketUpdated(
        uint256 indexed pocketId,
        address indexed recipient,
        uint256 amountUsdt,
        uint64 period,
        uint64 nextDue,
        string label
    );
    event PocketPaused(uint256 indexed pocketId, bool paused);
    event PocketDeleted(uint256 indexed pocketId);
    event AgentApproved(
        uint256 indexed pocketId,
        address indexed agent,
        bytes32 sessionKeyId,
        uint64 sessionExpiry,
        uint128 usdtDailyCap,
        uint128 cngnDailyCap
    );
    event PocketSwap(uint256 indexed pocketId, bytes32 indexed txRef);
    event PocketPaid(uint256 indexed pocketId, bytes32 txRef, uint64 nextDue);

    modifier onlyOwner(uint256 pocketId) {
        require(_exists(pocketId), "pocket missing");
        require(_pockets[pocketId].owner == msg.sender, "not owner");
        _;
    }

    modifier onlyAgent(uint256 pocketId) {
        require(_exists(pocketId), "pocket missing");
        require(!_pockets[pocketId].deleted, "pocket deleted");
        require(_pockets[pocketId].agent != address(0), "agent not approved");
        require(_pockets[pocketId].agent == msg.sender, "not approved agent");
        require(block.timestamp <= _pockets[pocketId].sessionExpiry, "session expired");
        _;
    }

    function createPocket(
        address recipient,
        uint256 amountUsdt,
        uint64 period,
        uint64 firstDue,
        string calldata label
    ) external returns (uint256 pocketId) {
        require(recipient != address(0), "zero recipient");
        require(amountUsdt > 0, "zero amount");
        require(period > 0, "zero period");
        require(firstDue >= block.timestamp, "first due in past");
        require(bytes(label).length > 0 && bytes(label).length <= 64, "bad label");

        pocketId = ++pocketCount;
        _pockets[pocketId] = Pocket({
            owner: msg.sender,
            recipient: recipient,
            amountUsdt: amountUsdt,
            period: period,
            nextDue: firstDue,
            label: label,
            paused: false,
            deleted: false,
            agent: address(0),
            sessionKeyId: bytes32(0),
            sessionExpiry: 0,
            usdtDailyCap: 0,
            cngnDailyCap: 0
        });

        emit PocketCreated(pocketId, msg.sender, recipient, amountUsdt, period, firstDue, label);
    }

    function updatePocket(
        uint256 pocketId,
        address recipient,
        uint256 amountUsdt,
        uint64 period,
        uint64 firstDue,
        string calldata label
    ) external onlyOwner(pocketId) {
        Pocket storage pocket = _pockets[pocketId];
        require(!pocket.deleted, "pocket deleted");
        require(recipient != address(0), "zero recipient");
        require(amountUsdt > 0, "zero amount");
        require(period > 0, "zero period");
        require(firstDue >= block.timestamp, "first due in past");
        require(bytes(label).length > 0 && bytes(label).length <= 64, "bad label");

        pocket.recipient = recipient;
        pocket.amountUsdt = amountUsdt;
        pocket.period = period;
        pocket.nextDue = firstDue;
        pocket.label = label;
        emit PocketUpdated(pocketId, recipient, amountUsdt, period, firstDue, label);
    }

    function pausePocket(uint256 pocketId, bool paused) external onlyOwner(pocketId) {
        require(!_pockets[pocketId].deleted, "pocket deleted");
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
        pocket.cngnDailyCap = 0;
        emit PocketDeleted(pocketId);
    }

    /// @notice Approves the owner's Altana wallet as the agent caller for this pocket.
    /// @dev A zero agent clears the approval; no external wallet can mark this pocket paid.
    function approveAgent(
        uint256 pocketId,
        address agent,
        bytes32 sessionKeyId,
        uint64 sessionExpiry,
        uint128 usdtDailyCap,
        uint128 cngnDailyCap
    ) external onlyOwner(pocketId) {
        Pocket storage pocket = _pockets[pocketId];
        require(!pocket.deleted, "pocket deleted");

        if (agent == address(0)) {
            require(
                sessionKeyId == bytes32(0) &&
                sessionExpiry == 0 &&
                usdtDailyCap == 0 &&
                cngnDailyCap == 0,
                "bad revoke"
            );
            pocket.agent = address(0);
            pocket.sessionKeyId = bytes32(0);
            pocket.sessionExpiry = 0;
            pocket.usdtDailyCap = 0;
            pocket.cngnDailyCap = 0;
        } else {
            require(sessionKeyId != bytes32(0), "zero key id");
            require(sessionExpiry > block.timestamp, "session expired");
            require(usdtDailyCap > 0 && cngnDailyCap > 0, "zero cap");
            pocket.agent = agent;
            pocket.sessionKeyId = sessionKeyId;
            pocket.sessionExpiry = sessionExpiry;
            pocket.usdtDailyCap = usdtDailyCap;
            pocket.cngnDailyCap = cngnDailyCap;
        }

        emit AgentApproved(
            pocketId,
            agent,
            sessionKeyId,
            sessionExpiry,
            usdtDailyCap,
            cngnDailyCap
        );
    }

    /// @notice Records a Textile RFQ reference after the swap succeeds.
    function recordSwap(uint256 pocketId, bytes32 txRef) external onlyAgent(pocketId) {
        require(txRef != bytes32(0), "empty tx ref");
        require(!_pockets[pocketId].paused, "pocket paused");
        require(!usedTxRef[txRef], "tx ref used");
        emit PocketSwap(pocketId, txRef);
    }

    /// @notice Marks one scheduled payment complete and advances by one period.
    /// @dev txRef is an idempotency reference derived from the unique Textile RFQ ID.
    ///      The explorer transaction hash is available from this event's log receipt.
    function markPaid(uint256 pocketId, bytes32 txRef) external onlyAgent(pocketId) {
        Pocket storage pocket = _pockets[pocketId];
        require(!pocket.paused, "pocket paused");
        require(txRef != bytes32(0), "empty tx ref");
        require(!usedTxRef[txRef], "tx ref used");
        require(block.timestamp >= pocket.nextDue, "not due");

        usedTxRef[txRef] = true;
        pocket.nextDue += pocket.period;
        emit PocketPaid(pocketId, txRef, pocket.nextDue);
    }

    function getPocket(uint256 pocketId) external view returns (Pocket memory) {
        require(pocketId > 0 && pocketId <= pocketCount, "pocket missing");
        return _pockets[pocketId];
    }

    function _exists(uint256 pocketId) private view returns (bool) {
        return pocketId > 0 && pocketId <= pocketCount;
    }
}
