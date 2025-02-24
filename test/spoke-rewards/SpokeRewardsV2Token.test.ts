import { expect } from "chai";
import { ethers } from "hardhat";
import { impersonateAccount, loadFixture, setBalance } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import {
  SimpleAddressOracle__factory,
  MockBridgeRouter__factory,
  SpokeRewardsV2MockToken__factory,
} from "../../typechain-types";
import {
  BYTES32_LENGTH,
  UINT256_LENGTH,
  convertEVMAddressToGenericAddress,
  convertNumberToBytes,
  convertStringToBytes,
  getAccountIdBytes,
  getEmptyBytes,
  getRandomAddress,
  getRandomBytes,
} from "../utils/bytes";
import { MessageParams, Action, buildMessagePayload, MessageReceived } from "../utils/messages/messages";
import { SECONDS_IN_DAY } from "../utils/time";

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
    const spokeToken = await new SpokeRewardsV2MockToken__factory(user).deploy(
      admin.address,
      bridgeRouter,
      hubChainId,
      hubAddress,
      addressOracle
    );
    const spokeAddress = await spokeToken.getAddress();

    // impersonate bridge router
    const bridgeRouterAddress = await bridgeRouter.getAddress();
    impersonateAccount(bridgeRouterAddress);
    const bridgeRouterSigner = await ethers.getSigner(bridgeRouterAddress);

    return {
      admin,
      user,
      unusedUsers,
      spokeToken,
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
      const { admin, spokeToken, bridgeRouter, hubChainId, hubAddress, addressOracle } =
        await loadFixture(deploySpokeFixture);

      // check default admin role
      expect(await spokeToken.owner()).to.equal(admin.address);
      expect(await spokeToken.defaultAdmin()).to.equal(admin.address);
      expect(await spokeToken.defaultAdminDelay()).to.equal(SECONDS_IN_DAY);
      expect(await spokeToken.getRoleAdmin(DEFAULT_ADMIN_ROLE)).to.equal(DEFAULT_ADMIN_ROLE);
      expect(await spokeToken.hasRole(DEFAULT_ADMIN_ROLE, admin.address)).to.be.true;

      // check config contracts role
      expect(await spokeToken.getRoleAdmin(CONFIG_CONTRACTS_ROLE)).to.equal(DEFAULT_ADMIN_ROLE);
      expect(await spokeToken.hasRole(CONFIG_CONTRACTS_ROLE, admin.address)).to.be.true;

      // check state
      expect(await spokeToken.getBridgeRouter()).to.equal(bridgeRouter);
      expect(await spokeToken.getHubChainId()).to.equal(hubChainId);
      expect(await spokeToken.getHubContractAddress()).to.equal(hubAddress);
      expect(await spokeToken.getAddressOracle()).to.equal(addressOracle);
    });
  });

  describe("Receive Message", () => {
    it("Should successfully receive send token message", async () => {
      const { user, spokeToken, spokeAddress, bridgeRouterAddress, bridgeRouterSigner, hubChainId, hubAddress } =
        await loadFixture(deploySpokeFixture);

      // fund bridge router to send transaction
      setBalance(bridgeRouterAddress, 1e18);

      // receive message
      const messageId: string = getRandomBytes(BYTES32_LENGTH);
      const accountId: string = getAccountIdBytes("ACCOUNT_ID");
      const amount = BigInt(1e9);
      const message: MessageReceived = {
        messageId: messageId,
        sourceChainId: BigInt(hubChainId),
        sourceAddress: convertEVMAddressToGenericAddress(hubAddress),
        handler: convertEVMAddressToGenericAddress(spokeAddress),
        payload: buildMessagePayload(
          Action.SendToken,
          accountId,
          user.address,
          convertNumberToBytes(amount, UINT256_LENGTH)
        ),
        returnAdapterId: BigInt(0),
        returnGasLimit: BigInt(0),
      };
      const receiveMessage = await spokeToken.connect(bridgeRouterSigner).receiveMessage(message);
      await expect(receiveMessage).to.emit(spokeToken, "SendToken").withArgs(user.address, amount);
    });

    it("Should fail to receive message when hub is unknown", async () => {
      const { user, spokeToken, spokeAddress, bridgeRouterAddress, bridgeRouterSigner, hubChainId } =
        await loadFixture(deploySpokeFixture);

      // fund bridge router to send transaction
      setBalance(bridgeRouterAddress, 1e18);

      // receive message
      const messageId: string = getRandomBytes(BYTES32_LENGTH);
      const accountId: string = getAccountIdBytes("ACCOUNT_ID");
      const hubAddress = convertEVMAddressToGenericAddress(getRandomAddress());
      const amount = BigInt(1e9);
      const message: MessageReceived = {
        messageId: messageId,
        sourceChainId: BigInt(hubChainId),
        sourceAddress: hubAddress,
        handler: convertEVMAddressToGenericAddress(spokeAddress),
        payload: buildMessagePayload(
          Action.SendToken,
          accountId,
          user.address,
          convertNumberToBytes(amount, UINT256_LENGTH)
        ),
        returnAdapterId: BigInt(0),
        returnGasLimit: BigInt(0),
      };
      const receiveMessage = spokeToken.connect(bridgeRouterSigner).receiveMessage(message);
      await expect(receiveMessage)
        .to.be.revertedWithCustomError(spokeToken, "HubUnknown")
        .withArgs(hubChainId, hubAddress);
    });

    it("Should fail to receive message when action is unsupported", async () => {
      const { user, spokeToken, spokeAddress, bridgeRouterAddress, bridgeRouterSigner, hubChainId, hubAddress } =
        await loadFixture(deploySpokeFixture);

      // fund bridge router to send transaction
      setBalance(bridgeRouterAddress, 1e18);

      // receive message
      const messageId: string = getRandomBytes(BYTES32_LENGTH);
      const accountId: string = getAccountIdBytes("ACCOUNT_ID");
      const amount = BigInt(1e9);
      const message: MessageReceived = {
        messageId: messageId,
        sourceChainId: BigInt(hubChainId),
        sourceAddress: convertEVMAddressToGenericAddress(hubAddress),
        handler: convertEVMAddressToGenericAddress(spokeAddress),
        payload: buildMessagePayload(
          Action.Borrow,
          accountId,
          user.address,
          convertNumberToBytes(amount, UINT256_LENGTH)
        ),
        returnAdapterId: BigInt(0),
        returnGasLimit: BigInt(0),
      };
      const receiveMessage = spokeToken.connect(bridgeRouterSigner).receiveMessage(message);
      await expect(receiveMessage)
        .to.be.revertedWithCustomError(spokeToken, "CannotReceiveMessage")
        .withArgs(message.messageId);
    });
  });

  it("Retry message should internally call receive message", async () => {
    const { user, spokeToken, spokeAddress, bridgeRouterAddress, bridgeRouterSigner, hubChainId, hubAddress } =
      await loadFixture(deploySpokeFixture);

    // fund bridge router to send transaction
    setBalance(bridgeRouterAddress, 1e18);

    // receive message
    const messageId: string = getRandomBytes(BYTES32_LENGTH);
    const accountId: string = getAccountIdBytes("ACCOUNT_ID");
    const amount = BigInt(1e9);
    const message: MessageReceived = {
      messageId: messageId,
      sourceChainId: BigInt(hubChainId),
      sourceAddress: convertEVMAddressToGenericAddress(hubAddress),
      handler: convertEVMAddressToGenericAddress(spokeAddress),
      payload: buildMessagePayload(
        Action.SendToken,
        accountId,
        user.address,
        convertNumberToBytes(amount, UINT256_LENGTH)
      ),
      returnAdapterId: BigInt(0),
      returnGasLimit: BigInt(0),
    };
    const extraArgs = "0x";
    const receiveMessage = await spokeToken.connect(bridgeRouterSigner).retryMessage(message, user.address, extraArgs);
    await expect(receiveMessage).to.emit(spokeToken, "SendToken").withArgs(user.address, amount);
  });

  it("Should fail to reverse message", async () => {
    const { user, spokeToken, spokeAddress, bridgeRouterAddress, bridgeRouterSigner } =
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
    const receiveMessage = spokeToken.connect(bridgeRouterSigner).reverseMessage(message, user.address, extraArgs);
    await expect(receiveMessage).to.be.revertedWithCustomError(spokeToken, "CannotReverseMessage").withArgs(messageId);
  });
});
