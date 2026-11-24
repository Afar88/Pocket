// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../src/PocketRegistry.sol";

interface Vm {
    function warp(uint256) external;
    function prank(address) external;
    function expectRevert(bytes calldata) external;
}

contract PocketRegistryTest {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    PocketRegistry private registry;
    address private owner = address(0xA11CE);
    address private agent = address(0xB0B);
    address private recipient = address(0xCAFE);
    bytes32 private keyId = keccak256("session-key");

    function setUp() public {
        registry = new PocketRegistry();
        vm.warp(1_800_000_000);
    }

    function _expectError(string memory reason) private {
        vm.expectRevert(abi.encodeWithSignature("Error(string)", reason));
    }

    function _create() private returns (uint256) {
        vm.prank(owner);
        return registry.createPocket(recipient, 5_000_000, 7 days, uint64(block.timestamp), "Family");
    }

    function testCreateStoresOnlyRules() public {
        uint256 id = _create();
        PocketRegistry.Pocket memory pocket = registry.getPocket(id);
        require(pocket.owner == owner, "owner");
        require(pocket.recipient == recipient, "recipient");
        require(pocket.amountUsdt == 5_000_000, "amount");
        require(pocket.period == 7 days, "period");
        require(pocket.nextDue == block.timestamp, "due");
        require(address(registry).balance == 0, "registry must not hold funds");
    }

    function testOnlyOwnerCanUpdatePauseAndDelete() public {
        uint256 id = _create();
        _expectError("not owner");
        vm.prank(address(0xBAD));
        registry.pausePocket(id, true);

        vm.prank(owner);
        registry.pausePocket(id, true);
        require(registry.getPocket(id).paused, "paused");

        vm.prank(owner);
        registry.deletePocket(id);
        require(registry.getPocket(id).deleted, "deleted");
    }

    function testAgentMustBeApprovedAndPaymentMustBeDue() public {
        uint256 id = _create();
        _expectError("agent not approved");
        vm.prank(agent);
        registry.markPaid(id, keccak256("payment"));

        vm.prank(owner);
        registry.approveAgent(id, agent, keyId, uint64(block.timestamp + 30 days), 5_000_000, 5_000_000_000);

        vm.prank(agent);
        registry.markPaid(id, keccak256("payment"));
        PocketRegistry.Pocket memory pocket = registry.getPocket(id);
        require(pocket.nextDue == block.timestamp + 7 days, "next due advanced by one period");
    }

    function testCannotMarkPaidBeforeDue() public {
        vm.prank(owner);
        uint256 id = registry.createPocket(recipient, 1_000_000, 7 days, uint64(block.timestamp + 1 days), "Future");
        vm.prank(owner);
        registry.approveAgent(id, agent, keyId, uint64(block.timestamp + 30 days), 5_000_000, 5_000_000_000);

        _expectError("not due");
        vm.prank(agent);
        registry.markPaid(id, keccak256("early"));
    }

    function testExpiredSessionCannotMarkPaid() public {
        uint256 id = _create();
        vm.prank(owner);
        registry.approveAgent(id, agent, keyId, uint64(block.timestamp + 2), 5_000_000, 5_000_000_000);

        vm.warp(block.timestamp + 3);
        _expectError("session expired");
        vm.prank(agent);
        registry.markPaid(id, keccak256("late"));
    }

    function testPauseBlocksAgentAndOwnerCanResume() public {
        uint256 id = _create();
        vm.prank(owner);
        registry.approveAgent(id, agent, keyId, uint64(block.timestamp + 30 days), 5_000_000, 5_000_000_000);
        vm.prank(owner);
        registry.pausePocket(id, true);

        _expectError("pocket paused");
        vm.prank(agent);
        registry.recordSwap(id, keccak256("swap"));

        vm.prank(owner);
        registry.pausePocket(id, false);
        vm.prank(agent);
        registry.recordSwap(id, keccak256("swap"));
    }

    function testOwnerCanRevokeAgent() public {
        uint256 id = _create();
        vm.prank(owner);
        registry.approveAgent(id, agent, keyId, uint64(block.timestamp + 30 days), 5_000_000, 5_000_000_000);
        vm.prank(owner);
        registry.approveAgent(id, address(0), bytes32(0), 0, 0, 0);

        _expectError("agent not approved");
        vm.prank(agent);
        registry.recordSwap(id, keccak256("swap"));
    }

    function testPaymentReferenceCannotBeReplayed() public {
        uint256 id = _create();
        vm.prank(owner);
        registry.approveAgent(id, agent, keyId, uint64(block.timestamp + 30 days), 5_000_000, 5_000_000_000);
        bytes32 ref = keccak256("one-rfq");
        vm.prank(agent);
        registry.recordSwap(id, ref);
        vm.prank(agent);
        registry.markPaid(id, ref);
        _expectError("tx ref used");
        vm.prank(agent);
        registry.markPaid(id, ref);
    }
}
