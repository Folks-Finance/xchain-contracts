import { expect } from "chai";
import { ethers } from "hardhat";
import { PANIC_CODES } from "@nomicfoundation/hardhat-chai-matchers/panic";
import {
  impersonateAccount,
  loadFixture,
  reset,
  setBalance,
  time,
} from "@nomicfoundation/hardhat-toolbox/network-helpers";
import {
  LoanManagerStateExposed__factory,
  MockAccountManager__factory,
  HubRewardsV2__factory,
  BridgeRouterReceiver__factory,
  MockSpokeManager__factory,
} from "../../typechain-types";
import { UserPoolRewards } from "../hub/libraries/assets/loanData";
import {
  BYTES32_LENGTH,
  convertEVMAddressToGenericAddress,
  convertNumberToBytes,
  convertStringToBytes,
  getAccountIdBytes,
  getEmptyBytes,
  getRandomAddress,
  getRandomBytes,
  UINT16_LENGTH,
  UINT256_LENGTH,
  UINT8_LENGTH,
} from "../utils/bytes";
import {
  Action,
  buildMessagePayload,
  Finality,
  MessageParams,
  MessageReceived,
  MessageToSend,
} from "../utils/messages/messages";
import { SECONDS_IN_DAY, getLatestBlockTimestamp, getRandomInt } from "../utils/time";

const ONE_DAY = BigInt(86400);
const ONE_WEEK = ONE_DAY * BigInt(7);

interface PoolEpoch {
  poolId: number;
  epochIndex: number;
}

interface ReceiveRewardToken {
  rewardTokenId: bigint;
  returnAdapterId: bigint;
  returnGasLimit: bigint;
}

interface EpochReward {
  rewardTokenId: number;
  totalRewards: bigint;
}

interface Epoch {
  start: bigint;
  end: bigint;
  rewards: EpochReward[];
}

const getSendTokenMessage = (
  accountId: string,
  adapterId: bigint,
  gasLimit: bigint,
  hubRewardsV2Address: string,
  spokeChainId: bigint,
  spokeAddress: string,
  recipientAddress: string,
  amount: number | bigint
): MessageToSend => {
  const params: MessageParams = {
    adapterId: adapterId,
    returnAdapterId: BigInt(0),
    receiverValue: BigInt(0),
    gasLimit: gasLimit,
    returnGasLimit: BigInt(0),
  };
  const message: MessageToSend = {
    params: params,
    sender: convertEVMAddressToGenericAddress(hubRewardsV2Address),
    destinationChainId: BigInt(spokeChainId),
    handler: convertEVMAddressToGenericAddress(spokeAddress),
    payload: buildMessagePayload(
      Action.SendToken,
      accountId,
      recipientAddress,
      convertNumberToBytes(amount, UINT256_LENGTH)
    ),
    finalityLevel: Finality.FINALISED,
    extraArgs: "0x",
  };
  return message;
};

const getClaimRewardsMessage = (
  spokeChainId: number | bigint,
  spokeAddress: string,
  hubAddress: string,
  accountId: string,
  userAddr: string,
  poolEpochsToClaim: PoolEpoch[],
  rewardTokensToReceive: ReceiveRewardToken[]
): MessageReceived => ({
  messageId: getRandomBytes(BYTES32_LENGTH),
  sourceChainId: BigInt(spokeChainId),
  sourceAddress: convertEVMAddressToGenericAddress(spokeAddress),
  handler: convertEVMAddressToGenericAddress(hubAddress),
  payload: buildMessagePayload(
    Action.ClaimRewardsV2,
    accountId,
    userAddr,
    ethers.concat([
      convertNumberToBytes(poolEpochsToClaim.length, UINT8_LENGTH),
      convertNumberToBytes(rewardTokensToReceive.length, UINT8_LENGTH),
      ...poolEpochsToClaim.flatMap(({ poolId, epochIndex }) => [
        convertNumberToBytes(poolId, UINT8_LENGTH),
        convertNumberToBytes(epochIndex, UINT16_LENGTH),
      ]),
      ...rewardTokensToReceive.flatMap(({ rewardTokenId, returnAdapterId, returnGasLimit }) => [
        convertNumberToBytes(rewardTokenId, UINT8_LENGTH),
        convertNumberToBytes(returnAdapterId, UINT16_LENGTH),
        convertNumberToBytes(returnGasLimit, UINT256_LENGTH),
      ]),
    ])
  ),
  returnAdapterId: BigInt(0),
  returnGasLimit: BigInt(0),
});

describe("HubRewardsV2 (unit tests)", () => {
  const DEFAULT_ADMIN_ROLE = getEmptyBytes(BYTES32_LENGTH);
  const LISTING_ROLE = ethers.keccak256(convertStringToBytes("LISTING"));

  async function deployHubRewardsV2Fixture() {
    const [admin, relayer, user, ...unusedUsers] = await ethers.getSigners();

    // common params
    const hubChainId = 1;
    const spokeChainId = 3;
    const spokeAddress = getRandomAddress();

    // deploy contract
    const bridgeRouter = await new BridgeRouterReceiver__factory(relayer).deploy();
    const spokeManager = await new MockSpokeManager__factory(user).deploy();
    const accountManager = await new MockAccountManager__factory(user).deploy();
    const loanManager = await new LoanManagerStateExposed__factory(user).deploy(admin, getRandomAddress());
    const hubRewardsV2 = await new HubRewardsV2__factory(user).deploy(
      admin,
      bridgeRouter,
      spokeManager,
      accountManager,
      loanManager,
      hubChainId
    );
    const hubRewardsV2Address = await hubRewardsV2.getAddress();

    // impersonate bridge router
    const bridgeRouterAddress = await bridgeRouter.getAddress();
    impersonateAccount(bridgeRouterAddress);
    const bridgeRouterSigner = await ethers.getSigner(bridgeRouterAddress);

    return {
      admin,
      user,
      unusedUsers,
      hubRewardsV2,
      hubRewardsV2Address,
      bridgeRouter,
      bridgeRouterAddress,
      bridgeRouterSigner,
      spokeManager,
      accountManager,
      loanManager,
      hubChainId,
      spokeChainId,
      spokeAddress,
    };
  }

  async function addRewardTokensFixture() {
    const {
      admin,
      user,
      unusedUsers,
      hubRewardsV2,
      hubRewardsV2Address,
      bridgeRouter,
      spokeManager,
      accountManager,
      loanManager,
      hubChainId,
      spokeChainId,
      spokeAddress,
    } = await loadFixture(deployHubRewardsV2Fixture);

    // define reward tokens
    const rewardTokens = [
      { rewardTokenId: 0, chainId: spokeChainId, spokeAddress: convertEVMAddressToGenericAddress(getRandomAddress()) },
      { rewardTokenId: 2, chainId: hubChainId, spokeAddress: convertEVMAddressToGenericAddress(getRandomAddress()) },
      { rewardTokenId: 5, chainId: spokeChainId, spokeAddress: convertEVMAddressToGenericAddress(getRandomAddress()) },
    ];

    // add reward tokens
    const addRewardTokens = [];
    for (const { rewardTokenId, chainId, spokeAddress } of rewardTokens) {
      const addRewardToken = await hubRewardsV2.connect(admin).addRewardToken(rewardTokenId, chainId, spokeAddress);
      addRewardTokens.push(addRewardToken);
    }

    return {
      admin,
      user,
      unusedUsers,
      hubRewardsV2,
      hubRewardsV2Address,
      bridgeRouter,
      spokeManager,
      accountManager,
      loanManager,
      hubChainId,
      spokeChainId,
      spokeAddress,
      addRewardTokens,
      rewardTokens,
    };
  }

  async function addEpochFixture() {
    const {
      admin,
      user,
      unusedUsers,
      hubRewardsV2,
      hubRewardsV2Address,
      bridgeRouter,
      spokeManager,
      accountManager,
      loanManager,
      hubChainId,
      spokeChainId,
      spokeAddress,
      rewardTokens,
    } = await loadFixture(addRewardTokensFixture);

    // add epoch
    const poolId = 3;
    const start = BigInt(await getLatestBlockTimestamp()) + ONE_DAY;
    const end = start + ONE_WEEK;
    const rewards = rewardTokens.map(({ rewardTokenId }) => ({
      rewardTokenId,
      totalRewards: BigInt(getRandomInt(100e18)),
    }));
    const addEpoch = await hubRewardsV2.connect(admin).addEpoch(poolId, start, end, rewards);

    return {
      admin,
      user,
      unusedUsers,
      hubRewardsV2,
      hubRewardsV2Address,
      addEpoch,
      bridgeRouter,
      spokeManager,
      accountManager,
      loanManager,
      hubChainId,
      spokeChainId,
      spokeAddress,
      rewardTokens,
      poolId,
      start,
      end,
      rewards,
    };
  }

  async function addMultipleEpochsFixture() {
    const {
      admin,
      user,
      unusedUsers,
      hubRewardsV2,
      hubRewardsV2Address,
      bridgeRouter,
      spokeManager,
      accountManager,
      loanManager,
      hubChainId,
      spokeChainId,
      spokeAddress,
      rewardTokens,
    } = await loadFixture(addRewardTokensFixture);

    // epochs structure
    const poolIds = [3, 5, 6];
    const numEpochs = 4;
    const firstEpochStart = BigInt(await getLatestBlockTimestamp()) + ONE_DAY;
    // pool id -> epoch index -> epoch
    const epochs: Record<number, Record<number, Epoch>> = {};
    for (const poolId of poolIds) {
      epochs[poolId] = {};
      for (let epochIndex = 1; epochIndex <= numEpochs; epochIndex++) {
        const start = firstEpochStart + BigInt(epochIndex - 1) * ONE_WEEK;
        const end = start + ONE_WEEK - BigInt(1);
        const numRewards = getRandomInt(rewardTokens.length) + 1;
        const rewards: EpochReward[] = [];
        for (let i = 0; i < numRewards; i++) {
          const { rewardTokenId } = rewardTokens[i];
          const totalRewards = BigInt(getRandomInt(100e18));
          rewards.push({ rewardTokenId, totalRewards });
        }

        // add
        await hubRewardsV2.connect(admin).addEpoch(poolId, start, end, rewards);
        epochs[poolId][epochIndex] = { start, end, rewards };
      }
    }

    return {
      admin,
      user,
      unusedUsers,
      hubRewardsV2,
      hubRewardsV2Address,
      bridgeRouter,
      spokeManager,
      accountManager,
      loanManager,
      hubChainId,
      spokeChainId,
      spokeAddress,
      rewardTokens,
      poolIds,
      numEpochs,
      epochs,
    };
  }

  async function updateMultipleAccountsPointsForMultiplePoolsFixture() {
    const {
      admin,
      user,
      unusedUsers,
      hubRewardsV2,
      hubRewardsV2Address,
      bridgeRouter,
      spokeManager,
      accountManager,
      loanManager,
      hubChainId,
      spokeChainId,
      spokeAddress,
      rewardTokens,
      poolIds,
      numEpochs,
      epochs,
    } = await loadFixture(addMultipleEpochsFixture);

    const accountIds: string[] = [];
    for (let i = 0; i < 100; i++) {
      accountIds.push(getRandomBytes(BYTES32_LENGTH));
    }

    // account id -> pool id -> points
    const accountLastUpdatedPoints: Record<string, Record<number, bigint>> = {};
    // account id -> pool id -> epoch index -> points
    const accountEpochPoints: Record<string, Record<number, Record<number, bigint>>> = {};
    // pool id -> epoch index -> points
    const poolTotalEpochPoints: Record<number, Record<number, bigint>> = {};

    // initialise
    for (const accountId of accountIds) {
      accountLastUpdatedPoints[accountId] = {};
      accountEpochPoints[accountId] = {};
      for (const poolId of poolIds) {
        accountEpochPoints[accountId][poolId] = {};
      }
    }
    for (const poolId of poolIds) {
      poolTotalEpochPoints[poolId] = {};
      for (let epochIndex = 1; epochIndex <= numEpochs; epochIndex++) {
        poolTotalEpochPoints[poolId][epochIndex] = BigInt(0);
      }
    }

    // randomize points for all (accounts, pools, epoch index)
    for (let epochIndex = 1; epochIndex <= numEpochs; epochIndex++) {
      // make sure we are in the epoch
      const { start } = epochs[poolIds[0]][epochIndex];
      await time.setNextBlockTimestamp(start);

      // generate
      for (const poolId of poolIds) {
        for (const accountId of accountIds) {
          const prev = await hubRewardsV2.accountLastUpdatedPoints(accountId, poolId);
          const delta = BigInt(getRandomInt(500));
          const collateral = prev + delta;
          const userPoolRewards: UserPoolRewards = { collateral, borrow: BigInt(0), interestPaid: BigInt(0) };
          await loanManager.setUserPoolRewards(accountId, poolId, userPoolRewards);
          accountLastUpdatedPoints[accountId][poolId] = collateral;
          accountEpochPoints[accountId][poolId][epochIndex] = delta;
          poolTotalEpochPoints[poolId][epochIndex] += delta;
        }
      }

      // update
      const poolEpochs = poolIds.map((poolId) => ({ poolId, epochIndex }));
      await hubRewardsV2.connect(user).updateAccountPoints(accountIds, poolEpochs);
    }

    return {
      admin,
      user,
      unusedUsers,
      hubRewardsV2,
      hubRewardsV2Address,
      bridgeRouter,
      spokeManager,
      accountManager,
      loanManager,
      hubChainId,
      spokeChainId,
      spokeAddress,
      rewardTokens,
      poolIds,
      numEpochs,
      epochs,
      accountIds,
      accountLastUpdatedPoints,
      accountEpochPoints,
      poolTotalEpochPoints,
    };
  }

  // clear timestamp changes
  after(async () => {
    await reset();
  });

  describe("Deployment", () => {
    it("Should set admin and contracts correctly", async () => {
      const { admin, hubRewardsV2, bridgeRouter, accountManager, loanManager, hubChainId } =
        await loadFixture(deployHubRewardsV2Fixture);

      // check default admin role
      expect(await hubRewardsV2.owner()).to.equal(admin.address);
      expect(await hubRewardsV2.defaultAdmin()).to.equal(admin.address);
      expect(await hubRewardsV2.defaultAdminDelay()).to.equal(SECONDS_IN_DAY);
      expect(await hubRewardsV2.getRoleAdmin(DEFAULT_ADMIN_ROLE)).to.equal(DEFAULT_ADMIN_ROLE);
      expect(await hubRewardsV2.hasRole(DEFAULT_ADMIN_ROLE, admin.address)).to.be.true;

      // check other roles
      expect(await hubRewardsV2.getRoleAdmin(LISTING_ROLE)).to.equal(DEFAULT_ADMIN_ROLE);
      expect(await hubRewardsV2.hasRole(LISTING_ROLE, admin.address)).to.be.true;

      // check state
      expect(await hubRewardsV2.getBridgeRouter()).to.equal(bridgeRouter);
      expect(await hubRewardsV2.accountManager()).to.equal(accountManager);
      expect(await hubRewardsV2.loanManager()).to.equal(loanManager);
      expect(await hubRewardsV2.hubChainId()).to.equal(hubChainId);
      await expect(hubRewardsV2.getActivePoolEpoch(1))
        .to.be.revertedWithCustomError(hubRewardsV2, "EpochNotActive")
        .withArgs(1, 0);
    });
  });

  describe("Add Reward Token", () => {
    it("Should successfully add reward token", async () => {
      const { hubRewardsV2, addRewardTokens, rewardTokens } = await loadFixture(addRewardTokensFixture);

      // verify added
      for (let i = 0; i < rewardTokens.length; i++) {
        const { rewardTokenId, chainId, spokeAddress } = rewardTokens[i];
        const addRewardToken = addRewardTokens[i];
        expect(await hubRewardsV2.isRewardAdded(rewardTokenId)).to.be.true;
        expect(await hubRewardsV2.rewardTokens(rewardTokenId)).to.deep.equal([chainId, spokeAddress]);
        await expect(addRewardToken)
          .to.emit(hubRewardsV2, "RewardTokenAdded")
          .withArgs(rewardTokenId, chainId, spokeAddress);
      }
    });

    it("Should fail to add reward token when already added", async () => {
      const { admin, hubRewardsV2, rewardTokens } = await loadFixture(addRewardTokensFixture);

      // verify already added
      const { rewardTokenId, chainId, spokeAddress } = rewardTokens[0];
      expect(await hubRewardsV2.isRewardAdded(rewardTokenId)).to.be.true;

      // add reward token
      const addRewardToken = hubRewardsV2.connect(admin).addRewardToken(rewardTokenId, chainId, spokeAddress);
      await expect(addRewardToken)
        .to.be.revertedWithCustomError(hubRewardsV2, "RewardAlreadyAdded")
        .withArgs(rewardTokenId);
    });

    it("Should fail to add reward token when sender is not listing admin", async () => {
      const { user, hubRewardsV2 } = await loadFixture(deployHubRewardsV2Fixture);

      // add reward token
      const rewardTokenId = 3;
      const chainId = 2;
      const spokeAddress = convertEVMAddressToGenericAddress(getRandomAddress());
      const addRewardToken = hubRewardsV2.connect(user).addRewardToken(rewardTokenId, chainId, spokeAddress);
      await expect(addRewardToken)
        .to.be.revertedWithCustomError(hubRewardsV2, "AccessControlUnauthorizedAccount")
        .withArgs(user.address, LISTING_ROLE);
    });
  });

  describe("Add Epoch", () => {
    it("Should successfully add epoch", async () => {
      const { hubRewardsV2, addEpoch, poolId, start, end, rewards } = await loadFixture(addEpochFixture);

      // verify added
      const epochIndex = 1;
      expect(await hubRewardsV2.poolEpochIndex(poolId)).to.equal(epochIndex);
      expect(await hubRewardsV2.getPoolEpoch(poolId, epochIndex)).to.deep.equal([
        start,
        end,
        rewards.map((reward) => Object.values(reward)),
      ]);
      for (const { rewardTokenId, totalRewards } of rewards) {
        await expect(addEpoch)
          .to.emit(hubRewardsV2, "EpochRewardAdded")
          .withArgs(poolId, epochIndex, rewardTokenId, totalRewards);
      }
      await expect(addEpoch).to.emit(hubRewardsV2, "EpochAdded").withArgs(poolId, epochIndex, start, end);

      // advance
      await time.increaseTo(start);
      expect(await hubRewardsV2.getActivePoolEpoch(poolId)).to.deep.equal([
        epochIndex,
        [start, end, rewards.map((reward) => Object.values(reward))],
      ]);
      await time.increaseTo(end);
      await expect(hubRewardsV2.getActivePoolEpoch(poolId))
        .to.to.be.revertedWithCustomError(hubRewardsV2, "EpochNotActive")
        .withArgs(poolId, epochIndex);
    });

    it("Should successfully add empty epochs", async () => {
      const { admin, hubRewardsV2 } = await loadFixture(deployHubRewardsV2Fixture);

      // add epoch
      const poolId = 3;
      const start = BigInt(await getLatestBlockTimestamp()) + ONE_DAY;
      const end = start + ONE_WEEK;
      const addEpoch = await hubRewardsV2.connect(admin).addEpoch(poolId, start, end, []);

      // verify added
      const epochIndex = 1;
      expect(await hubRewardsV2.poolEpochIndex(poolId)).to.equal(epochIndex);
      expect(await hubRewardsV2.getPoolEpoch(poolId, epochIndex)).to.deep.equal([start, end, []]);
      await expect(addEpoch).not.to.emit(hubRewardsV2, "EpochRewardAdded");
      await expect(addEpoch).to.emit(hubRewardsV2, "EpochAdded").withArgs(poolId, epochIndex, start, end);
    });

    it("Should successfully add multiple epochs", async () => {
      const { hubRewardsV2, poolIds, numEpochs, epochs } = await loadFixture(addMultipleEpochsFixture);

      // verify added
      for (let i = 0; i < poolIds.length; i++) {
        const poolId = poolIds[i];
        const poolEpochs = epochs[poolId];
        expect(await hubRewardsV2.poolEpochIndex(poolId)).to.equal(numEpochs);

        for (let epochIndex = 1; epochIndex <= numEpochs; epochIndex++) {
          const { start, end, rewards } = poolEpochs[epochIndex];
          expect(await hubRewardsV2.getPoolEpoch(poolId, epochIndex)).to.deep.equal([
            start,
            end,
            rewards.map((reward) => Object.values(reward)),
          ]);
        }
      }

      // advance
      const poolId = poolIds[0];
      const { start, end, rewards } = epochs[poolId][numEpochs];
      await time.increaseTo(start);
      expect(await hubRewardsV2.getActivePoolEpoch(poolId)).to.deep.equal([
        numEpochs,
        [start, end, rewards.map((reward) => Object.values(reward))],
      ]);
      await time.increaseTo(end);
      await expect(hubRewardsV2.getActivePoolEpoch(poolId))
        .to.to.be.revertedWithCustomError(hubRewardsV2, "EpochNotActive")
        .withArgs(poolId, numEpochs);
    });

    it("Should fail to add epoch when overlaps with previous epoch", async () => {
      const { admin, hubRewardsV2, poolId, end: previousEnd } = await loadFixture(addEpochFixture);

      // add epoch when overlaps
      let start = previousEnd;
      const end = start + ONE_WEEK;
      const addEpoch = hubRewardsV2.connect(admin).addEpoch(poolId, start, end, []);
      await expect(addEpoch)
        .to.be.revertedWithCustomError(hubRewardsV2, "InvalidEpochStart")
        .withArgs(poolId, previousEnd, start);

      // add epoch when okay
      start += BigInt(1);
      await hubRewardsV2.connect(admin).addEpoch(poolId, start, end, []);
    });

    it("Should fail to add epoch when start is in the past", async () => {
      const { admin, hubRewardsV2 } = await loadFixture(deployHubRewardsV2Fixture);

      // add epoch when overlaps
      const poolId = 3;
      let start = BigInt(await getLatestBlockTimestamp()) + ONE_DAY;
      let end = start + ONE_WEEK;
      await time.increaseTo(start);
      const addEpoch = hubRewardsV2.connect(admin).addEpoch(poolId, start, end, []);
      await expect(addEpoch)
        .to.be.revertedWithCustomError(hubRewardsV2, "InvalidEpochStart")
        .withArgs(poolId, start + BigInt(1), start);

      // add epoch when okay
      start = BigInt(await getLatestBlockTimestamp()) + ONE_DAY;
      end = start + ONE_WEEK;
      await time.increaseTo(start - BigInt(1));
      await hubRewardsV2.connect(admin).addEpoch(poolId, start, end, []);
    });

    it("Should fail to add epoch when start after end", async () => {
      const { admin, hubRewardsV2 } = await loadFixture(deployHubRewardsV2Fixture);

      // add epoch when start after end
      const poolId = 3;
      const start = BigInt(await getLatestBlockTimestamp()) + ONE_DAY;
      const end = start - BigInt(1);
      const addEpoch = hubRewardsV2.connect(admin).addEpoch(poolId, start, end, []);
      await expect(addEpoch).to.be.revertedWithPanic(PANIC_CODES.ARITHMETIC_OVERFLOW);
    });

    it("Should fail to add epoch when length is less than a day", async () => {
      const { admin, hubRewardsV2 } = await loadFixture(deployHubRewardsV2Fixture);

      // add epoch when length is less than day
      const poolId = 3;
      const start = BigInt(await getLatestBlockTimestamp()) + ONE_DAY;
      let end = start + ONE_DAY - BigInt(1);
      const addEpoch = hubRewardsV2.connect(admin).addEpoch(poolId, start, end, []);
      await expect(addEpoch)
        .to.be.revertedWithCustomError(hubRewardsV2, "InvalidEpochLength")
        .withArgs(end - start, ONE_DAY);

      // add epoch when length is a day
      end += BigInt(1);
      await hubRewardsV2.connect(admin).addEpoch(poolId, start, end, []);
    });

    it("Should fail to add epoch when length is more than 4 weeks", async () => {
      const { admin, hubRewardsV2 } = await loadFixture(deployHubRewardsV2Fixture);

      // add epoch when length is more than 4 weeks
      const poolId = 3;
      const start = BigInt(await getLatestBlockTimestamp()) + ONE_DAY;
      const FOUR_WEEKS = BigInt(4) * ONE_WEEK;
      let end = start + FOUR_WEEKS + BigInt(1);
      const addEpoch = hubRewardsV2.connect(admin).addEpoch(poolId, start, end, []);
      await expect(addEpoch)
        .to.be.revertedWithCustomError(hubRewardsV2, "InvalidEpochLength")
        .withArgs(end - start, FOUR_WEEKS);

      // add epoch when length is 4 weeks
      end -= BigInt(1);
      await hubRewardsV2.connect(admin).addEpoch(poolId, start, end, []);
    });

    it("Should fail to add epoch when more than 5 rewards", async () => {
      const { admin, hubRewardsV2 } = await loadFixture(deployHubRewardsV2Fixture);

      // add epoch
      const poolId = 3;
      const start = BigInt(await getLatestBlockTimestamp()) + ONE_DAY;
      const end = start + ONE_WEEK;
      const rewards: EpochReward[] = [
        { rewardTokenId: 0, totalRewards: BigInt(100e18) },
        { rewardTokenId: 1, totalRewards: BigInt(100e18) },
        { rewardTokenId: 2, totalRewards: BigInt(100e18) },
        { rewardTokenId: 3, totalRewards: BigInt(100e18) },
        { rewardTokenId: 4, totalRewards: BigInt(100e18) },
        { rewardTokenId: 5, totalRewards: BigInt(100e18) },
      ];
      const addEpoch = hubRewardsV2.connect(admin).addEpoch(poolId, start, end, rewards);
      await expect(addEpoch)
        .to.be.revertedWithCustomError(hubRewardsV2, "TooManyEpochRewards")
        .withArgs(5, rewards.length);
    });

    it("Should fail to add epoch when unknown reward", async () => {
      const { admin, hubRewardsV2 } = await loadFixture(deployHubRewardsV2Fixture);

      // add epoch
      const poolId = 3;
      const start = BigInt(await getLatestBlockTimestamp()) + ONE_DAY;
      const end = start + ONE_WEEK;
      const rewardTokenId = 1;
      const rewards: EpochReward[] = [{ rewardTokenId, totalRewards: BigInt(100e18) }];
      const addEpoch = hubRewardsV2.connect(admin).addEpoch(poolId, start, end, rewards);
      await expect(addEpoch).to.be.revertedWithCustomError(hubRewardsV2, "UnknownReward").withArgs(rewardTokenId);
    });

    it("Should fail to add epoch when duplicate rewards", async () => {
      const { admin, hubRewardsV2, rewardTokens } = await loadFixture(addRewardTokensFixture);

      // add epoch
      const poolId = 3;
      const start = BigInt(await getLatestBlockTimestamp()) + ONE_DAY;
      const end = start + ONE_WEEK;
      const { rewardTokenId } = rewardTokens[0];
      const rewards: EpochReward[] = [
        { rewardTokenId, totalRewards: BigInt(100e18) },
        { rewardTokenId, totalRewards: BigInt(100e18) },
      ];
      const addEpoch = hubRewardsV2.connect(admin).addEpoch(poolId, start, end, rewards);
      await expect(addEpoch)
        .to.be.revertedWithCustomError(hubRewardsV2, "PossibleDuplicateReward")
        .withArgs(rewardTokenId);
    });

    it("Should fail to add epoch when unordered rewards", async () => {
      const { admin, hubRewardsV2, rewardTokens } = await loadFixture(addRewardTokensFixture);

      // add epoch
      const poolId = 3;
      const start = BigInt(await getLatestBlockTimestamp()) + ONE_DAY;
      const end = start + ONE_WEEK;
      const rewards: EpochReward[] = [
        { rewardTokenId: rewardTokens[1].rewardTokenId, totalRewards: BigInt(100e18) },
        { rewardTokenId: rewardTokens[0].rewardTokenId, totalRewards: BigInt(100e18) },
      ];
      const addEpoch = hubRewardsV2.connect(admin).addEpoch(poolId, start, end, rewards);
      await expect(addEpoch)
        .to.be.revertedWithCustomError(hubRewardsV2, "PossibleDuplicateReward")
        .withArgs(rewardTokens[0].rewardTokenId);
    });

    it("Should fail to add epoch when sender is not listing admin", async () => {
      const { user, hubRewardsV2 } = await loadFixture(deployHubRewardsV2Fixture);

      // add epoch
      const poolId = 3;
      const start = BigInt(await getLatestBlockTimestamp()) + ONE_DAY;
      const end = start + ONE_WEEK;
      const addEpoch = hubRewardsV2.connect(user).addEpoch(poolId, start, end, []);
      await expect(addEpoch)
        .to.be.revertedWithCustomError(hubRewardsV2, "AccessControlUnauthorizedAccount")
        .withArgs(user.address, LISTING_ROLE);
    });
  });

  describe("Update epoch total rewards", () => {
    it("Should successfully update epoch total rewards", async () => {
      const { admin, hubRewardsV2, poolId, rewards: oldRewards } = await loadFixture(addEpochFixture);

      // verify old total rewards
      const epochIndex = 1;
      expect((await hubRewardsV2.getPoolEpoch(poolId, epochIndex))[2]).to.deep.equal(
        oldRewards.map((reward) => Object.values(reward))
      );

      // update
      const rewardIndex = oldRewards.length - 1;
      const { rewardTokenId, totalRewards: oldTotalRewards } = oldRewards[rewardIndex];
      const newTotalRewards = oldTotalRewards * BigInt(2);
      const updateEpochTotalRewards = await hubRewardsV2
        .connect(admin)
        .updateEpochTotalRewards({ poolId, epochIndex }, rewardIndex, rewardTokenId, newTotalRewards);
      expect((await hubRewardsV2.getPoolEpoch(poolId, epochIndex))[2][rewardIndex][1]).to.deep.equal(newTotalRewards);
      await expect(updateEpochTotalRewards)
        .to.emit(hubRewardsV2, "EpochTotalRewardsUpdated")
        .withArgs(poolId, epochIndex, rewardTokenId, newTotalRewards);
    });

    it("Should fail to update epoch total rewards after end", async () => {
      const { admin, hubRewardsV2, poolId, end, rewards: oldRewards } = await loadFixture(addEpochFixture);

      // update before end
      const epochIndex = 1;
      const { rewardTokenId, totalRewards } = oldRewards[0];
      await hubRewardsV2.connect(admin).updateEpochTotalRewards({ poolId, epochIndex }, 0, rewardTokenId, totalRewards);

      // update at end
      await time.setNextBlockTimestamp(end);
      const updateEpochTotalRewards = hubRewardsV2
        .connect(admin)
        .updateEpochTotalRewards({ poolId, epochIndex }, 0, rewardTokenId, totalRewards);
      await expect(updateEpochTotalRewards)
        .to.be.revertedWithCustomError(hubRewardsV2, "CannotUpdateExpiredEpoch")
        .withArgs(poolId, epochIndex, end);
    });

    it("Should fail to update epoch when incorrect reward token", async () => {
      const { admin, hubRewardsV2, poolId, end, rewards: oldRewards } = await loadFixture(addEpochFixture);

      // update with incorrect reward token id
      const epochIndex = 1;
      const { rewardTokenId: actualRewardTokenId, totalRewards } = oldRewards[0];
      const rewardTokenId = 33;
      const updateEpochTotalRewards = hubRewardsV2
        .connect(admin)
        .updateEpochTotalRewards({ poolId, epochIndex }, 0, rewardTokenId, totalRewards);
      await expect(updateEpochTotalRewards)
        .to.be.revertedWithCustomError(hubRewardsV2, "CannotUpdateIncorrectReward")
        .withArgs(rewardTokenId, actualRewardTokenId);
    });

    it("Should fail to update epoch when sender is not listing admin", async () => {
      const { user, hubRewardsV2, poolId, rewards } = await loadFixture(addEpochFixture);

      // update
      const epochIndex = 1;
      const { rewardTokenId, totalRewards } = rewards[0];
      const updateEpochTotalRewards = hubRewardsV2
        .connect(user)
        .updateEpochTotalRewards({ poolId, epochIndex }, 0, rewardTokenId, totalRewards);
      await expect(updateEpochTotalRewards)
        .to.be.revertedWithCustomError(hubRewardsV2, "AccessControlUnauthorizedAccount")
        .withArgs(user.address, LISTING_ROLE);
    });
  });

  describe("Update Account Points", () => {
    it("Should successfully update a single account's points for a single pool", async () => {
      const { user, hubRewardsV2, loanManager, poolIds, epochs } = await loadFixture(addMultipleEpochsFixture);

      // prepare rewards in loan manager
      const accountId = getRandomBytes(BYTES32_LENGTH);
      const poolId = poolIds[0];
      const userPoolRewards: UserPoolRewards = {
        collateral: BigInt(100),
        borrow: BigInt(50),
        interestPaid: BigInt(10),
      };
      await loanManager.setUserPoolRewards(accountId, poolId, userPoolRewards);

      // make sure we are in the epoch
      const epochIndex = 1;
      await time.setNextBlockTimestamp(epochs[poolId][epochIndex].start);

      // first update
      await hubRewardsV2.connect(user).updateAccountPoints([accountId], [{ poolId, epochIndex }]);
      expect(await hubRewardsV2.poolTotalEpochPoints(poolId, epochIndex)).to.equal(BigInt(100));
      expect(await hubRewardsV2.accountLastUpdatedPoints(accountId, poolId)).to.equal(BigInt(100));
      expect(await hubRewardsV2.accountEpochPoints(accountId, poolId, epochIndex)).to.equal(BigInt(100));

      // increase points in loan manager
      userPoolRewards.collateral += BigInt(50);
      await loanManager.setUserPoolRewards(accountId, poolId, userPoolRewards);

      // second update
      await hubRewardsV2.connect(user).updateAccountPoints([accountId], [{ poolId, epochIndex }]);
      expect(await hubRewardsV2.poolTotalEpochPoints(poolId, epochIndex)).to.equal(BigInt(150));
      expect(await hubRewardsV2.accountLastUpdatedPoints(accountId, poolId)).to.equal(BigInt(150));
      expect(await hubRewardsV2.accountEpochPoints(accountId, poolId, epochIndex)).to.equal(BigInt(150));
    });

    it("Should successfully update a single account's points for multiple pools", async () => {
      const { user, hubRewardsV2, loanManager, poolIds, epochs } = await loadFixture(addMultipleEpochsFixture);

      // prepare rewards in loan manager
      const accountId = getRandomBytes(BYTES32_LENGTH);
      await loanManager.setUserPoolRewards(accountId, poolIds[0], {
        collateral: BigInt(100),
        borrow: BigInt(0),
        interestPaid: BigInt(0),
      });
      await loanManager.setUserPoolRewards(accountId, poolIds[1], {
        collateral: BigInt(150),
        borrow: BigInt(0),
        interestPaid: BigInt(0),
      });

      // make sure we are in the epoch
      const epochIndex = 1;
      await time.setNextBlockTimestamp(epochs[poolIds[0]][epochIndex].start);

      // update
      await hubRewardsV2.connect(user).updateAccountPoints(
        [accountId],
        [
          { poolId: poolIds[0], epochIndex },
          { poolId: poolIds[1], epochIndex },
        ]
      );
      expect(await hubRewardsV2.poolTotalEpochPoints(poolIds[0], epochIndex)).to.equal(BigInt(100));
      expect(await hubRewardsV2.poolTotalEpochPoints(poolIds[1], epochIndex)).to.equal(BigInt(150));
      expect(await hubRewardsV2.accountLastUpdatedPoints(accountId, poolIds[0])).to.equal(BigInt(100));
      expect(await hubRewardsV2.accountLastUpdatedPoints(accountId, poolIds[1])).to.equal(BigInt(150));
      expect(await hubRewardsV2.accountEpochPoints(accountId, poolIds[0], epochIndex)).to.equal(BigInt(100));
      expect(await hubRewardsV2.accountEpochPoints(accountId, poolIds[1], epochIndex)).to.equal(BigInt(150));
    });

    it("Should successfully update multiple accounts' points for a single pool", async () => {
      const { user, hubRewardsV2, loanManager, poolIds, epochs } = await loadFixture(addMultipleEpochsFixture);

      // prepare rewards in loan manager
      const accountId0 = getRandomBytes(BYTES32_LENGTH);
      const accountId1 = getRandomBytes(BYTES32_LENGTH);
      const poolId = poolIds[0];
      await loanManager.setUserPoolRewards(accountId0, poolId, {
        collateral: BigInt(100),
        borrow: BigInt(0),
        interestPaid: BigInt(0),
      });
      await loanManager.setUserPoolRewards(accountId1, poolId, {
        collateral: BigInt(150),
        borrow: BigInt(0),
        interestPaid: BigInt(0),
      });

      // make sure we are in the epoch
      const epochIndex = 1;
      await time.setNextBlockTimestamp(epochs[poolId][epochIndex].start);

      // update
      await hubRewardsV2.connect(user).updateAccountPoints([accountId0, accountId1], [{ poolId, epochIndex }]);
      expect(await hubRewardsV2.poolTotalEpochPoints(poolIds[0], epochIndex)).to.equal(BigInt(250));
      expect(await hubRewardsV2.accountLastUpdatedPoints(accountId0, poolId)).to.equal(BigInt(100));
      expect(await hubRewardsV2.accountLastUpdatedPoints(accountId1, poolId)).to.equal(BigInt(150));
      expect(await hubRewardsV2.accountEpochPoints(accountId0, poolId, epochIndex)).to.equal(BigInt(100));
      expect(await hubRewardsV2.accountEpochPoints(accountId1, poolId, epochIndex)).to.equal(BigInt(150));
    });

    it("Should successfully update multiple accounts' points for multiple pools", async () => {
      const {
        hubRewardsV2,
        poolIds,
        numEpochs,
        accountIds,
        accountLastUpdatedPoints,
        accountEpochPoints,
        poolTotalEpochPoints,
      } = await loadFixture(updateMultipleAccountsPointsForMultiplePoolsFixture);

      for (const poolId of poolIds) {
        // check total points
        for (let epochIndex = 1; epochIndex <= numEpochs; epochIndex++) {
          expect(await hubRewardsV2.poolTotalEpochPoints(poolId, epochIndex)).to.equal(
            poolTotalEpochPoints[poolId][epochIndex]
          );
        }

        // check account specific points
        for (const accountId of accountIds) {
          for (let epochIndex = 1; epochIndex <= numEpochs; epochIndex++) {
            expect(await hubRewardsV2.accountEpochPoints(accountId, poolId, epochIndex)).to.equal(
              accountEpochPoints[accountId][poolId][epochIndex]
            );
          }
          expect(await hubRewardsV2.accountLastUpdatedPoints(accountId, poolId)).to.equal(
            accountLastUpdatedPoints[accountId][poolId]
          );
        }
      }
    });

    it("Should fail to update account points when epoch not active", async () => {
      const { user, hubRewardsV2, poolIds, epochs } = await loadFixture(addMultipleEpochsFixture);

      const poolId = poolIds[0];
      const accountId = getRandomBytes(BYTES32_LENGTH);

      // before start
      const epochIndex = 1;
      await time.setNextBlockTimestamp(epochs[poolId][epochIndex].start - BigInt(1));
      let updateAccountPoints = hubRewardsV2.connect(user).updateAccountPoints([accountId], [{ poolId, epochIndex }]);
      await expect(updateAccountPoints)
        .to.be.revertedWithCustomError(hubRewardsV2, "EpochNotActive")
        .withArgs(poolId, epochIndex);

      // after end
      await time.setNextBlockTimestamp(epochs[poolId][epochIndex].end);
      updateAccountPoints = hubRewardsV2.connect(user).updateAccountPoints([accountId], [{ poolId, epochIndex }]);
      await expect(updateAccountPoints)
        .to.be.revertedWithCustomError(hubRewardsV2, "EpochNotActive")
        .withArgs(poolId, epochIndex);
    });
  });

  describe("Receive message", () => {
    it("Should fail when spoke is unknown", async () => {
      const { user, hubRewardsV2, hubRewardsV2Address, bridgeRouter, spokeManager, spokeChainId, accountIds } =
        await loadFixture(updateMultipleAccountsPointsForMultiplePoolsFixture);

      // verify unknown spoke
      await spokeManager.setIsKnown(false);
      const sourceAddress = convertEVMAddressToGenericAddress(getRandomAddress());
      expect(await spokeManager.isSpoke(spokeChainId, sourceAddress)).to.be.false;

      // call receive message
      const accountId: string = accountIds[0];
      const message = getClaimRewardsMessage(
        spokeChainId,
        sourceAddress,
        hubRewardsV2Address,
        accountId,
        user.address,
        [],
        []
      );
      const receiveMessage = bridgeRouter.receiveMessage(message);

      // check failure
      const errorReason = hubRewardsV2.interface.encodeErrorResult("SpokeUnknown", [spokeChainId, sourceAddress]);
      await expect(receiveMessage).to.emit(bridgeRouter, "MessageFailed").withArgs(message.messageId, errorReason);
    });

    it("Should fail when unknown payload action", async () => {
      const {
        user,
        hubRewardsV2,
        hubRewardsV2Address,
        bridgeRouter,
        accountManager,
        spokeChainId,
        spokeAddress,
        accountIds,
      } = await loadFixture(updateMultipleAccountsPointsForMultiplePoolsFixture);

      // add user as registered
      const accountId: string = accountIds[0];
      const userAddr = convertEVMAddressToGenericAddress(user.address);
      await accountManager.setIsAddressRegisteredToAccount(accountId, spokeChainId, userAddr);

      // call receive message
      const message = getClaimRewardsMessage(
        spokeChainId,
        spokeAddress,
        hubRewardsV2Address,
        accountId,
        user.address,
        [],
        []
      );
      message.payload = buildMessagePayload(Action.SendToken, accountId, user.address, "0x");
      const receiveMessage = bridgeRouter.receiveMessage(message);

      // check failure
      const errorReason = hubRewardsV2.interface.encodeErrorResult("CannotReceiveMessage", [message.messageId]);
      await expect(receiveMessage).to.emit(bridgeRouter, "MessageFailed").withArgs(message.messageId, errorReason);
    });

    it("Should succeed when sender is registered", async () => {
      const { user, hubRewardsV2Address, bridgeRouter, accountManager, spokeChainId, spokeAddress, accountIds } =
        await loadFixture(updateMultipleAccountsPointsForMultiplePoolsFixture);

      // add user as registered
      const accountId: string = accountIds[0];
      const userAddr = convertEVMAddressToGenericAddress(user.address);
      await accountManager.setIsAddressRegisteredToAccount(accountId, spokeChainId, userAddr);

      // call receive message
      const message = getClaimRewardsMessage(
        spokeChainId,
        spokeAddress,
        hubRewardsV2Address,
        accountId,
        user.address,
        [],
        []
      );
      const claimRewards = await bridgeRouter.receiveMessage(message);

      // verify message
      await expect(claimRewards).to.emit(bridgeRouter, "MessageSucceeded").withArgs(message.messageId);
      await expect(claimRewards).to.emit(bridgeRouter, "MessageReceived").withArgs(Object.values(message));
    });

    it("Should fail to claim rewards when sender is not registered to account", async () => {
      const {
        user,
        hubRewardsV2Address,
        bridgeRouter,
        accountManager,
        hubChainId,
        spokeChainId,
        spokeAddress,
        accountIds,
      } = await loadFixture(updateMultipleAccountsPointsForMultiplePoolsFixture);

      // verify not registered
      const accountId: string = accountIds[0];
      const userAddr = convertEVMAddressToGenericAddress(user.address);
      expect(await accountManager.isAddressRegisteredToAccount(accountId, hubChainId, userAddr)).to.be.false;

      // call receive message
      const message = getClaimRewardsMessage(
        spokeChainId,
        spokeAddress,
        hubRewardsV2Address,
        accountId,
        user.address,
        [],
        []
      );
      const claimRewards = bridgeRouter.receiveMessage(message);

      // check failure
      const errorReason = accountManager.interface.encodeErrorResult("NotRegisteredToAccount", [
        accountId,
        message.sourceChainId,
        userAddr,
      ]);
      await expect(claimRewards).to.emit(bridgeRouter, "MessageFailed").withArgs(message.messageId, errorReason);
    });

    it("Should claim rewards, in two steps, for single pool and single epoch", async () => {
      const {
        user,
        hubRewardsV2,
        hubRewardsV2Address,
        bridgeRouter,
        accountManager,
        spokeChainId,
        spokeAddress,
        poolIds,
        accountIds,
      } = await loadFixture(updateMultipleAccountsPointsForMultiplePoolsFixture);

      // add user as registered
      const accountId: string = accountIds[0];
      const userAddr = convertEVMAddressToGenericAddress(user.address);
      await accountManager.setIsAddressRegisteredToAccount(accountId, spokeChainId, userAddr);
      await accountManager.setAddressRegisteredToAccountOnChain(userAddr);

      // calculate expected claimable rewards
      const poolId = poolIds[0];
      const unclaimedRewards: Map<bigint, bigint> = new Map();
      const epochIndex = 1;
      const totalPoints: bigint = await hubRewardsV2.poolTotalEpochPoints(poolId, epochIndex);
      const accountPoints: bigint = await hubRewardsV2.accountEpochPoints(accountId, poolId, epochIndex);
      const rewards = (await hubRewardsV2.getPoolEpoch(poolId, epochIndex))[2];
      rewards.forEach(([rewardTokenId, totalRewards]) => {
        const oldAmount = unclaimedRewards.get(rewardTokenId) || BigInt(0);
        const additionalAmount = (accountPoints * totalRewards) / totalPoints;
        unclaimedRewards.set(rewardTokenId, oldAmount + additionalAmount);
      });

      // check expected claimable rewards
      const poolEpochs = [{ poolId, epochIndex }];
      for (const [rewardTokenId, amount] of unclaimedRewards) {
        expect(await hubRewardsV2.getUnclaimedRewards(accountId, poolEpochs, rewardTokenId)).to.equal(amount);
      }

      // call receive message
      let message = getClaimRewardsMessage(
        spokeChainId,
        spokeAddress,
        hubRewardsV2Address,
        accountId,
        user.address,
        poolEpochs,
        []
      );
      let claimRewards = await bridgeRouter.receiveMessage(message);
      expect(await hubRewardsV2.accountEpochPoints(accountId, poolId, epochIndex)).to.equal(0);

      // verify message
      await expect(claimRewards).to.emit(bridgeRouter, "MessageSucceeded").withArgs(message.messageId);
      await expect(claimRewards).to.emit(bridgeRouter, "MessageReceived").withArgs(Object.values(message));

      // verify expected claimable rewards
      for (const [rewardTokenId, amount] of unclaimedRewards) {
        expect(await hubRewardsV2.accountUnclaimedRewards(accountId, rewardTokenId)).to.equal(amount);
        expect(await hubRewardsV2.getUnclaimedRewards(accountId, poolEpochs, rewardTokenId)).to.equal(amount);
      }

      // call receive message
      const rewardTokensToReceive = Array.from(unclaimedRewards.keys()).map((rewardTokenId) => ({
        rewardTokenId,
        returnAdapterId: BigInt(getRandomInt(3)),
        returnGasLimit: BigInt(getRandomInt(300000)),
      }));
      message = getClaimRewardsMessage(
        spokeChainId,
        spokeAddress,
        hubRewardsV2Address,
        accountId,
        user.address,
        [],
        rewardTokensToReceive
      );
      claimRewards = await bridgeRouter.receiveMessage(message);

      // verify message
      await expect(claimRewards).to.emit(bridgeRouter, "MessageSucceeded").withArgs(message.messageId);
      await expect(claimRewards).to.emit(bridgeRouter, "MessageReceived").withArgs(Object.values(message));

      // verify expected claimable rewards
      for (const [rewardTokenId] of unclaimedRewards) {
        expect(await hubRewardsV2.accountUnclaimedRewards(accountId, rewardTokenId)).to.equal(0);
        expect(await hubRewardsV2.getUnclaimedRewards(accountId, poolEpochs, rewardTokenId)).to.equal(0);
      }

      // verify tokens claimed
      for (const { rewardTokenId, returnAdapterId, returnGasLimit } of rewardTokensToReceive) {
        const [spokeChainId, spokeAddress] = await hubRewardsV2.rewardTokens(rewardTokenId);
        const amount = unclaimedRewards.get(rewardTokenId) || BigInt(0);
        await expect(claimRewards).to.emit(hubRewardsV2, "RewardsClaimed").withArgs(accountId, rewardTokenId, amount);

        const sendTokenMessage = getSendTokenMessage(
          accountId,
          returnAdapterId,
          returnGasLimit,
          hubRewardsV2Address,
          spokeChainId,
          spokeAddress,
          user.address,
          amount
        );
        await expect(claimRewards)
          .to.emit(bridgeRouter, "SendMessage")
          .withArgs(
            Object.values(sendTokenMessage.params),
            sendTokenMessage.sender,
            sendTokenMessage.destinationChainId,
            sendTokenMessage.handler,
            sendTokenMessage.payload,
            sendTokenMessage.finalityLevel,
            sendTokenMessage.extraArgs
          );
      }
    });

    it("Should claim rewards, in one step, for single pool and single epoch", async () => {
      const {
        user,
        hubRewardsV2,
        hubRewardsV2Address,
        bridgeRouter,
        accountManager,
        spokeChainId,
        spokeAddress,
        poolIds,
        accountIds,
      } = await loadFixture(updateMultipleAccountsPointsForMultiplePoolsFixture);

      // add user as registered
      const accountId: string = accountIds[0];
      const userAddr = convertEVMAddressToGenericAddress(user.address);
      await accountManager.setIsAddressRegisteredToAccount(accountId, spokeChainId, userAddr);
      await accountManager.setAddressRegisteredToAccountOnChain(userAddr);

      // calculate expected claimable rewards
      const poolId = poolIds[0];
      const unclaimedRewards: Map<bigint, bigint> = new Map();
      const epochIndex = 1;
      const totalPoints: bigint = await hubRewardsV2.poolTotalEpochPoints(poolId, epochIndex);
      const accountPoints: bigint = await hubRewardsV2.accountEpochPoints(accountId, poolId, epochIndex);
      const rewards = (await hubRewardsV2.getPoolEpoch(poolId, epochIndex))[2];
      rewards.forEach(([rewardTokenId, totalRewards]) => {
        const oldAmount = unclaimedRewards.get(rewardTokenId) || BigInt(0);
        const additionalAmount = (accountPoints * totalRewards) / totalPoints;
        unclaimedRewards.set(rewardTokenId, oldAmount + additionalAmount);
      });

      // check expected claimable rewards
      const poolEpochs = [{ poolId, epochIndex }];
      for (const [rewardTokenId, amount] of unclaimedRewards) {
        expect(await hubRewardsV2.getUnclaimedRewards(accountId, poolEpochs, rewardTokenId)).to.equal(amount);
      }

      // call receive message
      const rewardTokensToReceive = Array.from(unclaimedRewards.keys()).map((rewardTokenId) => ({
        rewardTokenId,
        returnAdapterId: BigInt(getRandomInt(3)),
        returnGasLimit: BigInt(getRandomInt(300000)),
      }));
      const message = getClaimRewardsMessage(
        spokeChainId,
        spokeAddress,
        hubRewardsV2Address,
        accountId,
        user.address,
        poolEpochs,
        rewardTokensToReceive
      );
      const claimRewards = await bridgeRouter.receiveMessage(message);
      expect(await hubRewardsV2.accountEpochPoints(accountId, poolId, epochIndex)).to.equal(0);

      // verify message
      await expect(claimRewards).to.emit(bridgeRouter, "MessageSucceeded").withArgs(message.messageId);
      await expect(claimRewards).to.emit(bridgeRouter, "MessageReceived").withArgs(Object.values(message));

      // verify expected claimable rewards
      for (const [rewardTokenId] of unclaimedRewards) {
        expect(await hubRewardsV2.accountUnclaimedRewards(accountId, rewardTokenId)).to.equal(0);
        expect(await hubRewardsV2.getUnclaimedRewards(accountId, poolEpochs, rewardTokenId)).to.equal(0);
      }

      // verify tokens claimed
      for (const { rewardTokenId, returnAdapterId, returnGasLimit } of rewardTokensToReceive) {
        const [spokeChainId, spokeAddress] = await hubRewardsV2.rewardTokens(rewardTokenId);
        const amount = unclaimedRewards.get(rewardTokenId) || BigInt(0);
        await expect(claimRewards).to.emit(hubRewardsV2, "RewardsClaimed").withArgs(accountId, rewardTokenId, amount);

        const sendTokenMessage = getSendTokenMessage(
          accountId,
          returnAdapterId,
          returnGasLimit,
          hubRewardsV2Address,
          spokeChainId,
          spokeAddress,
          user.address,
          amount
        );
        await expect(claimRewards)
          .to.emit(bridgeRouter, "SendMessage")
          .withArgs(
            Object.values(sendTokenMessage.params),
            sendTokenMessage.sender,
            sendTokenMessage.destinationChainId,
            sendTokenMessage.handler,
            sendTokenMessage.payload,
            sendTokenMessage.finalityLevel,
            sendTokenMessage.extraArgs
          );
      }
    });

    it("Should update claimable rewards for single pool and multiple epochs", async () => {
      const {
        user,
        hubRewardsV2,
        hubRewardsV2Address,
        bridgeRouter,
        accountManager,
        spokeChainId,
        spokeAddress,
        poolIds,
        numEpochs,
        accountIds,
      } = await loadFixture(updateMultipleAccountsPointsForMultiplePoolsFixture);

      // add user as registered
      const accountId: string = accountIds[0];
      const userAddr = convertEVMAddressToGenericAddress(user.address);
      await accountManager.setIsAddressRegisteredToAccount(accountId, spokeChainId, userAddr);

      // calculate expected claimable rewards
      const poolId = poolIds[0];
      const unclaimedRewards: Map<bigint, bigint> = new Map();
      const poolEpochs = [];
      for (let epochIndex = 1; epochIndex < numEpochs; epochIndex++) {
        const totalPoints: bigint = await hubRewardsV2.poolTotalEpochPoints(poolId, epochIndex);
        const accountPoints: bigint = await hubRewardsV2.accountEpochPoints(accountId, poolId, epochIndex);
        const rewards = (await hubRewardsV2.getPoolEpoch(poolId, epochIndex))[2];
        rewards.forEach(([rewardTokenId, totalRewards]) => {
          const oldAmount = unclaimedRewards.get(rewardTokenId) || BigInt(0);
          const additionalAmount = (accountPoints * totalRewards) / totalPoints;
          unclaimedRewards.set(rewardTokenId, oldAmount + additionalAmount);
        });
        poolEpochs.push({ poolId, epochIndex });
      }

      // check expected claimable rewards
      for (const [rewardTokenId, amount] of unclaimedRewards) {
        expect(await hubRewardsV2.getUnclaimedRewards(accountId, poolEpochs, rewardTokenId)).to.equal(amount);
      }

      // receive message (split in two groups to check summation)
      let message = getClaimRewardsMessage(
        spokeChainId,
        spokeAddress,
        hubRewardsV2Address,
        accountId,
        user.address,
        poolEpochs.slice(0, 1),
        []
      );
      let claimRewards = await bridgeRouter.receiveMessage(message);
      await expect(claimRewards).to.emit(bridgeRouter, "MessageSucceeded").withArgs(message.messageId);
      await expect(claimRewards).to.emit(bridgeRouter, "MessageReceived").withArgs(Object.values(message));
      message = getClaimRewardsMessage(
        spokeChainId,
        spokeAddress,
        hubRewardsV2Address,
        accountId,
        user.address,
        poolEpochs.slice(1),
        []
      );
      claimRewards = await bridgeRouter.receiveMessage(message);
      await expect(claimRewards).to.emit(bridgeRouter, "MessageSucceeded").withArgs(message.messageId);
      await expect(claimRewards).to.emit(bridgeRouter, "MessageReceived").withArgs(Object.values(message));
      for (let epochIndex = 1; epochIndex < numEpochs; epochIndex++) {
        expect(await hubRewardsV2.accountEpochPoints(accountId, poolId, epochIndex)).to.equal(0);
      }

      // verify expected claimable rewards
      for (const [rewardTokenId, amount] of unclaimedRewards) {
        expect(await hubRewardsV2.accountUnclaimedRewards(accountId, rewardTokenId)).to.equal(amount);
        expect(await hubRewardsV2.getUnclaimedRewards(accountId, poolEpochs, rewardTokenId)).to.equal(amount);
      }
    });

    it("Should update claimable rewards for single pools and multiple epochs", async () => {
      const {
        user,
        hubRewardsV2,
        hubRewardsV2Address,
        bridgeRouter,
        accountManager,
        spokeChainId,
        spokeAddress,
        poolIds,
        numEpochs,
        accountIds,
      } = await loadFixture(updateMultipleAccountsPointsForMultiplePoolsFixture);

      // add user as registered
      const accountId: string = accountIds[0];
      const userAddr = convertEVMAddressToGenericAddress(user.address);
      await accountManager.setIsAddressRegisteredToAccount(accountId, spokeChainId, userAddr);

      // calculate expected claimable rewards
      const unclaimedRewards: Map<bigint, bigint> = new Map();
      const poolEpochs = [];
      for (const poolId of poolIds) {
        for (let epochIndex = 1; epochIndex < numEpochs; epochIndex++) {
          const totalPoints: bigint = await hubRewardsV2.poolTotalEpochPoints(poolId, epochIndex);
          const accountPoints: bigint = await hubRewardsV2.accountEpochPoints(accountId, poolId, epochIndex);
          const rewards = (await hubRewardsV2.getPoolEpoch(poolId, epochIndex))[2];
          rewards.forEach(([rewardTokenId, totalRewards]) => {
            const oldAmount = unclaimedRewards.get(rewardTokenId) || BigInt(0);
            const additionalAmount = (accountPoints * totalRewards) / totalPoints;
            unclaimedRewards.set(rewardTokenId, oldAmount + additionalAmount);
          });
          // pushing twice should have no impact on actual amount
          poolEpochs.push({ poolId, epochIndex });
          poolEpochs.push({ poolId, epochIndex });
        }
      }

      // check expected claimable rewards
      for (const [rewardTokenId, amount] of unclaimedRewards) {
        expect(await hubRewardsV2.getUnclaimedRewards(accountId, poolEpochs, rewardTokenId)).to.equal(
          amount * BigInt(2)
        );
      }

      // receive message
      const message = getClaimRewardsMessage(
        spokeChainId,
        spokeAddress,
        hubRewardsV2Address,
        accountId,
        user.address,
        poolEpochs,
        []
      );
      const claimRewards = await bridgeRouter.receiveMessage(message);
      for (const poolId of poolIds) {
        for (let epochIndex = 1; epochIndex < numEpochs; epochIndex++) {
          expect(await hubRewardsV2.accountEpochPoints(accountId, poolId, epochIndex)).to.equal(0);
        }
      }

      // verify message
      await expect(claimRewards).to.emit(bridgeRouter, "MessageSucceeded").withArgs(message.messageId);
      await expect(claimRewards).to.emit(bridgeRouter, "MessageReceived").withArgs(Object.values(message));

      // verify expected claimable rewards
      for (const [rewardTokenId, amount] of unclaimedRewards) {
        expect(await hubRewardsV2.accountUnclaimedRewards(accountId, rewardTokenId)).to.equal(amount);
        expect(await hubRewardsV2.getUnclaimedRewards(accountId, poolEpochs, rewardTokenId)).to.equal(amount);
      }
    });

    it("Should fail when epoch not ended", async () => {
      const {
        user,
        hubRewardsV2,
        hubRewardsV2Address,
        bridgeRouter,
        accountManager,
        spokeChainId,
        spokeAddress,
        numEpochs,
        poolIds,
        accountIds,
      } = await loadFixture(updateMultipleAccountsPointsForMultiplePoolsFixture);

      // add user as registered
      const accountId: string = accountIds[0];
      const userAddr = convertEVMAddressToGenericAddress(user.address);
      await accountManager.setIsAddressRegisteredToAccount(accountId, spokeChainId, userAddr);

      // verify epoch hasn't ended
      const poolId = poolIds[0];
      const epochIndex = numEpochs;
      const timestamp = await getLatestBlockTimestamp();
      const epochEnd = (await hubRewardsV2.getPoolEpoch(poolId, epochIndex))[1];
      expect(epochEnd).to.be.greaterThan(timestamp);

      // receive message
      const message = getClaimRewardsMessage(
        spokeChainId,
        spokeAddress,
        hubRewardsV2Address,
        accountId,
        user.address,
        [{ poolId, epochIndex }],
        []
      );
      const claimRewards = await bridgeRouter.receiveMessage(message);

      // check failure
      const errorReason = hubRewardsV2.interface.encodeErrorResult("EpochNotEnded", [poolId, epochIndex, epochEnd]);
      await expect(claimRewards).to.emit(bridgeRouter, "MessageFailed").withArgs(message.messageId, errorReason);
    });

    it("Should fail to receive message when action is unsupported", async () => {
      const {
        user,
        hubRewardsV2,
        hubRewardsV2Address,
        bridgeRouter,
        accountManager,
        spokeChainId,
        spokeAddress,
        accountIds,
      } = await loadFixture(updateMultipleAccountsPointsForMultiplePoolsFixture);

      // add user as registered
      const accountId: string = accountIds[0];
      const userAddr = convertEVMAddressToGenericAddress(user.address);
      await accountManager.setIsAddressRegisteredToAccount(accountId, spokeChainId, userAddr);

      // receive message
      const messageId: string = getRandomBytes(BYTES32_LENGTH);
      const message: MessageReceived = {
        messageId: messageId,
        sourceChainId: BigInt(spokeChainId),
        sourceAddress: convertEVMAddressToGenericAddress(spokeAddress),
        handler: convertEVMAddressToGenericAddress(hubRewardsV2Address),
        payload: buildMessagePayload(Action.AcceptInviteAddress, accountId, user.address, "0x"),
        returnAdapterId: BigInt(0),
        returnGasLimit: BigInt(0),
      };
      const receiveMessage = bridgeRouter.receiveMessage(message);

      // check failure
      const errorReason = hubRewardsV2.interface.encodeErrorResult("CannotReceiveMessage", [messageId]);
      await expect(receiveMessage).to.emit(bridgeRouter, "MessageFailed").withArgs(messageId, errorReason);
    });
  });

  it("Should fail to retry message", async () => {
    const { user, hubRewardsV2, hubRewardsV2Address, bridgeRouterAddress, bridgeRouterSigner } =
      await loadFixture(deployHubRewardsV2Fixture);

    // fund bridge router to send transaction
    setBalance(bridgeRouterAddress, 1e18);

    // retry message
    const messageId: string = getRandomBytes(BYTES32_LENGTH);
    const accountId: string = getAccountIdBytes("ACCOUNT_ID");
    const message: MessageReceived = {
      messageId: messageId,
      sourceChainId: BigInt(0),
      sourceAddress: convertEVMAddressToGenericAddress(getRandomAddress()),
      handler: convertEVMAddressToGenericAddress(hubRewardsV2Address),
      payload: buildMessagePayload(0, accountId, getRandomAddress(), "0x"),
      returnAdapterId: BigInt(0),
      returnGasLimit: BigInt(0),
    };
    const extraArgs = "0x";
    const receiveMessage = hubRewardsV2.connect(bridgeRouterSigner).retryMessage(message, user.address, extraArgs);
    await expect(receiveMessage).to.be.revertedWithCustomError(hubRewardsV2, "CannotRetryMessage").withArgs(messageId);
  });

  it("Should fail to reverse message", async () => {
    const { user, hubRewardsV2, hubRewardsV2Address, bridgeRouterAddress, bridgeRouterSigner } =
      await loadFixture(deployHubRewardsV2Fixture);

    // fund bridge router to send transaction
    setBalance(bridgeRouterAddress, 1e18);

    // reverse message
    const messageId: string = getRandomBytes(BYTES32_LENGTH);
    const accountId: string = getAccountIdBytes("ACCOUNT_ID");
    const message: MessageReceived = {
      messageId: messageId,
      sourceChainId: BigInt(0),
      sourceAddress: convertEVMAddressToGenericAddress(getRandomAddress()),
      handler: convertEVMAddressToGenericAddress(hubRewardsV2Address),
      payload: buildMessagePayload(0, accountId, getRandomAddress(), "0x"),
      returnAdapterId: BigInt(0),
      returnGasLimit: BigInt(0),
    };
    const extraArgs = "0x";
    const receiveMessage = hubRewardsV2.connect(bridgeRouterSigner).reverseMessage(message, user.address, extraArgs);
    await expect(receiveMessage)
      .to.be.revertedWithCustomError(hubRewardsV2, "CannotReverseMessage")
      .withArgs(messageId);
  });
});
