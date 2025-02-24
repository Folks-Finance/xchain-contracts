// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.23;

import "@solidity-bytes-utils/contracts/BytesLib.sol";

library Messages {
    using BytesLib for bytes;

    error InvalidExtraArgsTag();

    struct MessageParams {
        uint16 adapterId; // where to route message through
        uint16 returnAdapterId; // if applicable, where to route message through for return message
        uint256 receiverValue; // amount of value to attach for receive message
        uint256 gasLimit; // gas limit for receive message
        uint256 returnGasLimit; // if applicable, gas limit for return message
    }

    struct MessageToSend {
        Messages.MessageParams params; // message parameters
        bytes32 sender; // source address which sent the message
        uint16 destinationChainId; // chain to send message to
        bytes32 handler; // address to handle the message received
        bytes payload; // message payload
        uint64 finalityLevel; // zero for immediate, non-zero for finalised
        bytes extraArgs;
    }

    // bytes4(keccak256("Folks ExtraArgsV1));
    bytes4 public constant EXTRA_ARGS_V1_TAG = 0x1b366e79;
    struct ExtraArgsV1 {
        bytes32 token;
        bytes32 recipient;
        uint256 amount;
    }

    function extraArgsToBytes(ExtraArgsV1 memory extraArgs) internal pure returns (bytes memory bts) {
        return abi.encodeWithSelector(EXTRA_ARGS_V1_TAG, extraArgs);
    }

    function bytesToExtraArgs(bytes calldata bts) internal pure returns (Messages.ExtraArgsV1 memory extraArgs) {
        if (bts.length > 0) {
            if (bytes4(bts) != EXTRA_ARGS_V1_TAG) revert InvalidExtraArgsTag();
            extraArgs = abi.decode(bts[4:], (Messages.ExtraArgsV1));
        }
    }

    struct MessageReceived {
        bytes32 messageId; // uniquie identifier for message when combined with adapter id
        uint16 sourceChainId; // chain where message is sent from
        bytes32 sourceAddress; // address where message is sent from (e.g. spoke)
        bytes32 handler; // address of smart contract (which inherits from BridgeMessenger) to handle message received
        bytes payload; // message payload
        uint16 returnAdapterId; // if applicable, where to route message through for return message
        uint256 returnGasLimit; // if applicable, gas limit for return message
    }

    function convertEVMAddressToGenericAddress(address addr) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(addr)));
    }

    function convertGenericAddressToEVMAddress(bytes32 addr) internal pure returns (address) {
        return address(uint160(uint256(addr)));
    }

    enum Action {
        // SPOKE -> HUB
        CreateAccount,
        InviteAddress,
        AcceptInviteAddress,
        UnregisterAddress,
        AddDelegate,
        RemoveDelegate,
        CreateLoan,
        DeleteLoan,
        CreateLoanAndDeposit,
        Deposit,
        DepositFToken,
        Withdraw,
        WithdrawFToken,
        Borrow,
        Repay,
        RepayWithCollateral,
        Liquidate,
        SwitchBorrowType,
        // HUB -> SPOKE
        SendToken,
        // ADDITIONAL
        ClaimRewardsV2,
        P20,
        P21,
        P22,
        P23,
        P24,
        P25,
        P26,
        P27,
        P28,
        P29,
        P30,
        P31,
        P32,
        P33,
        P34,
        P35,
        P36,
        P37,
        P38,
        P39,
        P40,
        P41,
        P42,
        P43,
        P44,
        P45,
        P46,
        P47,
        P48,
        P49,
        P50,
        P51,
        P52,
        P53,
        P54,
        P55,
        P56,
        P57,
        P58,
        P59,
        P60,
        P61,
        P62,
        P63
    }

    struct MessagePayload {
        Action action;
        bytes32 accountId;
        bytes32 userAddress;
        bytes data;
    }

    function encodeMessagePayload(MessagePayload memory payload) internal pure returns (bytes memory) {
        return abi.encodePacked(uint16(payload.action), payload.accountId, payload.userAddress, payload.data);
    }

    function decodeActionPayload(bytes memory serialized) internal pure returns (MessagePayload memory payload) {
        uint256 index = 0;
        payload.action = Action(serialized.toUint16(index));
        index += 2;
        payload.accountId = serialized.toBytes32(index);
        index += 32;
        payload.userAddress = serialized.toBytes32(index);
        index += 32;
        payload.data = serialized.slice(index, serialized.length - index);
    }

    struct MessageMetadata {
        uint16 returnAdapterId;
        uint256 returnGasLimit;
        bytes32 sender;
        bytes32 handler;
    }

    function encodePayloadWithMetadata(Messages.MessageToSend memory message) internal pure returns (bytes memory) {
        return
            abi.encodePacked(
                message.params.returnAdapterId,
                message.params.returnGasLimit,
                message.sender,
                message.handler,
                message.payload
            );
    }

    function decodePayloadWithMetadata(
        bytes memory serialized
    ) internal pure returns (MessageMetadata memory metadata, bytes memory payload) {
        uint256 index = 0;
        metadata.returnAdapterId = serialized.toUint16(index);
        index += 2;
        metadata.returnGasLimit = serialized.toUint256(index);
        index += 32;
        metadata.sender = serialized.toBytes32(index);
        index += 32;
        metadata.handler = serialized.toBytes32(index);
        index += 32;
        payload = serialized.slice(index, serialized.length - index);
    }
}
