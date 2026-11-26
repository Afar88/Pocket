// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../src/PocketRegistry.sol";

interface Vm {
    function warp(uint256) external;
    function prank(address) external;
    function expectRevert(bytes calldata) external;
}

contract MockDecimalsToken {
    uint8 public immutable decimals;
    constructor(uint8 decimals_) { decimals = decimals_; }
}

contract PocketRegistryTest {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    PocketRegistry private registry;
    address private owner = address(0xA11CE);
    address private agent = address(0xB0B);
    address private recipient = address(0xCAFE);
    address private payoutToken;
    bytes32 private keyId = keccak256("session-key");
    bytes private sealedKey = hex"deadbeef";
    string private storedSession = "{\"publicKey\":\"0x1234\"}";

    function setUp() public {
        registry = new PocketRegistry();
        payoutToken = address(new MockDecimalsToken(6));
        vm.warp(1_800_000_000);
    }

    function _expectError(string memory reason) private {
        vm.expectRevert(abi.encodeWithSignature("Error(string)", reason));
    }

    function _create(uint64 period) private returns (uint256) {
        vm.prank(owner);
        return registry.createPocket(recipient, 5_000_000, payoutToken, period, uint64(block.timestamp), "Family", "Public note", 0);
    }

    function _approve(uint256 id) private {
        vm.prank(owner);
        registry.approveAgent(id, agent, keyId, uint64(block.timestamp + 30 days), 5_000_000, 5_000_000, sealedKey, storedSession);
    }

    function testCreateStoresOnlyRulesAndPublicNote() public {
        uint256 id = _create(7 days);
        PocketRegistry.Pocket memory pocket = registry.getPocket(id);
        require(pocket.owner == owner && pocket.recipient == recipient, "parties");
        require(pocket.amountUsdt == 5_000_000 && pocket.payoutToken == payoutToken, "amount and token");
        require(pocket.period == 7 days && pocket.nextDue == block.timestamp, "schedule");
        require(keccak256(bytes(pocket.note)) == keccak256(bytes("Public note")), "public note");
        require(address(registry).balance == 0, "registry must not hold funds");
    }

    function testNoteCannotExceed80Bytes() public {
        _expectError("note too long");
        vm.prank(owner);
        registry.createPocket(recipient, 1_000_000, payoutToken, 0, uint64(block.timestamp), "Once", string(new bytes(81)), 0);
    }

    function testNoteLimitCountsUnicodeCharactersNotUtf8Bytes() public {
        bytes memory multibyteNote = new bytes(240);
        for (uint256 i = 0; i < 80; i++) {
            multibyteNote[i * 3] = 0xE7;
            multibyteNote[i * 3 + 1] = 0x95;
            multibyteNote[i * 3 + 2] = 0x8C;
        }
        vm.prank(owner);
        uint256 id = registry.createPocket(recipient, 1_000_000, payoutToken, 0, uint64(block.timestamp), "Unicode", string(multibyteNote), 0);
        require(bytes(registry.getPocket(id).note).length == 240, "all 80 characters stored");
    }

    function testOnlyOwnerCanUpdatePauseDeleteAndSetFloor() public {
        uint256 id = _create(7 days);
        _expectError("not owner");
        vm.prank(address(0xBAD));
        registry.setMinRate(id, 2e18);
        _expectError("not owner");
        vm.prank(address(0xBAD));
        registry.pausePocket(id, true);
        vm.prank(owner);
        registry.setMinRate(id, 2e18);
        require(registry.getPocket(id).minOutPerUsdt == 2e18, "floor stored");
        vm.prank(owner);
        registry.pausePocket(id, true);
        require(registry.getPocket(id).paused, "paused");
        vm.prank(owner);
        registry.deletePocket(id);
        require(registry.getPocket(id).deleted, "deleted");
    }

    function testAgentMustBeApprovedAndPaymentMustBeDue() public {
        uint256 id = _create(7 days);
        _expectError("not approved agent");
        vm.prank(agent);
        registry.markPaid(id, payoutToken, 1_000_000, 1_000_000, registry.getPocket(id).nextDue, keccak256("payment"));
        _approve(id);
        vm.prank(agent);
        registry.markPaid(id, payoutToken, 1_000_000, 1_000_000, keccak256("payment"));
        require(registry.getPocket(id).nextDue == block.timestamp + 7 days, "next due advanced");
    }

    function testCannotMarkPaidBeforeDue() public {
        vm.prank(owner);
        uint256 id = registry.createPocket(recipient, 1_000_000, payoutToken, 7 days, uint64(block.timestamp + 1 days), "Future", "", 0);
        _approve(id);
        _expectError("not due");
        vm.prank(agent);
        registry.markPaid(id, payoutToken, 1_000_000, 1_000_000, keccak256("early"));
    }

    function testStaleOverlappingRunCannotMarkTheNextDuePeriod() public {
        uint256 id = _create(1 days);
        _approve(id);
        uint64 originalDue = registry.getPocket(id).nextDue;
        vm.prank(agent);
        registry.markPaid(id, payoutToken, 1_000_000, 1_000_000, originalDue, keccak256("first-run"));
        require(registry.getPocket(id).nextDue == originalDue + 1 days, "next period");
        _expectError("stale period");
        vm.prank(agent);
        registry.markPaid(id, payoutToken, 1_000_000, 1_000_000, originalDue, keccak256("overlap"));
    }

    function testOneOffClosesAndCannotPayTwice() public {
        uint256 id = _create(0);
        _approve(id);
        vm.prank(agent);
        registry.markPaid(id, payoutToken, 1_000_000, 1_000_000, keccak256("once"));
        require(registry.getPocket(id).closed, "closed after one payment");
        require(registry.getPocket(id).nextDue == 0, "no next due");
        _expectError("pocket inactive");
        vm.prank(agent);
        registry.markPaid(id, payoutToken, 1_000_000, 1_000_000, keccak256("twice"));
    }

    function testWrongTokenAndCapsAreRejected() public {
        uint256 id = _create(7 days);
        _approve(id);
        _expectError("wrong payout token");
        vm.prank(agent);
        registry.markPaid(id, address(0x1234), 1_000_000, 1_000_000, registry.getPocket(id).nextDue, keccak256("wrong-token"));
        _expectError("over payout cap");
        vm.prank(agent);
        registry.markPaid(id, payoutToken, 1_000_000, 5_000_001, registry.getPocket(id).nextDue, keccak256("over-cap"));
    }

    function testFloorIsEnforcedOnchainAndCanBeChangedAlone() public {
        uint256 id = _create(7 days);
        _approve(id);
        vm.prank(owner);
        registry.setMinRate(id, 2e18);
        _expectError("rate below floor");
        vm.prank(agent);
        registry.markPaid(id, payoutToken, 1_000_000, 1_000_000, keccak256("below-floor"));
        vm.prank(owner);
        registry.setMinRate(id, 0);
        vm.prank(agent);
        registry.markPaid(id, payoutToken, 1_000_000, 1_000_000, keccak256("floor-off"));
    }

    function testLastPaymentStoresFullReceiptData() public {
        uint256 id = _create(7 days);
        _approve(id);
        bytes32 txRef = keccak256("receipt");
        vm.prank(agent);
        registry.markPaid(id, payoutToken, 750_000, 1_500_000, registry.getPocket(id).nextDue, txRef);
        PocketRegistry.LastPayment memory payment = registry.getLastPayment(id);
        require(payment.payoutToken == payoutToken, "token");
        require(payment.usdtSpent == 750_000 && payment.amountOut == 1_500_000, "amounts");
        require(payment.txRef == txRef && payment.timestamp == block.timestamp, "reference and time");
    }

    function testPaymentReferenceCannotBeReplayed() public {
        uint256 id = _create(1 days);
        _approve(id);
        bytes32 ref = keccak256("same-ref");
        vm.prank(agent);
        registry.markPaid(id, payoutToken, 1_000_000, 1_000_000, ref);
        vm.warp(block.timestamp + 1 days);
        _expectError("tx ref used");
        vm.prank(agent);
        registry.markPaid(id, payoutToken, 1_000_000, 1_000_000, ref);
    }

    function testExpiredSessionCannotPayButCanRecordExpirySkip() public {
        uint256 id = _create(1 days);
        vm.prank(owner);
        registry.approveAgent(id, agent, keyId, uint64(block.timestamp + 2), 5_000_000, 5_000_000, sealedKey, storedSession);
        vm.warp(block.timestamp + 3);
        _expectError("session expired");
        vm.prank(agent);
        registry.markPaid(id, payoutToken, 1_000_000, 1_000_000, keccak256("expired-payment"));
        vm.prank(agent);
        registry.skipPocket(id, registry.SKIP_SESSION_EXPIRED());
        require(registry.getPocket(id).lastSkippedDue == registry.getPocket(id).nextDue, "expiry skip recorded");
    }

    function testSkipOnlyOncePerDuePeriodAndDoesNotAdvanceSchedule() public {
        uint256 id = _create(1 days);
        _approve(id);
        uint64 due = registry.getPocket(id).nextDue;
        vm.prank(agent);
        registry.skipPocket(id, registry.SKIP_RATE_BELOW_FLOOR());
        require(registry.getPocket(id).nextDue == due, "skip remains due");
        _expectError("already skipped this period");
        vm.prank(agent);
        registry.skipPocket(id, registry.SKIP_RATE_BELOW_FLOOR());
    }

    function testOwnerCanRevokeAgent() public {
        uint256 id = _create(7 days);
        _approve(id);
        vm.prank(owner);
        registry.approveAgent(id, address(0), bytes32(0), 0, 0, 0, "", "");
        _expectError("not approved agent");
        vm.prank(agent);
        registry.skipPocket(id, registry.SKIP_NO_QUOTE());
    }
}
