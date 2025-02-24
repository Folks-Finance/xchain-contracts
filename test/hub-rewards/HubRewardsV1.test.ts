import { expect } from "chai";
import { ethers } from "hardhat";
import { PANIC_CODES } from "@nomicfoundation/hardhat-chai-matchers/panic";
import { loadFixture, reset, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import {
  LoanManagerStateExposed__factory,
  MockAccountManager__factory,
  RewardsV1__factory,
} from "../../typechain-types";
import { UserPoolRewards } from "../hub/libraries/assets/loanData";
import {
  BYTES32_LENGTH,
  convertEVMAddressToGenericAddress,
  convertStringToBytes,
  getEmptyBytes,
  getRandomAddress,
  getRandomBytes,
} from "../utils/bytes";
import { SECONDS_IN_DAY, getLatestBlockTimestamp, getRandomInt } from "../utils/time";

const ONE_DAY = BigInt(86400);
const ONE_WEEK = ONE_DAY * BigInt(7);

interface Epoch {
  start: bigint;
  end: bigint;
  totalRewards: bigint;
}

describe("HubRewardsV1 (unit tests)", () => {
  const DEFAULT_ADMIN_ROLE = getEmptyBytes(BYTES32_LENGTH);
  const LISTING_ROLE = ethers.keccak256(convertStringToBytes("LISTING"));

  async function deployRewardsV1Fixture() {
    const [admin, user, ...unusedUsers] = await ethers.getSigners();

    // deploy contract
    const accountManager = await new MockAccountManager__factory(user).deploy();
    const loanManager = await new LoanManagerStateExposed__factory(user).deploy(admin, getRandomAddress());
    const hubChainId = 1;
    const rewardsV1 = await new RewardsV1__factory(user).deploy(admin, accountManager, loanManager, hubChainId);

    return { admin, user, unusedUsers, rewardsV1, accountManager, loanManager, hubChainId };
  }

  async function addEpochFixture() {
    const { admin, user, unusedUsers, rewardsV1, accountManager, loanManager, hubChainId } =
      await loadFixture(deployRewardsV1Fixture);

    // add epoch
    const poolId = 3;
    const start = BigInt(await getLatestBlockTimestamp()) + ONE_DAY;
    const end = start + ONE_WEEK;
    const totalRewards = BigInt(100e18);
    const addEpoch = await rewardsV1.connect(admin).addEpoch(poolId, start, end, totalRewards);

    return {
      admin,
      user,
      unusedUsers,
      rewardsV1,
      addEpoch,
      accountManager,
      loanManager,
      hubChainId,
      poolId,
      start,
      end,
      totalRewards,
    };
  }

  async function addMultipleEpochsFixture() {
    const { admin, user, unusedUsers, rewardsV1, accountManager, loanManager, hubChainId } =
      await loadFixture(deployRewardsV1Fixture);

    // epochs structure
    const poolIds = [3, 5, 6];
    const numEpochs = 4;
    const firstEpochStart = BigInt(await getLatestBlockTimestamp()) + ONE_DAY;
    // pool id -> epoch index -> epoch
    const epochs: Record<number, Record<number, Epoch>> = {};
    for (const poolId of poolIds) {
      epochs[poolId] = {};
      for (let epochIndex = 1; epochIndex <= numEpochs; epochIndex++) {
        const totalRewards = BigInt(getRandomInt(100e18));
        const start = firstEpochStart + BigInt(epochIndex - 1) * ONE_WEEK;
        const end = start + ONE_WEEK - BigInt(1);

        // add
        await rewardsV1.connect(admin).addEpoch(poolId, start, end, totalRewards);
        epochs[poolId][epochIndex] = { start, end, totalRewards };
      }
    }

    return {
      admin,
      user,
      unusedUsers,
      rewardsV1,
      accountManager,
      loanManager,
      hubChainId,
      poolIds,
      numEpochs,
      epochs,
    };
  }

  async function updateMultipleAccountsPointsForMultiplePoolsFixture() {
    const { admin, user, unusedUsers, rewardsV1, accountManager, loanManager, hubChainId, poolIds, numEpochs, epochs } =
      await loadFixture(addMultipleEpochsFixture);

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
          const prev = await rewardsV1.accountLastUpdatedPoints(accountId, poolId);
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
      await rewardsV1.connect(user).updateAccountPoints(accountIds, poolEpochs);
    }

    return {
      admin,
      user,
      unusedUsers,
      rewardsV1,
      accountManager,
      loanManager,
      hubChainId,
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
      const { admin, rewardsV1, accountManager, loanManager, hubChainId } = await loadFixture(deployRewardsV1Fixture);

      // check default admin role
      expect(await rewardsV1.owner()).to.equal(admin.address);
      expect(await rewardsV1.defaultAdmin()).to.equal(admin.address);
      expect(await rewardsV1.defaultAdminDelay()).to.equal(SECONDS_IN_DAY);
      expect(await rewardsV1.getRoleAdmin(DEFAULT_ADMIN_ROLE)).to.equal(DEFAULT_ADMIN_ROLE);
      expect(await rewardsV1.hasRole(DEFAULT_ADMIN_ROLE, admin.address)).to.be.true;

      // check other roles
      expect(await rewardsV1.getRoleAdmin(LISTING_ROLE)).to.equal(DEFAULT_ADMIN_ROLE);
      expect(await rewardsV1.hasRole(LISTING_ROLE, admin.address)).to.be.true;

      // check state
      expect(await rewardsV1.accountManager()).to.equal(accountManager);
      expect(await rewardsV1.loanManager()).to.equal(loanManager);
      expect(await rewardsV1.hubChainId()).to.equal(hubChainId);
      await expect(rewardsV1.getActiveEpoch(1))
        .to.be.revertedWithCustomError(rewardsV1, "EpochNotActive")
        .withArgs(1, 0);
    });
  });

  describe("Fund", () => {
    it("Should be payable", async () => {
      const { user, rewardsV1 } = await loadFixture(deployRewardsV1Fixture);

      // fund
      const amount = BigInt(10e18);
      const fund = await rewardsV1.connect(user).fund({ value: amount });
      const balance = await ethers.provider.getBalance(rewardsV1);
      expect(balance).to.equal(amount);
      expect(fund).to.emit(rewardsV1, "Funded").withArgs(amount);
    });
  });

  describe("Add Epoch", () => {
    it("Should successfully add epoch", async () => {
      const { rewardsV1, addEpoch, poolId, start, end, totalRewards } = await loadFixture(addEpochFixture);

      // verify added
      const epochIndex = 1;
      expect(await rewardsV1.poolEpochIndex(poolId)).to.equal(epochIndex);
      expect(await rewardsV1.poolEpochs(poolId, epochIndex)).to.deep.equal([start, end, totalRewards]);
      await expect(addEpoch).to.emit(rewardsV1, "EpochAdded").withArgs(poolId, start, end, totalRewards, epochIndex);

      // advance
      await time.increaseTo(start);
      expect(await rewardsV1.getActiveEpoch(poolId)).to.deep.equal([epochIndex, [start, end, totalRewards]]);
      await time.increaseTo(end);
      await expect(rewardsV1.getActiveEpoch(poolId))
        .to.to.be.revertedWithCustomError(rewardsV1, "EpochNotActive")
        .withArgs(poolId, epochIndex);
    });

    it("Should successfully add multiple epochs", async () => {
      const { rewardsV1, poolIds, numEpochs, epochs } = await loadFixture(addMultipleEpochsFixture);

      // verify added
      for (let i = 0; i < poolIds.length; i++) {
        const poolId = poolIds[i];
        const poolEpochs = epochs[poolId];
        expect(await rewardsV1.poolEpochIndex(poolId)).to.equal(numEpochs);

        for (let epochIndex = 1; epochIndex <= numEpochs; epochIndex++) {
          const { start, end, totalRewards } = poolEpochs[epochIndex];
          expect(await rewardsV1.poolEpochs(poolId, epochIndex)).to.deep.equal([start, end, totalRewards]);
        }
      }

      // advance
      const poolId = poolIds[0];
      const { start, end, totalRewards } = epochs[poolId][numEpochs];
      await time.increaseTo(start);
      expect(await rewardsV1.getActiveEpoch(poolId)).to.deep.equal([numEpochs, [start, end, totalRewards]]);
      await time.increaseTo(end);
      await expect(rewardsV1.getActiveEpoch(poolId))
        .to.to.be.revertedWithCustomError(rewardsV1, "EpochNotActive")
        .withArgs(poolId, numEpochs);
    });

    it("Should fail to add epoch when overlaps with previous epoch", async () => {
      const { admin, rewardsV1, poolId, end: previousEnd } = await loadFixture(addEpochFixture);

      // add epoch when overlaps
      let start = previousEnd;
      const end = start + ONE_WEEK;
      const totalRewards = BigInt(100e18);
      const addEpoch = rewardsV1.connect(admin).addEpoch(poolId, start, end, totalRewards);
      await expect(addEpoch)
        .to.be.revertedWithCustomError(rewardsV1, "InvalidEpochStart")
        .withArgs(poolId, previousEnd, start);

      // add epoch when okay
      start += BigInt(1);
      await rewardsV1.connect(admin).addEpoch(poolId, start, end, totalRewards);
    });

    it("Should fail to add epoch when start after end", async () => {
      const { admin, rewardsV1 } = await loadFixture(deployRewardsV1Fixture);

      // add epoch when start after end
      const poolId = 3;
      const start = BigInt(await getLatestBlockTimestamp()) + ONE_DAY;
      const end = start - BigInt(1);
      const totalRewards = BigInt(100e18);
      const addEpoch = rewardsV1.connect(admin).addEpoch(poolId, start, end, totalRewards);
      await expect(addEpoch).to.be.revertedWithPanic(PANIC_CODES.ARITHMETIC_OVERFLOW);
    });

    it("Should fail to add epoch when length is less than a day", async () => {
      const { admin, rewardsV1 } = await loadFixture(deployRewardsV1Fixture);

      // add epoch when length is less than day
      const poolId = 3;
      const start = BigInt(await getLatestBlockTimestamp()) + ONE_DAY;
      let end = start + ONE_DAY - BigInt(1);
      const totalRewards = BigInt(100e18);
      const addEpoch = rewardsV1.connect(admin).addEpoch(poolId, start, end, totalRewards);
      await expect(addEpoch)
        .to.be.revertedWithCustomError(rewardsV1, "InvalidEpochLength")
        .withArgs(end - start, ONE_DAY);

      // add epoch when length is a day
      end += BigInt(1);
      await rewardsV1.connect(admin).addEpoch(poolId, start, end, totalRewards);
    });

    it("Should fail to add epoch when sender is not listing admin", async () => {
      const { user, rewardsV1 } = await loadFixture(deployRewardsV1Fixture);

      // add epoch
      const poolId = 3;
      const start = BigInt(await getLatestBlockTimestamp()) + ONE_DAY;
      const end = start + ONE_WEEK;
      const totalRewards = BigInt(100e18);
      const addEpoch = rewardsV1.connect(user).addEpoch(poolId, start, end, totalRewards);
      await expect(addEpoch)
        .to.be.revertedWithCustomError(rewardsV1, "AccessControlUnauthorizedAccount")
        .withArgs(user.address, LISTING_ROLE);
    });
  });

  describe("Update epoch total rewards", () => {
    it("Should successfully update epoch total rewards", async () => {
      const { admin, rewardsV1, poolId, totalRewards: oldTotalRewards } = await loadFixture(addEpochFixture);

      // verify old total rewards
      const epochIndex = 1;
      expect((await rewardsV1.poolEpochs(poolId, epochIndex))[2]).to.deep.equal(oldTotalRewards);

      // update
      const newTotalRewards = oldTotalRewards * BigInt(2);
      const updateEpochTotalRewards = await rewardsV1
        .connect(admin)
        .updateEpochTotalRewards({ poolId, epochIndex }, newTotalRewards);
      expect((await rewardsV1.poolEpochs(poolId, epochIndex))[2]).to.deep.equal(newTotalRewards);
      await expect(updateEpochTotalRewards)
        .to.emit(rewardsV1, "EpochUpdated")
        .withArgs(poolId, epochIndex, newTotalRewards);
    });

    it("Should fail to update epoch total rewards after end", async () => {
      const { admin, rewardsV1, poolId, end, totalRewards } = await loadFixture(addEpochFixture);

      // update before end
      const epochIndex = 1;
      await rewardsV1.connect(admin).updateEpochTotalRewards({ poolId, epochIndex }, totalRewards);

      // update at end
      await time.setNextBlockTimestamp(end);
      const updateEpochTotalRewards = rewardsV1
        .connect(admin)
        .updateEpochTotalRewards({ poolId, epochIndex }, totalRewards);
      await expect(updateEpochTotalRewards)
        .to.be.revertedWithCustomError(rewardsV1, "CannotUpdateExpiredEpoch")
        .withArgs(poolId, epochIndex, end);
    });

    it("Should fail to update epoch total rewards when sender is not listing admin", async () => {
      const { user, rewardsV1, poolId, totalRewards } = await loadFixture(addEpochFixture);

      // update
      const epochIndex = 1;
      const updateEpochTotalRewards = rewardsV1
        .connect(user)
        .updateEpochTotalRewards({ poolId, epochIndex }, totalRewards);
      await expect(updateEpochTotalRewards)
        .to.be.revertedWithCustomError(rewardsV1, "AccessControlUnauthorizedAccount")
        .withArgs(user.address, LISTING_ROLE);
    });
  });

  describe("Update Account Points", () => {
    it("Should successfully update a single account's points for a single pool", async () => {
      const { user, rewardsV1, loanManager, poolIds, epochs } = await loadFixture(addMultipleEpochsFixture);

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
      await rewardsV1.connect(user).updateAccountPoints([accountId], [{ poolId, epochIndex }]);
      expect(await rewardsV1.poolTotalEpochPoints(poolId, epochIndex)).to.equal(BigInt(100));
      expect(await rewardsV1.accountLastUpdatedPoints(accountId, poolId)).to.equal(BigInt(100));
      expect(await rewardsV1.accountEpochPoints(accountId, poolId, epochIndex)).to.equal(BigInt(100));

      // increase points in loan manager
      userPoolRewards.collateral += BigInt(50);
      await loanManager.setUserPoolRewards(accountId, poolId, userPoolRewards);

      // second update
      await rewardsV1.connect(user).updateAccountPoints([accountId], [{ poolId, epochIndex }]);
      expect(await rewardsV1.poolTotalEpochPoints(poolId, epochIndex)).to.equal(BigInt(150));
      expect(await rewardsV1.accountLastUpdatedPoints(accountId, poolId)).to.equal(BigInt(150));
      expect(await rewardsV1.accountEpochPoints(accountId, poolId, epochIndex)).to.equal(BigInt(150));
    });

    it("Should successfully update a single account's points for multiple pools", async () => {
      const { user, rewardsV1, loanManager, poolIds, epochs } = await loadFixture(addMultipleEpochsFixture);

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
      await rewardsV1.connect(user).updateAccountPoints(
        [accountId],
        [
          { poolId: poolIds[0], epochIndex },
          { poolId: poolIds[1], epochIndex },
        ]
      );
      expect(await rewardsV1.poolTotalEpochPoints(poolIds[0], epochIndex)).to.equal(BigInt(100));
      expect(await rewardsV1.poolTotalEpochPoints(poolIds[1], epochIndex)).to.equal(BigInt(150));
      expect(await rewardsV1.accountLastUpdatedPoints(accountId, poolIds[0])).to.equal(BigInt(100));
      expect(await rewardsV1.accountLastUpdatedPoints(accountId, poolIds[1])).to.equal(BigInt(150));
      expect(await rewardsV1.accountEpochPoints(accountId, poolIds[0], epochIndex)).to.equal(BigInt(100));
      expect(await rewardsV1.accountEpochPoints(accountId, poolIds[1], epochIndex)).to.equal(BigInt(150));
    });

    it("Should successfully update multiple accounts' points for a single pool", async () => {
      const { user, rewardsV1, loanManager, poolIds, epochs } = await loadFixture(addMultipleEpochsFixture);

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
      await rewardsV1.connect(user).updateAccountPoints([accountId0, accountId1], [{ poolId, epochIndex }]);
      expect(await rewardsV1.poolTotalEpochPoints(poolIds[0], epochIndex)).to.equal(BigInt(250));
      expect(await rewardsV1.accountLastUpdatedPoints(accountId0, poolId)).to.equal(BigInt(100));
      expect(await rewardsV1.accountLastUpdatedPoints(accountId1, poolId)).to.equal(BigInt(150));
      expect(await rewardsV1.accountEpochPoints(accountId0, poolId, epochIndex)).to.equal(BigInt(100));
      expect(await rewardsV1.accountEpochPoints(accountId1, poolId, epochIndex)).to.equal(BigInt(150));
    });

    it("Should successfully update multiple accounts' points for multiple pools", async () => {
      const {
        rewardsV1,
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
          expect(await rewardsV1.poolTotalEpochPoints(poolId, epochIndex)).to.equal(
            poolTotalEpochPoints[poolId][epochIndex]
          );
        }

        // check account specific points
        for (const accountId of accountIds) {
          for (let epochIndex = 1; epochIndex <= numEpochs; epochIndex++) {
            expect(await rewardsV1.accountEpochPoints(accountId, poolId, epochIndex)).to.equal(
              accountEpochPoints[accountId][poolId][epochIndex]
            );
          }
          expect(await rewardsV1.accountLastUpdatedPoints(accountId, poolId)).to.equal(
            accountLastUpdatedPoints[accountId][poolId]
          );
        }
      }
    });

    it("Should fail to update account points when epoch not active", async () => {
      const { user, rewardsV1, poolIds, epochs } = await loadFixture(addMultipleEpochsFixture);

      const poolId = poolIds[0];
      const accountId = getRandomBytes(BYTES32_LENGTH);

      // before start
      const epochIndex = 1;
      await time.setNextBlockTimestamp(epochs[poolId][epochIndex].start - BigInt(1));
      let updateAccountPoints = rewardsV1.connect(user).updateAccountPoints([accountId], [{ poolId, epochIndex }]);
      await expect(updateAccountPoints)
        .to.be.revertedWithCustomError(rewardsV1, "EpochNotActive")
        .withArgs(poolId, epochIndex);

      // after end
      await time.setNextBlockTimestamp(epochs[poolId][epochIndex].end);
      updateAccountPoints = rewardsV1.connect(user).updateAccountPoints([accountId], [{ poolId, epochIndex }]);
      await expect(updateAccountPoints)
        .to.be.revertedWithCustomError(rewardsV1, "EpochNotActive")
        .withArgs(poolId, epochIndex);
    });
  });

  describe("Claim Rewards", () => {
    it("Should successfully claim rewards when sender is registered", async () => {
      const { user, rewardsV1, accountManager, hubChainId, accountIds } = await loadFixture(
        updateMultipleAccountsPointsForMultiplePoolsFixture
      );

      // add user as registered
      const accountId: string = accountIds[0];
      const userAddr = convertEVMAddressToGenericAddress(user.address);
      await accountManager.setIsAddressRegisteredToAccount(accountId, hubChainId, userAddr);

      // claim rewards
      await rewardsV1.connect(user).claimRewards(accountId, [], getRandomAddress());
    });

    it("Should successfully claim rewards when sender is delegate", async () => {
      const { user, rewardsV1, accountManager, accountIds } = await loadFixture(
        updateMultipleAccountsPointsForMultiplePoolsFixture
      );

      // add user as delegate
      const accountId: string = accountIds[0];
      await accountManager.setIsDelegate(accountId, user.address, true);

      // claim rewards
      await rewardsV1.connect(user).claimRewards(accountId, [], getRandomAddress());
    });

    it("Should successfully claim rewards for single pool and single epoch", async () => {
      const { user, rewardsV1, accountManager, hubChainId, poolIds, accountIds } = await loadFixture(
        updateMultipleAccountsPointsForMultiplePoolsFixture
      );

      // add user as registered
      const accountId: string = accountIds[0];
      const userAddr = convertEVMAddressToGenericAddress(user.address);
      await accountManager.setIsAddressRegisteredToAccount(accountId, hubChainId, userAddr);

      // calculate expected amount
      const poolId = poolIds[0];
      const epochIndex = 1;
      const poolEpochs = [{ poolId, epochIndex }];
      const totalRewards: bigint = (await rewardsV1.poolEpochs(poolId, epochIndex))[2];
      const totalPoints: bigint = await rewardsV1.poolTotalEpochPoints(poolId, epochIndex);
      const accountPoints: bigint = await rewardsV1.accountEpochPoints(accountId, poolId, epochIndex);
      const amount: bigint = (accountPoints * totalRewards) / totalPoints;
      expect(await rewardsV1.getUnclaimedRewards(accountId, poolEpochs)).to.equal(amount);

      // fund smart contract
      await rewardsV1.connect(user).fund({ value: amount });

      // balance before
      const receiver = getRandomAddress();
      const scBalanceBefore = await ethers.provider.getBalance(rewardsV1);
      const receiverBalanceBefore = await ethers.provider.getBalance(receiver);

      // claim rewards
      const claimRewards = await rewardsV1.connect(user).claimRewards(accountId, poolEpochs, receiver);
      expect(await rewardsV1.accountEpochPoints(accountId, poolId, epochIndex)).to.equal(0);
      expect(claimRewards).to.emit(rewardsV1, "RewardsClaimed").withArgs(accountId, receiver, amount);

      // balance after
      const scBalanceAfter = await ethers.provider.getBalance(rewardsV1);
      const receiverBalanceAfter = await ethers.provider.getBalance(receiver);
      expect(scBalanceAfter).to.equal(scBalanceBefore - amount);
      expect(receiverBalanceAfter).to.equal(receiverBalanceBefore + amount);
    });

    it("Should successfully claim rewards for single pool and multiple epochs", async () => {
      const { user, rewardsV1, accountManager, hubChainId, poolIds, numEpochs, accountIds } = await loadFixture(
        updateMultipleAccountsPointsForMultiplePoolsFixture
      );

      // add user as registered
      const accountId: string = accountIds[0];
      const userAddr = convertEVMAddressToGenericAddress(user.address);
      await accountManager.setIsAddressRegisteredToAccount(accountId, hubChainId, userAddr);

      // calculate expected amount
      const poolId = poolIds[0];
      let amount = BigInt(0);
      const poolEpochs = [];
      for (let epochIndex = 1; epochIndex < numEpochs; epochIndex++) {
        const totalRewards: bigint = (await rewardsV1.poolEpochs(poolId, epochIndex))[2];
        const totalPoints: bigint = await rewardsV1.poolTotalEpochPoints(poolId, epochIndex);
        const accountPoints: bigint = await rewardsV1.accountEpochPoints(accountId, poolId, epochIndex);
        amount += (accountPoints * totalRewards) / totalPoints;
        poolEpochs.push({ poolId, epochIndex });
      }
      expect(await rewardsV1.getUnclaimedRewards(accountId, poolEpochs)).to.equal(amount);

      // fund smart contract
      await rewardsV1.connect(user).fund({ value: amount });

      // balance before
      const scBalanceBefore = await ethers.provider.getBalance(rewardsV1);
      const userBalanceBefore = await ethers.provider.getBalance(user.address);

      // claim rewards
      const claimRewards = await rewardsV1.connect(user).claimRewards(accountId, poolEpochs, user.address);
      for (let epochIndex = 1; epochIndex < numEpochs; epochIndex++) {
        expect(await rewardsV1.accountEpochPoints(accountId, poolId, epochIndex)).to.equal(0);
      }
      expect(claimRewards).to.emit(rewardsV1, "RewardsClaimed").withArgs(accountId, user.address, amount);

      // balance after
      const receipt = await ethers.provider.getTransactionReceipt(claimRewards.hash);
      const scBalanceAfter = await ethers.provider.getBalance(rewardsV1);
      const userBalanceAfter = await ethers.provider.getBalance(user.address);
      expect(scBalanceAfter).to.equal(scBalanceBefore - amount);
      expect(userBalanceAfter).to.equal(userBalanceBefore + amount - receipt!.fee);
    });

    it("Should successfully claim rewards for multiple pools and multiple epochs", async () => {
      const { user, rewardsV1, accountManager, hubChainId, poolIds, numEpochs, accountIds } = await loadFixture(
        updateMultipleAccountsPointsForMultiplePoolsFixture
      );

      // add user as registered
      const accountId: string = accountIds[0];
      const userAddr = convertEVMAddressToGenericAddress(user.address);
      await accountManager.setIsAddressRegisteredToAccount(accountId, hubChainId, userAddr);

      // calculate expected amount
      let amount = BigInt(0);
      const poolEpochs = [];
      for (const poolId of poolIds) {
        for (let epochIndex = 1; epochIndex < numEpochs; epochIndex++) {
          const totalRewards: bigint = (await rewardsV1.poolEpochs(poolId, epochIndex))[2];
          const totalPoints: bigint = await rewardsV1.poolTotalEpochPoints(poolId, epochIndex);
          const accountPoints: bigint = await rewardsV1.accountEpochPoints(accountId, poolId, epochIndex);
          amount += (accountPoints * totalRewards) / totalPoints;
          // pushing twice should have no impact on actual amount
          poolEpochs.push({ poolId, epochIndex });
          poolEpochs.push({ poolId, epochIndex });
        }
      }
      expect(await rewardsV1.getUnclaimedRewards(accountId, poolEpochs)).to.equal(amount * BigInt(2));

      // fund smart contract
      await rewardsV1.connect(user).fund({ value: amount });

      // balance before
      const scBalanceBefore = await ethers.provider.getBalance(rewardsV1);
      const userBalanceBefore = await ethers.provider.getBalance(user.address);

      // claim rewards
      const claimRewards = await rewardsV1.connect(user).claimRewards(accountId, poolEpochs, user.address);
      for (const poolId of poolIds) {
        for (let epochIndex = 1; epochIndex < numEpochs; epochIndex++) {
          expect(await rewardsV1.accountEpochPoints(accountId, poolId, epochIndex)).to.equal(0);
        }
      }
      expect(claimRewards).to.emit(rewardsV1, "RewardsClaimed").withArgs(accountId, user.address, amount);

      // balance after
      const receipt = await ethers.provider.getTransactionReceipt(claimRewards.hash);
      const scBalanceAfter = await ethers.provider.getBalance(rewardsV1);
      const userBalanceAfter = await ethers.provider.getBalance(user.address);
      expect(scBalanceAfter).to.equal(scBalanceBefore - amount);
      expect(userBalanceAfter).to.equal(userBalanceBefore + amount - receipt!.fee);
    });

    it("Should fail to claim rewards when sender doesn't have permission on hub", async () => {
      const { user, rewardsV1, accountManager, hubChainId, accountIds } = await loadFixture(
        updateMultipleAccountsPointsForMultiplePoolsFixture
      );

      // verify not registered or delegate
      const accountId: string = accountIds[0];
      const userAddr = convertEVMAddressToGenericAddress(user.address);
      expect(await accountManager.isAddressRegisteredToAccount(accountId, hubChainId, userAddr)).to.be.false;
      expect(await accountManager.isDelegate(accountId, user.address)).to.be.false;

      // claim rewards
      const claimRewards = rewardsV1.connect(user).claimRewards(accountId, [], getRandomAddress());
      await expect(claimRewards)
        .to.be.revertedWithCustomError(rewardsV1, "NoPermissionOnHub")
        .withArgs(accountId, user.address);
    });

    it("Should fail to claim rewards when epoch not ended", async () => {
      const { user, rewardsV1, accountManager, hubChainId, numEpochs, poolIds, accountIds } = await loadFixture(
        updateMultipleAccountsPointsForMultiplePoolsFixture
      );

      // add user as registered
      const accountId: string = accountIds[0];
      const userAddr = convertEVMAddressToGenericAddress(user.address);
      await accountManager.setIsAddressRegisteredToAccount(accountId, hubChainId, userAddr);

      // verify epoch hasn't ended
      const poolId = poolIds[0];
      const epochIndex = numEpochs;
      const timestamp = await getLatestBlockTimestamp();
      const epochEnd = (await rewardsV1.poolEpochs(poolId, epochIndex))[1];
      expect(epochEnd).to.be.greaterThan(timestamp);

      // claim rewards
      const claimRewards = rewardsV1
        .connect(user)
        .claimRewards(accountId, [{ poolId, epochIndex }], getRandomAddress());
      await expect(claimRewards)
        .to.be.revertedWithCustomError(rewardsV1, "EpochNotEnded")
        .withArgs(poolId, epochIndex, epochEnd);
    });

    // TODO test non payable recipient
  });
});
