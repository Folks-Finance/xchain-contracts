import { expect } from "chai";
import { ethers } from "hardhat";
import { impersonateAccount, loadFixture, setBalance } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import {
  SimpleAddressOracle__factory,
  MockBridgeRouter__factory,
  SimpleERC20Token__factory,
  SpokeRewardsV2Erc20Token__factory,
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
import { Action, buildMessagePayload, MessageReceived } from "../utils/messages/messages";
import { SECONDS_IN_DAY } from "../utils/time";

describe("SpokeRewardsV2GasToken contract (unit tests)", () => {
  const DEFAULT_ADMIN_ROLE = getEmptyBytes(BYTES32_LENGTH);
  const CONFIG_CONTRACTS_ROLE = ethers.keccak256(convertStringToBytes("CONFIG_CONTRACTS"));

  async function deploySpokeFixture() {
    const [admin, user, ...unusedUsers] = await ethers.getSigners();

    // deploy token and fund user
    const token = await new SimpleERC20Token__factory(user).deploy("ChainLink", "LINK");
    await token.mint(user, BigInt(1000e18));

    // deploy spoke
    const bridgeRouter = await new MockBridgeRouter__factory(user).deploy();
    const hubChainId = 0;
    const hubAddress = convertEVMAddressToGenericAddress(getRandomAddress());
    const addressOracle = await new SimpleAddressOracle__factory(user).deploy();
    const spokeToken = await new SpokeRewardsV2Erc20Token__factory(user).deploy(
      admin.address,
      bridgeRouter,
      hubChainId,
      hubAddress,
      addressOracle,
      token
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
      token,
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
      const { admin, token, spokeToken, bridgeRouter, hubChainId, hubAddress, addressOracle } =
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
      expect(await spokeToken.token()).to.equal(token);
    });
  });

  describe("Fund", () => {
    it("Should receive token", async () => {
      const { user, token, spokeToken, spokeAddress } = await loadFixture(deploySpokeFixture);

      // approve spoke to transfer token
      const amount = BigInt(1e9);
      await token.approve(spokeAddress, amount);

      // fund
      const fund = await spokeToken.connect(user).fund(amount);
      const balance = await token.balanceOf(spokeToken);
      expect(balance).to.equal(amount);
      expect(fund).to.emit(spokeToken, "Funded").withArgs(amount);
    });
  });

  describe("Receive message", () => {
    it("Should send gas token to user", async () => {
      const { user, token, spokeToken, spokeAddress, bridgeRouterAddress, bridgeRouterSigner, hubChainId, hubAddress } =
        await loadFixture(deploySpokeFixture);

      // fund bridge router and spoke to send transaction
      setBalance(bridgeRouterAddress, 1e18);
      await token.mint(spokeAddress, BigInt(1e18));

      // balance before
      const balance = await token.balanceOf(user.address);

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
      await spokeToken.connect(bridgeRouterSigner).receiveMessage(message);
      expect(await token.balanceOf(user.address)).to.equal(balance + amount);
    });
  });
});
