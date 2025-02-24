// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.23;

import "@openzeppelin/contracts/access/extensions/AccessControlDefaultAdminRules.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";

import "../bridge/libraries/Messages.sol";
import "../hub/interfaces/IAccountManager.sol";
import "../hub/LoanManager.sol";

contract RewardsV1 is AccessControlDefaultAdminRules {
    struct PoolEpoch {
        uint8 poolId;
        uint16 epochIndex;
    }

    struct Epoch {
        uint256 start; // UNIX timestamp
        uint256 end; // UNIX timestamp
        uint256 totalRewards; // in native gas token
    }

    error InvalidEpochStart(uint8 poolId, uint256 previousEpochEnd, uint256 newEpochStart);
    error InvalidEpochLength(uint256 length, uint256 minimum);
    error CannotUpdateExpiredEpoch(uint8 poolId, uint16 epoch, uint256 expired);
    error EpochNotActive(uint8 poolId, uint16 epochIndex);
    error EpochNotEnded(uint8 poolId, uint16 epoch, uint256 end);
    error FailedToClaimRewards(address receiver, uint256 amount);

    event Funded(uint256 amount);
    event EpochAdded(uint8 poolId, uint256 start, uint256 end, uint256 totalRewards, uint16 epochIndex);
    event EpochUpdated(uint8 poolId, uint16 epochIndex, uint256 totalRewards);
    event RewardsClaimed(bytes32 accountId, address receiver, uint256 amount);

    bytes32 public constant LISTING_ROLE = keccak256("LISTING");

    mapping(uint8 poolId => uint16 epochIndex) public poolEpochIndex;
    mapping(uint8 poolId => mapping(uint16 epochIndex => Epoch)) public poolEpochs;
    mapping(uint8 poolId => mapping(uint16 epochIndex => uint256 points)) public poolTotalEpochPoints;

    mapping(bytes32 accountId => mapping(uint8 poolId => uint256 points)) public accountLastUpdatedPoints;
    mapping(bytes32 accountId => mapping(uint8 poolId => mapping(uint16 epochIndex => uint256 points)))
        public accountEpochPoints;

    IAccountManager public immutable accountManager;
    LoanManager public immutable loanManager;
    uint16 public immutable hubChainId;

    constructor(
        address admin,
        IAccountManager accountManager_,
        LoanManager loanManager_,
        uint16 hubChainId_
    ) AccessControlDefaultAdminRules(1 days, admin) {
        accountManager = accountManager_;
        loanManager = loanManager_;
        hubChainId = hubChainId_;

        // initialise role to update parameters
        _grantRole(LISTING_ROLE, admin);
    }

    function fund() external payable {
        emit Funded(msg.value);
    }

    function addEpoch(uint8 poolId, uint256 start, uint256 end, uint256 totalRewards) external onlyRole(LISTING_ROLE) {
        // must start later than last epoch end
        uint16 epochIndex = poolEpochIndex[poolId];
        uint256 previousEpochEnd = poolEpochs[poolId][epochIndex].end;
        if (start <= previousEpochEnd) revert InvalidEpochStart(poolId, previousEpochEnd, start);

        // must last more than one day - panic with underflow if start after end
        uint256 length = end - start;
        if (length < 1 days) revert InvalidEpochLength(length, 1 days);

        // add epoch
        uint16 newEpochIndex = epochIndex + 1;
        poolEpochIndex[poolId] = newEpochIndex;
        poolEpochs[poolId][newEpochIndex] = Epoch({ start: start, end: end, totalRewards: totalRewards });

        emit EpochAdded(poolId, start, end, totalRewards, newEpochIndex);
    }

    function updateEpochTotalRewards(
        PoolEpoch calldata poolEpoch,
        uint256 totalRewards
    ) external onlyRole(LISTING_ROLE) {
        uint8 poolId = poolEpoch.poolId;
        uint16 epochIndex = poolEpoch.epochIndex;

        // must be before epoch end
        uint256 epochEnd = poolEpochs[poolId][epochIndex].end;
        if (block.timestamp >= epochEnd) revert CannotUpdateExpiredEpoch(poolId, epochIndex, epochEnd);

        // update epoch
        poolEpochs[poolId][epochIndex].totalRewards = totalRewards;

        emit EpochUpdated(poolId, epochIndex, totalRewards);
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

    function claimRewards(bytes32 accountId, PoolEpoch[] calldata poolEpochsToClaim, address receiver) external {
        // check sender has permission to claim rewards for the account
        verifySenderPermissionOnHub(accountId);

        // calculate total rewards to claim and reset
        uint256 amount = 0;
        for (uint256 i = 0; i < poolEpochsToClaim.length; i++) {
            uint8 poolId = poolEpochsToClaim[i].poolId;
            uint16 epochIndex = poolEpochsToClaim[i].epochIndex;
            amount += rewardToClaim(accountId, poolId, epochIndex);
            delete accountEpochPoints[accountId][poolId][epochIndex];
        }

        // send balance to user
        (bool sent, ) = receiver.call{ value: amount }("");
        if (!sent) revert FailedToClaimRewards(receiver, amount);

        emit RewardsClaimed(accountId, receiver, amount);
    }

    function getActiveEpoch(uint8 poolId) external view returns (uint16 epochIndex, Epoch memory epoch) {
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

    function getUnclaimedRewards(
        bytes32 accountId,
        PoolEpoch[] calldata poolEpochsToClaim
    ) external view returns (uint256) {
        uint256 amount = 0;
        for (uint256 i = 0; i < poolEpochsToClaim.length; i++) {
            uint8 poolId = poolEpochsToClaim[i].poolId;
            uint16 epochIndex = poolEpochsToClaim[i].epochIndex;
            amount += rewardToClaim(accountId, poolId, epochIndex);
        }
        return amount;
    }

    function rewardToClaim(bytes32 accountId, uint8 poolId, uint16 epochIndex) internal view returns (uint256) {
        uint256 epochEnd = poolEpochs[poolId][epochIndex].end;
        uint256 totalRewards = poolEpochs[poolId][epochIndex].totalRewards;
        if (block.timestamp < epochEnd) revert EpochNotEnded(poolId, epochIndex, epochEnd);

        uint256 accountPoints = accountEpochPoints[accountId][poolId][epochIndex];
        uint256 totalPoints = poolTotalEpochPoints[poolId][epochIndex];
        return Math.mulDiv(accountPoints, totalRewards, totalPoints);
    }

    function verifySenderPermissionOnHub(bytes32 accountId) internal view {
        bool isRegistered = accountManager.isAddressRegisteredToAccount(
            accountId,
            hubChainId,
            Messages.convertEVMAddressToGenericAddress(msg.sender)
        );
        bool isDelegate = accountManager.isDelegate(accountId, msg.sender);
        if (!(isRegistered || isDelegate)) revert IAccountManager.NoPermissionOnHub(accountId, msg.sender);
    }
}
