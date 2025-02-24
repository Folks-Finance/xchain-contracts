import { expect } from "chai";
import { ethers } from "hardhat";
import { impersonateAccount, loadFixture, setBalance } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import {
  SimpleAddressOracle__factory,
  MockBridgeRouter__factory,
  SpokeRewardsV2Common__factory,
} from "../../typechain-types";
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
import { MessageParams, Action, buildMessagePayload, MessageReceived, Finality } from "../utils/messages/messages";
import { getRandomInt, SECONDS_IN_DAY } from "../utils/time";

describe("SpokeToken contract (unit tests)", () => {
  const DEFAULT_ADMIN_ROLE = getEmptyBytes(BYTES32_LENGTH);
  const CONFIG_CONTRACTS_ROLE = ethers.keccak256(convertStringToBytes("CONFIG_CONTRACTS"));

  const MESSAGE_PARAMS: MessageParams = {
    adapterId: BigInt(0),
    returnAdapterId: BigInt(0),
    receiverValue: BigInt(0),
    gasLimit: BigInt(30000),
    returnGasLimit: BigInt(0),
  };

  async function deploySpokeFixture() {
    const [admin, user, ...unusedUsers] = await ethers.getSigners();

    // deploy spoke
    const bridgeRouter = await new MockBridgeRouter__factory(user).deploy();
    const hubChainId = 0;
    const hubAddress = convertEVMAddressToGenericAddress(getRandomAddress());
    const addressOracle = await new SimpleAddressOracle__factory(user).deploy();
    const spokeCommon = await new SpokeRewardsV2Common__factory(user).deploy(
      admin.address,
      bridgeRouter,
      hubChainId,
      hubAddress,
      addressOracle
    );
    const spokeAddress = await spokeCommon.getAddress();

    // impersonate bridge router
    const bridgeRouterAddress = await bridgeRouter.getAddress();
    impersonateAccount(bridgeRouterAddress);
    const bridgeRouterSigner = await ethers.getSigner(bridgeRouterAddress);

    return {
      admin,
      user,
      unusedUsers,
      spokeCommon,
      spokeAddress,
      bridgeRouter,
      bridgeRouterAddress,
      bridgeRouterSigner,
      hubChainId,
      hubAddress,
      addressOracle,
    };
  }

  describe("Deployment", () => {
    it("Should set roles and state correctly", async () => {
      const { admin, spokeCommon, bridgeRouter, hubChainId, hubAddress, addressOracle } =
        await loadFixture(deploySpokeFixture);

      // check default admin role
      expect(await spokeCommon.owner()).to.equal(admin.address);
      expect(await spokeCommon.defaultAdmin()).to.equal(admin.address);
      expect(await spokeCommon.defaultAdminDelay()).to.equal(SECONDS_IN_DAY);
      expect(await spokeCommon.getRoleAdmin(DEFAULT_ADMIN_ROLE)).to.equal(DEFAULT_ADMIN_ROLE);
      expect(await spokeCommon.hasRole(DEFAULT_ADMIN_ROLE, admin.address)).to.be.true;

      // check config contracts role
      expect(await spokeCommon.getRoleAdmin(CONFIG_CONTRACTS_ROLE)).to.equal(DEFAULT_ADMIN_ROLE);
      expect(await spokeCommon.hasRole(CONFIG_CONTRACTS_ROLE, admin.address)).to.be.true;

      // check state
      expect(await spokeCommon.getBridgeRouter()).to.equal(bridgeRouter);
      expect(await spokeCommon.getHubChainId()).to.equal(hubChainId);
      expect(await spokeCommon.getHubContractAddress()).to.equal(hubAddress);
      expect(await spokeCommon.getAddressOracle()).to.equal(addressOracle);
    });
  });

  describe("Claim Rewards", () => {
    it("Should call bridge router with the correct message to send", async () => {
      const { user, spokeCommon, spokeAddress, bridgeRouter, hubChainId, hubAddress } =
        await loadFixture(deploySpokeFixture);

      // call create account
      const accountId: string = getAccountIdBytes("ACCOUNT_ID");
      const poolEpochsToClaim = Array.from({ length: getRandomInt(10) }, () => ({
        poolId: BigInt(getRandomInt(128)),
        epochIndex: BigInt(getRandomInt(20)),
      }));
      const rewardTokensToReceive = Array.from({ length: getRandomInt(5) }, () => ({
        rewardTokenId: BigInt(getRandomInt(16)),
        returnAdapterId: BigInt(getRandomInt(4)),
        returnGasLimit: BigInt(getRandomInt(300000)),
      }));
      const feeAmount = BigInt(30000);
      const claimRewards = spokeCommon.claimRewards(
        MESSAGE_PARAMS,
        accountId,
        poolEpochsToClaim,
        rewardTokensToReceive,
        {
          value: feeAmount,
        }
      );

      // expect message
      const params = Object.values(MESSAGE_PARAMS);
      const sourceAddress = convertEVMAddressToGenericAddress(spokeAddress);
      const payload = buildMessagePayload(
        Action.ClaimRewardsV2,
        accountId,
        user.address,
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
      );
      await expect(claimRewards)
        .to.emit(bridgeRouter, "SendMessage")
        .withArgs(params, sourceAddress, hubChainId, hubAddress, payload, Finality.IMMEDIATE, "0x");
      expect(await ethers.provider.getBalance(bridgeRouter)).to.equal(feeAmount);
    });

    it("Should fail if address is not eligible to perform action", async () => {
      const { user, spokeCommon, addressOracle } = await loadFixture(deploySpokeFixture);

      // set eligibility to false
      await addressOracle.setEligible(false);

      // create account
      const accountId: string = getAccountIdBytes("ACCOUNT_ID");
      const claimRewards = spokeCommon.claimRewards(MESSAGE_PARAMS, accountId, [], []);
      await expect(claimRewards)
        .to.be.revertedWithCustomError(spokeCommon, "AddressIneligible")
        .withArgs(user.address, Action.ClaimRewardsV2);
    });
  });

  it("Should fail to receive message", async () => {
    const { spokeCommon, spokeAddress, bridgeRouterAddress, bridgeRouterSigner } =
      await loadFixture(deploySpokeFixture);

    // fund bridge router to send transaction
    setBalance(bridgeRouterAddress, 1e18);

    // receive message
    const messageId: string = getRandomBytes(BYTES32_LENGTH);
    const accountId: string = getAccountIdBytes("ACCOUNT_ID");
    const message: MessageReceived = {
      messageId: messageId,
      sourceChainId: BigInt(0),
      sourceAddress: convertEVMAddressToGenericAddress(getRandomAddress()),
      handler: convertEVMAddressToGenericAddress(spokeAddress),
      payload: buildMessagePayload(0, accountId, getRandomAddress(), "0x"),
      returnAdapterId: BigInt(0),
      returnGasLimit: BigInt(0),
    };
    const receiveMessage = spokeCommon.connect(bridgeRouterSigner).receiveMessage(message);
    await expect(receiveMessage).to.be.revertedWithCustomError(spokeCommon, "CannotReceiveMessage").withArgs(messageId);
  });

  it("Should fail to retry message", async () => {
    const { user, spokeCommon, spokeAddress, bridgeRouterAddress, bridgeRouterSigner } =
      await loadFixture(deploySpokeFixture);

    // fund bridge router to send transaction
    setBalance(bridgeRouterAddress, 1e18);

    // retry message
    const messageId: string = getRandomBytes(BYTES32_LENGTH);
    const accountId: string = getAccountIdBytes("ACCOUNT_ID");
    const message: MessageReceived = {
      messageId: messageId,
      sourceChainId: BigInt(0),
      sourceAddress: convertEVMAddressToGenericAddress(getRandomAddress()),
      handler: convertEVMAddressToGenericAddress(spokeAddress),
      payload: buildMessagePayload(0, accountId, getRandomAddress(), "0x"),
      returnAdapterId: BigInt(0),
      returnGasLimit: BigInt(0),
    };
    const extraArgs = "0x";
    const receiveMessage = spokeCommon.connect(bridgeRouterSigner).retryMessage(message, user.address, extraArgs);
    await expect(receiveMessage).to.be.revertedWithCustomError(spokeCommon, "CannotRetryMessage").withArgs(messageId);
  });

  it("Should fail to reverse message", async () => {
    const { user, spokeCommon, spokeAddress, bridgeRouterAddress, bridgeRouterSigner } =
      await loadFixture(deploySpokeFixture);

    // fund bridge router to send transaction
    setBalance(bridgeRouterAddress, 1e18);

    // reverse message
    const messageId: string = getRandomBytes(BYTES32_LENGTH);
    const accountId: string = getAccountIdBytes("ACCOUNT_ID");
    const message: MessageReceived = {
      messageId: messageId,
      sourceChainId: BigInt(0),
      sourceAddress: convertEVMAddressToGenericAddress(getRandomAddress()),
      handler: convertEVMAddressToGenericAddress(spokeAddress),
      payload: buildMessagePayload(0, accountId, getRandomAddress(), "0x"),
      returnAdapterId: BigInt(0),
      returnGasLimit: BigInt(0),
    };
    const extraArgs = "0x";
    const receiveMessage = spokeCommon.connect(bridgeRouterSigner).reverseMessage(message, user.address, extraArgs);
    await expect(receiveMessage).to.be.revertedWithCustomError(spokeCommon, "CannotReverseMessage").withArgs(messageId);
  });
});
