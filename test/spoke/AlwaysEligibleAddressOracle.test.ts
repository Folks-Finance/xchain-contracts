import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { AlwaysEligibleAddressOracle__factory } from "../../typechain-types";
import { getRandomAddress } from "../utils/bytes";
import { Action } from "../utils/messages/messages";

describe("AlwaysEligibleAddressOracle (unit tests)", () => {
  async function deployAddressOracleFixture() {
    const [user, ...unusedUsers] = await ethers.getSigners();

    // deploy contract
    const addressOracle = await new AlwaysEligibleAddressOracle__factory(user).deploy();

    return { user, unusedUsers, addressOracle };
  }

  describe("Deployment", () => {
    it("Should successfully deploy", async () => {
      const { addressOracle } = await loadFixture(deployAddressOracleFixture);
      expect(await addressOracle.getAddress()).to.not.equal(ethers.ZeroAddress);
    });
  });

  describe("Is Eligible", () => {
    it("Should successfully return true for is eligible", async () => {
      const { addressOracle } = await loadFixture(deployAddressOracleFixture);

      // check eligibility
      const address = getRandomAddress();
      const action = Action.Borrow;
      const isEligible = await addressOracle.isEligible(address, action);
      expect(isEligible).to.be.true;
    });
  });
});
