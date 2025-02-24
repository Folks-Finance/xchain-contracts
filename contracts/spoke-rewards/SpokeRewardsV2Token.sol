// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.23;

import "@solidity-bytes-utils/contracts/BytesLib.sol";

import "../bridge/BridgeMessenger.sol";
import "../bridge/interfaces/IBridgeRouter.sol";
import "../spoke/interfaces/IAddressOracle.sol";
import "../spoke/SpokeState.sol";

abstract contract SpokeRewardsV2Token is BridgeMessenger, SpokeState {
    using BytesLib for bytes;

    error HubUnknown(uint16 chainId, bytes32 addr);

    event Funded(uint256 amount);

    constructor(
        address admin,
        IBridgeRouter bridgeRouter,
        uint16 hubChainId,
        bytes32 hubContractAddress,
        IAddressOracle addressOracle
    ) BridgeMessenger(bridgeRouter) SpokeState(admin, hubChainId, hubContractAddress, addressOracle) {}

    /**
     * @notice Send token from Spoke to recipient
     * @param recipient The token recipient
     * @param amount The amount of token to send
     */
    function _sendToken(address recipient, uint256 amount) internal virtual;

    function _receiveMessage(Messages.MessageReceived memory message) internal override {
        Messages.MessagePayload memory payload = Messages.decodeActionPayload(message.payload);

        // ensure message sender is recognised
        bool isHub = message.sourceChainId == _hub.chainId && message.sourceAddress == _hub.contractAddress;
        if (!isHub) revert HubUnknown(message.sourceChainId, message.sourceAddress);

        // switch on payload action
        uint256 index = 0;
        if (payload.action == Messages.Action.SendToken) {
            address recipient = Messages.convertGenericAddressToEVMAddress(payload.userAddress);
            uint256 amount = payload.data.toUint256(index);

            // send token to user
            _sendToken(recipient, amount);
        } else {
            revert CannotReceiveMessage(message.messageId);
        }
    }

    function _retryMessage(Messages.MessageReceived memory message, address, bytes memory) internal override {
        return _receiveMessage(message);
    }

    function _reverseMessage(Messages.MessageReceived memory message, address, bytes memory) internal pure override {
        revert CannotReverseMessage(message.messageId);
    }
}
