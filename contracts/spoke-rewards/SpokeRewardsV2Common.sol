// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.23;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import "../bridge/BridgeMessenger.sol";
import "../bridge/interfaces/IBridgeRouter.sol";
import "../bridge/libraries/Messages.sol";
import "../spoke/interfaces/IAddressOracle.sol";
import "../spoke/SpokeState.sol";

contract SpokeRewardsV2Common is BridgeMessenger, SpokeState {
    struct PoolEpoch {
        uint8 poolId;
        uint16 epochIndex;
    }

    struct ReceiveRewardToken {
        uint8 rewardTokenId;
        uint16 returnAdapterId;
        uint256 returnGasLimit;
    }

    constructor(
        address admin,
        IBridgeRouter bridgeRouter,
        uint16 hubChainId,
        bytes32 hubContractAddress,
        IAddressOracle addressOracle
    ) BridgeMessenger(bridgeRouter) SpokeState(admin, hubChainId, hubContractAddress, addressOracle) {}

    function claimRewards(
        Messages.MessageParams calldata params,
        bytes32 accountId,
        PoolEpoch[] calldata poolEpochsToClaim,
        ReceiveRewardToken[] calldata rewardTokensToReceive
    ) external payable {
        uint256 poolEpochsToClaimLength = poolEpochsToClaim.length;
        uint256 rewardTokensToReceiveLength = rewardTokensToReceive.length;
        bytes memory data = abi.encodePacked(uint8(poolEpochsToClaimLength), uint8(rewardTokensToReceiveLength));

        for (uint256 i = 0; i < poolEpochsToClaimLength; i++) {
            data = abi.encodePacked(data, poolEpochsToClaim[i].poolId, poolEpochsToClaim[i].epochIndex);
        }
        for (uint256 i = 0; i < rewardTokensToReceiveLength; i++) {
            data = abi.encodePacked(
                data,
                rewardTokensToReceive[i].rewardTokenId,
                rewardTokensToReceive[i].returnAdapterId,
                rewardTokensToReceive[i].returnGasLimit
            );
        }

        _doOperation(params, Messages.Action.ClaimRewardsV2, accountId, data);
    }

    function _doOperation(
        Messages.MessageParams calldata params,
        Messages.Action action,
        bytes32 accountId,
        bytes memory data
    ) internal {
        // check sender is eligible to do given action
        if (!_addressOracle.isEligible(msg.sender, uint16(action)))
            revert IAddressOracle.AddressIneligible(msg.sender, uint16(action));

        // construct message
        Messages.MessageToSend memory message = Messages.MessageToSend({
            params: params,
            sender: Messages.convertEVMAddressToGenericAddress(address(this)),
            destinationChainId: _hub.chainId,
            handler: _hub.contractAddress,
            payload: Messages.encodeMessagePayload(
                Messages.MessagePayload({
                    action: action,
                    accountId: accountId,
                    userAddress: Messages.convertEVMAddressToGenericAddress(msg.sender),
                    data: data
                })
            ),
            finalityLevel: 0, // immediate
            extraArgs: ""
        });

        // send message
        _sendMessage(message, msg.value);
    }

    function _receiveMessage(Messages.MessageReceived memory message) internal pure override {
        revert CannotReceiveMessage(message.messageId);
    }

    function _retryMessage(Messages.MessageReceived memory message, address, bytes memory) internal pure override {
        revert CannotRetryMessage(message.messageId);
    }

    function _reverseMessage(Messages.MessageReceived memory message, address, bytes memory) internal pure override {
        revert CannotReverseMessage(message.messageId);
    }
}
