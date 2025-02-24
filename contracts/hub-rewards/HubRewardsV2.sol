// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.23;

import "@openzeppelin/contracts/access/extensions/AccessControlDefaultAdminRules.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";

import "../bridge/BridgeMessenger.sol";
import "../bridge/interfaces/IBridgeRouter.sol";
import "../bridge/libraries/Messages.sol";
import "../hub/interfaces/IAccountManager.sol";
import "../hub/interfaces/ISpokeManager.sol";
import "../hub/LoanManager.sol";

contract HubRewardsV2 is AccessControlDefaultAdminRules, BridgeMessenger {
    using BytesLib for bytes;

    struct PoolEpoch {
        uint8 poolId;
        uint16 epochIndex;
    }

    struct RewardToken {
        uint16 chainId;
        bytes32 spokeAddress;
    }

    struct EpochReward {
        uint8 rewardTokenId;
        uint256 totalRewards;
    }

    struct Epoch {
        uint256 start; // UNIX timestamp
        uint256 end; // UNIX timestamp
        EpochReward[] rewards;
    }

    error RewardAlreadyAdded(uint8 rewardTokenId);
    error UnknownReward(uint8 rewardTokenId);
    error PossibleDuplicateReward(uint8 rewardTokenId);
    error InvalidEpochStart(uint8 poolId, uint256 min, uint256 newEpochStart);
    error InvalidEpochLength(uint256 length, uint256 bound);
    error TooManyEpochRewards(uint256 length, uint256 bound);
    error CannotUpdateExpiredEpoch(uint8 poolId, uint16 epoch, uint256 expired);
    error CannotUpdateIncorrectReward(uint8 expectedRewardTokenId, uint8 actualRewardTokenId);
    error EpochNotActive(uint8 poolId, uint16 epochIndex);
    error EpochNotEnded(uint8 poolId, uint16 epoch, uint256 end);
    error SpokeUnknown(uint16 chainId, bytes32 addr);

    event RewardTokenAdded(uint8 rewardTokenId, uint16 chainId, bytes32 spokeAddress);
    event EpochRewardAdded(uint8 poolId, uint16 epochIndex, uint8 rewardTokenId, uint256 totalRewards);
    event EpochAdded(uint8 poolId, uint16 epochIndex, uint256 start, uint256 end);
    event EpochTotalRewardsUpdated(uint8 poolId, uint16 epochIndex, uint8 rewardTokenId, uint256 totalRewards);
    event RewardsClaimed(bytes32 accountId, uint8 rewardTokenId, uint256 amount);

    bytes32 public constant LISTING_ROLE = keccak256("LISTING");

    mapping(uint8 rewardTokenId => RewardToken) public rewardTokens;
    mapping(bytes32 accountId => mapping(uint8 rewardTokenId => uint256 amount)) public accountUnclaimedRewards;

    mapping(uint8 poolId => uint16 epochIndex) public poolEpochIndex;
    mapping(uint8 poolId => mapping(uint16 epochIndex => Epoch)) internal poolEpochs;
    mapping(uint8 poolId => mapping(uint16 epochIndex => uint256 points)) public poolTotalEpochPoints;

    mapping(bytes32 accountId => mapping(uint8 poolId => uint256 points)) public accountLastUpdatedPoints;
    mapping(bytes32 accountId => mapping(uint8 poolId => mapping(uint16 epochIndex => uint256 points)))
        public accountEpochPoints;

    ISpokeManager public immutable spokeManager;
    IAccountManager public immutable accountManager;
    LoanManager public immutable loanManager;
    uint16 public immutable hubChainId;

    constructor(
        address admin,
        IBridgeRouter bridgeRouter,
        ISpokeManager spokeManager_,
        IAccountManager accountManager_,
        LoanManager loanManager_,
        uint16 hubChainId_
    ) AccessControlDefaultAdminRules(1 days, admin) BridgeMessenger(bridgeRouter) {
        spokeManager = spokeManager_;
        accountManager = accountManager_;
        loanManager = loanManager_;
        hubChainId = hubChainId_;

        // initialise role to update parameters
        _grantRole(LISTING_ROLE, admin);
    }

    function addRewardToken(uint8 rewardTokenId, uint16 chainId, bytes32 spokeAddress) external onlyRole(LISTING_ROLE) {
        if (isRewardAdded(rewardTokenId)) revert RewardAlreadyAdded(rewardTokenId);
        rewardTokens[rewardTokenId] = RewardToken({ chainId: chainId, spokeAddress: spokeAddress });

        emit RewardTokenAdded(rewardTokenId, chainId, spokeAddress);
    }

    function addEpoch(
        uint8 poolId,
        uint256 start,
        uint256 end,
        EpochReward[] calldata rewards
    ) external onlyRole(LISTING_ROLE) {
        // must start later than last epoch end
        uint16 epochIndex = poolEpochIndex[poolId];
        uint256 previousEpochEnd = poolEpochs[poolId][epochIndex].end;
        if (start <= previousEpochEnd) revert InvalidEpochStart(poolId, previousEpochEnd, start);
        if (start < block.timestamp) revert InvalidEpochStart(poolId, block.timestamp, start);

        // must be between 1 day and 4 weeks - panic with underflow if start after end
        uint256 length = end - start;
        if (length < 1 days) revert InvalidEpochLength(length, 1 days);
        if (length > 4 weeks) revert InvalidEpochLength(length, 4 weeks);

        // add epoch times but not epoch rewards - cannot directly assign a memory array to a storage array
        uint16 newEpochIndex = epochIndex + 1;
        poolEpochIndex[poolId] = newEpochIndex;
        Epoch storage epoch = poolEpochs[poolId][newEpochIndex];
        epoch.start = start;
        epoch.end = end;

        // max 5 rewards, and each reward must exist and be unique
        if (rewards.length > 5) revert TooManyEpochRewards(5, rewards.length);
        for (uint256 i = 0; i < rewards.length; i++) {
            EpochReward memory reward = rewards[i];
            uint8 rewardTokenId = reward.rewardTokenId;
            if (!isRewardAdded(rewardTokenId)) revert UnknownReward(rewardTokenId);

            // we can guarantee no duplicates if array is ordered
            if (i > 0 && rewardTokenId <= rewards[i - 1].rewardTokenId) revert PossibleDuplicateReward(rewardTokenId);

            // add epoch rewards
            epoch.rewards.push(reward);

            emit EpochRewardAdded(poolId, newEpochIndex, rewardTokenId, reward.totalRewards);
        }

        emit EpochAdded(poolId, newEpochIndex, start, end);
    }

    function updateEpochTotalRewards(
        PoolEpoch calldata poolEpoch,
        uint8 rewardIndex,
        uint8 rewardTokenId,
        uint256 totalRewards
    ) external onlyRole(LISTING_ROLE) {
        uint8 poolId = poolEpoch.poolId;
        uint16 epochIndex = poolEpoch.epochIndex;
        Epoch storage epoch = poolEpochs[poolId][epochIndex];

        // must be before epoch end
        uint256 epochEnd = epoch.end;
        if (block.timestamp >= epochEnd) revert CannotUpdateExpiredEpoch(poolId, epochIndex, epochEnd);

        // update epoch
        EpochReward storage reward = epoch.rewards[rewardIndex];
        if (reward.rewardTokenId != rewardTokenId)
            revert CannotUpdateIncorrectReward(rewardTokenId, reward.rewardTokenId);
        reward.totalRewards = totalRewards;

        emit EpochTotalRewardsUpdated(poolId, epochIndex, rewardTokenId, totalRewards);
    }

    function updateAccountPoints(bytes32[] calldata accountIds, PoolEpoch[] calldata poolEpochsToUpdate) external {
        for (uint256 i = 0; i < poolEpochsToUpdate.length; i++) {
            uint8 poolId = poolEpochsToUpdate[i].poolId;
            uint16 epochIndex = poolEpochsToUpdate[i].epochIndex;
            uint256 totalPointsDelta = 0;

            // must be active epoch
            Epoch memory epoch = poolEpochs[poolId][epochIndex];
            if (block.timestamp < epoch.start || block.timestamp >= epoch.end)
                revert EpochNotActive(poolId, epochIndex);

            // update points for given account
            for (uint256 j = 0; j < accountIds.length; j++) {
                bytes32 accountId = accountIds[j];
                uint256 newPoints = loanManager.getUserPoolRewards(accountId, poolId).collateral;

                uint256 pointsDelta = newPoints - accountLastUpdatedPoints[accountId][poolId];
                totalPointsDelta += pointsDelta;
                accountEpochPoints[accountId][poolId][epochIndex] += pointsDelta;
                accountLastUpdatedPoints[accountId][poolId] = newPoints;
            }

            // update total points across all accounts
            poolTotalEpochPoints[poolId][epochIndex] += totalPointsDelta;
        }
    }

    function getUnclaimedRewards(
        bytes32 accountId,
        PoolEpoch[] calldata poolEpochsToClaim,
        uint8 rewardTokenId
    ) external view returns (uint256) {
        uint256 amount = accountUnclaimedRewards[accountId][rewardTokenId];

        // add rewards from pool epochs to claim
        for (uint256 i = 0; i < poolEpochsToClaim.length; i++) {
            uint8 poolId = poolEpochsToClaim[i].poolId;
            uint16 epochIndex = poolEpochsToClaim[i].epochIndex;
            uint256 epochEnd = poolEpochs[poolId][epochIndex].end;
            EpochReward[] memory epochRewards = poolEpochs[poolId][epochIndex].rewards;

            if (block.timestamp < epochEnd) revert EpochNotEnded(poolId, epochIndex, epochEnd);

            // for each reward token, add to account unclaimed rewards
            uint256 accountPoints = accountEpochPoints[accountId][poolId][epochIndex];
            uint256 totalPoints = poolTotalEpochPoints[poolId][epochIndex];

            if (accountPoints > 0) {
                for (uint256 j = 0; j < epochRewards.length; j++) {
                    if (rewardTokenId == epochRewards[j].rewardTokenId) {
                        uint256 totalRewards = epochRewards[j].totalRewards;
                        amount += Math.mulDiv(accountPoints, totalRewards, totalPoints);
                    }
                }
            }
        }

        return amount;
    }

    function getActivePoolEpoch(uint8 poolId) external view returns (uint16 epochIndex, Epoch memory epoch) {
        for (epochIndex = poolEpochIndex[poolId]; epochIndex >= 1; epochIndex--) {
            epoch = poolEpochs[poolId][epochIndex];
            // must be before end
            if (epoch.end <= block.timestamp) revert EpochNotActive(poolId, epochIndex);
            // match if after start
            if (epoch.start <= block.timestamp) break;
        }

        // check if failed to find active epoch
        if (epochIndex == 0) revert EpochNotActive(poolId, epochIndex);
    }

    // replaces the default public mapping getter since it wouldn't include nested array
    function getPoolEpoch(uint8 poolId, uint16 epochIndex) external view returns (Epoch memory) {
        return poolEpochs[poolId][epochIndex];
    }

    function isRewardAdded(uint8 rewardTokenId) public view returns (bool) {
        return rewardTokens[rewardTokenId].spokeAddress != "";
    }

    function _receiveMessage(Messages.MessageReceived memory message) internal override {
        Messages.MessagePayload memory payload = Messages.decodeActionPayload(message.payload);

        // ensure message sender is recognised
        bool isSpoke = spokeManager.isSpoke(message.sourceChainId, message.sourceAddress);
        if (!isSpoke) revert SpokeUnknown(message.sourceChainId, message.sourceAddress);

        // check sender has permission for relevant operations
        bool isRegistered = accountManager.isAddressRegisteredToAccount(
            payload.accountId,
            message.sourceChainId,
            payload.userAddress
        );
        if (!isRegistered)
            revert IAccountManager.NotRegisteredToAccount(
                payload.accountId,
                message.sourceChainId,
                payload.userAddress
            );

        // check payload
        if (payload.action != Messages.Action.ClaimRewardsV2) revert CannotReceiveMessage(message.messageId);
        uint256 index = 0;
        uint8 poolEpochsToClaimLength = payload.data.toUint8(index);
        index += 1;
        uint8 rewardTokensToReceiveLength = payload.data.toUint8(index);
        index += 1;

        // calculate total rewards to claim and reset
        for (uint256 i = 0; i < poolEpochsToClaimLength; i++) {
            uint8 poolId = payload.data.toUint8(index);
            index += 1;
            uint16 epochIndex = payload.data.toUint16(index);
            index += 2;

            uint256 epochEnd = poolEpochs[poolId][epochIndex].end;
            EpochReward[] memory epochRewards = poolEpochs[poolId][epochIndex].rewards;

            if (block.timestamp < epochEnd) revert EpochNotEnded(poolId, epochIndex, epochEnd);

            // for each reward token, add to account unclaimed rewards
            bytes32 accountId = payload.accountId; // avoid stack too deep error
            uint256 accountPoints = accountEpochPoints[accountId][poolId][epochIndex];
            uint256 totalPoints = poolTotalEpochPoints[poolId][epochIndex];

            if (accountPoints > 0) {
                for (uint256 j = 0; j < epochRewards.length; j++) {
                    uint8 rewardTokenId = epochRewards[j].rewardTokenId;
                    uint256 totalRewards = epochRewards[j].totalRewards;
                    accountUnclaimedRewards[accountId][rewardTokenId] += Math.mulDiv(
                        accountPoints,
                        totalRewards,
                        totalPoints
                    );
                }
            }

            // ensure cannot claim rewards multiple times on same pool epoch
            delete accountEpochPoints[accountId][poolId][epochIndex];
        }

        // send balance to user
        for (uint256 i = 0; i < rewardTokensToReceiveLength; i++) {
            uint8 rewardTokenId = payload.data.toUint8(index);
            index += 1;
            uint16 adapterId = payload.data.toUint16(index);
            index += 2;
            uint256 gasLimit = payload.data.toUint256(index);
            index += 32;

            bytes32 accountId = payload.accountId; // avoid stack too deep error
            uint16 chainId = rewardTokens[rewardTokenId].chainId;
            bytes32 spokeAddress = rewardTokens[rewardTokenId].spokeAddress;
            bytes32 recipient = accountManager.getAddressRegisteredToAccountOnChain(accountId, chainId);
            uint256 amount = accountUnclaimedRewards[accountId][rewardTokenId];

            // ensure cannot claim rewards multiple times on same reward token
            delete accountUnclaimedRewards[accountId][rewardTokenId];

            // construct message
            Messages.MessageToSend memory messageToSend = Messages.MessageToSend({
                params: Messages.MessageParams({
                    adapterId: adapterId,
                    returnAdapterId: 0,
                    receiverValue: 0,
                    gasLimit: gasLimit,
                    returnGasLimit: 0
                }),
                sender: Messages.convertEVMAddressToGenericAddress(address(this)),
                destinationChainId: chainId,
                handler: spokeAddress,
                payload: Messages.encodeMessagePayload(
                    Messages.MessagePayload({
                        action: Messages.Action.SendToken,
                        accountId: accountId,
                        userAddress: recipient,
                        data: abi.encodePacked(amount)
                    })
                ),
                finalityLevel: 1, // finalised
                extraArgs: ""
            });

            // msg.value passed only once and covers all messages
            uint256 feeAmount = 0;
            if (i == 0) feeAmount = msg.value;

            // send message
            _sendMessage(messageToSend, feeAmount);

            emit RewardsClaimed(accountId, rewardTokenId, amount);
        }
    }

    function _retryMessage(Messages.MessageReceived memory message, address, bytes memory) internal pure override {
        revert CannotRetryMessage(message.messageId);
    }

    function _reverseMessage(Messages.MessageReceived memory message, address, bytes memory) internal pure override {
        revert CannotReverseMessage(message.messageId);
    }
}
